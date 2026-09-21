// ============================================================================
// 記憶固化
// ============================================================================
// 核心理念：複習單字時要能連回「當初是在哪部影片、哪一句話裡看到它的」。
// 一份純文字單字清單背不起來，但「那部影片裡那句話」會有畫面感。
//
// 兩層，刻意做到最精簡：
//   L1 影片清單 —— 依收藏日期分組（今天／昨天／9月17日），像 YouTube 觀看紀錄
//   L2 複習卡片 —— 點影片直接進第一個字，一次一個，看完按「下一個」
//
// 【刻意沒有做的事】
// 不追蹤「生單字 / 學會了」的狀態。每次點進一部影片，就是把裡面收藏的字
// 從頭到尾過一遍——不用判斷自己記住沒有，也不用維護第二份清單。
// 少一個要管理的狀態，就少一個會不同步的地方。
//
// VocabularyWord 上的 mastered 欄位仍然保留（既有資料不能憑空銷毀），
// 只是這個流程不再讀寫它。
// ============================================================================

import { getAllWords, updateWord, deleteWord } from "../core/storage/vocabularyStore.js";
import { buildVideoFeed, getOccurrencesForVideo } from "../core/storage/occurrenceStore.js";

const LEVEL = { VIDEOS: "videos", REVIEW: "review" };

let container = null;
let words = [];
let wordById = new Map();
let feed = [];

let level = LEVEL.VIDEOS;
let selectedVideo = null;
let cards = [];        // [{ word, sentence, startTime, videoId }]
let cardIndex = 0;
let revealed = false;

