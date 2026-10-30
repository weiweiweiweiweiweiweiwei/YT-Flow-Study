// ============================================================================
// 手機版 YouTube（m.youtube.com）的轉接
// ============================================================================
//
// content.js 是照桌面版 YouTube 寫的。手機版的播放器（#movie_player）是同一套，
// 字幕抓取、查字都照常運作；不一樣的是播放器周圍：
//
//   1. 手機版播放器上面蓋著一層透明的觸控層（點一下顯示控制列、連點兩下快轉）。
//      掛在播放器「裡面」的東西全部點不到。所以這裡在那層觸控層的更上面疊一個圖層
//      （#flowstudy-player-layer），大小位置跟播放器一模一樣，content.js 會把字幕條掛在這裡
//      （見 content.js 的 getPlayerContainer）。
//   2. 桌面版把「沉浸模式」膠囊和齒輪塞進播放器控制列（.ytp-right-controls），手機版沒有這一列。
//      圖層裡放一個同名的容器，content.js 會自己把按鈕放進來。容器放在 YouTube「自動播放」開關
//      的位置（開關藏起來），跟著 YouTube 的控制列一起出現、一起消失。
//   3. 手指在我們的字幕條、翻譯框、按鈕上時，不讓 YouTube 收到，免得點單字時影片跟著快轉。
//   4. 點影片畫面任何地方 = 播放／暫停（查完單字不用特地去按正中央的播放鈕）。
//   5. 設定裡：藏起「隱藏推薦影片」（桌面版用的），加上「句子按鈕」開關與「同步到電腦」。
//   6. 所有 Shorts 藏起來。
// ============================================================================

