// ============================================================================
// 記憶強化頁（間隔重複複習）
// ============================================================================
//
// 這一頁只負責「顯示卡片」與「把使用者按的 Again / Good 送出去」。
// 它不含任何排程公式——什麼時候該再出現、單字算不算熟，全部由 core/srs 決定；
// 保留率也是呼叫 core/analytics 的 calculateRetentionRate()，跟分析頁用的同一個函式。
//
// 幾個刻意的設計：
//   - 每次評分「立刻寫入資料庫」。中途重新整理頁面，已經複習過的卡片不會跑回來重做。
//   - 每張卡片顯示前都重新讀一次資料庫確認它還在（使用者可能在另一個分頁刪掉了它）。
//   - 送出期間按鈕鎖住，連點不會讓同一張卡被評分兩次。
//   - 資料只在進頁面時載入一次，之後在記憶體裡增量更新。
//     render() 完全不碰資料庫，所以每翻一張卡都不會重掃幾千筆事件。
// ============================================================================

import { getDueQueue, takeNextCard } from "../core/srs/dueQueue.js";
import { submitReview, countReviewsToday, getAllReviewEvents } from "../core/storage/reviewStore.js";
import { getOccurrencesForWord } from "../core/storage/occurrenceStore.js";
import { getStateCounts } from "../core/storage/vocabularyStore.js";
import { calculateRetentionRate } from "../core/analytics/analytics.js";
import { previewSchedule, formatDueIn } from "../core/srs/scheduler.js";
import { getSettings, saveSettings } from "../core/storage/settingsStore.js";
import { VOCAB_STATE, REVIEW_RATING } from "../core/models.js";

