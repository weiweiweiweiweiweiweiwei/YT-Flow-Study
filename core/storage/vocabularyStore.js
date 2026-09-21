// ============================================================================
// 單字倉儲層
// ============================================================================
// UI 一律透過這一層存取單字，不可以直接開 IndexedDB 交易。
// 這樣「怎麼查重複」「怎麼分頁」這類規則只會有一份實作。
// ============================================================================

import {
  STORES,
  withStore,
  getById,
  getAll,
  getAllByIndex,
  remove,
  iterateIndex,
  count as countAll,
} from "./db.js";
import {
  createVocabularyWord,
  createVocabularyOccurrence,
  createVideo,
  normalizeTerm,
  nowIso,
  VOCAB_STATE,
} from "../models.js";

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getWord(id) {
  return getById(STORES.VOCABULARY, id);
}

export async function getAllWords() {
  return getAll(STORES.VOCABULARY);
}

export async function countWords() {
  return countAll(STORES.VOCABULARY);
}

export async function findWordByTerm(term, language = "en") {
  const normalized = normalizeTerm(term);
  if (!normalized) return null;
  return withStore(STORES.VOCABULARY, "readonly", (store) =>
    promisify(store.index("byLangTerm").get([language, normalized]))
  );
}

// ---------- 從字幕收藏單字（最重要的入口）----------
//
// 整個流程放在「同一個交易」裡完成，原因是要同時解決兩個失敗案例：
//   - 重複的單字：同一個字在不同影片收藏第二次時，不能變成兩筆 VocabularyWord。
//   - 連續快速點擊：先查再寫如果拆成兩個交易，中間會有空檔讓第二次點擊也查到
//     「不存在」，結果寫進兩筆。同一個交易內就不會有這個競態。
//
// 回傳 { word, occurrence, isNewWord }，呼叫端可以據此顯示「已收藏 / 已存在」。
export async function saveWordFromSubtitle({
  term,
  language = "en",
  translation = "",
  definition = "",
  videoId = "",
  videoTitle = "",
  videoUrl = "",
  sentence = "",
  startTime = 0,
  endTime = 0,
} = {}) {
  const trimmed = String(term || "").trim();
  const normalized = normalizeTerm(trimmed);
  if (!normalized) throw new Error("單字內容是空的，無法收藏");

  return withStore(
    [STORES.VOCABULARY, STORES.OCCURRENCES, STORES.VIDEOS],
    "readwrite",
    async ([vocabStore, occStore, videoStore]) => {
      const existing = await promisify(vocabStore.index("byLangTerm").get([language, normalized]));

      let word;
      let isNewWord = false;

      if (existing) {
        word = existing;
        // 已經有這個單字：補上之前缺的翻譯／解釋，但不覆蓋使用者自己編輯過的內容
        let touched = false;
        if (!word.translation && translation) {
          word.translation = translation;
          touched = true;
        }
        if (!word.definition && definition) {
          word.definition = definition;
          touched = true;
        }
        if (touched) {
          word.updatedAt = nowIso();
          await promisify(vocabStore.put(word));
        }
      } else {
        word = createVocabularyWord({ term: trimmed, language, translation, definition });
        isNewWord = true;
        await promisify(vocabStore.add(word));
      }

      // 同一句、同一部影片、同一個單字不要重複記錄出現位置
      // （使用者可能在同一句上點了兩次）
      let occurrence = null;
      if (videoId && sentence) {
        const existingOccs = await promisify(occStore.index("byWord").getAll(word.id));
        const duplicate = existingOccs.find(
          (o) => o.videoId === videoId && Math.abs(o.startTime - startTime) < 0.5
        );
        if (duplicate) {
          occurrence = duplicate;
        } else {
          occurrence = createVocabularyOccurrence({
            vocabularyWordId: word.id,
            videoId,
            videoTitle,
            videoUrl,
            sentence,
            startTime,
            endTime,
          });
          await promisify(occStore.add(occurrence));
        }
      }

      if (videoId) {
        const existingVideo = await promisify(videoStore.get(videoId));
        const video = existingVideo || createVideo({ videoId, title: videoTitle });
        video.lastWatchedAt = nowIso();
        if (videoTitle && !video.title) video.title = videoTitle;
        await promisify(videoStore.put(video));
      }

      return { word, occurrence, isNewWord };
    }
  );
}

// ---------- 更新 ----------

export async function updateWord(id, patch) {
  return withStore(STORES.VOCABULARY, "readwrite", async (store) => {
    const word = await promisify(store.get(id));
    // 單字可能在複習進行中被別的分頁刪掉了——回傳 null 讓呼叫端優雅處理，
    // 而不是丟出例外把整個複習畫面弄壞。
    if (!word) return null;

    const updated = { ...word, ...patch, updatedAt: nowIso() };
    // term 改了的話 normalizedTerm 一定要跟著改，否則重複比對會失準
    if (patch && patch.term !== undefined) {
      updated.term = String(patch.term).trim();
      updated.normalizedTerm = normalizeTerm(patch.term);
    }
    updated.id = word.id; // 絕對不允許改 ID
    await promisify(store.put(updated));
    return updated;
  });
}

