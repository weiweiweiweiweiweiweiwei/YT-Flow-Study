// ============================================================================
// 雲端同步的排程與連線（background 專用）
// ============================================================================
//
// core/cloud/sync.js 只管「怎麼合併」，不知道網路和登入的存在；
// 這支檔案負責把它接上 Supabase，並決定什麼時候同步：
//   - 登入完成後立刻同步一次（新電腦登入 → 資料直接拉回來）
//   - 收藏單字、刪改單字、結束一段沉浸之後 15 秒（連續操作只會同步一次）
//   - 之後每 5 分鐘一次，補上設定頁、記憶固化頁直接改資料庫的變動
// 沒登入時全部安靜跳過，擴充功能照常在本機運作。
// ============================================================================

import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./core/cloud/config.js";
import { getValidSession, forceRefresh } from "./core/cloud/auth.js";
import { syncWithCloud } from "./core/cloud/sync.js";

const STATUS_KEY = "flowstudySyncStatus";
const ALARM_NAME = "flowstudy-cloud-sync";
const ALARM_PERIOD_MINUTES = 5;

let running = null;
let debounceTimer = null;
let onDataChanged = () => {};

// ---------- Supabase REST（PostgREST）----------

function createRestApi(initialSession) {
  let session = initialSession;

  async function call(path, init) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        ...init,
        headers: {
          apikey: SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
          ...(init && init.headers),
        },
      });
      // token 剛好在這一刻過期：換一次新的再試，只試一次
      if (res.status === 401 && attempt === 0) {
        session = await forceRefresh();
        if (!session) throw new Error("登入已過期，請重新登入");
        continue;
      }
      if (!res.ok) {
        let detail = "";
        try {
          const body = await res.json();
          detail = body.message || body.hint || JSON.stringify(body);
        } catch (e) {}
        throw new Error(`雲端回應錯誤（HTTP ${res.status}）${detail ? "：" + detail : ""}`);
      }
      return res;
    }
    throw new Error("登入已過期，請重新登入");
  }

  return {
    async pull(cursor, limit) {
      const params = new URLSearchParams({
        select: "store,record_id,data,deleted,updated_at",
        order: "updated_at.asc,record_id.asc",
        limit: String(limit),
      });
      if (cursor) params.append("updated_at", `gte.${cursor}`);
      const res = await call(`sync_records?${params}`, { method: "GET" });
      return res.json();
    },
    async push(rows) {
      if (!rows.length) return;
      const userId = session.user.id;
      await call("sync_records?on_conflict=user_id,store,record_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(rows.map((r) => ({ user_id: userId, ...r }))),
      });
    },
  };
}

// ---------- 對外 ----------

export async function getSyncStatus() {
  const data = await chrome.storage.local.get(STATUS_KEY);
  return data[STATUS_KEY] || null;
}

export async function clearSyncStatus() {
  await chrome.storage.local.remove(STATUS_KEY);
}

export function runCloudSync({ reason = "auto" } = {}) {
  if (running) return running;
  running = doSync(reason).finally(() => {
    running = null;
  });
  return running;
}

async function doSync(reason) {
  let session;
  try {
    session = await getValidSession();
  } catch (err) {
    const status = { at: new Date().toISOString(), ok: false, reason, error: err.message || String(err) };
    await chrome.storage.local.set({ [STATUS_KEY]: status });
    return status;
  }
  if (!session || !session.user) return { skipped: "signed-out" };

  try {
    const stats = await syncWithCloud({ userId: session.user.id, api: createRestApi(session) });
    if (stats.pulled || stats.recoveredFromLoss) await onDataChanged();
    const status = { at: new Date().toISOString(), ok: true, reason, ...stats };
    await chrome.storage.local.set({ [STATUS_KEY]: status });
    return status;
  } catch (err) {
    console.warn("[FlowStudy] 雲端同步失敗：", err);
    const status = { at: new Date().toISOString(), ok: false, reason, error: err.message || String(err) };
    await chrome.storage.local.set({ [STATUS_KEY]: status });
    return status;
  }
}

/** 資料剛變動時呼叫：等一小段時間再同步，連續收藏好幾個字只會同步一次。 */
export function scheduleCloudSync(delayMs = 15000) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runCloudSync({ reason: "change" }).catch(() => {}), delayMs);
}

/**
 * handlers.onDataChanged：同步從雲端拉回資料之後要做的事
 * （例如重建字幕底線用的單字索引）。
 */
export async function initCloudSync(handlers = {}) {
  if (handlers.onDataChanged) onDataChanged = handlers.onDataChanged;
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) runCloudSync({ reason: "auto" }).catch(() => {});
  });
  // 跟自動備份同一個道理：只在不存在時建立，否則頻繁喚醒會一直把鬧鐘往後推
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES, delayInMinutes: 1 });
}
