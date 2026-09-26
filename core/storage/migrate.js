// ============================================================================
// 舊資料搬移
// ============================================================================
//
// 舊版把學習資料直接放在 chrome.storage.local 的扁平 key 裡：
//   learningWords            = { "run": { word, sentence, addedAt }, ... }
//   immersion:2026-09-17     = 該日沉浸秒數
//   immersion_total_seconds  = 總秒數
//
// 這些是使用者真實累積的紀錄，升級時絕對不能弄丟。這支檔案負責把它們搬進
// 新的 IndexedDB 模型，而且只搬一次（用 meta 旗標記錄）。
//
// 搬移過程「不刪除」舊資料。萬一搬移邏輯有 bug，原始資料還在，可以重來。
// 舊 key 要等使用者確認一切正常之後，再由設定頁的清理功能移除。
// ============================================================================

import { STORES, withStore, getMeta, setMeta } from "./db.js";
import { createVocabularyWord, createVocabularyOccurrence, createImmersionSession } from "../models.js";

const MIGRATION_FLAG = "migration:v1-from-chrome-storage";

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function storageGetAll() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(null, (data) => resolve(data || {}));
    } catch (e) {
      resolve({});
    }
  });
}

/**
 * 執行搬移。已經搬過就直接跳過。
 * 回傳統計資訊，方便在 console 確認到底搬了多少東西。
 */
export async function runMigrationIfNeeded() {
  const done = await getMeta(MIGRATION_FLAG, false);
  if (done) return { skipped: true };

  const all = await storageGetAll();
  const result = { words: 0, occurrences: 0, immersionDays: 0, skipped: false };

  // ---------- 收藏的單字 ----------
  const learningWords = all.learningWords || {};
  const entries = Object.entries(learningWords);

  if (entries.length) {
    await withStore([STORES.VOCABULARY, STORES.OCCURRENCES], "readwrite", async ([vocabStore, occStore]) => {
      for (const [key, raw] of entries) {
        if (!raw) continue;
        const term = raw.word || key;
        if (!term) continue;

        const createdAt = raw.addedAt ? new Date(raw.addedAt).toISOString() : new Date().toISOString();
        const word = createVocabularyWord({ term, language: "en", createdAt });

        try {
          await promisify(vocabStore.add(word));
        } catch (e) {
          // 唯一索引擋下重複（舊資料裡 "Run" 和 "run" 會正規化成同一個字）——
          // 跳過就好，不要讓整批搬移失敗。
          continue;
        }
        result.words++;

        // 舊格式只存了句子，沒有影片 ID 與時間戳（那時候還沒有句子時間軸）。
        // 還是把句子保留下來當作學習情境，videoId 留空，UI 會顯示「來源未知」。
        if (raw.sentence) {
          const occurrence = createVocabularyOccurrence({
            vocabularyWordId: word.id,
            videoId: "",
            sentence: raw.sentence,
            startTime: 0,
            endTime: 0,
            createdAt,
          });
          await promisify(occStore.add(occurrence));
          result.occurrences++;
        }
      }
    });
  }

  // ---------- 每日沉浸時數 ----------
  //
  // 舊資料只知道「那天總共看了幾秒」，不知道分成幾段、看了哪些影片。
  // 所以每一天合成一筆 session，並標記 source: "legacy-daily"，
  // 讓分析頁能誠實區分「真的記錄到的觀看」與「只知道當日總量的歷史資料」。
  const immersionKeys = Object.keys(all).filter((k) => /^immersion:\d{4}-\d{2}-\d{2}$/.test(k));

  if (immersionKeys.length) {
    await withStore(STORES.IMMERSION_SESSIONS, "readwrite", async (store) => {
      for (const key of immersionKeys) {
        const seconds = all[key];
        if (!Number.isFinite(seconds) || seconds <= 0) continue;

        const dateStr = key.slice("immersion:".length);
        // 用當地時間中午當代表時間點。用 00:00 的話，換算時區時容易掉到前一天。
        const startedAt = new Date(dateStr + "T12:00:00").toISOString();

        const session = createImmersionSession({
          videoId: "",
          videoTitle: "",
          startedAt,
          source: "legacy-daily",
        });
        session.watchedSeconds = Math.round(seconds);
        session.endedAt = startedAt;

        await promisify(store.add(session));
        result.immersionDays++;
      }
    });
  }

  await setMeta(MIGRATION_FLAG, { completedAt: new Date().toISOString(), ...result });
  return result;
}

// ---------- 移除從 zeroStudy 帶入的時數 ----------
//
// 早期版本啟動時會自動塞一筆 10 小時 4 分、source = "legacy-zerostudy" 的沉浸紀錄，
// 代表改用這個工具之前在 zeroStudy 累積的時數。使用者決定不把它算進總時數，
// 這裡把它刪掉——只刪這個來源的紀錄，真實記錄到的觀看一筆都不碰。只執行一次。
export const ZEROSTUDY_SOURCE = "legacy-zerostudy";
const REMOVE_ZEROSTUDY_FLAG = "cleanup:remove-zerostudy-hours";

export async function removeZeroStudyHoursIfNeeded() {
  const done = await getMeta(REMOVE_ZEROSTUDY_FLAG, false);
  if (done) return { skipped: true };

  const removed = await withStore(STORES.IMMERSION_SESSIONS, "readwrite", async (store) => {
    const all = await promisify(store.getAll());
    let count = 0;
    let seconds = 0;
    for (const session of all) {
      if (session.source !== ZEROSTUDY_SOURCE) continue;
      await promisify(store.delete(session.id));
      count++;
      seconds += session.watchedSeconds || 0;
    }
    return { count, seconds };
  });

  await setMeta(REMOVE_ZEROSTUDY_FLAG, { completedAt: new Date().toISOString(), ...removed });
  return { skipped: false, ...removed };
}

// 設定頁的「清除舊格式資料」用。等使用者確認搬移沒問題之後才會執行，
// 刻意做成獨立動作而不是搬移完自動刪除。
export async function removeLegacyKeys() {
  const all = await storageGetAll();
  const keys = Object.keys(all).filter(
    (k) => k === "learningWords" || /^immersion:\d{4}-\d{2}-\d{2}$/.test(k) || k === "immersion_total_seconds"
  );
  if (!keys.length) return 0;
  return new Promise((resolve) => {
    chrome.storage.local.remove(keys, () => resolve(keys.length));
  });
}

export { MIGRATION_FLAG };
