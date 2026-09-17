const DEFAULT_SIZE = 100;

function render(activeSize) {
  document.querySelectorAll(".size-btn").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.size) === activeSize);
  });
}

chrome.storage.local.get("boxScale", ({ boxScale }) => {
  render(boxScale || DEFAULT_SIZE);
});

document.querySelectorAll(".size-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const size = Number(btn.dataset.size);
    chrome.storage.local.set({ boxScale: size }, () => {
      render(size);
    });
  });
});

document.getElementById("openReviewBtn").addEventListener("click", () => {
  // 直接開「學習中單字」清單，而不是目標儀表板首頁——這顆按鈕原本的目的
  // 就是讓使用者能隨時看到已經標記收藏的單字，開儀表板會讓人以為雙擊收藏沒有生效。
  chrome.tabs.create({ url: chrome.runtime.getURL("review.html?view=words") });
});
