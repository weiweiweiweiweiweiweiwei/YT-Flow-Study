// 網頁查字：在任何網頁反白英文，按 Z，就在反白處上方跳出翻譯小框框。
// 快速翻譯：沒有反白時連按兩下 Z，在滑鼠的位置打開一個小小的輸入欄，打英文按 Enter 看中文。
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
  let quick = null; // 快速翻譯的輸入欄（跟查字框放在同一個 Shadow DOM 裡）
  let quickId = 0;
  let lastZAt = 0; // 上一次按 Z 的時間：兩下夠近就算「連按兩下」
  const DOUBLE_Z_MS = 400;
  const mouse = { x: innerWidth / 2, y: innerHeight / 2 }; // 輸入欄要出現在滑鼠的地方

  document.addEventListener(
    "mousemove",
    (e) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
    },
    { capture: true, passive: true }
  );

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
    // 游標在 Shadow DOM 裡的輸入框（例如我們自己的快速翻譯欄）時，外面看到的只是外殼，要往裡找
    if (el.shadowRoot && el.shadowRoot.activeElement) return isTyping(el.shadowRoot.activeElement);
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
      if (isTyping(document.activeElement) || isTyping(e.composedPath()[0])) return;
      const picked = currentSelection();
      if (picked) {
        e.preventDefault();
        e.stopPropagation();
        lastZAt = 0;
        anchorRange = picked.range;
        lookup(picked.text, picked.rect);
        return;
      }
      // 沒有反白：第一下 Z 照樣交還給網站（有些網站自己用 Z 當快捷鍵），
      // 很快再按一下才算「連按兩下」，打開快速翻譯欄
      const now = Date.now();
      if (now - lastZAt <= DOUBLE_Z_MS) {
        e.preventDefault(); // 不然這個 z 會被打進剛打開的輸入欄
        e.stopPropagation();
        lastZAt = 0;
        openQuick();
      } else {
        lastZAt = now;
      }
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

    /* 快速翻譯欄：Liquid Glass。
       半透明白 + 背景模糊與提高飽和度（透出後面畫面的顏色），
       上緣一道內側高光、外圈一圈細亮邊，看起來像一片有厚度的玻璃。
       不透明度刻意留在五成上下：太透在深色網頁上字會看不清楚。 */
    .quick {
      position: fixed;
      z-index: 2147483647;
      box-sizing: border-box;
      width: 200px;
      padding: 5px;
      border-radius: 14px;
      font-family: -apple-system, "Segoe UI", "PingFang TC", "Microsoft JhengHei", sans-serif;
      color: #111;
      background: linear-gradient(160deg, rgba(255, 255, 255, 0.62), rgba(255, 255, 255, 0.36));
      -webkit-backdrop-filter: blur(20px) saturate(180%);
      backdrop-filter: blur(20px) saturate(180%);
      border: 1px solid rgba(255, 255, 255, 0.6);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.85),
        inset 0 -1px 0 rgba(255, 255, 255, 0.25),
        0 8px 28px rgba(0, 0, 0, 0.22),
        0 1px 3px rgba(0, 0, 0, 0.12);
      animation: rise 0.16s ease-out;
    }
    @keyframes rise { from { opacity: 0; transform: translateY(4px) scale(0.97); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) { .quick { animation: none; } }
    .quick input {
      all: unset;
      box-sizing: border-box;
      display: block;
      width: 100%;
      padding: 5px 9px;
      border-radius: 10px;
      font-size: 14px;
      line-height: 1.3;
      color: #111;
      background: rgba(255, 255, 255, 0.35);
      caret-color: #2563eb;
    }
    .quick input::placeholder { color: rgba(17, 17, 17, 0.45); }
    .quick .out {
      padding: 6px 9px 3px;
      font-size: 14px;
      line-height: 1.45;
      color: #111;
      word-break: break-word;
      text-shadow: 0 1px 0 rgba(255, 255, 255, 0.5);
    }
    .quick .out.dim { color: rgba(17, 17, 17, 0.55); font-size: 12.5px; }
  `;

  function ensureBox() {
    // 全螢幕時要掛在全螢幕元素底下，不然會被蓋住看不見
    const parent = document.fullscreenElement || document.documentElement;
    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>${STYLE}</style><div class="box" role="dialog" aria-live="polite" hidden></div>
        <div class="quick" hidden><input type="text" placeholder="輸入英文，按 Enter" aria-label="輸入英文翻成中文"
          autocomplete="off" spellcheck="false"><div class="out" aria-live="polite" hidden></div></div>`;
      box = root.querySelector(".box");
      quick = root.querySelector(".quick");
      wireQuick();
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

  // ---------- 快速翻譯欄 ----------
  function quickOpen() {
    return !!(quick && !quick.hidden && host && host.isConnected);
  }

  function openQuick() {
    ensureBox();
    close(); // 查字框跟輸入欄不同時出現
    const input = quick.querySelector("input");
    const out = quick.querySelector(".out");
    input.value = "";
    out.hidden = true;
    out.textContent = "";
    quick.hidden = false;
    placeQuick();
    input.focus({ preventScroll: true });
  }

  // 左上角對齊滑鼠（稍微往右下錯開，不要被游標本身蓋住），超出視窗就往內收
  function placeQuick() {
    const vw = document.documentElement.clientWidth || innerWidth;
    const vh = document.documentElement.clientHeight || innerHeight;
    const w = quick.offsetWidth;
    const h = quick.offsetHeight;
    let left = mouse.x + 8;
    let top = mouse.y + 8;
    if (left + w > vw - 8) left = Math.max(8, mouse.x - w - 8);
    if (top + h > vh - 8) top = Math.max(8, mouse.y - h - 8);
    quick.style.left = left + "px";
    quick.style.top = top + "px";
  }

  function closeQuick() {
    if (!quick) return;
    quickId++;
    quick.hidden = true;
    const input = quick.querySelector("input");
    if (host && host.shadowRoot.activeElement === input) input.blur();
  }

  function wireQuick() {
    const input = quick.querySelector("input");
    const out = quick.querySelector(".out");

    // 在輸入欄裡打字時，按鍵不能再傳到網頁上：
    // YouTube 會把 k、j、空白鍵當成播放控制，其他網站也各有自己的快捷鍵。
    for (const type of ["keydown", "keyup", "keypress"]) {
      input.addEventListener(type, (e) => e.stopPropagation());
    }

    input.addEventListener("keydown", async (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeQuick();
        return;
      }
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      const text = input.value.replace(/\s+/g, " ").trim();
      if (!text) return;
      // 只在按 Enter 時翻譯，不邊打邊翻：每打一個字就送一次，很快就會被 Google 暫時擋下
      const id = ++quickId;
      out.hidden = false;
      out.className = "out dim";
      out.textContent = "翻譯中…";
      placeQuick();
      const res = await send({ type: "translate", text: text.slice(0, 500) });
      if (id !== quickId) return;
      if (res && res.translated) {
        out.className = "out";
        out.textContent = res.translated;
      } else {
        out.className = "out dim";
        out.textContent = !res ? "FlowStudy 剛更新過，請重新整理這個網頁" : res.error || "翻譯失敗，請檢查網路連線";
      }
      placeQuick();
    });
  }

  // 點框框以外的任何地方、按 Esc → 關掉（查字框與輸入欄都一樣）
  document.addEventListener(
    "mousedown",
    (e) => {
      const inside = host && e.composedPath().includes(host);
      if (inside) return;
      if (isOpen()) close();
      if (quickOpen()) closeQuick();
    },
    true
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      if (isOpen()) close();
      if (quickOpen()) closeQuick();
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
