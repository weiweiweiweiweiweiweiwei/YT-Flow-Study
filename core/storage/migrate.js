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

// ---------- 從 zeroStudy 帶過來的既有時數 ----------
//
// 使用者在改用這個擴充功能之前，已經在 zeroStudy 累積了 10 小時。
// 那是真實發生過的學習時間，不該因為換工具就歸零。
//
// 刻意做成一筆「標記來源的 ImmersionSession」而不是直接調整某個總數：
//   - 資料是誠實的：分析頁看得出這 10 小時的來源是匯入，不是本工具記錄的
//   - 可以回溯：哪天想拿掉，刪掉這一筆就好，不必猜哪個數字被動過手腳
//   - 只會執行一次（用 meta 旗標鎖住），不會每次啟動都加 10 小時
// 使用者在 zeroStudy 累積的時數。之後可以在「設定 → 沉浸時數維護」裡自行調整，
// 這裡只是第一次啟動時的初始值。
const LEGACY_HOURS_FLAG = "migration:zerostudy-legacy-hours";
const LEGACY_HOURS = 10;
const LEGACY_MINUTES = 4;

export async function importLegacyHoursIfNeeded() {
  const done = await getMeta(LEGACY_HOURS_FLAG, false);
  if (done) return { skipped: true };

  // 放在「最早一筆現有紀錄的前一天」，時間軸上排在所有本工具的紀錄之前
  let earliest = null;
  await withStore(STORES.IMMERSION_SESSIONS, "readonly", async (store) => {
    const all = await promisify(store.getAll());
    for (const s of all) {
      if (!earliest || String(s.startedAt) < String(earliest)) earliest = s.startedAt;
    }
  });

  const anchor = earliest ? new Date(earliest) : new Date();
  anchor.setDate(anchor.getDate() - 1);
  anchor.setHours(12, 0, 0, 0);

  const session = createImmersionSession({
    videoId: "",
    videoTitle: "",
    startedAt: anchor.toISOString(),
    source: "legacy-zerostudy",
  });
  session.watchedSeconds = LEGACY_HOURS * 3600 + LEGACY_MINUTES * 60;
  session.endedAt = anchor.toISOString();

  await withStore(STORES.IMMERSION_SESSIONS, "readwrite", async (store) => {
    await promisify(store.add(session));
  });

  await setMeta(LEGACY_HOURS_FLAG, {
    completedAt: new Date().toISOString(),
    hours: LEGACY_HOURS,
    minutes: LEGACY_MINUTES,
  });
  return { skipped: false, hours: LEGACY_HOURS, minutes: LEGACY_MINUTES };
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
