// ============================================================================
// 沉浸 session 倉儲層
// ============================================================================
//
// 核心原則：只累計「真的有在看」的時間。
//
// 實作上用「真實流逝的時間」（Date.now() 的差值）累計，而不是影片播放位置的差值。
// 這個選擇一次解決了兩個需求：
//   - 拖曳進度條從 02:00 跳到 20:00，中間 18 分鐘不會被算進去
//     （牆上的時鐘並沒有因為你拖了進度條就走得比較快）
//   - 調整播放速度（0.5x / 2x）也不會扭曲統計數字
//
// 暫停時呼叫端會停止累加，session 的 watchedSeconds 就停在那裡。
// ============================================================================

import { STORES, withStore, getAll, getById, put, remove, iterateIndex } from "./db.js";
import { createImmersionSession, nowIso, toLocalDateKey } from "../models.js";

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// 一次觀看至少要累積這麼多秒才值得留存。
// 沒有這個門檻的話，使用者在推薦影片之間快速點來點去，會留下一堆 1~2 秒的
// 垃圾 session，把「學習次數」這個統計數字灌水到毫無意義。
export const MIN_MEANINGFUL_SECONDS = 20;

export async function startSession({ videoId, videoTitle = "", language = "en" } = {}) {
  const session = createImmersionSession({ videoId, videoTitle, language });
  await put(STORES.IMMERSION_SESSIONS, session);
  return session;
}

/**
 * 累加某個 session 的觀看秒數。
 *
 * 用「加法」而不是「直接設定總值」：background 收到的是每次心跳之間的增量，
 * 這樣就算有某一次訊息漏掉，也只會少算那幾秒，不會把整個累計值覆蓋成錯的。
 */
export async function addWatchedSeconds(sessionId, deltaSeconds) {
  if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return null;
  return withStore(STORES.IMMERSION_SESSIONS, "readwrite", async (store) => {
    const session = await promisify(store.get(sessionId));
    if (!session) return null;
    session.watchedSeconds = Math.round((session.watchedSeconds || 0) + deltaSeconds);
    session.endedAt = nowIso();
    await promisify(store.put(session));
    return session;
  });
}

export async function endSession(sessionId) {
  return withStore(STORES.IMMERSION_SESSIONS, "readwrite", async (store) => {
    const session = await promisify(store.get(sessionId));
    if (!session) return null;
    session.endedAt = nowIso();

    // 太短的 session 直接丟掉，不要污染統計
    if ((session.watchedSeconds || 0) < MIN_MEANINGFUL_SECONDS) {
      await promisify(store.delete(sessionId));
      return { ...session, discarded: true };
    }

    await promisify(store.put(session));
    return session;
  });
}

// 擴充功能重新載入 / 瀏覽器當掉時，可能留下沒有正常結束的 session。
// 這些 session 的 endedAt 已經由 addWatchedSeconds 持續更新，所以資料本身沒問題，
// 只是沒被正式關閉。這裡負責把它們清乾淨。
export async function closeStaleSessions(olderThanMs = 10 * 60 * 1000, now = new Date()) {
  const cutoff = now.getTime() - olderThanMs;
  const stale = [];
  await iterateIndex(STORES.IMMERSION_SESSIONS, "byStartedAt", null, "next", (session) => {
    if (session.endedAt) return true;
    const started = new Date(session.startedAt).getTime();
    if (Number.isFinite(started) && started < cutoff) stale.push(session);
    return true;
  });

  for (const s of stale) await endSession(s.id);
  return stale.length;
}

export async function getSession(id) {
  return getById(STORES.IMMERSION_SESSIONS, id);
}

export async function getAllSessions() {
  return getAll(STORES.IMMERSION_SESSIONS);
}

export async function getSessionsBetween(startIso, endIso) {
  const rows = [];
  await iterateIndex(
    STORES.IMMERSION_SESSIONS,
    "byStartedAt",
    IDBKeyRange.bound(startIso, endIso),
    "next",
    (row) => {
      rows.push(row);
      return true;
    }
  );
  return rows;
}

