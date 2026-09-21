// ============================================================================
// 到期卡片佇列
// ============================================================================
// 複習頁不會把整個單字庫載進來，只取「現在到期」的那一批，而且有數量上限。
// 單字累積到幾千筆之後，這個差別就是「秒開」跟「卡住好幾秒」的差別。
// ============================================================================

import { STORES, iterateIndex, getById } from "../storage/db.js";
import { deriveState } from "./scheduler.js";
import { VOCAB_STATE } from "../models.js";

export const DEFAULT_SESSION_LIMIT = 100;

/**
 * 取得目前到期的卡片佇列。
 *
 * 排序規則刻意寫死成「可重現」的：先按到期時間由舊到新，時間相同再按 ID。
 * 不用隨機排序，這樣重新整理頁面後佇列順序不變，複習到一半也不會亂掉。
 *
 * 新卡片在建立時 dueAt 就等於 createdAt，所以天然會排在佇列裡，
 * 不需要另外處理「新卡片」這個特例。
 */
export async function getDueQueue({ limit = DEFAULT_SESSION_LIMIT, now = new Date() } = {}) {
  const nowIso = now.toISOString();
  const due = [];

  // byDueAt 索引 + upperBound：資料庫只會走訪到期的那一段就停，
  // 不會掃過整個單字庫。
  await iterateIndex(STORES.VOCABULARY, "byDueAt", IDBKeyRange.upperBound(nowIso), "next", (word) => {
    due.push(word);
    // 多抓一些再排序，讓「同一個到期時間」的順序也穩定
    return due.length < limit * 2;
  });

  due.sort((a, b) => {
    const byDue = String(a.dueAt || "").localeCompare(String(b.dueAt || ""));
    if (byDue !== 0) return byDue;
    return String(a.id).localeCompare(String(b.id));
  });

  return due.slice(0, limit);
}

// 只要數量的時候用這個，不用把資料撈出來
export async function countDue({ now = new Date() } = {}) {
  const nowIso = now.toISOString();
  let n = 0;
  await iterateIndex(STORES.VOCABULARY, "byDueAt", IDBKeyRange.upperBound(nowIso), "next", () => {
    n++;
    return true;
  });
  return n;
}

/**
 * 從佇列裡挑出下一張「還存在」的卡片。
 *
 * 為什麼要重新讀一次資料庫？因為複習視窗開著的時候，使用者可能在另一個分頁的
 * 單字頁把這個字刪掉了，或是編輯過它。直接用佇列裡的舊快照會顯示已經不存在的
 * 資料，按下 Good 還會寫回一筆幽靈單字。
 *
 * 回傳 { word, queue } —— queue 是把失效項目移除後的新佇列。
 */
export async function takeNextCard(queue) {
  const remaining = [...queue];
  while (remaining.length) {
    const candidate = remaining[0];
    const fresh = await getById(STORES.VOCABULARY, candidate.id);
    if (!fresh) {
      remaining.shift(); // 已經被刪掉了，跳過
      continue;
    }
    return { word: fresh, queue: remaining };
  }
  return { word: null, queue: remaining };
}

// 複習頁上方的統計數字
export function summarizeQueue(words) {
  const summary = { total: words.length, new: 0, learning: 0, mature: 0 };
  for (const w of words) {
    const state = w.state || deriveState(w);
    if (state === VOCAB_STATE.NEW) summary.new++;
    else if (state === VOCAB_STATE.MATURE) summary.mature++;
    else summary.learning++;
  }
  return summary;
}
