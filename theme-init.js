// 在畫面畫出來之前先套用主題，避免「先白一下再變深色」的閃爍。
// localStorage 是同步的，chrome.storage.local 是非同步的，所以先用
// localStorage 做第一時間的判斷，後面 review.js 再用 chrome.storage.local
// 校正（例如你在另一個分頁改了設定）。
//
// 這段特意拆成獨立檔案、用 <script src> 載入，而不是寫成 <head> 裡的內嵌
// <script> 區塊：Manifest V3 的擴充功能頁面預設 CSP 會直接擋掉內嵌 script。
(function () {
  try {
    var theme = localStorage.getItem("themePreference") || "light";
    document.documentElement.setAttribute("data-theme", theme);
  } catch (e) {}
})();
