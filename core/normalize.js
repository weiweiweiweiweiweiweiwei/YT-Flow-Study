// ============================================================================
// 單字正規化（唯一實作）
// ============================================================================
//
// 這個函式有兩個完全不同的使用場景，而且兩邊「必須」得到一模一樣的結果：
//
//   1. 資料層（ES module，背景 / 擴充功能頁面）——用來判斷單字是否重複。
//   2. content.js（傳統 script，跑在 youtube.com）——用來判斷畫面上這個字
//      是不是已經收藏過、要不要畫底線。
//
// content script 不能使用 ES module 的 import，所以不能直接共用一般的 ESM 檔案。
// 如果各寫一份，只要有一天其中一邊改了規則，就會出現「明明收藏過卻不畫底線」
// 這種很難查的 bug。
//
// 解法是沿用 sentence-timeline.js 已經在用的 UMD 寫法：同一個檔案既可以當
// 傳統 script 載入（掛在 globalThis 上），也可以被 ES module 匯入使用。
// ============================================================================

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api; // Node：測試用
  root.FlowStudyNormalize = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  "use strict";

  /**
   * 把單字轉成用於「比對是否為同一個字」的形式。
   *
   *   "Run"  "run"  " RUN "  "run."  →  "run"
   *
   * 注意這裡刻意「不」做詞形還原（run / running / ran 不會合併）：
   * 那需要語言學詞庫，而且對學習者來說 running 跟 run 本來就值得分開記。
   *
   * 顯示時一律使用使用者當初選取的原始文字，這個正規化結果只用於比對與搜尋。
   */
  function normalizeTerm(term) {
    return String(term == null ? "" : term)
      .normalize("NFC") // 統一 Unicode 組合字，避免看起來一樣但位元組不同
      .toLowerCase()
      .replace(/[‘’]/g, "'") // 彎引號統一成直引號
      .replace(/[“”]/g, '"')
      .replace(/^[^\p{L}\p{N}]+/u, "") // 去掉開頭的標點
      .replace(/[^\p{L}\p{N}'’-]+$/u, "") // 去掉結尾標點，但保留字中的 ' 和 -（don't、well-known）
      .replace(/\s+/g, " ")
      .trim();
  }

  return { normalizeTerm };
});
