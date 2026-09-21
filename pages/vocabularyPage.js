// ============================================================================
// 詞彙庫
// ============================================================================
// 定位：這裡放的是「有點印象但還沒真正背起來」的單字，是拿來反覆複習的地方，
// 不是一份「我學過的字」的清單。所以：
//   - 卡片網格（一排三個、可一直往下滑）讓人一眼掃過很多字，適合快速自我測驗
//   - 點進去才看完整釋義：先想想看，想不出來再翻答案
//   - 「學會了」＝ 直接從詞彙庫移除。真的記住的字不需要再佔位置。
//   - 「再複習」＝ 留著，並記一次複習次數
//
// 刻意沒有做「已學會」這個狀態。多一個狀態就要多一個地方去管理它，
// 而使用者要的是「詞彙庫愈用愈少」的成就感，不是另一份清單。
// ============================================================================

import { getAllWords, deleteWord, updateWord } from "../core/storage/vocabularyStore.js";

const PAGE_SIZE = 30; // 一次先畫 30 張，捲到底再補下一批

let allWords = [];
let visibleCount = PAGE_SIZE;
let searchTerm = "";
let container = null;
let scrollSentinel = null;
let observer = null;

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Google 的例句會用 <b> 標出目標單字，轉成我們自己的樣式
function renderExample(text) {
  return escapeHtml(text)
    .replace(/&lt;b&gt;/g, '<mark class="vocab-mark">')
    .replace(/&lt;\/b&gt;/g, "</mark>");
}

export async function renderVocabularyPage(root) {
  container = root;
  visibleCount = PAGE_SIZE;
  root.innerHTML = `<div class="card empty-hint">載入中…</div>`;

  try {
    const words = await getAllWords();
    // 新收藏的排前面——剛遇到的字最需要趁印象還在時複習
    allWords = words.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    renderGrid();
  } catch (err) {
    console.error("[FlowStudy] 詞彙庫載入失敗：", err);
    root.innerHTML = `<div class="card empty-hint">詞彙資料讀取失敗：${escapeHtml(err.message || err)}</div>`;
  }
}

function filtered() {
  const q = searchTerm.trim().toLowerCase();
  if (!q) return allWords;
  return allWords.filter(
    (w) =>
      (w.term || "").toLowerCase().includes(q) ||
      (w.normalizedTerm || "").includes(q) ||
      (w.translation || "").toLowerCase().includes(q)
  );
}

function renderGrid() {
  if (!container) return;
  const items = filtered();
  const shown = items.slice(0, visibleCount);

  const toolbar = `
    <div class="vocab-toolbar">
      <div class="vocab-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <input type="search" id="vocabSearch" placeholder="搜尋單詞…" value="${escapeHtml(searchTerm)}" />
      </div>
      <span class="vocab-count-chip">待複習 ${allWords.length}</span>
    </div>`;

  let body;
  if (!allWords.length) {
    body = `<div class="card empty-hint">
      詞彙庫是空的。<br />去 YouTube 看影片，點字幕上的單字再雙擊翻譯框就能收進來。
    </div>`;
  } else if (!items.length) {
    body = `<div class="card empty-hint">找不到符合「${escapeHtml(searchTerm)}」的單字。</div>`;
  } else {
    body = `<div class="vocab-grid">${shown.map(renderCard).join("")}</div>
      ${items.length > shown.length ? `<div class="vocab-sentinel" id="vocabSentinel">載入更多…</div>` : ""}`;
  }

  container.innerHTML = toolbar + body;

  const input = container.querySelector("#vocabSearch");
  input.addEventListener("input", () => {
    searchTerm = input.value;
    visibleCount = PAGE_SIZE;
    const caret = input.selectionStart;
    renderGrid();
    // 重繪後把焦點與游標放回搜尋框，否則每打一個字焦點就跑掉
    const next = container.querySelector("#vocabSearch");
    next.focus();
    next.setSelectionRange(caret, caret);
  });

  container.querySelectorAll("[data-word-id]").forEach((card) => {
    card.addEventListener("click", () => openDetail(card.dataset.wordId));
  });

  setupInfiniteScroll();
}

function renderCard(word) {
  return `
  <button class="vocab-card" type="button" data-word-id="${escapeHtml(word.id)}">
    <span class="vocab-card-term">${escapeHtml(word.term)}</span>
    ${word.translation ? `<span class="vocab-card-hint">${escapeHtml(word.translation)}</span>` : ""}
  </button>`;
}

// 捲到底自動補下一批。用 IntersectionObserver 而不是監聽 scroll 事件，
// 瀏覽器只在哨兵真的進入畫面時才通知我們，不用每次捲動都做計算。
function setupInfiniteScroll() {
  if (observer) observer.disconnect();
  scrollSentinel = container.querySelector("#vocabSentinel");
  if (!scrollSentinel) return;

  observer = new IntersectionObserver(
    (entries) => {
      if (!entries[0].isIntersecting) return;
      visibleCount += PAGE_SIZE;
      renderGrid();
    },
    { rootMargin: "240px" } // 提早一點載入，捲到底時不會看到空白
  );
  observer.observe(scrollSentinel);
}

