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
//      圖層裡放一個同名的容器，content.js 會自己把按鈕放進來。
//   3. 手指在我們的字幕條、翻譯框、按鈕上時，不讓 YouTube 收到，免得點單字時影片跟著快轉。
//   4. 設定裡的「隱藏推薦影片」是給桌面版用的，藏起來；最下面加一個「同步到電腦」。
//   5. 不需要的東西藏起來：進度條、全螢幕下方的按讚／收藏那一排、「更多影片」，以及所有 Shorts。
// ============================================================================

(function () {
  const OUR_UI = "#flowstudy-player-layer, #my-translate-box, #zerostudy-settings-panel";
  // 手機版播放器的觸控層與控制列可能的名字（YouTube 會改，多列幾個）
  const OVERLAY = "ytm-custom-control, #player-control-container, .player-controls-content, .player-control-overlay, .ytm-autonav-bar";

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

    /* 按鈕容器：YouTube 自己對 .ytp-right-controls 的樣式（撐滿高度、垂直置中…）全部蓋掉 */
    #flowstudy-player-layer > .flowstudy-mobile-controls.ytp-right-controls {
      position: absolute !important;
      top: 6px !important;
      left: 6px !important;
      right: auto !important;
      bottom: auto !important;
      width: auto !important;
      height: auto !important;
      margin: 0 !important;
      padding: 0 !important;
      transform: none !important;
      display: flex !important;
      align-items: flex-start !important;
      float: none !important;
      opacity: 1 !important;
      visibility: visible !important;
    }
    .flowstudy-mobile-controls .zerostudy-player-controls { margin-right: 0; padding: 2px 8px 2px 2px; gap: 4px; background: rgba(0, 0, 0, 0.45); }
    .flowstudy-mobile-controls .zerostudy-immersion-btn { padding: 6px 10px; font-size: 13px !important; }
    .flowstudy-mobile-controls .zerostudy-settings-btn { width: 30px; height: 30px; }

    .fs-panel-row:has(#fsWideLayout) { display: none !important; }
    .fs-modal-card { max-height: calc(100vh - 32px); overflow-y: auto; }
    .flowstudy-sync-row button {
      border: 1px solid rgba(59, 130, 246, 0.6);
      background: transparent;
      color: rgb(59, 130, 246);
      border-radius: 8px;
      padding: 6px 12px;
      font: inherit;
      font-weight: 600;
    }

    /* 進度條 */
    ytm-progress-bar, .ytm-progress-bar, .ytp-progress-bar-container, .ytChapteredProgressBarHost,
    .ytProgressBarLineHost, .YtProgressBarLineHost, .ytm-chapter-progress-bar,
    [class*="ProgressBarHost"], [class*="progress-bar-line"] { display: none !important; }

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
    if (!p || !p.parentElement) return;
    // 桌面版播放器（自己有控制列）：content.js 照原本的方式運作，不需要圖層
    if (p.querySelector(".ytp-right-controls:not(.flowstudy-mobile-controls)")) return;

    let layer = document.getElementById("flowstudy-player-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.id = "flowstudy-player-layer";
      // 圖層上的點擊不要往上傳到播放器容器（content.js 的按鈕監聽是掛在按鈕本身，先執行，不受影響）
      layer.addEventListener("click", (e) => e.stopPropagation());
      const controls = document.createElement("div");
      controls.className = "ytp-right-controls flowstudy-mobile-controls";
      layer.appendChild(controls);
    }
    const parent = layerParent(p);
    if (layer.parentElement !== parent) parent.appendChild(layer);
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    positionLayer(layer, p, parent);
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

  // ---------- 4. 設定視窗 ----------
  function ensureSyncRow() {
    const panel = document.getElementById("zerostudy-settings-panel");
    if (!panel || panel.querySelector(".flowstudy-sync-row")) return;
    const done = panel.querySelector("#fsModalDone");
    if (!done) return;
    const row = document.createElement("div");
    row.className = "fs-panel-row flowstudy-sync-row";
    row.innerHTML =
      '<span><div class="fs-panel-label">同步到電腦</div>' +
      '<div class="fs-panel-sub">用 Google 帳號登入，單字和沉浸時數會跟電腦版共用</div></span>' +
      '<button type="button">設定</button>';
    row.querySelector("button").addEventListener("click", () => {
      if (window.__fsTransport) window.__fsTransport.call("openSync", {}).catch(() => {});
    });
    done.parentElement.insertBefore(row, done);
  }

  // 翻譯框在全螢幕時會掛進播放器裡面，點它不能被當成「點畫面」
  function guardTranslateBox() {
    const box = document.getElementById("my-translate-box");
    if (!box || box.__flowstudyGuarded) return;
    box.__flowstudyGuarded = true;
    box.addEventListener("click", (e) => e.stopPropagation());
  }

  // ---------- 5. 藏起來的東西（CSS 認不到的，照按鈕的名稱與文字找） ----------
  const ACTION_LABEL = /^(喜歡|不喜歡|分享|儲存|收藏)|^(like|dislike|share|save)\b/i;
  const MORE_VIDEOS = /^(更多影片|more videos)$/i;

  function hide(el) {
    if (el && !el.classList.contains("flowstudy-hidden")) el.classList.add("flowstudy-hidden");
  }

  function lowestCommonAncestor(nodes) {
    let anc = nodes[0];
    while (anc && !nodes.every((n) => anc.contains(n))) anc = anc.parentElement;
    return anc;
  }

  function declutterPlayer() {
    const scope = document.fullscreenElement || (player() && player().parentElement);
    if (!scope) return;
    const layer = document.getElementById("flowstudy-player-layer");

    // 全螢幕下方左側：按讚、不喜歡、分享、收藏 —— 找到這幾顆按鈕，藏起包住它們的那一排
    const actions = Array.from(scope.querySelectorAll("button, [role='button']")).filter((b) => {
      if (layer && layer.contains(b)) return false;
      const label = (b.getAttribute("aria-label") || b.getAttribute("title") || "").trim();
      return ACTION_LABEL.test(label);
    });
    if (actions.length >= 2) {
      const row = lowestCommonAncestor(actions);
      if (row && row !== scope && !row.contains(player())) hide(row);
    }

    // 全螢幕下方右側：「更多影片」
    scope.querySelectorAll("button, [role='button'], a, div, span").forEach((el) => {
      if (el.childElementCount > 3 || !MORE_VIDEOS.test((el.textContent || "").trim())) return;
      const target = el.closest("button, [role='button'], a") || el;
      if (!target.contains(player())) hide(target);
    });

    // 進度條：CSS 沒認到的話，找播放器範圍內的拖曳條
    scope.querySelectorAll("[role='slider']").forEach((s) => {
      if (layer && layer.contains(s)) return;
      const bar = s.closest("[class*='progress' i], [class*='Progress']") || s;
      if (!bar.contains(player())) hide(bar);
    });
  }

  // Shorts：任何連到 /shorts/ 的項目、底部選單的 Shorts 分頁
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

  let scheduled = false;
  function tick() {
    scheduled = false;
    ensureLayer();
    ensureSyncRow();
    guardTranslateBox();
    declutterPlayer();
    hideShorts();
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(tick);
  }
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", schedule);
  window.addEventListener("scroll", schedule, { passive: true });
  document.addEventListener("fullscreenchange", () => setTimeout(tick, 50));
  setInterval(tick, 500);
  tick();

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
})();
