// ============================================================================
// 工具列小面板
// ============================================================================
// 只有兩件事：顯示今天沉浸了幾分鐘，以及開啟首頁。
//
// 沉浸時數存在擴充功能自己的 IndexedDB 裡，這個面板雖然也跑在
// chrome-extension:// 底下、理論上碰得到，但仍然走背景的訊息介面——
// 讀取邏輯（哪些 session 算今天、時區怎麼算）只有一份，不會兩邊各寫一套。
// ============================================================================

function showMinutes(seconds) {
  const el = document.getElementById("todayNum");
  el.textContent = String(Math.floor((seconds || 0) / 60));
  document.getElementById("today").classList.remove("is-loading");
}

try {
  chrome.runtime.sendMessage({ type: "immersion:today" }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) {
      // 背景還沒醒或讀取失敗時顯示 0，而不是一直卡在「—」讓人以為當掉了
      showMinutes(0);
      return;
    }
    showMinutes(res.data);
  });
} catch (e) {
  showMinutes(0);
}

document.getElementById("openHomeBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("review.html") });
});