// ---------- 單字詳細頁 ----------

async function openDetail(wordId) {
  const word = allWords.find((w) => w.id === wordId);
  if (!word) return;

  const backdrop = document.createElement("div");
  backdrop.className = "vocab-modal-backdrop";
  backdrop.innerHTML = `
    <div class="vocab-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(word.term)}">
      <button class="vocab-modal-close" type="button" aria-label="關閉">×</button>

      <div class="vocab-modal-head">
        <span class="vocab-modal-term">${escapeHtml(word.term)}</span>
        <button class="vocab-speak" type="button" aria-label="播放發音">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.384 3.383A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/></svg>
        </button>
      </div>

      <div class="vocab-modal-body" id="vocabModalBody">
        <div class="vocab-detail-loading">查詢釋義中…</div>
      </div>

      <div class="vocab-modal-actions">
        <button class="vocab-action vocab-again" type="button">再複習</button>
        <button class="vocab-action vocab-known" type="button">學會了</button>
      </div>
    </div>`;

  document.body.appendChild(backdrop);

  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onEsc, true);
  };
  const onEsc = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onEsc, true);

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector(".vocab-modal-close").addEventListener("click", close);
  backdrop.querySelector(".vocab-speak").addEventListener("click", () => speak(word.term));

  // 「再複習」：留在詞彙庫裡，只記一次複習次數
  backdrop.querySelector(".vocab-again").addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    try {
      await updateWord(word.id, { reviewCount: (word.reviewCount || 0) + 1 });
      word.reviewCount = (word.reviewCount || 0) + 1;
    } catch (err) {
      console.error("[FlowStudy] 更新複習次數失敗：", err);
    }
    close();
  });

  // 「學會了」：直接從詞彙庫移除。詞彙庫愈用愈少才有成就感。
  backdrop.querySelector(".vocab-known").addEventListener("click", async (e) => {
    e.currentTarget.disabled = true; // 連點不要送出兩次刪除
    try {
      await deleteWord(word.id);
      chrome.runtime.sendMessage({ type: "vocab:syncIndex" }, () => void chrome.runtime.lastError);
      allWords = allWords.filter((w) => w.id !== word.id);
      close();
      renderGrid();
    } catch (err) {
      e.currentTarget.disabled = false;
      console.error("[FlowStudy] 移除單字失敗：", err);
    }
  });

  renderDetailBody(backdrop.querySelector("#vocabModalBody"), word);
}

async function renderDetailBody(body, word) {
  let dict = null;
  try {
    dict = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "dict:lookup", payload: { term: word.term } }, (res) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(res && res.ok ? res.data : null);
      });
    });
  } catch (e) {
    dict = null;
  }

  if (!body.isConnected) return; // 使用者已經把視窗關掉了

  const entries = (dict && dict.entries) || [];
  if (!entries.length) {
    // 查不到完整釋義時，至少把收藏當下存的翻譯顯示出來，不要開出一個空視窗
    body.innerHTML = word.translation
      ? `<div class="vocab-entry"><div class="vocab-entry-meaning">${escapeHtml(word.translation)}</div></div>
         <div class="vocab-detail-loading">找不到更詳細的釋義。</div>`
      : `<div class="vocab-detail-loading">查不到這個字的釋義。</div>`;
    return;
  }

  body.innerHTML = entries
    .map((entry) => {
      const meaning = entry.meanings.length
        ? entry.meanings.join("；")
        : entry.examples[0] && entry.examples[0].definitionZh
          ? entry.examples[0].definitionZh
          : "";

      const examples = entry.examples
        .filter((ex) => ex.example)
        .map(
          (ex) => `<div class="vocab-example">
            <div class="vocab-example-en">${renderExample(ex.example)}</div>
            ${ex.exampleZh ? `<div class="vocab-example-zh">${escapeHtml(ex.exampleZh)}</div>` : ""}
          </div>`
        )
        .join("");

      return `<div class="vocab-entry">
        <div class="vocab-entry-head">
          <span class="vocab-pos">${escapeHtml(entry.badge || entry.pos)}</span>
          <span class="vocab-entry-meaning">${escapeHtml(meaning)}</span>
        </div>
        ${examples}
      </div>`;
    })
    .join("");
}

function speak(text) {
  try {
    chrome.runtime.sendMessage({ type: "speak", text }, (result) => {
      if (chrome.runtime.lastError) return;
      if (result && result.audioDataUrl) new Audio(result.audioDataUrl).play().catch(() => {});
    });
  } catch (e) {
    /* 發音失敗不影響複習 */
  }
}
