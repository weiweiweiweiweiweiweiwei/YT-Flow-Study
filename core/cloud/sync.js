// ============================================================================
// 雲端同步引擎
// ============================================================================
//
// 本機 IndexedDB 永遠是主要的資料來源（離線也能用、速度快），雲端是它的鏡像。
// 雲端的 sync_records 表每一列對應本機的一筆紀錄（單字、例句、複習、沉浸、影片），
// 整筆紀錄以 JSON 存在 data 欄位。
//
// 每次同步做兩件事，順序固定：
//   1. 拉：把雲端「上次同步之後」有變動的列拉下來，合併進本機
//   2. 推：把本機「跟上次同步時不一樣」的紀錄推上去；本機刪掉的，推一個墓碑
//
// 怎麼知道本機哪些紀錄變了？
//   同步狀態（存在 meta）記著每一筆紀錄上次同步時的指紋（內容雜湊）。
//   推的時候重算指紋，不一樣就是有改；指紋表裡有、本機卻找不到的，就是被刪了。
//
// 合併規則跟備份還原一致（「不會讓資料變少」）：
//   單字 updatedAt 新的贏；沉浸紀錄秒數多的贏；影片最後觀看時間新的贏；
//   例句、複習紀錄建立後不會再改，本機已有就保留本機的。
//
// 兩台電腦各自收藏了同一個字（id 不同）怎麼辦？
//   資料庫規定同一個字只能有一筆，所以一定要選一筆留下。規則是「建立時間早的贏，
//   同時間比 id」——每台電腦算出來的結果都一樣，才不會你刪我、我刪你來回拉鋸。
//   輸的那筆推一個墓碑，它底下的例句、複習紀錄改掛到贏的那筆。
//
// 最重要的保險：本機資料被清掉時，絕對不能把「清掉」同步成「刪除」。
//   如果這次要推的墓碑數量超過已同步紀錄的一半（而且不是零星幾筆），
//   判定為「本機資料遺失」而不是「使用者刪東西」：一個墓碑都不推，
//   改成把同步狀態歸零、從雲端完整拉一次——資料就這樣回來了。
// ============================================================================

import { STORES, withStore, getMeta, setMeta } from "../storage/db.js";

export const SYNC_STORES = [
  { name: STORES.VOCABULARY, key: "id" },
  { name: STORES.OCCURRENCES, key: "id" },
  { name: STORES.REVIEW_EVENTS, key: "id" },
  { name: STORES.IMMERSION_SESSIONS, key: "id" },
  { name: STORES.VIDEOS, key: "videoId" },
];
const STORE_NAMES = SYNC_STORES.map((s) => s.name);
const KEY_OF = Object.fromEntries(SYNC_STORES.map((s) => [s.name, s.key]));

const PULL_PAGE_SIZE = 500;
const PUSH_BATCH_SIZE = 200;
// 每次從「上次拉到的時間點再往前兩分鐘」開始拉。伺服器上同時進行的寫入，
// 提交順序不一定照時間戳記，稍微重疊可以避免漏掉；重複拉到的列合併起來不會有任何效果。
const PULL_OVERLAP_MS = 2 * 60 * 1000;
const MAX_RECORD_CHARS = 60000;
const MASS_DELETE_MIN = 20;
const MASS_DELETE_RATIO = 0.5;

export function syncStateKey(userId) {
  return `sync:state:${userId}`;
}

// ---------- 指紋 ----------
//
// 雲端的 jsonb 會把物件的 key 重新排序，同一筆資料拉回來 JSON.stringify 的結果就不一樣了。
// 所以先把 key 排好再序列化，內容相同 → 指紋一定相同。
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map((v) => (v === undefined ? "null" : stableStringify(v))).join(",") + "]";
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
}

// FNV-1a，兩個 32 位元的變體接起來。不需要密碼學強度，只要「內容一變指紋就變」
export function fingerprint(record) {
  const text = stableStringify(record);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

// ---------- IndexedDB 小工具 ----------

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// 寫入失敗（例如撞到「同一個字只能一筆」的唯一索引）時，只放棄這一筆，
// 不要讓整個交易跟著中止——IndexedDB 預設會因為一個失敗的請求把整批都撤銷。
function tryReq(request) {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve({ ok: true, result: request.result });
    request.onerror = (event) => {
      event.preventDefault();
      event.stopPropagation();
      resolve({ ok: false, error: request.error });
    };
  });
}

// ---------- 合併規則 ----------

function isNewer(a, b, field) {
  return String((a && a[field]) || "") > String((b && b[field]) || "");
}

