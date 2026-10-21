// 網頁查字：在任何網頁反白英文，按 Z，就在反白處上方跳出翻譯小框框。
//
// 框框的樣子跟 YouTube 字幕上點字跳出來的那個一樣（白底、粗體原文、下面一行中文），
// 也一樣會自動唸出發音。翻譯與發音都交給背景（background.js 的 translate / speak），
// 跟字幕查字走同一條路：Google 被擋時會自動改用 Gemini，這裡不用另外處理。
//
// 為什麼框框放在 Shadow DOM 裡：這支程式會跑在各式各樣的網站上，
// 網站自己的 CSS（例如把所有 div 都加上邊框、改字型）會把框框弄得面目全非。
// Shadow DOM 裡的樣式跟外面完全隔開，在哪個網站看起來都一樣。
(() => {
  if (window.__flowstudyWebLookup) return; // all_frames + SPA 重複注入時只跑一份
  window.__flowstudyWebLookup = true;

  const HOST_ID = "flowstudy-web-lookup";
  const MAX_CHARS = 300; // 選太長（整段文章）就不是「查字」了，翻譯也會很慢
  const SCALE_KEY = "flowstudyCaptionScale"; // 跟字幕大小共用同一個比例，兩個框框永遠一樣大

  let host = null;
  let box = null;
  let scale = 1;
  let lookupId = 0; // 每次查詢遞增；舊的翻譯晚回來時對不上號就丟掉
  let audio = null;
  let anchorRange = null; // 反白的那段字；頁面捲動時框框跟著它移動

  // ---------- 字幕大小設定（框框跟著縮放） ----------
  try {
    chrome.storage.local.get([SCALE_KEY], (data) => {
      const v = data && data[SCALE_KEY];
      if (Number.isFinite(v)) scale = v / 100;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[SCALE_KEY] && Number.isFinite(changes[SCALE_KEY].newValue)) {
        scale = changes[SCALE_KEY].newValue / 100;
        if (box) box.style.setProperty("--s", scale);
      }
    });
  } catch (e) {
    /* 擴充功能剛重新載入、舊分頁失去連線：用預設大小 */
  }

  // ---------- 什麼時候「不」接手 Z ----------
  // 使用者正在打字（搜尋框、留言、文件編輯器）時，Z 就是 Z
  function isTyping(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (el.isContentEditable) return true;
    const role = el.getAttribute && el.getAttribute("role");
    return role === "textbox" || role === "combobox" || role === "searchbox";
  }

  // YouTube 上我們自己的字幕條：在那裡反白已經會直接查字，不要再跳第二個框框
  function insideFlowStudyUi(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return !!(el && el.closest && el.closest("#flowstudy-caption-bar, #zerostudy-settings-panel, #my-translate-box"));
  }

  function currentSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const text = sel.toString().replace(/\s+/g, " ").trim();
    // 要有英文字母才查；只選到中文、數字、空白就讓 Z 照原本的用途
    if (!text || text.length > MAX_CHARS || !/[A-Za-z]/.test(text)) return null;
    if (insideFlowStudyUi(sel.anchorNode)) return null;
    const range = sel.getRangeAt(0);
    let rect = range.getBoundingClientRect();
    // 有些網站（表格、跨好幾個元素）整體的框量出來是 0，改用第一行的框
    if (!rect.width && !rect.height) {
      const rects = range.getClientRects();
      if (rects.length) rect = rects[0];
    }
    return { text, rect, range: range.cloneRange() };
  }

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "z" && e.key !== "Z") return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return; // Ctrl+Z 是復原，絕對不能搶
      if (e.isComposing || e.keyCode === 229) return; // 輸入法組字中
      if (isTyping(document.activeElement) || isTyping(e.target)) return;
      const picked = currentSelection();
      if (!picked) return; // 沒有反白英文：Z 交還給網站（有些網站自己用 Z 當快捷鍵）
      e.preventDefault();
      e.stopPropagation();
      anchorRange = picked.range;
      lookup(picked.text, picked.rect);
    },
    true
  );

  // ---------- 框框 ----------
  const STYLE = `
    :host { all: initial; }
    .box {
      --s: 1;
      position: fixed;
      z-index: 2147483647;
      box-sizing: border-box;
      font-family: -apple-system, "Segoe UI", "PingFang TC", "Microsoft JhengHei", sans-serif;
      background: #ffffff;
      color: #1a1a1a;
      border-radius: 10px;
      padding: calc(10px * var(--s)) calc(14px * var(--s));
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
      max-width: calc(280px * var(--s));
      line-height: 1.45;
      text-align: left;
    }
    .original { font-size: calc(17px * var(--s)); font-weight: 700; margin-bottom: 2px; word-break: break-word; }
    .translated { font-size: calc(14px * var(--s)); color: #333; }
    .loading { font-size: calc(13px * var(--s)); color: #888; }
  `;

  function ensureBox() {
    // 全螢幕時要掛在全螢幕元素底下，不然會被蓋住看不見
    const parent = document.fullscreenElement || document.documentElement;
    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>${STYLE}</style><div class="box" role="dialog" aria-live="polite"></div>`;
      box = root.querySelector(".box");
    }
    if (host.parentNode !== parent) parent.appendChild(host);
    box.style.setProperty("--s", scale);
    return box;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function render(original, line, cls, rect) {
    const b = ensureBox();
    b.innerHTML = `<div class="original">${escapeHtml(original)}</div><div class="${cls}">${escapeHtml(line)}</div>`;
    place(b, rect);
  }

  // 放在反白文字的正上方、置中；上面空間不夠就改放下面，左右不超出視窗
  function place(b, rect) {
    b.style.visibility = "hidden";
    b.style.left = "0px";
    b.style.top = "0px";
    b.hidden = false;
    const w = b.offsetWidth;
    const h = b.offsetHeight;
    const gap = 10;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    let left = rect.left + rect.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, vw - w - 8));
    let top = rect.top - h - gap;
    if (top < 8) top = rect.bottom + gap;
    b.style.left = left + "px";
    b.style.top = top + "px";
    b.style.visibility = "visible";
  }

  function close() {
    lookupId++; // 還在路上的翻譯回來時作廢，不會把關掉的框框又叫出來
    if (box) box.hidden = true;
    stopAudio();
  }

  function isOpen() {
    return !!(box && !box.hidden && host && host.isConnected);
  }

  function stopAudio() {
    if (audio) {
      audio.pause();
      audio = null;
    }
  }

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError;
          resolve(res);
        });
      } catch (e) {
        resolve(null); // 擴充功能剛重新載入：舊分頁要重新整理才連得上
      }
    });
  }

  async function lookup(text, rect) {
    const id = ++lookupId;
    stopAudio();
    render(text, "翻譯中…", "loading", rect);

    // 發音跟翻譯同時出發，不用等翻譯回來才開始唸
    send({ type: "speak", text }).then((res) => {
      if (id !== lookupId || !res || !res.audioDataUrl) return;
      audio = new Audio(res.audioDataUrl);
      audio.play().catch(() => {});
    });

    const res = await send({ type: "translate", text });
    if (id !== lookupId) return;
    if (!res) {
      render(text, "FlowStudy 剛更新過，請重新整理這個網頁", "loading", rect);
    } else if (res.translated) {
      render(text, res.translated, "translated", rect);
    } else {
      render(text, res.error || "翻譯失敗，請檢查網路連線", "loading", rect);
    }
  }

  // 點框框以外的地方、按 Esc → 關掉
  document.addEventListener(
    "mousedown",
    (e) => {
      if (isOpen() && !e.composedPath().includes(host)) close();
    },
    true
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && isOpen()) close();
    },
    true
  );

  // 框框是 position: fixed，頁面捲動時要重新對準那段字，不然會停在原地、離文字越來越遠
  // 瀏覽器本來就把 scroll 事件節流成一個畫面一次，直接重新定位就好
  function reposition() {
    if (!isOpen() || !anchorRange) return;
    const r = anchorRange.getBoundingClientRect();
    if (!r.width && !r.height) return close(); // 那段字已經從頁面上消失（例如動態載入的內容被換掉）
    place(box, r);
  }
  window.addEventListener("scroll", reposition, { capture: true, passive: true });
  window.addEventListener("resize", reposition);
})();
