// ============================================================================
// 學習資料的備份與還原
// ============================================================================
//
// 為什麼需要這支檔案？
//   Chrome 把擴充功能的資料（IndexedDB、chrome.storage）綁在「擴充功能 ID」上。
//   開發中的擴充功能（載入未封裝項目）ID 是由「資料夾路徑」算出來的，所以：
//     - 在 chrome://extensions 按「移除」→ Chrome 會把這個 ID 的資料整包刪掉
//     - 資料夾改名或搬家後重新載入 → 變成新的 ID，看到的是一個全新的空資料庫
//   這兩件事程式碼本身完全攔不住。唯一可靠的保險，是把資料定期寫成一個
//   「擴充功能以外」的檔案——下載資料夾裡的 JSON 不會跟著擴充功能被刪。
//
// 還原一律是「合併」，不是「覆蓋」：
//   備份檔裡有、目前資料庫沒有的才補進去；兩邊都有的保留比較新（或比較多）的那一份。
//   這樣就算拿一份舊備份來還原，也不會把備份之後新收藏的單字、新累積的時數蓋掉。
//
// 這支檔案只能在擴充功能的 origin 執行（background 與設定頁），理由同 db.js。
// ============================================================================

import { STORES, withStore } from "./db.js";
import { ZEROSTUDY_SOURCE } from "./migrate.js";

export const BACKUP_APP = "FlowStudy";
export const BACKUP_FORMAT = 1;

// 要備份的 object store。刻意不含 dictionary：那是查字典的快取，
// 隨時可以重新查回來，而且會隨查詢量長得很大，放進備份只是讓檔案變肥。
// meta 一定要帶：裡面有「舊資料已搬移過」的旗標，少了它，還原後下次啟動
// 會把舊格式的每日時數再搬一次，總時數就重複計算了。
const BACKUP_STORES = [
  STORES.VOCABULARY,
  STORES.OCCURRENCES,
  STORES.REVIEW_EVENTS,
  STORES.IMMERSION_SESSIONS,
  STORES.VIDEOS,
  STORES.META,
];

// chrome.storage.local 裡不需要備份的東西：
//   tr:*                 翻譯快取，重新查就有
//   flowstudyMarkedTerms 字幕底線用的索引，是從單字表重新算出來的投影
//   flowstudyBackup*     備份本身的紀錄（上次備份時間等），還原回去反而會誤導
//   flowstudyAuth* / flowstudySync*
//                        登入 token 與同步狀態——token 絕對不能寫進一個躺在下載資料夾的檔案
//   learningWords / immersion:YYYY-MM-DD / immersion_total_seconds
//                        舊版格式，早就搬進 IndexedDB 了
function shouldBackupLocalKey(key) {
  if (key.startsWith("tr:")) return false;
  if (key === "flowstudyMarkedTerms") return false;
  if (key.startsWith("flowstudyBackup")) return false;
  if (key.startsWith("flowstudyAuth") || key.startsWith("flowstudySync")) return false;
  if (key === "learningWords" || key === "immersion_total_seconds") return false;
  if (/^immersion:\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  return true;
}

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

function storageSet(obj) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set(obj, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    } catch (e) {
      reject(e);
    }
  });
}

export function summarizeStores(stores) {
  const sessions = stores[STORES.IMMERSION_SESSIONS] || [];
  return {
    words: (stores[STORES.VOCABULARY] || []).length,
    occurrences: (stores[STORES.OCCURRENCES] || []).length,
    reviewEvents: (stores[STORES.REVIEW_EVENTS] || []).length,
    immersionSessions: sessions.length,
    videos: (stores[STORES.VIDEOS] || []).length,
    immersionSeconds: sessions.reduce((sum, s) => sum + (Number(s.watchedSeconds) || 0), 0),
  };
}

// 資料庫裡「值得保護」的東西是不是一筆都沒有。
// 自動備份遇到空資料庫會直接跳過——空的備份檔沒有任何價值，
// 還可能讓人誤以為「最新的備份」就是那份空的。
export function isSummaryEmpty(summary) {
  return !summary || (summary.words === 0 && summary.immersionSessions === 0);
}

/**
 * 把目前所有學習資料讀成一個可以直接 JSON.stringify 的物件。
 * 所有 store 在同一個交易裡讀，確保拿到的是同一個時間點的一致快照。
 */
export async function buildBackupSnapshot({ extensionVersion = "" } = {}) {
  const stores = await withStore(BACKUP_STORES, "readonly", async (objectStores) => {
    const out = {};
    for (let i = 0; i < BACKUP_STORES.length; i++) {
      out[BACKUP_STORES[i]] = await promisify(objectStores[i].getAll());
    }
    return out;
  });

  // 雲端同步的指紋表是「這台電腦跟雲端對過哪些帳」，搬到別的地方還原就不成立了
  stores[STORES.META] = (stores[STORES.META] || []).filter((row) => !String(row.key).startsWith("sync:"));

  const local = await storageGetAll();
  const storageLocal = {};
  for (const [key, value] of Object.entries(local)) {
    if (shouldBackupLocalKey(key)) storageLocal[key] = value;
  }

  return {
    app: BACKUP_APP,
    format: BACKUP_FORMAT,
    exportedAt: new Date().toISOString(),
    extensionVersion,
    summary: summarizeStores(stores),
    stores,
    storageLocal,
  };
}