// 今天總共沉浸了幾秒（首頁的每日目標進度條要用）
export async function getTodaySeconds(now = new Date()) {
  const todayKey = toLocalDateKey(now);
  let total = 0;
  await iterateIndex(STORES.IMMERSION_SESSIONS, "byStartedAt", null, "prev", (session) => {
    const key = toLocalDateKey(session.startedAt);
    if (key === todayKey) {
      total += session.watchedSeconds || 0;
      return true;
    }
    return key > todayKey; // 由新到舊走訪，掃過今天就可以停
  });
  return total;
}

export async function deleteSession(id) {
  return remove(STORES.IMMERSION_SESSIONS, id);
}

// 依「每一天」彙總，找出異常的紀錄讓使用者檢查。
// 影片放著整夜沒關、或瀏覽器當掉留下沒結束的 session，都可能灌出離譜的單日時數。
export async function getDailyBreakdown() {
  const all = await getAllSessions();
  const byDate = new Map();
  for (const s of all) {
    const key = toLocalDateKey(s.startedAt);
    if (!key) continue;
    if (!byDate.has(key)) byDate.set(key, { date: key, seconds: 0, sessions: [] });
    const day = byDate.get(key);
    day.seconds += s.watchedSeconds || 0;
    day.sessions.push(s);
  }
  return Array.from(byDate.values()).sort((a, b) => b.date.localeCompare(a.date));
}

// 從別的工具帶過來的既有時數。用單一一筆標記來源的 session 表示，
// 想改數字就改這一筆，不必去動任何真實記錄到的觀看紀錄。
export const LEGACY_SOURCE = "legacy-zerostudy";

export async function getLegacySession() {
  const all = await getAllSessions();
  return all.find((s) => s.source === LEGACY_SOURCE) || null;
}

/**
 * 設定「帶入的既有時數」。
 *
 * 日期刻意放在所有真實紀錄之前，這樣它會計進總時數，
 * 但不會在首頁「最近 7 天」的長條圖裡冒出一根柱子。
 */
export async function setLegacySeconds(seconds) {
  const existing = await getLegacySession();

  if (seconds <= 0) {
    if (existing) await deleteSession(existing.id);
    return null;
  }

  if (existing) {
    existing.watchedSeconds = Math.round(seconds);
    await put(STORES.IMMERSION_SESSIONS, existing);
    return existing;
  }

  const all = await getAllSessions();
  let earliest = null;
  for (const s of all) {
    if (!earliest || String(s.startedAt) < String(earliest)) earliest = s.startedAt;
  }
  const anchor = earliest ? new Date(earliest) : new Date();
  anchor.setDate(anchor.getDate() - 1);
  anchor.setHours(12, 0, 0, 0);

  const session = createImmersionSession({
    videoId: "",
    videoTitle: "",
    startedAt: anchor.toISOString(),
    source: LEGACY_SOURCE,
  });
  session.watchedSeconds = Math.round(seconds);
  session.endedAt = anchor.toISOString();
  await put(STORES.IMMERSION_SESSIONS, session);
  return session;
}

// 最早一筆沉浸紀錄的時間 = 使用者「開始學習的那一天」。
// 用 byStartedAt 索引往前取第一筆就停，不會把整個資料表讀進來。
export async function getFirstSessionDate() {
  let first = null;
  await iterateIndex(STORES.IMMERSION_SESSIONS, "byStartedAt", null, "next", (session) => {
    first = session.startedAt;
    return false; // 拿到第一筆就停
  });
  return first;
}

export async function getTotalSeconds() {
  let total = 0;
  await iterateIndex(STORES.IMMERSION_SESSIONS, "byStartedAt", null, "next", (session) => {
    total += session.watchedSeconds || 0;
    return true;
  });
  return total;
}
