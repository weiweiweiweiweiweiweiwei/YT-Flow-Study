// ============================================================================
// 單字出現位置倉儲層
// ============================================================================
// 同一個單字在不同影片、不同句子裡的每一次出現各存一筆。
// 單字詳細頁的「這個字在哪些地方出現過」就是讀這裡。
// ============================================================================

import { STORES, getAll, getAllByIndex, remove, put } from "./db.js";

export async function getOccurrencesForWord(vocabularyWordId) {
  const rows = await getAllByIndex(STORES.OCCURRENCES, "byWord", vocabularyWordId);
  // 新的排前面，讓使用者先看到最近一次遇到這個字的情境
  return rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function getOccurrencesForVideo(videoId) {
  return getAllByIndex(STORES.OCCURRENCES, "byVideo", videoId);
}

export async function getAllOccurrences() {
  return getAll(STORES.OCCURRENCES);
}

export async function deleteOccurrence(id) {
  return remove(STORES.OCCURRENCES, id);
}

export async function saveOccurrence(occurrence) {
  return put(STORES.OCCURRENCES, occurrence);
}

// 建立「單字 ID → 它所有句子串成一段文字」的索引，給單字頁的搜尋用。
// 一次全部讀進來只做一次，之後搜尋都在記憶體比對，不用每敲一個字就查一次資料庫。
export async function buildSentenceIndex() {
  const all = await getAllOccurrences();
  const index = {};
  for (const o of all) {
    if (!o.sentence) continue;
    index[o.vocabularyWordId] = index[o.vocabularyWordId]
      ? index[o.vocabularyWordId] + " " + o.sentence
      : o.sentence;
  }
  return index;
}

// 一次取得多個單字的出現紀錄，避免單字清單逐筆查詢造成 N+1 問題
export async function getOccurrenceCountsByWord() {
  const all = await getAllOccurrences();
  const counts = {};
  for (const o of all) counts[o.vocabularyWordId] = (counts[o.vocabularyWordId] || 0) + 1;
  return counts;
}

/**
 * 組出「記憶固化」第一層要的影片清單。
 *
 * 一次把 occurrences 走完就算出每部影片的單字集合與最後收藏時間，
 * 不做「每部影片再查一次」的 N+1 查詢——影片多起來那會很慢。
 *
 * 回傳的每一筆：
 *   { videoId, title, lastSavedAt, wordIds, unmasteredCount, masteredCount }
 * 依 lastSavedAt 由新到舊排序，呼叫端再依日期切分組。
 *
 * @param words 全部的 VocabularyWord（呼叫端已經載入過，不必在這裡重讀）
 */
export async function buildVideoFeed(words) {
  const wordById = new Map();
  for (const w of words) wordById.set(w.id, w);

  const all = await getAllOccurrences();
  const byVideo = new Map();

  for (const o of all) {
    if (!o.videoId) continue; // 舊資料搬過來的沒有影片來源，不放進影片清單
    if (!wordById.has(o.vocabularyWordId)) continue; // 單字已被刪除，跳過孤兒紀錄

    let entry = byVideo.get(o.videoId);
    if (!entry) {
      entry = {
        videoId: o.videoId,
        title: o.videoTitle || "",
        lastSavedAt: o.createdAt,
        wordIds: new Set(),
      };
      byVideo.set(o.videoId, entry);
    }
    entry.wordIds.add(o.vocabularyWordId);
    if (!entry.title && o.videoTitle) entry.title = o.videoTitle;
    if (String(o.createdAt) > String(entry.lastSavedAt)) entry.lastSavedAt = o.createdAt;
  }

  const feed = [];
  for (const entry of byVideo.values()) {
    let mastered = 0;
    for (const id of entry.wordIds) {
      if (wordById.get(id).mastered) mastered++;
    }
    feed.push({
      videoId: entry.videoId,
      title: entry.title,
      lastSavedAt: entry.lastSavedAt,
      wordIds: Array.from(entry.wordIds),
      totalCount: entry.wordIds.size,
      masteredCount: mastered,
      unmasteredCount: entry.wordIds.size - mastered,
    });
  }

  feed.sort((a, b) => String(b.lastSavedAt).localeCompare(String(a.lastSavedAt)));
  return feed;
}

// 某部影片收藏過的單字 ID（依收藏時間由舊到新，跟影片裡出現的順序大致一致）
export async function getWordIdsForVideo(videoId) {
  const rows = await getOccurrencesForVideo(videoId);
  rows.sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
  const seen = new Set();
  const ids = [];
  for (const o of rows) {
    if (seen.has(o.vocabularyWordId)) continue;
    seen.add(o.vocabularyWordId);
    ids.push(o.vocabularyWordId);
  }
  return ids;
}
