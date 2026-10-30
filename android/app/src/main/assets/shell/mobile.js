// ============================================================================
// 手機版 YouTube（m.youtube.com）的轉接
// ============================================================================
//
// content.js 是照桌面版 YouTube 寫的。手機版的播放器（#movie_player）是同一套，
// 字幕抓取、自繪字幕條、查字都照常運作；不一樣的只有播放器周圍：
//
//   1. 桌面版把「沉浸模式」膠囊和齒輪塞進播放器控制列（.ytp-right-controls），手機版沒有這一列。
//      沒有它，沉浸模式就開不了、自繪字幕條永遠不會出現。所以這裡在播放器左上角補一個
//      同名的容器，content.js 會自己把按鈕放進來。
//   2. 手機版播放器自己也在聽觸控（點一下顯示控制列、連點兩下快轉 10 秒）。
//      手指在我們的字幕條、翻譯框、按鈕上時，不讓 YouTube 收到，免得點單字時影片跟著快轉。
//   3. 設定裡的「隱藏推薦影片」是給桌面版的寬螢幕用的，手機版用不到，藏起來。
//   4. 設定最下面加一個「同步到電腦」，打開 Google 登入與同步的設定頁。
// ============================================================================

(function () {
  const OUR_UI = "#flowstudy-caption-bar, #my-translate-box, .flowstudy-mobile-controls, #zerostudy-settings-panel";

  const style = document.createElement("style");
  style.id = "flowstudy-mobile-css";
  style.textContent = `
    .flowstudy-mobile-controls {
      position: absolute;
      top: 8px;
      left: 8px;
      z-index: 60;
      display: flex;
      align-items: center;
      pointer-events: auto;
    }
    .flowstudy-mobile-controls .zerostudy-player-controls { margin-right: 0; padding: 2px 8px 2px 2px; gap: 4px; background: rgba(0, 0, 0, 0.35); }
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
  `;
  (document.head || document.documentElement).appendChild(style);

  function player() {
    return document.getElementById("movie_player") || document.querySelector(".html5-video-player");
  }

  // ---------- 1. 給 content.js 放按鈕的容器 ----------
  function ensureControlsHost() {
    const p = player();
    if (!p) return;
    if (p.querySelector(".ytp-right-controls")) return; // 桌面版播放器：用原本那一列
    const host = document.createElement("div");
    host.className = "ytp-right-controls flowstudy-mobile-controls";
    host.addEventListener("click", (e) => e.stopPropagation()); // 不要讓 YouTube 當成「點畫面」
    p.appendChild(host);
  }

  // ---------- 4. 設定視窗裡的「同步到電腦」 ----------
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

  function tick() {
    ensureControlsHost();
    ensureSyncRow();
    guardTranslateBox();
  }
  new MutationObserver(tick).observe(document.body, { childList: true, subtree: true });
  setInterval(tick, 1000);
  tick();

  // ---------- 2. 我們的介面上的觸控，不讓 YouTube 的播放器收到 ----------
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