/**
 * 檢查一個物件是不是 FlowStudy 的備份檔。
 * 使用者可能選錯檔案，一定要在寫進資料庫之前擋下來。
 */
export function validateBackupSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return "檔案內容不是有效的 JSON 物件";
  if (snapshot.app !== BACKUP_APP) return "這不是 FlowStudy 的備份檔";
  if (!Number.isFinite(snapshot.format) || snapshot.format > BACKUP_FORMAT) {
    return "備份檔的格式版本比目前的擴充功能還新，請先更新擴充功能";
  }
  if (!snapshot.stores || typeof snapshot.stores !== "object") return "備份檔裡找不到學習資料";
  return null;
}

// ISO 時間字串可以直接比大小。相等時視為「不比較新」，就不必多寫一次。
function isNewer(a, b, field) {
  return String((a && a[field]) || "") > String((b && b[field]) || "");
}

/**
 * 把備份檔合併回資料庫。回傳每一類資料實際補回幾筆。
 *
 * 合併規則（重點是「永遠不會讓資料變少」）：
 *   單字       同一筆（同 id）保留 updatedAt 較新的；不同 id 但同一個字，保留現有的，
 *              並把備份裡掛在舊 id 底下的例句、複習紀錄改掛到現有這筆
 *   例句／複習 以 id 判斷，沒有的才補
 *   沉浸紀錄   同一筆保留秒數較多的（同一段觀看只會越記越長）
 *   影片       保留最後觀看時間較新的
 *   meta       沒有的才補
 *   設定值     目前沒有的才補，不蓋掉還原之前已經改過的設定
 */
export async function restoreBackupSnapshot(snapshot) {
  const problem = validateBackupSnapshot(snapshot);
  if (problem) throw new Error(problem);

  const src = snapshot.stores;
  const list = (name) => (Array.isArray(src[name]) ? src[name] : []);
  const result = { words: 0, occurrences: 0, reviewEvents: 0, immersionSessions: 0, videos: 0, settings: 0 };

  await withStore(BACKUP_STORES, "readwrite", async (objectStores) => {
    const [vocab, occ, rev, imm, vid, meta] = objectStores;

    // ---------- 單字 ----------
    // 備份裡的 id → 資料庫裡實際使用的 id（同一個字在兩邊 id 不同時用得到）
    const idMap = new Map();
    for (const word of list(STORES.VOCABULARY)) {
      if (!word || !word.id) continue;
      const sameId = await promisify(vocab.get(word.id));
      if (sameId) {
        idMap.set(word.id, word.id);
        if (isNewer(word, sameId, "updatedAt")) await promisify(vocab.put(word));
        continue;
      }
      const sameTerm = await promisify(
        vocab.index("byLangTerm").get([word.language || "en", word.normalizedTerm || ""])
      );
      if (sameTerm) {
        idMap.set(word.id, sameTerm.id);
        continue;
      }
      await promisify(vocab.add(word));
      idMap.set(word.id, word.id);
      result.words++;
    }

    const remapWordId = (row) =>
      idMap.has(row.vocabularyWordId) ? { ...row, vocabularyWordId: idMap.get(row.vocabularyWordId) } : row;

    // ---------- 例句 ----------
    for (const row of list(STORES.OCCURRENCES)) {
      if (!row || !row.id) continue;
      if (await promisify(occ.get(row.id))) continue;
      await promisify(occ.add(remapWordId(row)));
      result.occurrences++;
    }

    // ---------- 複習紀錄 ----------
    for (const row of list(STORES.REVIEW_EVENTS)) {
      if (!row || !row.id) continue;
      if (await promisify(rev.get(row.id))) continue;
      await promisify(rev.add(remapWordId(row)));
      result.reviewEvents++;
    }

    // ---------- 沉浸紀錄 ----------
    for (const row of list(STORES.IMMERSION_SESSIONS)) {
      if (!row || !row.id) continue;
      // 從 zeroStudy 帶入的時數已經被使用者刪掉了，拿舊備份還原時不要把它帶回來
      if (row.source === ZEROSTUDY_SOURCE) continue;
      const existing = await promisify(imm.get(row.id));
      if (!existing) {
        await promisify(imm.add(row));
        result.immersionSessions++;
      } else if ((Number(row.watchedSeconds) || 0) > (Number(existing.watchedSeconds) || 0)) {
        await promisify(imm.put(row));
      }
    }

    // ---------- 影片 ----------
    for (const row of list(STORES.VIDEOS)) {
      if (!row || !row.videoId) continue;
      const existing = await promisify(vid.get(row.videoId));
      if (!existing) {
        await promisify(vid.add(row));
        result.videos++;
      } else if (isNewer(row, existing, "lastWatchedAt")) {
        await promisify(vid.put(row));
      }
    }

    // ---------- meta ----------
    for (const row of list(STORES.META)) {
      if (!row || !row.key || String(row.key).startsWith("sync:")) continue;
      if (await promisify(meta.get(row.key))) continue;
      await promisify(meta.add(row));
    }
  });

  // ---------- chrome.storage.local 裡的設定值 ----------
  const incoming = snapshot.storageLocal && typeof snapshot.storageLocal === "object" ? snapshot.storageLocal : {};
  const current = await storageGetAll();
  const missing = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (!shouldBackupLocalKey(key)) continue;
    if (current[key] === undefined) missing[key] = value;
  }
  if (Object.keys(missing).length) {
    await storageSet(missing);
    result.settings = Object.keys(missing).length;
  }

  return result;
}