// 回傳應該留在本機的那一份（local 或 remote）
function mergeRecord(storeName, local, remote) {
  switch (storeName) {
    case STORES.VOCABULARY:
      return isNewer(remote, local, "updatedAt") ? remote : local;
    case STORES.IMMERSION_SESSIONS:
      return (Number(remote.watchedSeconds) || 0) > (Number(local.watchedSeconds) || 0) ? remote : local;
    case STORES.VIDEOS:
      return isNewer(remote, local, "lastWatchedAt") ? remote : local;
    default:
      return local;
  }
}

// 同一個字兩筆，留哪一筆？每台電腦都要算出同樣的答案
function pickVocabWinner(a, b) {
  const ca = String(a.createdAt || "");
  const cb = String(b.createdAt || "");
  if (ca !== cb) return ca < cb ? a : b;
  return String(a.id) < String(b.id) ? a : b;
}

// ---------- 拉 ----------

async function applyRemotePage(rows, state) {
  await withStore(STORE_NAMES, "readwrite", async (objectStores) => {
    const stores = Object.fromEntries(STORE_NAMES.map((n, i) => [n, objectStores[i]]));
    const localRemap = new Map(); // 本機輸掉的單字 id → 贏的 id（本機例句要改掛）

    for (const row of rows) {
      const store = stores[row.store];
      if (!store) continue;
      const key = `${row.store}/${row.record_id}`;

      if (row.deleted) {
        const local = await req(store.get(row.record_id));
        if (local) await req(store.delete(row.record_id));
        delete state.synced[key];
        continue;
      }

      let remote = row.data;
      if (!remote || typeof remote !== "object") continue;
      const remoteFp = fingerprint(remote);

      // 例句、複習紀錄掛在「已經判定輸掉」的單字底下 → 改掛到贏的那筆
      if ((row.store === STORES.OCCURRENCES || row.store === STORES.REVIEW_EVENTS) && state.aliases[remote.vocabularyWordId]) {
        remote = { ...remote, vocabularyWordId: state.aliases[remote.vocabularyWordId] };
      }

      const local = await req(store.get(row.record_id));
      if (local) {
        const keep = mergeRecord(row.store, local, remote);
        if (keep === remote) await tryReq(store.put(remote));
        state.synced[key] = remoteFp; // 本機留下的若不同於雲端，推的時候就會被推上去
        continue;
      }

      // 本機沒有，但雲端這一版正是上次同步時的那一版 → 是本機刪掉的，不要把它拉回來。
      // 推的時候會發現「指紋表有、本機沒有」，送出墓碑。
      // （如果雲端在這之後被別台電腦改過，指紋就不同，會走下面的路把它加回來——寧可多留，不要誤刪）
      if (state.synced[key] === remoteFp) continue;

      if (row.store === STORES.VOCABULARY) {
        const same = await req(
          store.index("byLangTerm").get([remote.language || "en", remote.normalizedTerm || ""])
        );
        if (same && same.id !== remote.id) {
          const winner = pickVocabWinner(same, remote);
          if (winner === same) {
            // 雲端這筆輸了：不寫進本機。指紋照記，推的時候發現本機沒有它 → 自動推一個墓碑
            state.aliases[remote.id] = same.id;
            state.synced[key] = remoteFp;
            continue;
          }
          // 本機這筆輸了：換成雲端那筆，本機底下的例句、複習紀錄改掛過去
          await req(store.delete(same.id));
          state.aliases[same.id] = remote.id;
          localRemap.set(same.id, remote.id);
        }
      }

      const added = await tryReq(store.put(remote));
      if (added.ok) state.synced[key] = remoteFp;
    }

    // 本機輸掉的單字，底下的例句與複習紀錄改掛到贏的那筆（改完指紋不同，稍後會被推上去）
    for (const [fromId, toId] of localRemap) {
      for (const name of [STORES.OCCURRENCES, STORES.REVIEW_EVENTS]) {
        const children = await req(stores[name].index("byWord").getAll(fromId));
        for (const child of children) await req(stores[name].put({ ...child, vocabularyWordId: toId }));
      }
    }
  });
}

async function pullAll(api, state, stats) {
  let cursor = state.cursor ? new Date(Date.parse(state.cursor) - PULL_OVERLAP_MS).toISOString() : null;
  let newest = state.cursor;

  for (let guard = 0; guard < 10000; guard++) {
    const rows = await api.pull(cursor, PULL_PAGE_SIZE);
    if (!rows.length) break;
    await applyRemotePage(rows, state);
    stats.pulled += rows.length;

    const last = rows[rows.length - 1].updated_at;
    if (!newest || last > newest) newest = last;
    if (rows.length < PULL_PAGE_SIZE) break;
    if (last === cursor) break; // 一整頁都是同一個時間點（理論上不會發生），避免無窮迴圈
    cursor = last;
  }
  state.cursor = newest || null;
}

