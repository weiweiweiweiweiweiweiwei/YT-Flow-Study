// ============================================================================
// 複習事件倉儲層
// ============================================================================
// 每一次複習都留下一筆不可變更的紀錄。分析頁的記憶保留率、複習趨勢
// 全部從這裡推導，而不是另外存一份統計數字——統計數字會跟事實脫節，事件不會。
// ============================================================================

import { STORES, withStore, getAll, getAllByIndex, iterateIndex } from "./db.js";
import { createReviewEvent, nowIso, toLocalDateKey } from "../models.js";
import { schedule } from "../srs/scheduler.js";

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * 送出一次複習：套用排程、更新單字、寫入事件——三件事在同一個交易裡完成。
 *
 * 為什麼要放在同一個交易？因為這三件事必須「全部成功或全部不發生」。
 * 如果單字更新了但事件沒寫進去，分析頁算出來的保留率就永遠是錯的，
 * 而且再也無法修復（事件遺失了就是遺失了）。
 *
 * 回傳 null 代表單字已經不存在（可能在另一個分頁被刪掉了），
 * 呼叫端應該跳過這張卡片，而不是當成錯誤。
 */
export async function submitReview(vocabularyWordId, rating, now = new Date()) {
  return withStore(
    [STORES.VOCABULARY, STORES.REVIEW_EVENTS],
    "readwrite",
    async ([vocabStore, reviewStore]) => {
      const word = await promisify(vocabStore.get(vocabularyWordId));
      if (!word) return null;

      const { patch, event } = schedule(word, rating, now);

      const updatedWord = { ...word, ...patch, updatedAt: now.toISOString() };
      await promisify(vocabStore.put(updatedWord));

      const reviewEvent = createReviewEvent({
        vocabularyWordId,
        rating: event.rating,
        reviewedAt: event.reviewedAt,
        previousState: event.previousState,
        newState: event.newState,
        previousDueAt: event.previousDueAt,
        newDueAt: event.newDueAt,
        previousInterval: event.previousInterval,
        newInterval: event.newInterval,
      });
      await promisify(reviewStore.add(reviewEvent));

      return { word: updatedWord, reviewEvent };
    }
  );
}

export async function getAllReviewEvents() {
  return getAll(STORES.REVIEW_EVENTS);
}

export async function getReviewEventsForWord(vocabularyWordId) {
  const rows = await getAllByIndex(STORES.REVIEW_EVENTS, "byWord", vocabularyWordId);
  return rows.sort((a, b) => String(a.reviewedAt).localeCompare(String(b.reviewedAt)));
}

// 取某個時間範圍內的事件。分析頁切換「週/月/年」時只讀需要的那一段，
// 不用每次都把全部歷史載進來。
export async function getReviewEventsBetween(startIso, endIso) {
  const rows = [];
  await iterateIndex(
    STORES.REVIEW_EVENTS,
    "byReviewedAt",
    IDBKeyRange.bound(startIso, endIso),
    "next",
    (row) => {
      rows.push(row);
      return true;
    }
  );
  return rows;
}

// 今天完成了幾次複習（複習頁的「今日已完成」）
export async function countReviewsToday(now = new Date()) {
  const todayKey = toLocalDateKey(now);
  let n = 0;
  await iterateIndex(STORES.REVIEW_EVENTS, "byReviewedAt", null, "prev", (row) => {
    const key = toLocalDateKey(row.reviewedAt);
    if (key === todayKey) {
      n++;
      return true;
    }
    // 索引是照時間排序的，由新到舊走訪時一旦碰到「不是今天」就可以停，
    // 不必把整個歷史掃完。
    return key > todayKey;
  });
  return n;
}

export { nowIso };
