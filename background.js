// ============================================================================
// 背景 service worker
// ============================================================================
//
// 兩個職責：
//   1. 代為發出翻譯 / 發音的網路請求（避開 YouTube 頁面的 CSP 限制）
//   2. 當 content script 存取學習資料的唯一窗口
//
// 為什麼資料存取一定要繞過這裡？
//   content script 跑在 youtube.com 的 origin，它看到的 indexedDB 是 YouTube
//   自己的資料庫。擴充功能的資料庫在 chrome-extension:// 這個 origin 底下，
//   只有 service worker 和擴充功能頁面碰得到。所以 content script 想寫單字，
//   只能透過 chrome.runtime.sendMessage 請這裡代勞。
//
// 這支檔案是 ES module（manifest 裡宣告 "type": "module"），
// 可以直接 import core/ 底下的模組，不需要任何打包工具。
// ============================================================================

import { saveWordFromSubtitle, getAllWords } from "./core/storage/vocabularyStore.js";
import {
  startSession,
  addWatchedSeconds,
  endSession,
  closeStaleSessions,
  getTodaySeconds,
} from "./core/storage/immersionStore.js";
import { upsertVideo } from "./core/storage/videoStore.js";
import { runMigrationIfNeeded, importLegacyHoursIfNeeded } from "./core/storage/migrate.js";
import { lookupWord } from "./core/dictionary/lookup.js";

// chrome.storage.session 預設只有 extension 頁面（background/popup）能存取，
// content script 拿不到。這裡把存取範圍打開，讓 content.js 也能直接讀寫，
// 用來存放沉浸計時器的「本次瀏覽器工作階段」狀態。
if (chrome.storage.session && chrome.storage.session.setAccessLevel) {
  chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" }).catch(() => {});
}

// ---------- 啟動時的維護工作 ----------

async function bootstrap() {
  try {
    const result = await runMigrationIfNeeded();
    if (!result.skipped) {
      console.log("[FlowStudy] 舊資料搬移完成：", result);
    }
  } catch (err) {
    // 搬移失敗不能讓整個擴充功能停擺。舊資料原封不動還在 chrome.storage.local，
    // 沒有遺失風險，下次啟動會再試一次。
    console.error("[FlowStudy] 舊資料搬移失敗（舊資料仍然保留，下次啟動會重試）：", err);
  }

  try {
    // 把轉用這個工具之前，在 zeroStudy 累積的時數帶進來（只會執行一次）
    const legacy = await importLegacyHoursIfNeeded();
    if (!legacy.skipped) {
      console.log(`[FlowStudy] 已帶入先前累積的 ${legacy.hours} 小時 ${legacy.minutes} 分沉浸時數`);
    }
  } catch (err) {
    console.warn("[FlowStudy] 帶入既有時數失敗：", err);
  }

  try {
    // 瀏覽器當掉或擴充功能重新載入時，可能留下沒有正常結束的 session
    const closed = await closeStaleSessions();
    if (closed) console.log(`[FlowStudy] 已結束 ${closed} 個中斷的沉浸 session`);
  } catch (err) {
    console.warn("[FlowStudy] 清理中斷的 session 失敗：", err);
  }

  // 搬移完成後重建一次索引，讓舊資料搬進來的單字也能在字幕上畫底線
  await syncMarkedTermsIndex();
}

chrome.runtime.onInstalled.addListener(bootstrap);
chrome.runtime.onStartup.addListener(bootstrap);
bootstrap(); // service worker 被喚醒時也跑一次（runMigrationIfNeeded 本身會判斷是否已搬過）

// ---------- 已收藏單字的索引（給 content.js 畫底線用）----------
//
// content.js 需要「這個字收藏過了沒」的即時判斷，才能在字幕上畫出橘色底線。
// 但它碰不到 IndexedDB，而且這個判斷發生在每一次字幕更新，不可能每次都發訊息問。
//
// 所以這裡維護一份「只有正規化後單字」的輕量索引放在 chrome.storage.local。
// 它是純粹的讀取用快取（read model），不是第二份資料來源——
// 真相永遠在 IndexedDB，這份索引只是從真相重新算出來的投影，隨時可以重建。
export const MARKED_TERMS_KEY = "flowstudyMarkedTerms";

async function syncMarkedTermsIndex() {
  try {
    const words = await getAllWords();
    const terms = words.map((w) => w.normalizedTerm).filter(Boolean);
    await chrome.storage.local.set({ [MARKED_TERMS_KEY]: terms });
    return terms.length;
  } catch (err) {
    console.warn("[FlowStudy] 已收藏單字索引更新失敗：", err);
    return 0;
  }
}

