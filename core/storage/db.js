// ============================================================================
// IndexedDB 底層封裝
// ============================================================================
//
// 重要前提：這支檔案只能在「擴充功能的 origin」執行，也就是 background service
// worker 與 review.html 這類擴充功能頁面。
//
// content script 不可以直接用這裡的東西——content script 跑在 youtube.com 的
// origin，它看到的 indexedDB 是 YouTube 自己的資料庫，跟我們的完全是兩回事。
// content script 要存取資料請透過 chrome.runtime.sendMessage 走 background。
//
// 為什麼用 IndexedDB 而不是全部塞進 chrome.storage.local？
//   chrome.storage.local 是「一整包 JSON 讀進來、整包寫回去」的模型。
//   單字出現紀錄（occurrences）跟複習事件（reviewEvents）會一直累積，
//   幾千筆之後每次存檔都要序列化整個陣列，會愈用愈慢。
//   IndexedDB 有索引、可以只讀需要的範圍，才撐得住長期使用。
//   小而固定的設定值仍然放 chrome.storage.local（見 settingsStore.js）。
// ============================================================================

const DB_NAME = "flowstudy";
const DB_VERSION = 2;

export const STORES = {
  VOCABULARY: "vocabulary",
  OCCURRENCES: "occurrences",
  REVIEW_EVENTS: "reviewEvents",
  IMMERSION_SESSIONS: "immersionSessions",
  VIDEOS: "videos",
  META: "meta",
  DICTIONARY: "dictionary",
};

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(e);
      return;
    }

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const oldVersion = event.oldVersion;

      if (oldVersion < 1) {
        // --- 單字 ---
        const vocab = db.createObjectStore(STORES.VOCABULARY, { keyPath: "id" });
        // 複合唯一索引：同一個語言裡，同一個正規化後的單字只能有一筆。
        // 由資料庫本身保證唯一，比在程式裡「先查再寫」可靠——後者在
        // 連續快速點擊時會有競態，可能寫進兩筆重複資料。
        vocab.createIndex("byLangTerm", ["language", "normalizedTerm"], { unique: true });
        vocab.createIndex("byDueAt", "dueAt");
        vocab.createIndex("byState", "state");
        vocab.createIndex("byCreatedAt", "createdAt");

        // --- 單字出現的上下文 ---
        const occ = db.createObjectStore(STORES.OCCURRENCES, { keyPath: "id" });
        occ.createIndex("byWord", "vocabularyWordId");
        occ.createIndex("byVideo", "videoId");
        occ.createIndex("byCreatedAt", "createdAt");

        // --- 複習事件（append-only）---
        const rev = db.createObjectStore(STORES.REVIEW_EVENTS, { keyPath: "id" });
        rev.createIndex("byWord", "vocabularyWordId");
        rev.createIndex("byReviewedAt", "reviewedAt");

        // --- 沉浸 session ---
        const imm = db.createObjectStore(STORES.IMMERSION_SESSIONS, { keyPath: "id" });
        imm.createIndex("byStartedAt", "startedAt");
        imm.createIndex("byVideo", "videoId");

        // --- 影片 ---
        const vid = db.createObjectStore(STORES.VIDEOS, { keyPath: "videoId" });
        vid.createIndex("byLastWatchedAt", "lastWatchedAt");

        // --- 雜項：搬移旗標、每日彙總快取 ---
        db.createObjectStore(STORES.META, { keyPath: "key" });
      }

      if (oldVersion < 2) {
        // --- 單字釋義快取 ---
        // 查一次字典要打好幾次網路請求（釋義、例句、各自的中譯），
        // 查完就存起來，之後開同一個單字都是瞬間顯示、完全離線可用。
        // keyPath 用正規化後的單字，"Run" 和 "run." 會命中同一筆。
        db.createObjectStore(STORES.DICTIONARY, { keyPath: "term" });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // 另一個分頁要求升級資料庫版本時，舊連線必須先關掉，否則會卡住對方。
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB 被其他分頁的舊連線擋住了"));
  }).catch((err) => {
    dbPromise = null; // 失敗就清掉，下次呼叫可以重試（例如使用者關掉了無痕模式限制）
    throw err;
  });

  return dbPromise;
}