(function () {
  const OUR_UI = "#flowstudy-player-layer, #my-translate-box, #zerostudy-settings-panel";
  // 手機版播放器的觸控層與控制列可能的名字（YouTube 會改，多列幾個）
  const OVERLAY = "ytm-custom-control, #player-control-container, .player-controls-content, .player-control-overlay";
  const SENTENCE_BUTTONS_KEY = "flowstudyAndroidSentenceButtons"; // App 讀這個值決定要不要顯示 ◀ ↻ ▶

  const style = document.createElement("style");
  style.id = "flowstudy-mobile-css";
  style.textContent = `
    #flowstudy-player-layer {
      position: absolute;
      z-index: 2147482000;
      pointer-events: none;
      overflow: visible;
    }
    #flowstudy-player-layer > * { pointer-events: auto; }

    /* 按鈕容器：YouTube 自己對 .ytp-right-controls 的樣式（撐滿高度、垂直置中…）全部蓋掉，
       位置與顯示由下面的 placeControls() 決定 */
    #flowstudy-player-layer > .flowstudy-mobile-controls.ytp-right-controls {
      position: absolute !important;
      left: auto !important;
      bottom: auto !important;
      width: auto !important;
      height: auto !important;
      margin: 0 !important;
      padding: 0 !important;
      transform: none !important;
      display: flex !important;
      align-items: center !important;
      float: none !important;
      visibility: visible !important;
      transition: opacity 0.2s ease;
    }
    #flowstudy-player-layer > .flowstudy-mobile-controls.is-hidden {
      opacity: 0 !important;
      pointer-events: none !important;
    }
    .flowstudy-mobile-controls .zerostudy-player-controls { margin-right: 0; padding: 2px 8px 2px 2px; gap: 4px; background: rgba(0, 0, 0, 0.45); }
    .flowstudy-mobile-controls .zerostudy-immersion-btn { padding: 6px 10px; font-size: 13px !important; }
    .flowstudy-mobile-controls .zerostudy-settings-btn { width: 30px; height: 30px; }

    /* 被膠囊取代的「自動播放」開關 */
    .flowstudy-replaced { opacity: 0 !important; pointer-events: none !important; }

    .fs-panel-row:has(#fsWideLayout) { display: none !important; }
    .fs-modal-card { max-height: calc(100vh - 32px); overflow-y: auto; }
    .flowstudy-sync-row button.flowstudy-link {
      border: 1px solid rgba(59, 130, 246, 0.6);
      background: transparent;
      color: rgb(59, 130, 246);
      border-radius: 8px;
      padding: 6px 12px;
      font: inherit;
      font-weight: 600;
    }

    /* Shorts */
    ytm-reel-shelf-renderer, ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2,
    ytm-reel-item-renderer, ytm-rich-section-renderer:has(ytm-shorts-lockup-view-model),
    ytm-rich-section-renderer:has(ytm-shorts-lockup-view-model-v2), ytm-rich-section-renderer:has(ytm-reel-shelf-renderer),
    ytm-rich-item-renderer:has(a[href^="/shorts/"]), ytm-video-with-context-renderer:has(a[href^="/shorts/"]),
    ytm-compact-video-renderer:has(a[href^="/shorts/"]), ytm-pivot-bar-item-renderer:has(.pivot-shorts),
    .flowstudy-hidden { display: none !important; }
  `;
  (document.head || document.documentElement).appendChild(style);

  function player() {
    return document.getElementById("movie_player") || document.querySelector(".html5-video-player");
  }

  function mainVideo() {
    const p = player();
    return p ? p.querySelector("video") : null;
  }

  // ---------- 1 & 2. 播放器上方的圖層 ----------

  // 觸控層跟播放器是兄弟（或更上一層的親戚）。往上找到「同時包住播放器和觸控層」的那一層，
  // 圖層掛在那裡、z-index 拉高，才會疊在觸控層上面。
  function layerParent(p) {
    const fs = document.fullscreenElement;
    let node = p.parentElement;
    for (let i = 0; node && node !== document.body && i < 6; i++) {
      if (node.querySelector(OVERLAY)) return fs && !fs.contains(node) ? fs : node;
      node = node.parentElement;
    }
    return fs && fs.contains(p) ? fs : p.parentElement;
  }

  function ensureLayer() {
    const p = player();
    if (!p || !p.parentElement) return null;
    // 桌面版播放器（自己有控制列）：content.js 照原本的方式運作，不需要圖層
    if (p.querySelector(".ytp-right-controls:not(.flowstudy-mobile-controls)")) return null;

    let layer = document.getElementById("flowstudy-player-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.id = "flowstudy-player-layer";
      // 圖層上的點擊不要往上傳到播放器容器（content.js 的按鈕監聽是掛在按鈕本身，先執行，不受影響）
      layer.addEventListener("click", (e) => e.stopPropagation());
      const controls = document.createElement("div");
      controls.className = "ytp-right-controls flowstudy-mobile-controls is-hidden";
      layer.appendChild(controls);
    }
    const parent = layerParent(p);
    if (layer.parentElement !== parent) parent.appendChild(layer);
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    positionLayer(layer, p, parent);
    return layer;
  }

  function positionLayer(layer, p, parent) {
    const pr = p.getBoundingClientRect();
    const ar = parent.getBoundingClientRect();
    const left = pr.left - ar.left - parent.clientLeft + parent.scrollLeft;
    const top = pr.top - ar.top - parent.clientTop + parent.scrollTop;
    const next = `left:${left}px;top:${top}px;width:${pr.width}px;height:${pr.height}px;`;
    if (layer.__flowstudyPos !== next) {
      layer.__flowstudyPos = next;
      layer.style.cssText = next;
    }
  }

  // ---------- 2. 膠囊放在「自動播放」開關的位置，跟著 YouTube 的控制列出現／消失 ----------

  const AUTOPLAY = /自動播放|autoplay|autonav/i;
  const FALLBACK_ANCHOR = /字幕|captions|subtitles|^設定|settings|更多選項|more options/i;

  function labelOf(el) {
    return (el.getAttribute("aria-label") || el.getAttribute("title") || "") + " " + (typeof el.className === "string" ? el.className : "");
  }

  // 元素真的看得到嗎？（YouTube 收起控制列時，是把整個控制列淡出或拿掉）
  function shown(el, skipSelf) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    let opacity = 1;
    for (let n = skipSelf ? el.parentElement : el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      opacity *= parseFloat(cs.opacity) || 0;
      if (opacity < 0.2) return false;
    }
    return true;
  }

  function findAnchor(scope, layer) {
    const candidates = Array.from(scope.querySelectorAll("button, [role='button'], [role='switch'], [class*='autonav' i]")).filter(
      (el) => !layer.contains(el)
    );
    const autoplay = candidates.find((el) => AUTOPLAY.test(labelOf(el)));
    if (autoplay) return { el: autoplay.closest("button, [role='button'], [role='switch']") || autoplay, replace: true };
    const other = candidates.find((el) => FALLBACK_ANCHOR.test(labelOf(el)) && shown(el));
    return other ? { el: other, replace: false } : null;
  }

  function placeControls(layer) {
    const controls = layer.querySelector(".flowstudy-mobile-controls");
    if (!controls) return;
    const scope = layer.parentElement || document;
    const anchor = findAnchor(scope, layer);

    if (anchor && anchor.replace && !anchor.el.classList.contains("flowstudy-replaced")) {
      anchor.el.classList.add("flowstudy-replaced");
    }
    // 自動播放開關被我們設成透明了，看它的「外層」有沒有顯示
    const visible = !!anchor && shown(anchor.el, anchor.replace);
    controls.classList.toggle("is-hidden", !visible);
    if (!visible) return;

    const lr = layer.getBoundingClientRect();
    const ar = anchor.el.getBoundingClientRect();
    const height = controls.offsetHeight || 34;
    // 取代自動播放：右邊對齊開關的右邊；只找到字幕／設定鈕：放在它左邊
    const right = anchor.replace ? lr.right - ar.right : lr.right - ar.left + 8;
    const top = ar.top - lr.top + (ar.height - height) / 2;
    const pos = Math.round(Math.max(4, right)) + "/" + Math.round(Math.max(4, top));
    if (controls.__flowstudyPos === pos) return;
    controls.__flowstudyPos = pos;
    controls.style.setProperty("right", Math.round(Math.max(4, right)) + "px", "important");
    controls.style.setProperty("top", Math.round(Math.max(4, top)) + "px", "important");
  }

  // ---------- 5. 設定視窗 ----------
  function ensureSettingsRows() {
    const panel = document.getElementById("zerostudy-settings-panel");
    if (!panel || panel.querySelector(".flowstudy-android-rows")) return;
    const done = panel.querySelector("#fsModalDone");
    if (!done) return;

    const wrap = document.createElement("div");
    wrap.className = "flowstudy-android-rows";
    wrap.innerHTML =
      '<div class="fs-panel-row">' +
      '<span><div class="fs-panel-label">句子按鈕</div>' +
      '<div class="fs-panel-sub">全螢幕時右側顯示 ◀ 上一句、↻ 重播、▶ 下一句</div></span>' +
      '<button class="fs-switch" id="fsSentenceButtons" type="button" role="switch" aria-checked="false"><span class="fs-switch-knob"></span></button>' +
      "</div>" +
      '<div class="fs-panel-row flowstudy-sync-row">' +
      '<span><div class="fs-panel-label">同步到電腦</div>' +
      '<div class="fs-panel-sub">用 Google 帳號登入，單字和沉浸時數會跟電腦版共用</div></span>' +
      '<button class="flowstudy-link" type="button">設定</button>' +
      "</div>";

    const sw = wrap.querySelector("#fsSentenceButtons");
    const render = (on) => {
      sw.setAttribute("aria-checked", String(on));
      sw.classList.toggle("is-on", on);
    };
    chrome.storage.local.get([SENTENCE_BUTTONS_KEY], (data) => render(!!(data && data[SENTENCE_BUTTONS_KEY])));
    sw.addEventListener("click", () => {
      const on = sw.getAttribute("aria-checked") !== "true";
      render(on);
      chrome.storage.local.set({ [SENTENCE_BUTTONS_KEY]: on });
    });

    wrap.querySelector(".flowstudy-link").addEventListener("click", () => {
      if (window.__fsTransport) window.__fsTransport.call("openSync", {}).catch(() => {});
    });
    done.parentElement.insertBefore(wrap, done);
  }

  // 翻譯框在全螢幕時會掛進播放器裡面，點它不能被當成「點畫面」
  function guardTranslateBox() {
    const box = document.getElementById("my-translate-box");
    if (!box || box.__flowstudyGuarded) return;
    box.__flowstudyGuarded = true;
    box.addEventListener("click", (e) => e.stopPropagation());
  }

  // ---------- 6. Shorts：任何連到 /shorts/ 的項目、底部選單的 Shorts 分頁 ----------
  function hide(el) {
    if (el && !el.classList.contains("flowstudy-hidden")) el.classList.add("flowstudy-hidden");
  }

  function hideShorts() {
    document.querySelectorAll('a[href^="/shorts/"], a[href*="youtube.com/shorts/"]').forEach((a) => {
      if (a.closest(".flowstudy-hidden")) return;
      hide(
        a.closest(
          "ytm-rich-item-renderer, ytm-video-with-context-renderer, ytm-compact-video-renderer, ytm-reel-item-renderer, ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytm-reel-shelf-renderer"
        ) || a
      );
    });
    document.querySelectorAll("ytm-pivot-bar-item-renderer").forEach((item) => {
      if (/^shorts$/i.test((item.textContent || "").trim())) hide(item);
    });
    // 標題是「Shorts」的整排
    document.querySelectorAll("ytm-rich-section-renderer, ytm-reel-shelf-renderer").forEach((shelf) => {
      const title = shelf.querySelector("h2, h3, .reel-shelf-title, [class*='title']");
      if (title && /^shorts$/i.test((title.textContent || "").trim())) hide(shelf);
    });
  }

  // 圖層位置、膠囊要不要顯示：常常檢查（YouTube 的控制列一淡出，膠囊就跟著消失）
  function fastTick() {
    const layer = ensureLayer();
    if (layer) placeControls(layer);
  }
  // 頁面上新出現的東西（設定視窗、翻譯框、Shorts）：有新元素時才看
  let scheduled = false;
  function slowTick() {
    scheduled = false;
    ensureSettingsRows();
    guardTranslateBox();
    hideShorts();
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      slowTick();
      fastTick();
    });
  }
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", fastTick);
  window.addEventListener("scroll", fastTick, { passive: true });
  document.addEventListener("fullscreenchange", () => setTimeout(fastTick, 50));
  document.addEventListener("touchend", () => setTimeout(fastTick, 60), { passive: true });
  setInterval(fastTick, 150);
  setInterval(slowTick, 1000);
  schedule();

  // ---------- 背景播放：主影片在播還是停，告訴 App（切到背景時決定要不要繼續播） ----------
  function reportPlayback(e) {
    const v = e.target;
    if (!v || v.tagName !== "VIDEO") return;
    const p = player();
    if (p && !p.contains(v)) return; // 首頁縮圖的預覽影片不算
    if (window.__fsTransport) window.__fsTransport.post({ op: "playbackState", playing: !v.paused && !v.ended });
  }
  for (const type of ["play", "playing", "pause", "ended"]) document.addEventListener(type, reportPlayback, true);

  // ---------- 3. 我們的介面上的觸控，不讓 YouTube 的播放器收到 ----------
  for (const type of ["touchstart", "touchmove", "touchend", "pointerdown", "pointerup"]) {
    document.addEventListener(
      type,
      (e) => {
        const t = e.target;
        if (t && t.closest && t.closest(OUR_UI)) e.stopPropagation();
      },
      { capture: true, passive: true }
    );
  }

  // ---------- 4. 點影片畫面任何地方 = 播放／暫停 ----------
  //
  // 手機版 YouTube 點一下畫面只會叫出控制列，要再按正中央的播放鈕才會播。
  // 查完單字（影片被暫停）想繼續看，點畫面任何地方就好。
  // 連點兩下是 YouTube 的快轉／倒轉 10 秒，所以點一下之後先等一下，確定不是連點才切換。
  const DOUBLE_TAP_MS = 300;
  let tapStart = null;
  let pendingToggle = null;

  document.addEventListener(
    "touchstart",
    (e) => {
      const t = e.touches[0];
      tapStart = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY, at: Date.now(), target: e.target } : null;
    },
    { capture: true, passive: true }
  );

  document.addEventListener(
    "touchend",
    (e) => {
      const start = tapStart;
      tapStart = null;
      const t = e.changedTouches[0];
      if (!start || !t || Date.now() - start.at > 500 || Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) return;

      const target = start.target;
      if (!target || !target.closest) return;
      // 我們的介面、YouTube 的按鈕與進度條：照它們自己的行為
      if (target.closest(OUR_UI)) return;
      if (target.closest("button, a, input, [role='button'], [role='slider'], [role='switch'], [role='menuitem'], [role='option']")) return;
      if (document.getElementById("zerostudy-settings-panel")) return;

      const p = player();
      const video = mainVideo();
      if (!p || !video) return;
      const r = p.getBoundingClientRect();
      if (t.clientX < r.left || t.clientX > r.right || t.clientY < r.top || t.clientY > r.bottom) return;
      if (p.classList.contains("ad-showing")) return;

      if (pendingToggle) {
        // 連點兩下：交給 YouTube 快轉，這次不切換
        clearTimeout(pendingToggle);
        pendingToggle = null;
        return;
      }
      pendingToggle = setTimeout(() => {
        pendingToggle = null;
        if (video.paused) video.play().catch(() => {});
        else video.pause();
      }, DOUBLE_TAP_MS);
    },
    { capture: true, passive: true }
  );
})();
