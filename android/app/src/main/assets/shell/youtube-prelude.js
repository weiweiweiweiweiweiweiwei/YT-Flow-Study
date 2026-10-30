// ============================================================================
// YouTube 頁面最先執行的一段（document start，比 YouTube 自己的程式還早）
// ============================================================================
//
// 擴充功能的 content.js 原本跑在 Chrome 的「隔離世界」，不受 YouTube 的 Trusted Types
// 限制，可以直接寫 innerHTML。App 裡沒有隔離世界，所有注入的程式都跟 YouTube 在同一個世界，
// YouTube 的 CSP（require-trusted-types-for 'script'）會讓每一個 innerHTML 都丟例外。
//
// 解法：搶在 YouTube 之前建立一個 "default" 政策，讓沒有指定政策的字串照常通過。
// YouTube 自己都用具名的政策，不受影響。
// ============================================================================
(function () {
  if (window.top !== window) return;
  try {
    if (window.trustedTypes && trustedTypes.createPolicy && !trustedTypes.defaultPolicy) {
      trustedTypes.createPolicy("default", {
        createHTML: (s) => s,
        createScript: (s) => s,
        createScriptURL: (s) => s,
      });
    }
  } catch (e) {
    console.warn("[FlowStudy] 無法建立 Trusted Types 預設政策：", e);
  }
})();

// ============================================================================
// 背景播放：App 切到背景或關掉螢幕時，YouTube 會看 document.hidden / visibilitychange
// 把影片停下來。這裡讓頁面永遠回報「看得見」，影片就會繼續播（聲音照常出來）。
// App 端另外開一個前景服務（PlaybackService），系統才不會把背景的 App 凍結。
// ============================================================================
(function () {
  if (window.top !== window) return;
  try {
    Object.defineProperty(Document.prototype, "hidden", { configurable: true, get: () => false });
    Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get: () => "visible" });
    Object.defineProperty(Document.prototype, "webkitHidden", { configurable: true, get: () => false });
    Object.defineProperty(Document.prototype, "webkitVisibilityState", { configurable: true, get: () => "visible" });
  } catch (e) {}
  const swallow = (e) => e.stopImmediatePropagation();
  for (const type of ["visibilitychange", "webkitvisibilitychange", "freeze"]) {
    window.addEventListener(type, swallow, true);
    document.addEventListener(type, swallow, true);
  }
})();