const STATE_LABELS = {
  [VOCAB_STATE.NEW]: "新單字",
  [VOCAB_STATE.LEARNING]: "學習中",
  [VOCAB_STATE.MATURE]: "已熟悉",
};

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTimestamp(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// 把句子裡的目標單字標出來，讓使用者看到它在上下文中的位置。
// 用逐字比對而不是正規表達式：收藏的可能是含特殊字元的片語（例如 "don't (yet)"），
// 直接塞進 RegExp 會壞掉。
function highlightTermInSentence(sentence, term) {
  if (!sentence) return "";
  if (!term) return escapeHtml(sentence);

  const index = sentence.toLowerCase().indexOf(term.toLowerCase());
  if (index === -1) return escapeHtml(sentence);

  return (
    escapeHtml(sentence.slice(0, index)) +
    '<mark class="reinforce-highlight">' +
    escapeHtml(sentence.slice(index, index + term.length)) +
    "</mark>" +
    escapeHtml(sentence.slice(index + term.length))
  );
}

// ---------- 頁面狀態（只在進頁面時載入一次，之後增量更新）----------
let container = null;
let queue = [];
let currentWord = null;
let currentOccurrences = [];
let revealed = false;
let submitting = false;
let activeRecall = true;
let completedToday = 0;
let reviewedInSession = 0;
let stateCounts = { total: 0, new: 0, learning: 0, mature: 0, dueNow: 0 };
// 完整的複習事件保存在記憶體裡，評分後直接 push 新事件。
// 這樣保留率永遠用同一個 calculateRetentionRate() 算，又不必每張卡都重讀資料庫。
let reviewEvents = [];

export async function renderReinforcePage(root) {
  container = root;
  root.innerHTML = `<div class="card empty-hint">載入中…</div>`;

  try {
    const settings = await getSettings();
    activeRecall = settings.activeRecallDefault !== false;
    revealed = !activeRecall;

    const [dueCards, todayCount, counts, events] = await Promise.all([
      getDueQueue({ limit: 100 }),
      countReviewsToday(),
      getStateCounts(),
      getAllReviewEvents(),
    ]);

    queue = dueCards;
    completedToday = todayCount;
    reviewedInSession = 0;
    stateCounts = counts;
    reviewEvents = events;

    await loadCurrentCard();
    renderAll();
  } catch (err) {
    console.error("[FlowStudy] 記憶強化頁載入失敗：", err);
    root.innerHTML = `<div class="card empty-hint">學習資料讀取失敗：${escapeHtml(
      err.message || err
    )}</div>`;
  }
}

// 從佇列前端取出下一張「確實還存在」的卡片
async function loadCurrentCard() {
  revealed = !activeRecall;
  const next = await takeNextCard(queue);
  queue = next.queue;
  currentWord = next.word;
  currentOccurrences = currentWord ? await getOccurrencesForWord(currentWord.id) : [];
}

// ---------- 繪製（純 DOM，不碰資料庫）----------

function renderAll() {
  if (!container) return;
  const retention = calculateRetentionRate(reviewEvents);

  container.innerHTML = `
    <div class="cards-row reinforce-stats">
      <div class="card stat-card">
        <div class="card-label">目前到期</div>
        <div class="stat-value">${stateCounts.dueNow}</div>
      </div>
      <div class="card stat-card">
        <div class="card-label">今日已複習</div>
        <div class="stat-value">${completedToday}</div>
      </div>
      <div class="card stat-card">
        <div class="card-label">記憶保留率</div>
        <div class="stat-value">${
          retention.rate === null ? "—" : Math.round(retention.rate * 100) + "%"
        }</div>
        <div class="stat-sub">${
          retention.rate === null
            ? "還沒有複習紀錄"
            : `${retention.successful} / ${retention.total} 次答對`
        }</div>
      </div>
      <div class="card stat-card">
        <div class="card-label">學習中 / 已熟悉</div>
        <div class="stat-value">${stateCounts.learning}<span class="stat-divider">/</span>${
    stateCounts.mature
  }</div>
        <div class="stat-sub">新單字 ${stateCounts.new} 個</div>
      </div>
    </div>

    <div class="reinforce-toolbar">
      <label class="switch-row">
        <input type="checkbox" id="activeRecallToggle" ${activeRecall ? "checked" : ""} />
        <span>主動回想</span>
      </label>
      <span class="settings-hint">開啟時先隱藏答案，讓自己先想過一遍再揭曉</span>
    </div>

    <div id="reinforceCardSlot"></div>`;

  container.querySelector("#activeRecallToggle").addEventListener("change", async (e) => {
    activeRecall = e.target.checked;
    if (!activeRecall) revealed = true; // 關閉主動回想就直接顯示答案
    renderCard();
    // 記成預設值，下次進來維持同樣模式
    try {
      await saveSettings({ activeRecallDefault: activeRecall });
    } catch (err) {
      console.warn("[FlowStudy] 主動回想設定儲存失敗：", err);
    }
  });

  renderCard();
}

function renderCard() {
  const slot = container && container.querySelector("#reinforceCardSlot");
  if (!slot) return;

  if (!currentWord) {
    slot.innerHTML = renderEmptyState();
    return;
  }

  // 分母用「已複習 + 還沒複習」而不是一開始的總數：
  // 答錯的卡片會被放回佇列再練一次，總數是會變動的。
  const remaining = queue.length;
  const total = reviewedInSession + remaining;
  const progressPct = total > 0 ? Math.round((reviewedInSession / total) * 100) : 0;
  const showAnswer = revealed || !activeRecall;
  const occurrence = currentOccurrences[0];

  slot.innerHTML = `
    <div class="card reinforce-card">
      <div class="reinforce-progress">
        <div class="progress-track"><div class="progress-fill" style="width:${progressPct}%"></div></div>
        <span class="reinforce-progress-label">${reviewedInSession} / ${total}</span>
      </div>

      <span class="word-status-tag reinforce-state">${escapeHtml(
        STATE_LABELS[currentWord.state] || currentWord.state
      )}</span>

      <div class="reinforce-term">${escapeHtml(currentWord.term)}</div>
      <button class="reinforce-speak" id="speakBtn" type="button">🔊 發音</button>

      ${showAnswer ? renderAnswer(occurrence) : renderHiddenAnswer()}
      ${showAnswer ? renderActions() : ""}
    </div>`;

  const revealBtn = slot.querySelector("#revealBtn");
  if (revealBtn) {
    revealBtn.addEventListener("click", () => {
      revealed = true;
      renderCard();
    });
  }
  const speakBtn = slot.querySelector("#speakBtn");
  if (speakBtn) speakBtn.addEventListener("click", () => speak(currentWord.term));

  const againBtn = slot.querySelector("#againBtn");
  if (againBtn) againBtn.addEventListener("click", () => handleRating(REVIEW_RATING.AGAIN));
  const goodBtn = slot.querySelector("#goodBtn");
  if (goodBtn) goodBtn.addEventListener("click", () => handleRating(REVIEW_RATING.GOOD));
}

function renderHiddenAnswer() {
  return `<div class="reinforce-hidden-answer">
    <button class="reinforce-reveal" id="revealBtn" type="button">顯示答案</button>
    <div class="settings-hint">先在心裡想一遍意思，再按下去對答案</div>
  </div>`;
}

function renderAnswer(occurrence) {
  const sourceHtml = occurrence
    ? `<div class="reinforce-source">
        ${
          occurrence.videoTitle
            ? `<span class="reinforce-source-title">${escapeHtml(occurrence.videoTitle)}</span>`
            : `<span class="reinforce-source-unknown">來源影片未知（舊資料）</span>`
        }
        ${
          occurrence.videoId
            ? `<a class="reinforce-jump" target="_blank" rel="noopener"
                  href="https://www.youtube.com/watch?v=${encodeURIComponent(
                    occurrence.videoId
                  )}&t=${Math.floor(occurrence.startTime)}s">▶ 跳到 ${formatTimestamp(
                occurrence.startTime
              )}</a>`
            : ""
        }
      </div>`
    : `<div class="reinforce-source"><span class="reinforce-source-unknown">沒有儲存原始句子</span></div>`;

  return `<div class="reinforce-answer">
    ${
      currentWord.translation
        ? `<div class="reinforce-translation">${escapeHtml(currentWord.translation)}</div>`
        : `<div class="reinforce-source-unknown">沒有儲存翻譯</div>`
    }
    ${
      currentWord.definition
        ? `<div class="reinforce-definition">${escapeHtml(currentWord.definition)}</div>`
        : ""
    }
    ${
      occurrence && occurrence.sentence
        ? `<blockquote class="reinforce-sentence">${highlightTermInSentence(
            occurrence.sentence,
            currentWord.term
          )}</blockquote>`
        : ""
    }
    ${sourceHtml}
    ${
      currentOccurrences.length > 1
        ? `<div class="settings-hint">這個字另外出現在 ${currentOccurrences.length - 1} 個地方</div>`
        : ""
    }
  </div>`;
}

