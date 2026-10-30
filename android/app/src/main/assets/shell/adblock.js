// ============================================================================
// 擋廣告的第二層：影片廣告與頁面上的廣告欄位（document start，比 YouTube 自己的程式還早）
// ============================================================================
//
// YouTube 的影片廣告是寫在「播放器資料」裡的：每部影片的資料有 adPlacements / playerAds / adSlots
// 這幾個欄位，播放器照著它們插廣告。這裡在資料交給播放器之前就把這幾個欄位刪掉，
// 播放器就不知道有廣告要播。資料的來源有三個，三個都攔：
//   1. 網頁一打開就內嵌的 ytInitialPlayerResponse
//   2. 換影片時用 fetch 抓的 /youtubei/v1/player（回應是 JSON）
//   3. 其他經過 JSON.parse 的地方
//
// 萬一還是有廣告漏網（YouTube 改了格式），最後一道防線是：偵測到正在播廣告就靜音、
// 直接跳到廣告結尾、按「略過」。
//
// 頁面上的廣告卡片（首頁、搜尋結果、影片下方）用 CSS 藏起來。
// ============================================================================
(function () {
  if (window.top !== window || window.__flowstudyAdblock) return;
  Object.defineProperty(window, "__flowstudyAdblock", { value: true });

  const AD_KEYS = ["adPlacements", "adSlots", "playerAds", "adBreakHeartbeatParams"];
  const AD_KEY_PATTERN = /"(adPlacements|adSlots|playerAds)"/;

  function prune(obj, depth) {
    depth = depth || 0;
    if (!obj || typeof obj !== "object" || depth > 4) return obj;
    if (Array.isArray(obj)) {
      for (const item of obj) prune(item, depth + 1);
      return obj;
    }
    for (const key of AD_KEYS) if (key in obj) delete obj[key];
    if (obj.playerResponse) prune(obj.playerResponse, depth + 1);
    if (obj.response) prune(obj.response, depth + 1);
    return obj;
  }

  // 1. 內嵌的播放器資料：搶先定義成 getter/setter，YouTube 一指定就被清掉
  try {
    let initial;
    Object.defineProperty(window, "ytInitialPlayerResponse", {
      configurable: true,
      get: () => initial,
      set: (value) => {
        initial = prune(value);
      },
    });
  } catch (e) {}

  // 2 & 3. JSON.parse 與 Response.json()
  const nativeParse = JSON.parse;
  JSON.parse = function (text, reviver) {
    const result = nativeParse.call(this, text, reviver);
    try {
      if (typeof text === "string" && AD_KEY_PATTERN.test(text)) prune(result);
    } catch (e) {}
    return result;
  };

  const nativeJson = Response.prototype.json;
  Response.prototype.json = function () {
    return nativeJson.call(this).then((data) => {
      try {
        const url = this.url || "";
        if (url.includes("/youtubei/") || url.includes("/player")) prune(data);
      } catch (e) {}
      return data;
    });
  };

  // ---------- 頁面上的廣告欄位 ----------
  const css = `
    ytm-promoted-sparkles-web-renderer, ytm-promoted-video-renderer, ytm-promoted-sparkles-text-search-renderer,
    ytm-companion-ad-renderer, ytm-companion-slot, ytm-ad-slot-renderer, ad-slot-renderer,
    ytm-display-ad-renderer, ytm-in-feed-ad-layout-renderer, ytm-banner-promo-renderer,
    ytm-statement-banner-renderer, ytm-mealbar-promo-renderer, ytm-paid-content-overlay-renderer,
    ytm-rich-item-renderer:has(ad-slot-renderer), ytm-rich-item-renderer:has(ytm-ad-slot-renderer),
    ytm-item-section-renderer:has(> lazy-list > ad-slot-renderer),
    .ytp-ad-overlay-container, .ytp-ad-image-overlay, .ytp-ad-text-overlay,
    #player-ads, #masthead-ad, ytd-ad-slot-renderer, ytd-promoted-sparkles-web-renderer
    { display: none !important; }
  `;
  function addStyle() {
    const style = document.createElement("style");
    style.id = "flowstudy-adblock-css";
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }
  if (document.documentElement) addStyle();
  else document.addEventListener("DOMContentLoaded", addStyle, { once: true });

  // ---------- 最後一道防線：漏網的影片廣告直接跳過 ----------
  const SKIP_BUTTONS = ".ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button-slot button, button.ytp-ad-skip-button-container";
  let skippingVideo = null;

  setInterval(() => {
    const player = document.getElementById("movie_player") || document.querySelector(".html5-video-player");
    if (!player) return;
    const video = player.querySelector("video");
    const adShowing = player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting");

    if (adShowing && video) {
      if (skippingVideo !== video) {
        skippingVideo = video;
        video.muted = true;
      }
      if (Number.isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.1) {
        video.currentTime = video.duration;
      }
      const skip = player.querySelector(SKIP_BUTTONS);
      if (skip) skip.click();
    } else if (skippingVideo) {
      // 廣告結束：把聲音還回來
      skippingVideo.muted = false;
      skippingVideo = null;
    }
  }, 250);
})();