// 例句的中譯查過就記著，同一輪來回切換不會重複發請求
const sentenceTranslations = new Map();

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 參考畫面用的是 0:05:22 這種時:分:秒格式
function formatTimestamp(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// 把句子裡的目標單字標出來。逐字比對而不是用正規表達式：
// 收藏的可能是含特殊字元的片語（例如 "don't (yet)"），塞進 RegExp 會壞掉。
function highlight(sentence, term) {
  if (!sentence) return "";
  const i = sentence.toLowerCase().indexOf(String(term || "").toLowerCase());
  if (i === -1 || !term) return escapeHtml(sentence);
  return (
    escapeHtml(sentence.slice(0, i)) +
    `<mark class="mem-mark">${escapeHtml(sentence.slice(i, i + term.length))}</mark>` +
    escapeHtml(sentence.slice(i + term.length))
  );
}

// 日期標題：今天 / 昨天 / 9月17日，跟 YouTube 觀看紀錄的分組方式一致
function dateHeading(iso, now = new Date()) {
  const d = new Date(iso);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  const label = `${d.getMonth() + 1}月${d.getDate()}日`;
  if (d >= startOfToday) return `今天 ${label}`;
  if (d >= startOfYesterday) return `昨天 ${label}`;
  return label;
}

function dateKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export async function renderMemoryPage(root) {
  container = root;
  level = LEVEL.VIDEOS;
  selectedVideo = null;
  root.innerHTML = `<div class="card empty-hint">載入中…</div>`;

  try {
    words = await getAllWords();
    wordById = new Map(words.map((w) => [w.id, w]));
    feed = await buildVideoFeed(words);
    render();
  } catch (err) {
    console.error("[FlowStudy] 記憶固化載入失敗：", err);
    root.innerHTML = `<div class="card empty-hint">資料讀取失敗：${escapeHtml(err.message || err)}</div>`;
  }
}

export function getTotalWordCount() {
  return words.length;
}

function render() {
  if (level === LEVEL.VIDEOS) renderVideoFeed();
  else renderFlashcard();
}

// ---------- L1：影片清單 ----------

function renderVideoFeed() {
  if (!feed.length) {
    container.innerHTML = `<div class="card empty-hint">
      還沒有收藏任何單字。<br />去 YouTube 看影片，點字幕上的單字再雙擊翻譯框就能收進來。
    </div>`;
    return;
  }

  const groups = [];
  let current = null;
  for (const v of feed) {
    const key = dateKey(v.lastSavedAt);
    if (!current || current.key !== key) {
      current = { key, heading: dateHeading(v.lastSavedAt), items: [] };
      groups.push(current);
    }
    current.items.push(v);
  }

  container.innerHTML = `<div class="mem-feed">${groups
    .map(
      (g) => `
      <section class="mem-day">
        <h2 class="mem-day-heading">${escapeHtml(g.heading)}</h2>
        <div class="mem-video-list">${g.items.map(renderVideoCard).join("")}</div>
      </section>`
    )
    .join("")}</div>`;

  container.querySelectorAll("[data-video-id]").forEach((el) => {
    el.addEventListener("click", () => startReview(el.dataset.videoId));
  });
}

function renderVideoCard(v) {
  // YouTube 的縮圖網址可以直接組出來，不需要另外呼叫 API
  const thumb = `https://i.ytimg.com/vi/${encodeURIComponent(v.videoId)}/mqdefault.jpg`;
  return `
  <button class="mem-video-card" type="button" data-video-id="${escapeHtml(v.videoId)}">
    <span class="mem-thumb"><img src="${thumb}" alt="" loading="lazy" /></span>
    <span class="mem-video-body">
      <span class="mem-video-title">${escapeHtml(v.title || "（未取得影片標題）")}</span>
      <span class="mem-video-meta">
        <span class="mem-badge">${v.totalCount} 個單字</span>
      </span>
    </span>
  </button>`;
}

// ---------- L2：複習卡片 ----------

// 點影片直接進複習，中間不再插一層單字總覽——
// 多一層點擊只是多一次中斷，而那一層並沒有提供決策所需的資訊。
async function startReview(videoId) {
  const entry = feed.find((v) => v.videoId === videoId);
  if (!entry) return;
  selectedVideo = entry;

  let occurrences = [];
  try {
    occurrences = await getOccurrencesForVideo(videoId);
  } catch (err) {
    console.error("[FlowStudy] 讀取影片單字失敗：", err);
  }

  // 依影片裡出現的時間排序，複習順序跟看影片的順序一致，比較有情境感。
  // 同一個字在同一部影片出現多次時只取最早那次。
  occurrences.sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
  const seen = new Set();
  cards = [];
  for (const o of occurrences) {
    if (seen.has(o.vocabularyWordId)) continue;
    const word = wordById.get(o.vocabularyWordId);
    if (!word) continue; // 單字已被刪除，跳過孤兒紀錄
    seen.add(o.vocabularyWordId);
    cards.push({
      word,
      sentence: o.sentence || "",
      startTime: o.startTime || 0,
      videoId: o.videoId,
    });
  }

  if (!cards.length) {
    level = LEVEL.VIDEOS;
    render();
    return;
  }

  cardIndex = 0;
  revealed = false;
  level = LEVEL.REVIEW;
  render();
}

function renderFlashcard() {
  const card = cards[cardIndex];
  if (!card) {
    backToFeed();
    return;
  }
  const { word, sentence, startTime, videoId } = card;
  const zh = sentenceTranslations.get(sentence);

  container.innerHTML = `
    <div class="card mem-card">
      <div class="mem-card-head">
        <a class="mem-source" target="_blank" rel="noopener"
           href="https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${Math.floor(startTime)}s"
           title="回到影片這一刻">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/></svg>
          <span class="mem-source-title">${escapeHtml(selectedVideo.title || "影片")}</span>
          <span class="mem-timestamp">${formatTimestamp(startTime)}</span>
        </a>
        <span class="mem-head-right">
          <span class="mem-progress-label">${cardIndex + 1} / ${cards.length}</span>
          <button class="mem-icon-btn mem-icon-sm mem-delete" id="memDelete" type="button"
                  aria-label="刪除這個單字" title="刪除這個單字">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
          </button>
        </span>
      </div>

      <div class="mem-card-body">
        <div class="mem-term-row">
          <button class="mem-term" id="memTerm" type="button" title="點一下顯示翻譯">${escapeHtml(word.term)}</button>
          <button class="mem-icon-btn" id="memSpeakWord" type="button" aria-label="播放單字發音">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/></svg>
          </button>
        </div>

        ${
          sentence
            ? `<div class="mem-sentence-row">
                 <blockquote class="mem-sentence">${highlight(sentence, word.term)}</blockquote>
                 <button class="mem-icon-btn mem-icon-sm" id="memSpeakSentence" type="button" aria-label="播放例句發音">
                   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/></svg>
                 </button>
               </div>`
            : ""
        }

        <div class="mem-answer ${revealed ? "is-open" : ""}" id="memAnswer">
          ${
            revealed
              ? `<div class="mem-translation" id="memTranslation">${escapeHtml(
                  word.translation || "翻譯中…"
                )}</div>
                 ${
                   sentence
                     ? `<div class="mem-sentence-zh" id="memSentenceZh">${
                         zh === undefined ? "翻譯中…" : escapeHtml(zh)
                       }</div>`
                     : ""
                 }`
              : `<button class="mem-reveal" id="memReveal" type="button">顯示翻譯</button>`
          }
        </div>
      </div>

      <div class="mem-actions">
        <button class="mem-next" id="memNext" type="button">
          ${cardIndex === cards.length - 1 ? "完成這一輪" : "下一個"}
        </button>
      </div>
    </div>`;

  const reveal = () => {
    if (revealed) return;
    revealed = true;
    render();
  };
  container.querySelector("#memTerm").addEventListener("click", reveal);
  const revealBtn = container.querySelector("#memReveal");
  if (revealBtn) revealBtn.addEventListener("click", reveal);

  container.querySelector("#memSpeakWord").addEventListener("click", () => speak(word.term));
  const speakSentence = container.querySelector("#memSpeakSentence");
  if (speakSentence) speakSentence.addEventListener("click", () => speak(sentence));

  container.querySelector("#memNext").addEventListener("click", next);
  container.querySelector("#memDelete").addEventListener("click", () => removeCurrentWord(word));

  // 揭曉之後才去翻譯例句。沒翻過的才發請求，翻過的直接用記憶體裡的。
  if (revealed && sentence && zh === undefined) loadSentenceTranslation(sentence);

  // 舊資料補課：修正前收藏的單字沒有存到翻譯，這裡即時補查一次並寫回資料庫，
  // 下次再看到同一個字就直接有了。
  if (revealed && !word.translation) backfillWordTranslation(word);
}

// 補查單字翻譯並寫回資料庫（只在該單字沒有翻譯時才會被呼叫）
function backfillWordTranslation(word) {
  try {
    chrome.runtime.sendMessage({ type: "translate", text: word.term }, async (result) => {
      if (chrome.runtime.lastError) return;
      const translated = (result && result.translated) || "";
      if (!translated) {
        const el = container && container.querySelector("#memTranslation");
        if (el) el.textContent = "（查不到翻譯）";
        return;
      }

      word.translation = translated; // 更新記憶體裡的物件，同一輪不會再查一次
      try {
        await updateWord(word.id, { translation: translated });
      } catch (e) {
        /* 寫不回去不影響這次顯示 */
      }

      // 使用者可能已經按下一個了，只在還停在同一張卡片時才更新畫面
      const el = container && container.querySelector("#memTranslation");
      const card = cards[cardIndex];
      if (el && card && card.word.id === word.id) el.textContent = translated;
    });
  } catch (e) {
    /* 沒有連線就算了 */
  }
}

// 刪除存錯的單字。這裡是真的實體刪除——
// 跟「學會了」不同，使用者是說「這個字我根本不該收」，
// 所以首頁的「今日新單字」跟著減少才是正確的。
async function removeCurrentWord(word) {
  if (!confirm(`確定要刪除「${word.term}」嗎？\n這個字會從詞彙紀錄中移除。`)) return;

  try {
    await deleteWord(word.id);
  } catch (err) {
    console.error("[FlowStudy] 刪除單字失敗：", err);
    return;
  }

  // 通知背景重建索引，讓已開著的 YouTube 分頁即時移除底線
  try {
    chrome.runtime.sendMessage({ type: "vocab:syncIndex" }, () => void chrome.runtime.lastError);
  } catch (e) {}

  // 同步記憶體裡的資料，回到影片清單時數字才會是對的
  wordById.delete(word.id);
  words = words.filter((w) => w.id !== word.id);
  cards = cards.filter((c) => c.word.id !== word.id);
  if (selectedVideo) {
    selectedVideo.totalCount = Math.max(0, selectedVideo.totalCount - 1);
    if (selectedVideo.totalCount === 0) {
      feed = feed.filter((v) => v.videoId !== selectedVideo.videoId);
    }
  }

  if (!cards.length) {
    backToFeed();
    return;
  }
  // 刪掉的是最後一張的話，索引要往前收，否則會指到不存在的位置
  if (cardIndex >= cards.length) cardIndex = cards.length - 1;
  revealed = false;
  render();
}

function loadSentenceTranslation(sentence) {
  try {
    chrome.runtime.sendMessage({ type: "translate", text: sentence }, (result) => {
      if (chrome.runtime.lastError) {
        sentenceTranslations.set(sentence, "");
        return;
      }
      sentenceTranslations.set(sentence, (result && result.translated) || "");
      // 使用者可能已經按下一個了，只在還停在同一張卡片時才更新畫面
      const el = container && container.querySelector("#memSentenceZh");
      const card = cards[cardIndex];
      if (el && card && card.sentence === sentence) {
        el.textContent = sentenceTranslations.get(sentence);
      }
    });
  } catch (e) {
    sentenceTranslations.set(sentence, "");
  }
}

// 單向往前。走到最後一張再按一次，這一輪就結束，回到影片清單。
function next() {
  if (cardIndex >= cards.length - 1) {
    backToFeed();
    return;
  }
  cardIndex += 1;
  revealed = false;
  render();
}

function backToFeed() {
  level = LEVEL.VIDEOS;
  selectedVideo = null;
  cards = [];
  cardIndex = 0;
  revealed = false;
  render();
}

function speak(text) {
  if (!text) return;
  try {
    chrome.runtime.sendMessage({ type: "speak", text }, (result) => {
      if (chrome.runtime.lastError) return;
      if (result && result.audioDataUrl) new Audio(result.audioDataUrl).play().catch(() => {});
    });
  } catch (e) {
    /* 發音失敗不影響複習 */
  }
}