/**
 * 標記 / 取消標記「學會了」。
 *
 * 這是「學會了」按鈕唯一該做的事——只改狀態，絕不刪資料。
 * 單字仍然留在該影片的歷史紀錄裡，只是歸到「學會了」分頁底下。
 *
 * 之前的實作是直接 deleteWord()，那會連帶讓首頁的「今日新單字」跟著減少，
 * 因為那個數字是數「createdAt 落在今天」的單字——記錄被刪掉就少一個。
 * 複習一個字不該讓「我今天採集了幾個新字」這個事實改變。
 */
export async function setMastered(id, mastered = true) {
  return withStore(STORES.VOCABULARY, "readwrite", async (store) => {
    const word = await promisify(store.get(id));
    if (!word) return null; // 可能在別的分頁被刪掉了，交給呼叫端優雅處理

    const updated = {
      ...word,
      mastered: !!mastered,
      masteredAt: mastered ? nowIso() : null,
      updatedAt: nowIso(),
    };
    await promisify(store.put(updated));
    return updated;
  });
}

// 刪除單字時，連同它的出現紀錄與複習事件一起刪掉，不留孤兒資料。
// 注意：「學會了」按鈕不走這裡，它只呼叫 setMastered()。
// 這個函式保留給「使用者明確要求刪除」的情境。
export async function deleteWord(id) {
  return withStore(
    [STORES.VOCABULARY, STORES.OCCURRENCES, STORES.REVIEW_EVENTS],
    "readwrite",
    async ([vocabStore, occStore, revStore]) => {
      await promisify(vocabStore.delete(id));

      const occs = await promisify(occStore.index("byWord").getAll(id));
      for (const o of occs) await promisify(occStore.delete(o.id));

      const revs = await promisify(revStore.index("byWord").getAll(id));
      for (const r of revs) await promisify(revStore.delete(r.id));

      return { deletedOccurrences: occs.length, deletedReviewEvents: revs.length };
    }
  );
}

// ---------- 查詢：搜尋 / 篩選 / 排序 / 分頁 ----------

export const VOCAB_FILTER = {
  ALL: "all",
  NEW: "new",
  LEARNING: "learning",
  MATURE: "mature",
  DUE_TODAY: "dueToday",
};

function matchesFilter(word, filter, nowMs) {
  switch (filter) {
    case VOCAB_FILTER.NEW:
      return word.state === VOCAB_STATE.NEW;
    case VOCAB_FILTER.LEARNING:
      return word.state === VOCAB_STATE.LEARNING;
    case VOCAB_FILTER.MATURE:
      return word.state === VOCAB_STATE.MATURE;
    case VOCAB_FILTER.DUE_TODAY:
      return word.dueAt && new Date(word.dueAt).getTime() <= nowMs;
    default:
      return true;
  }
}

const SORTERS = {
  createdDesc: (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  createdAsc: (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  termAsc: (a, b) => a.normalizedTerm.localeCompare(b.normalizedTerm) || a.id.localeCompare(b.id),
  termDesc: (a, b) => b.normalizedTerm.localeCompare(a.normalizedTerm) || a.id.localeCompare(b.id),
  dueAsc: (a, b) => String(a.dueAt || "").localeCompare(String(b.dueAt || "")) || a.id.localeCompare(b.id),
  reviewsDesc: (a, b) => b.reviewCount - a.reviewCount || a.id.localeCompare(b.id),
};

// 搜尋範圍包含 term / normalizedTerm / translation / definition。
// 句子（sentence）存在 occurrence 上，需要搜尋句子時由呼叫端帶入
// sentenceIndex（單字 ID → 該單字所有句子串起來的字串），避免這一層
// 為了搜尋就把所有 occurrence 全部載入。
export async function queryWords({
  search = "",
  filter = VOCAB_FILTER.ALL,
  sort = "createdDesc",
  offset = 0,
  limit = 50,
  sentenceIndex = null,
} = {}) {
  const nowMs = Date.now();
  const needle = normalizeTerm(search);
  const rawNeedle = String(search || "").trim().toLowerCase();

  const matched = [];
  await iterateIndex(STORES.VOCABULARY, "byCreatedAt", null, "next", (word) => {
    if (!matchesFilter(word, filter, nowMs)) return true;

    if (rawNeedle) {
      const haystacks = [
        word.normalizedTerm || "",
        (word.term || "").toLowerCase(),
        (word.translation || "").toLowerCase(),
        (word.definition || "").toLowerCase(),
      ];
      if (sentenceIndex && sentenceIndex[word.id]) haystacks.push(sentenceIndex[word.id].toLowerCase());
      const hit = haystacks.some((h) => h.includes(needle) || h.includes(rawNeedle));
      if (!hit) return true;
    }

    matched.push(word);
    return true;
  });

  matched.sort(SORTERS[sort] || SORTERS.createdDesc);

  return {
    total: matched.length,
    items: matched.slice(offset, offset + limit),
  };
}

// 各狀態的數量。分析頁與複習頁都要用，集中在這裡算，避免兩邊算法不一致。
export async function getStateCounts() {
  const counts = { total: 0, new: 0, learning: 0, mature: 0, dueNow: 0 };
  const nowMs = Date.now();
  await iterateIndex(STORES.VOCABULARY, "byCreatedAt", null, "next", (word) => {
    counts.total++;
    if (counts[word.state] !== undefined) counts[word.state]++;
    if (word.dueAt && new Date(word.dueAt).getTime() <= nowMs) counts.dueNow++;
    return true;
  });
  return counts;
}

export { getAllByIndex, remove };
