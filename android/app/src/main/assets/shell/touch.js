// ============================================================================
// 觸控轉接：把手指的操作翻譯成 content.js 本來就看得懂的滑鼠事件
// ============================================================================
//
// content.js 是為滑鼠寫的，這支檔案不改它，只在旁邊補上觸控版的手勢：
//
//   手指在字幕上「滑過幾個字」 → 選取那幾個字，放開時送一個 mouseup
//                                （content.js 的片語查詢就是在 mouseup 時做的）
//   碰到字幕                   → 送一個 mousemove，觸發「滑到字幕上自動暫停」
//   連點兩下翻譯框             → 送 dblclick（收藏）。手機上連點兩下通常會被當成「放大畫面」
//   按住把手拖曳               → 送 mousedown / mousemove / mouseup，移動字幕位置
//   長按字幕                   → 擋掉系統的選字選單，免得跟上面的滑動選字打架
//
// 點一下單字本來就會有 click，不用另外處理。
// ============================================================================

(function () {
  const BAR = "#flowstudy-caption-bar";
  const WORD = BAR + " .my-word";
  const DOUBLE_TAP_TARGETS = "#my-translate-box, .flowstudy-caption-grip";
  const MOVE_THRESHOLD = 8; // 手指移動超過這個距離（px）才算滑動，不算點一下
  const DOUBLE_TAP_MS = 350;

  const style = document.createElement("style");
  style.textContent = `
    ${BAR} .flowstudy-caption-text,
    ${BAR} .flowstudy-caption-grip { touch-action: none; -webkit-touch-callout: none; }
    #my-translate-box { touch-action: manipulation; }
    ${BAR} .flowstudy-caption-grip { padding: 6px 10px; }
  `;
  (document.head || document.documentElement).appendChild(style);

  function mouse(type, target, point, extra) {
    target.dispatchEvent(
      new MouseEvent(type, Object.assign({
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: point.clientX,
        clientY: point.clientY,
        screenX: point.screenX,
        screenY: point.screenY,
        button: 0,
        buttons: type === "mouseup" ? 0 : 1,
      }, extra || {}))
    );
  }

  // ---------- 滑動選字 ----------
  let drag = null;

  function selectWords(a, b) {
    const forward = a === b || !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const first = forward ? a : b;
    const last = forward ? b : a;
    const range = document.createRange();
    range.setStart(first.firstChild || first, 0);
    range.setEnd(last.firstChild || last, (last.textContent || "").length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ---------- 拖曳把手 ----------
  let gripDrag = false;

  document.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const target = e.target;
      if (!target || !target.closest) return;

      const grip = target.closest(BAR + " .flowstudy-caption-grip");
      if (grip) {
        gripDrag = true;
        mouse("mousedown", grip, t);
        return;
      }

      const word = target.closest(WORD);
      if (word) {
        drag = { start: word, end: null, x: t.clientX, y: t.clientY, moved: false };
      }
      // 碰到字幕就等於「滑鼠移到字幕上」：讓自動暫停照常運作
      if (target.closest(BAR)) mouse("mousemove", target, t, { buttons: 0 });
    },
    { capture: true, passive: true }
  );

  document.addEventListener(
    "touchmove",
    (e) => {
      const t = e.touches[0];
      if (!t) return;

      if (gripDrag) {
        e.preventDefault();
        mouse("mousemove", document.documentElement, t);
        return;
      }
      if (!drag) return;
      if (!drag.moved && Math.hypot(t.clientX - drag.x, t.clientY - drag.y) < MOVE_THRESHOLD) return;
      drag.moved = true;
      e.preventDefault(); // 不要捲動頁面

      const el = document.elementFromPoint(t.clientX, t.clientY);
      const word = el && el.closest && el.closest(WORD);
      const bar = drag.start.closest(BAR);
      if (word && bar && bar.contains(word)) {
        drag.end = word;
        selectWords(drag.start, word);
      }
    },
    { capture: true, passive: false }
  );

  function endTouch(e) {
    const t = e.changedTouches[0];

    if (gripDrag) {
      gripDrag = false;
      e.preventDefault(); // 不要再補送一次點擊
      mouse("mouseup", document.documentElement, t || { clientX: 0, clientY: 0 });
      return;
    }

    const d = drag;
    drag = null;
    if (!d || !d.moved) return;
    e.preventDefault();
    if (!d.end || e.type === "touchcancel") return;
    // content.js 在 mouseup 時把選取範圍對齊成完整單字，再查整段片語
    mouse("mouseup", d.end, t);
  }
  document.addEventListener("touchend", endTouch, { capture: true, passive: false });
  document.addEventListener("touchcancel", endTouch, { capture: true, passive: false });

  // 長按字幕：系統會選字並跳出「複製／分享」選單。我們用滑動選字，不需要它
  document.addEventListener(
    "contextmenu",
    (e) => {
      if (e.target && e.target.closest && e.target.closest(BAR)) e.preventDefault();
    },
    true
  );

  // ---------- 連點兩下 ----------
  let lastTap = null;
  let syntheticDblAt = 0;

  document.addEventListener(
    "touchend",
    (e) => {
      if (e.changedTouches.length !== 1) return;
      const t = e.changedTouches[0];
      const target = e.target && e.target.closest && e.target.closest(DOUBLE_TAP_TARGETS);
      if (!target) {
        lastTap = null;
        return;
      }
      const now = Date.now();
      if (
        lastTap &&
        lastTap.target === target &&
        now - lastTap.at < DOUBLE_TAP_MS &&
        Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 30
      ) {
        lastTap = null;
        e.preventDefault(); // 擋掉「連點放大」
        syntheticDblAt = now;
        mouse("dblclick", e.target, t, { detail: 2, buttons: 0 });
        return;
      }
      lastTap = { target, at: now, x: t.clientX, y: t.clientY };
    },
    { capture: true, passive: false }
  );

  // 有些裝置自己也會送出 dblclick；我們剛送過一次，就把系統那一次吃掉，免得收藏兩次
  document.addEventListener(
    "dblclick",
    (e) => {
      if (e.isTrusted && Date.now() - syntheticDblAt < 600) e.stopImmediatePropagation();
    },
    true
  );
})();
