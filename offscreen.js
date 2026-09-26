// service worker 沒有 URL.createObjectURL，這個看不見的頁面代為產生 blob: 網址，
// 背景再拿這個網址交給 chrome.downloads 寫成檔案。用完背景會直接把整個頁面關掉。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return;
  if (msg.type === "backup:makeUrl") {
    const blob = new Blob([msg.json], { type: "application/json" });
    sendResponse({ url: URL.createObjectURL(blob) });
  }
});
