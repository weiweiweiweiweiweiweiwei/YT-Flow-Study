// ============================================================================
// 自動備份：把學習資料定期寫成「下載」資料夾裡的 JSON 檔
// ============================================================================
//
// 備份檔放在 下載/FlowStudy Backups/flowstudy-backup-YYYY-MM-DD.json，一天一個檔。
// 選下載資料夾是因為它在擴充功能的管轄範圍之外：就算在 chrome://extensions 按了
// 「移除」、或資料夾改名讓擴充功能 ID 變了，這些檔案都還在。
//
// 什麼時候備份：
//   - 擴充功能每次重新載入（改完程式碼按 ⟳）時——改版前的資料一定有一份在檔案裡
//   - 之後每小時檢查一次，資料有變動才寫
//   - 設定頁的「立即備份」
//
// 「不會把好的備份蓋掉」的三道保險：
//   1. 一天一個檔，前幾天的檔案永遠不會再被寫入
//   2. 資料庫是空的就不備份——資料被清掉之後，空的快照不會去覆蓋任何東西
//   3. 只覆蓋「這次安裝自己寫過的」同日檔案。重新安裝之後第一次寫入時，
//      如果同名檔已經存在（上一次安裝留下的），會另存成「… (1).json」，不覆蓋
// ============================================================================

import { buildBackupSnapshot, isSummaryEmpty } from "./core/storage/backup.js";
import { toLocalDateKey } from "./core/models.js";

export const BACKUP_FOLDER = "FlowStudy Backups";

const STATUS_KEY = "flowstudyBackupStatus"; // 最近一次備份的結果，設定頁顯示用
const WRITTEN_KEY = "flowstudyBackupWritten"; // { "2026-09-26": "實際寫入的檔名" }
const ALARM_NAME = "flowstudy-auto-backup";
const ALARM_PERIOD_MINUTES = 60;
const DOWNLOAD_TIMEOUT_MS = 30 * 1000;

let running = null; // 同一時間只跑一個備份，連點「立即備份」也只會寫一次

// ---------- 小工具 ----------

async function readLocal(key, fallback) {
  const data = await chrome.storage.local.get(key);
  return data[key] === undefined ? fallback : data[key];
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function basename(path) {
  return String(path || "").split(/[\\/]/).pop();
}

// ---------- blob 網址（需要 offscreen 文件）----------
//
// chrome.downloads 需要一個網址。service worker 裡沒有 URL.createObjectURL，
// 而 data: 網址超過 2MB 會被 Chrome 拒絕——單字、例句、沉浸紀錄累積一兩年後
// 很可能超過。所以請一個看不見的 offscreen 頁面代為產生 blob: 網址。

async function ensureOffscreen() {
  try {
    if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) return;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "把學習資料轉成可以存進下載資料夾的備份檔",
    });
  } catch (err) {
    // 另一個備份剛好先建好了，不算錯誤
    if (!String((err && err.message) || err).includes("single offscreen")) throw err;
  }
}

async function closeOffscreen() {
  try {
    await chrome.offscreen.closeDocument();
  } catch (e) {}
}

async function makeBlobUrl(json) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: "offscreen", type: "backup:makeUrl", json });
  if (!res || !res.url) throw new Error("無法產生備份檔");
  return res.url;
}

// ---------- 下載 ----------

function waitForDownload(id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(onChanged);
      reject(new Error("寫入備份檔逾時"));
    }, DOWNLOAD_TIMEOUT_MS);

    function onChanged(delta) {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === "complete") {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve();
      } else if (delta.state.current === "interrupted") {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(onChanged);
        reject(new Error("寫入備份檔失敗：" + ((delta.error && delta.error.current) || "中斷")));
      }
    }
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

// 備份是背景的例行工作，不該每小時在工具列跳一次下載提示。
// 這個 API 需要 downloads.ui 權限；拿不到就算了，頂多看到提示。
async function setDownloadUi(enabled) {
  try {
    if (chrome.downloads.setUiOptions) await chrome.downloads.setUiOptions({ enabled });
  } catch (e) {}
}

async function writeFile(relativePath, json, conflictAction) {
  const url = await makeBlobUrl(json);
  let id = null;
  await setDownloadUi(false);
  try {
    id = await chrome.downloads.download({ url, filename: relativePath, conflictAction, saveAs: false });
    await waitForDownload(id);
    const [item] = await chrome.downloads.search({ id });
    return item ? item.filename : "";
  } finally {
    await setDownloadUi(true);
    // 只清掉「下載紀錄」這一行，檔案本身留在磁碟上。
    // 不清的話 chrome://downloads 會被每小時一筆的備份洗版。
    if (id !== null) chrome.downloads.erase({ id }).catch(() => {});
    // 關掉 offscreen 頁面時，它產生的 blob 網址會一起釋放，不必另外 revoke
    await closeOffscreen();
  }
}

// ---------- 對外 ----------

export async function getBackupStatus() {
  return readLocal(STATUS_KEY, null);
}

/**
 * 執行一次備份。
 *   force = false：資料跟上次備份一模一樣就跳過（自動備份）
 *   force = true ：照樣寫一次（設定頁的「立即備份」）
 * 資料庫是空的時候無論如何都不寫。
 */
export function runBackup({ reason = "auto", force = false } = {}) {
  if (running) return running;
  running = doBackup({ reason, force }).finally(() => {
    running = null;
  });
  return running;
}

async function doBackup({ reason, force }) {
  const previous = await getBackupStatus();
  try {
    const snapshot = await buildBackupSnapshot({ extensionVersion: chrome.runtime.getManifest().version });
    if (isSummaryEmpty(snapshot.summary)) {
      return { skipped: "empty", status: previous };
    }

    // 指紋只看資料本身，不含 exportedAt，否則每次都會被當成「有變動」
    const digest = await sha256(JSON.stringify({ stores: snapshot.stores, storageLocal: snapshot.storageLocal }));
    if (!force && previous && previous.digest === digest && !previous.error) {
      return { skipped: "unchanged", status: previous };
    }

    const dateKey = toLocalDateKey(new Date());
    const written = await readLocal(WRITTEN_KEY, {});
    const ownFile = written[dateKey];
    const relativePath = `${BACKUP_FOLDER}/${ownFile || `flowstudy-backup-${dateKey}.json`}`;
    const fullPath = await writeFile(relativePath, JSON.stringify(snapshot), ownFile ? "overwrite" : "uniquify");

    const status = {
      at: new Date().toISOString(),
      reason,
      file: fullPath,
      summary: snapshot.summary,
      digest,
      error: null,
    };
    await chrome.storage.local.set({
      [STATUS_KEY]: status,
      [WRITTEN_KEY]: { ...written, [dateKey]: basename(fullPath) || basename(relativePath) },
    });
    return { skipped: false, status };
  } catch (err) {
    console.error("[FlowStudy] 自動備份失敗：", err);
    // 保留上一次成功的資訊，只附上這次的錯誤，設定頁才看得出「最後一份好的備份」是哪一份
    const status = { ...(previous || {}), error: String((err && err.message) || err), errorAt: new Date().toISOString() };
    await chrome.storage.local.set({ [STATUS_KEY]: status });
    throw err;
  }
}

export async function initAutoBackup() {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) runBackup({ reason: "auto" }).catch(() => {});
  });
  // service worker 每次被喚醒都會跑到這裡。alarms.create 會把同名鬧鐘「重設」，
  // 如果每次都呼叫，頻繁喚醒時鬧鐘會一直被往後推、永遠響不了——所以只在不存在時建立。
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES, delayInMinutes: 5 });
  }
}