// 把 IDBRequest 包成 Promise
function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// 開一個交易並執行 fn。fn 拿到 store 物件，可以回傳 Promise。
// 交易「完成」才 resolve，確保資料真的寫進去了——這是「按下 Good 之後
// 馬上重新整理頁面，進度不會不見」的保證。
export async function withStore(storeNames, mode, fn) {
  const db = await openDb();
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];

  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(names, mode);
    } catch (e) {
      reject(e);
      return;
    }

    let result;
    let failed = null;

    tx.oncomplete = () => (failed ? reject(failed) : resolve(result));
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(failed || tx.error || new Error("交易被中止"));

    const stores = names.map((n) => tx.objectStore(n));
    Promise.resolve(fn(names.length === 1 ? stores[0] : stores, tx))
      .then((r) => {
        result = r;
      })
      .catch((err) => {
        failed = err;
        try {
          tx.abort();
        } catch (e) {}
      });
  });
}

// ---------- 常用操作 ----------

export async function getAll(storeName, query = null, count = undefined) {
  return withStore(storeName, "readonly", (store) => promisifyRequest(store.getAll(query, count)));
}

export async function getById(storeName, id) {
  return withStore(storeName, "readonly", (store) => promisifyRequest(store.get(id)));
}

export async function put(storeName, value) {
  return withStore(storeName, "readwrite", (store) => promisifyRequest(store.put(value)));
}

export async function putMany(storeName, values) {
  if (!values.length) return 0;
  return withStore(storeName, "readwrite", async (store) => {
    for (const v of values) await promisifyRequest(store.put(v));
    return values.length;
  });
}

export async function remove(storeName, id) {
  return withStore(storeName, "readwrite", (store) => promisifyRequest(store.delete(id)));
}

export async function count(storeName) {
  return withStore(storeName, "readonly", (store) => promisifyRequest(store.count()));
}

export async function getAllByIndex(storeName, indexName, query = null, count = undefined) {
  return withStore(storeName, "readonly", (store) =>
    promisifyRequest(store.index(indexName).getAll(query, count))
  );
}

export async function getOneByIndex(storeName, indexName, query) {
  return withStore(storeName, "readonly", (store) => promisifyRequest(store.index(indexName).get(query)));
}

export async function countByIndex(storeName, indexName, query = null) {
  return withStore(storeName, "readonly", (store) =>
    promisifyRequest(store.index(indexName).count(query))
  );
}

// 用游標逐筆走訪，避免把整個 store 讀進記憶體。
// 單字量很大的時候（幾千、上萬筆）這是必要的——getAll 會一次配置整個陣列。
// visit 回傳 false 就停止走訪。
export async function iterateIndex(storeName, indexName, query, direction, visit) {
  return withStore(storeName, "readonly", (store) => {
    return new Promise((resolve, reject) => {
      const source = indexName ? store.index(indexName) : store;
      const request = source.openCursor(query, direction || "next");
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        let keepGoing = true;
        try {
          keepGoing = visit(cursor.value) !== false;
        } catch (e) {
          reject(e);
          return;
        }
        if (keepGoing) cursor.continue();
        else resolve();
      };
      request.onerror = () => reject(request.error);
    });
  });
}

export async function clearStore(storeName) {
  return withStore(storeName, "readwrite", (store) => promisifyRequest(store.clear()));
}

// ---------- meta：搬移旗標之類的小東西 ----------

export async function getMeta(key, fallback = null) {
  const row = await getById(STORES.META, key);
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  return put(STORES.META, { key, value });
}

// 測試與「重設學習資料」用。刻意只清空我們自己建立的 object store，
// 不去刪整個資料庫，也絕對不碰 chrome.storage 裡跟學習無關的設定
// （例如翻譯框大小、字幕條位置）。
export async function clearLearningData() {
  const targets = [
    STORES.VOCABULARY,
    STORES.OCCURRENCES,
    STORES.REVIEW_EVENTS,
    STORES.IMMERSION_SESSIONS,
    STORES.VIDEOS,
  ];
  for (const name of targets) await clearStore(name);
  return true;
}
