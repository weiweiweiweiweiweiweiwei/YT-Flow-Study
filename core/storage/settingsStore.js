// ============================================================================
// 設定倉儲層
// ============================================================================
//
// 設定刻意「不」放 IndexedDB，而是留在 chrome.storage.local，原因有三個：
//   1. content script 需要讀設定（快捷鍵、目標語言），但它在 youtube.com 的
//      origin，碰不到擴充功能的 IndexedDB。chrome.storage 則是跨 origin 共用的。
//   2. 設定資料量很小而且固定，沒有 IndexedDB 的索引需求。
//   3. chrome.storage.onChanged 可以讓所有分頁即時同步，不用自己做通知機制。
//
// 對外只暴露一個型別明確的 Settings 物件，不讓各頁面各自去讀散落的 key。
// ============================================================================

import { DEFAULT_SETTINGS, mergeSettings } from "../models.js";

const SETTINGS_KEY = "flowstudySettings";

// 舊版本把設定散在幾個獨立的 key 裡。這裡把它們認回來，
// 使用者升級後不會發現自己的每日目標和深淺色設定被重設了。
const LEGACY_KEYS = ["dailyGoalMinutes", "themePreference"];

function storageGet(keys) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (data) => resolve(data || {}));
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

export async function getSettings() {
  const data = await storageGet([SETTINGS_KEY, ...LEGACY_KEYS]);
  const stored = data[SETTINGS_KEY];

  if (stored) return mergeSettings(stored);

  // 還沒有新格式：從舊的獨立 key 組出一份
  const migrated = mergeSettings({
    dailyGoalMinutes: data.dailyGoalMinutes,
    theme: data.themePreference,
  });
  return migrated;
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = mergeSettings({
    ...current,
    ...patch,
    shortcuts: { ...current.shortcuts, ...(patch && patch.shortcuts ? patch.shortcuts : {}) },
  });

  // 同時寫回舊的獨立 key。review.js 的首頁與 theme-init.js 還在讀它們，
  // 一起更新才不會出現「設定頁改了、首頁沒跟著變」的情況。
  await storageSet({
    [SETTINGS_KEY]: next,
    dailyGoalMinutes: next.dailyGoalMinutes,
    themePreference: next.theme,
  });

  return next;
}

export async function resetSettings() {
  return saveSettings(DEFAULT_SETTINGS);
}

// 設定變動時通知呼叫端。回傳取消訂閱的函式，元件卸載時要記得呼叫，
// 否則反覆切換頁面會累積出一堆監聽器。
export function onSettingsChanged(callback) {
  const listener = (changes, area) => {
    if (area !== "local") return;
    if (changes[SETTINGS_KEY]) callback(mergeSettings(changes[SETTINGS_KEY].newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export { DEFAULT_SETTINGS, SETTINGS_KEY };