// 按鈕上直接顯示「按下去之後下次什麼時候再出現」。
// previewSchedule 走的是跟實際評分同一個 schedule()，所以預覽跟結果一定一致。
function renderActions() {
  const againDue = formatDueIn(previewSchedule(currentWord, REVIEW_RATING.AGAIN).dueAt);
  const goodDue = formatDueIn(previewSchedule(currentWord, REVIEW_RATING.GOOD).dueAt);
  const disabled = submitting ? "disabled" : "";
  return `<div class="reinforce-actions">
    <button class="reinforce-btn reinforce-again" id="againBtn" type="button" ${disabled}>
      再一次<span class="reinforce-btn-sub">${againDue}</span>
    </button>
    <button class="reinforce-btn reinforce-good" id="goodBtn" type="button" ${disabled}>
      記得了<span class="reinforce-btn-sub">${goodDue}</span>
    </button>
  </div>`;
}

function renderEmptyState() {
  if (stateCounts.total === 0) {
    return `<div class="card empty-hint reinforce-empty">
      <div class="reinforce-empty-icon">📖</div>
      <div class="reinforce-empty-title">還沒有收藏任何單字</div>
      <div class="settings-hint">去 YouTube 看影片，點字幕上的單字再雙擊翻譯框就能收藏。</div>
    </div>`;
  }
  if (reviewedInSession === 0) {
    return `<div class="card empty-hint reinforce-empty">
      <div class="reinforce-empty-icon">🎉</div>
      <div class="reinforce-empty-title">目前沒有到期的卡片</div>
      <div class="settings-hint">收藏新單字，或等到期時間到了再回來複習。</div>
    </div>`;
  }
  return `<div class="card empty-hint reinforce-empty">
    <div class="reinforce-empty-icon">✅</div>
    <div class="reinforce-empty-title">這一輪複習完成了</div>
    <div class="settings-hint">這次共複習 ${reviewedInSession} 張卡片。</div>
  </div>`;
}

async function handleRating(rating) {
  // 連點防護：送出期間不接受第二次評分，避免同一張卡寫入兩筆複習事件
  if (submitting || !currentWord) return;
  submitting = true;
  renderCard(); // 讓按鈕立刻變成停用狀態

  const ratedId = currentWord.id;
  let requeue = null;

  try {
    const result = await submitReview(ratedId, rating);
    if (result) {
      completedToday += 1;
      reviewedInSession += 1;
      reviewEvents.push(result.reviewEvent);
      stateCounts = applyStateChange(stateCounts, currentWord.state, result.word.state);
      // 答錯的卡片幾分鐘後就會再到期，放回佇列尾端讓這一輪能再練一次
      if (rating === REVIEW_RATING.AGAIN) requeue = result.word;
    }
    // result 是 null 代表這個單字剛被刪掉了——跳過就好，不是錯誤
  } catch (err) {
    console.error("[FlowStudy] 送出複習失敗：", err);
  } finally {
    submitting = false;
  }

  // 剛評分的卡片一定在佇列最前面（takeNextCard 不會把它移除），這裡才移除
  if (queue.length && queue[0].id === ratedId) queue.shift();
  if (requeue) queue.push(requeue);

  await loadCurrentCard();
  renderAll();
}

// 在記憶體裡同步狀態統計，省下一次全表掃描。
// dueNow 減一是因為剛複習完的卡片一定已經被排到未來了。
function applyStateChange(counts, previousState, newState) {
  const next = { ...counts };
  if (next[previousState] !== undefined) next[previousState] = Math.max(0, next[previousState] - 1);
  if (next[newState] !== undefined) next[newState] += 1;
  next.dueNow = Math.max(0, next.dueNow - 1);
  return next;
}

function speak(text) {
  try {
    chrome.runtime.sendMessage({ type: "speak", text }, (result) => {
      if (chrome.runtime.lastError) return;
      if (result && result.audioDataUrl) new Audio(result.audioDataUrl).play().catch(() => {});
    });
  } catch (e) {
    /* 發音失敗不影響複習流程 */
  }
}