// ---------- 訊息路由 ----------
//
// 每個 handler 都回傳 Promise。統一在這裡包 try/catch 轉成
// { ok: false, error } 的形式，這樣 content script 永遠收得到回應，
// 不會因為背景丟出例外就一直等在那裡。
const HANDLERS = {
  translate: (msg) => translateText(msg.text),
  speak: (msg) => speakWord(msg.text),

  "vocab:save": async (msg) => {
    const result = await saveWordFromSubtitle(msg.payload);
    await syncMarkedTermsIndex(); // 立刻讓字幕上的底線反映新收藏
    return result;
  },
  // 單字頁刪除／編輯單字後呼叫，讓 YouTube 分頁的底線同步更新
  "vocab:syncIndex": () => syncMarkedTermsIndex(),

  "immersion:start": (msg) => startSession(msg.payload),
  "immersion:tick": (msg) => addWatchedSeconds(msg.payload.sessionId, msg.payload.deltaSeconds),
  "immersion:end": (msg) => endSession(msg.payload.sessionId),
  // 工具列小面板要顯示今天沉浸了幾分鐘。它碰不到 IndexedDB，一樣得問背景。
  "immersion:today": () => getTodaySeconds(),

  "video:upsert": (msg) => upsertVideo(msg.payload),

  // 播放器設定面板裡的「首頁」。content script 開不了擴充功能頁面，
  // 要由背景代為開啟。
  "open:dashboard": () => chrome.tabs.create({ url: chrome.runtime.getURL("review.html") }),

  // 詞彙庫的單字詳細頁。查詢結果會存進 IndexedDB，第二次開同一個字是瞬間顯示。
  "dict:lookup": (msg) => lookupWord(msg.payload.term),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  const handler = HANDLERS[msg.type];
  if (!handler) return;

  Promise.resolve()
    .then(() => handler(msg))
    .then((result) => {
      // 翻譯與發音沿用舊的回應格式（直接回傳結果物件），避免動到既有的呼叫端。
      // 資料層的新訊息則統一包成 { ok, data }。
      if (msg.type === "translate" || msg.type === "speak") sendResponse(result);
      else sendResponse({ ok: true, data: result });
    })
    .catch((err) => {
      console.error(`[FlowStudy] 處理訊息 ${msg.type} 時發生錯誤：`, err);
      if (msg.type === "translate" || msg.type === "speak") sendResponse({ error: String(err && err.message) });
      else sendResponse({ ok: false, error: String((err && err.message) || err) });
    });

  return true; // 保持通道開啟，等待非同步回覆
});

// ---------- 基礎翻譯：Google 翻譯的單字／片語查詢，秒回、免金鑰 ----------
async function translateText(text) {
  const cacheKey = "tr:" + text.toLowerCase();

  try {
    const cached = await chrome.storage.local.get(cacheKey);
    if (cached[cacheKey]) {
      return { original: text, translated: cached[cacheKey] };
    }
  } catch (e) {
    // 快取讀取失敗就當作沒快取，繼續往下即時查詢
  }

  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-TW&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    const data = await res.json();
    const translated = (data[0] || []).map((chunk) => chunk[0]).join("");

    if (!translated) {
      return { original: text, error: "查無翻譯結果" };
    }

    try {
      await chrome.storage.local.set({ [cacheKey]: translated }); // 只快取翻譯結果本身，不記錄查過哪些字
    } catch (e) {}

    return { original: text, translated };
  } catch (err) {
    console.error("翻譯失敗：", err);
    return { original: text, error: "翻譯失敗，請檢查網路連線" };
  }
}

// ---------- 發音：直接使用 Google 翻譯的朗讀語音 ----------
// 在背景這裡發出請求（而不是在網頁內容腳本裡），可以避開 YouTube 網頁本身的安全性設定（CSP）
// 對外部音檔的限制；抓回來的音檔轉成 data URL 傳回去，content.js 收到後直接播放。
async function speakWord(text) {
  try {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=en&client=tw-ob`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("TTS 請求失敗：" + res.status);
    const buf = await res.arrayBuffer();
    const base64 = arrayBufferToBase64(buf);
    return { audioDataUrl: `data:audio/mpeg;base64,${base64}` };
  } catch (err) {
    console.error("發音取得失敗：", err);
    return { error: "發音取得失敗" };
  }
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
