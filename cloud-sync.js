// ============================================================================
// 雲端同步的排程與連線（background 專用）
// ============================================================================
//
// core/cloud/sync.js 只管「怎麼合併」，不知道網路和登入的存在；
// 這支檔案負責把它接上使用者的 Google 雲端硬碟（core/cloud/drive.js），並決定什麼時候同步：
//   - 登入完成後立刻同步一次（新電腦登入 → 資料直接拉回來）
//   - 收藏單字、刪改單字、結束一段沉浸之後 15 秒（連續操作只會同步一次）
//   - 之後每 5 分鐘一次，補上設定頁、記憶固化頁直接改資料庫的變動
// 沒登入時全部安靜跳過，擴充功能照常在本機運作。
// ============================================================================

import { getValidSession, getAccessToken, forceRenewToken } from "./core/cloud/auth.js";
import { createDriveApi } from "./core/cloud/drive.js";
import { syncWithCloud } from "./core/cloud/sync.js";

const STATUS_KEY = "flowstudySyncStatus";
const ALARM_NAME = "flowstudy-cloud-sync";
const ALARM_PERIOD_MINUTES = 5;

let running = null;
let debounceTimer = null;
let onDataChanged = () => {};

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
    // 每次同步都建一個新的 api：它會把雲端硬碟上的同步檔讀一次，這一輪都用同一份
    const api = createDriveApi({ getToken: getAccessToken, renewToken: forceRenewToken });
    const stats = await syncWithCloud({ userId: session.user.id, api });
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