// ---------- 推 ----------

async function readAllLocal() {
  return withStore(STORE_NAMES, "readonly", async (objectStores) => {
    const out = {};
    for (let i = 0; i < STORE_NAMES.length; i++) out[STORE_NAMES[i]] = await req(objectStores[i].getAll());
    return out;
  });
}

function planPush(local, state) {
  const upserts = [];
  const seen = new Set();
  for (const name of STORE_NAMES) {
    for (const record of local[name] || []) {
      const id = record && record[KEY_OF[name]];
      if (id === undefined || id === null || id === "") continue;
      const key = `${name}/${id}`;
      seen.add(key);
      const fp = fingerprint(record);
      if (state.synced[key] === fp) continue;
      // 雲端每筆最多 64KB。正常的單字、例句遠小於此；真的有超大的一筆就跳過它，
      // 不能讓它卡住整批上傳、害其他資料也同步不了
      if (JSON.stringify(record).length > MAX_RECORD_CHARS) {
        console.warn(`[FlowStudy] ${key} 太大，略過同步`);
        continue;
      }
      upserts.push({ key, fp, row: { store: name, record_id: String(id), data: record, deleted: false } });
    }
  }
  const tombstones = [];
  for (const key of Object.keys(state.synced)) {
    if (seen.has(key)) continue;
    const slash = key.indexOf("/");
    tombstones.push({ key, row: { store: key.slice(0, slash), record_id: key.slice(slash + 1), data: {}, deleted: true } });
  }
  return { upserts, tombstones, syncedCount: Object.keys(state.synced).length };
}

function looksLikeDataLoss(plan) {
  return plan.tombstones.length >= MASS_DELETE_MIN && plan.tombstones.length > plan.syncedCount * MASS_DELETE_RATIO;
}

async function pushPlanned(api, state, items, stats) {
  for (let i = 0; i < items.length; i += PUSH_BATCH_SIZE) {
    const batch = items.slice(i, i + PUSH_BATCH_SIZE);
    await api.push(batch.map((item) => item.row));
    for (const item of batch) {
      if (item.row.deleted) delete state.synced[item.key];
      else state.synced[item.key] = item.fp;
    }
    stats.pushed += batch.length;
  }
}

// ---------- 對外 ----------

/**
 * 跟雲端同步一次。
 *   api.pull(cursor, limit) → [{ store, record_id, data, deleted, updated_at }]（依 updated_at 由舊到新）
 *   api.push(rows)          → 把列 upsert 上去
 * 同步狀態存在 meta（依使用者分開），換帳號登入不會拿別人的指紋來比對。
 */
export async function syncWithCloud({ userId, api }) {
  if (!userId) throw new Error("沒有登入，無法同步");
  const stateKey = syncStateKey(userId);
  const saved = await getMeta(stateKey, null);
  const state = {
    cursor: (saved && saved.cursor) || null,
    synced: { ...((saved && saved.synced) || {}) },
    aliases: { ...((saved && saved.aliases) || {}) },
  };
  const stats = { pulled: 0, pushed: 0, deleted: 0, recoveredFromLoss: false };

  const save = () => setMeta(stateKey, { ...state, lastSyncAt: new Date().toISOString() });

  await pullAll(api, state, stats);
  await save();

  let plan = planPush(await readAllLocal(), state);

  if (looksLikeDataLoss(plan)) {
    console.warn(
      `[FlowStudy] 本機少了 ${plan.tombstones.length} / ${plan.syncedCount} 筆已同步的紀錄，判定為資料遺失而不是刪除；` +
        "不推送任何刪除，改從雲端完整拉回。"
    );
    stats.recoveredFromLoss = true;
    state.cursor = null;
    state.synced = {};
    await pullAll(api, state, stats);
    await save();
    plan = planPush(await readAllLocal(), state);
    plan.tombstones = []; // 保險：這一輪不刪雲端任何東西
  }

  await pushPlanned(api, state, plan.upserts, stats);
  await pushPlanned(api, state, plan.tombstones, stats);
  stats.deleted = plan.tombstones.length;
  await save();
  return stats;
}

/** 登出或換帳號時用：清掉某個使用者的同步狀態（本機學習資料不動）。 */
export async function resetSyncState(userId) {
  if (userId) await setMeta(syncStateKey(userId), null);
}
