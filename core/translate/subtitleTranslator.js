// ============================================================================
// 中英雙字幕：把整部影片的英文句子翻成繁體中文（background 專用）
// ============================================================================
//
// 兩個翻譯引擎：
//   Gemini —— 使用者在設定頁填了 API 金鑰才用。一次送一批句子，看得到上下文，
//             口語、台灣用語、前後一致的人名都翻得比較自然。
//   Google —— 沒有金鑰、或 Gemini 失敗（額度用完、金鑰錯、網路問題）時的退路。
//             就是查單字那個免金鑰端點；一批句子用換行接起來一次送出，
//             實測送 7 句拆回 7 句、順序不變。
//
// Google 這個免費端點有流量限制：短時間翻太多，Google 會把「整個網路（IP）」擋下來一陣子——
// 回 429，或把請求導到 google.com/sorry 的「異常流量」頁。2026-09-29 實際發生過：
// 雙字幕一次翻整部影片、失敗的批次又自動重試，查單字跟雙字幕同時全部失效。
// 被擋之後再打只會讓封鎖拖更久，所以：
//   - 偵測到就記下來，冷卻期內（GOOGLE_COOLDOWN_MS）完全不再打 Google
//   - 冷卻期間查單字改用 Gemini（有金鑰的話）；沒有金鑰就老實告訴使用者原因
//   - 雙字幕送給 Google 的批次一次只送一批、中間隔一小段時間，不要一口氣灌出去
//
// 為什麼整部預先翻，而不是播到哪翻到哪？
//   字幕一句只停留兩三秒，等翻譯回來那句已經過去了。開啟時一批批送出去，
//   從「目前播到的地方」先翻（見 content.js），通常一兩秒內畫面上就有中文。
//
// 快取：每一句的翻譯存在 IndexedDB，key 是「引擎 + 英文原句」。
// 同一部影片再看、或別部影片出現一模一樣的句子，都不用再翻、也不花額度。
// 用 Google 翻過的句子，之後填了 Gemini 金鑰會重新用 Gemini 翻（兩者分開存）。
// ============================================================================

import { STORES, withStore } from "../storage/db.js";

export const GEMINI_KEY_STORAGE = "flowstudySecretGeminiKey"; // 備份檔會排除 flowstudySecret* 開頭的 key
export const TRANSLATE_STATUS_KEY = "flowstudyTranslateStatus";
// Google 被擋到什麼時候（毫秒時間戳）。存在 storage 而不是只放記憶體：
// service worker 隨時會被關掉重開，只放記憶體的話，重開之後又會馬上去撞。
export const GOOGLE_BLOCKED_KEY = "flowstudyTranslateGoogleBlockedUntil";

// 跟 VoiceInput 專案實際在用、確定能呼叫的是同一個模型。
// 伺服器說找不到這個模型（404）時，依序改試後面幾個。
export const GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-2.5-flash"];
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const GOOGLE_ENDPOINT = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-TW&dt=t";

const GOOGLE_MAX_CHARS = 4000; // 一次 POST 的上限，保守抓
const GOOGLE_COOLDOWN_MS = 30 * 60 * 1000; // 被擋之後多久內不再打 Google
const GOOGLE_BATCH_GAP_MS = 1500; // 雙字幕送給 Google 的批次之間至少隔多久

export const GOOGLE_BLOCKED_MESSAGE =
  "Google 翻譯暫時限制了這個網路（短時間內翻譯太多次），約 30 分鐘後自動恢復。在學習面板的設定填入 Gemini 金鑰可以馬上恢復";
const GEMINI_RETRY_AFTER_AUTH_ERROR_MS = 10 * 60 * 1000;

// 金鑰錯誤（400/401/403）時，這段時間內不再打 Gemini，直接用 Google。
// 否則一部影片幾十批，每一批都會先撞一次同樣的錯。
let geminiBlockedUntil = 0;
let workingModel = null; // 試出能用的模型後記住，不必每批都從頭試

// ---------- 快取 ----------

function cacheKey(engine, text) {
  return `${engine}|${text}`;
}

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readCache(engine, texts) {
  return withStore(STORES.SUBTITLE_TRANSLATIONS, "readonly", async (store) => {
    const out = [];
    for (const t of texts) {
      const row = await req(store.get(cacheKey(engine, t)));
      out.push(row ? row.zh : null);
    }
    return out;
  });
}

async function writeCache(engine, pairs) {
  if (!pairs.length) return;
  await withStore(STORES.SUBTITLE_TRANSLATIONS, "readwrite", async (store) => {
    const at = new Date().toISOString();
    for (const [text, zh] of pairs) await req(store.put({ key: cacheKey(engine, text), engine, text, zh, at }));
  });
}

// ---------- Google ----------

export class GoogleBlockedError extends Error {
  constructor() {
    super(GOOGLE_BLOCKED_MESSAGE);
    this.kind = "google-blocked";
  }
}

let googleBlockedUntil = null; // 記憶體裡的副本；null = 還沒從 storage 讀過

export async function isGoogleBlocked() {
  if (googleBlockedUntil === null) {
    try {
      const data = await chrome.storage.local.get(GOOGLE_BLOCKED_KEY);
      googleBlockedUntil = Number(data[GOOGLE_BLOCKED_KEY]) || 0;
    } catch (e) {
      googleBlockedUntil = 0;
    }
  }
  return Date.now() < googleBlockedUntil;
}

async function markGoogleBlocked() {
  googleBlockedUntil = Date.now() + GOOGLE_COOLDOWN_MS;
  try {
    await chrome.storage.local.set({ [GOOGLE_BLOCKED_KEY]: googleBlockedUntil });
  } catch (e) {}
}

// 所有打 Google 翻譯的請求都走這裡，才能統一認出「被擋了」
async function googleFetch(url, init) {
  const res = await fetch(url, init);
  // fetch 會自動跟著轉址走，被擋時最後停在 google.com/sorry 的頁面（狀態碼 429）
  if (res.status === 429 || /\/sorry\//.test(res.url)) {
    await markGoogleBlocked();
    throw new GoogleBlockedError();
  }
  if (!res.ok) throw new Error(`Google 翻譯回應 HTTP ${res.status}`);
  const data = await res.json();
  return (data[0] || []).map((chunk) => chunk[0]).join("");
}

// 雙字幕的批次排隊送：一次一批、前後至少隔 GOOGLE_BATCH_GAP_MS。
// 查單字不排隊（使用者點下去要馬上看到），只有整部影片的批次需要放慢。
let googleQueue = Promise.resolve();
let lastGoogleBatchAt = 0;

function pacedGoogle(task) {
  const run = googleQueue.then(async () => {
    const wait = lastGoogleBatchAt + GOOGLE_BATCH_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await task();
    } finally {
      lastGoogleBatchAt = Date.now();
    }
  });
  googleQueue = run.catch(() => {});
  return run;
}

async function googleOnce(joined) {
  if (await isGoogleBlocked()) throw new GoogleBlockedError();
  return pacedGoogle(() =>
    googleFetch(GOOGLE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "q=" + encodeURIComponent(joined),
    })
  );
}

export async function translateWithGoogle(texts) {
  const out = new Array(texts.length).fill("");
  // 依字數切成幾個 POST，每個 POST 內用換行分隔句子
  const groups = [];
  let cur = [];
  let len = 0;
  texts.forEach((t, i) => {
    if (cur.length && len + t.length + 1 > GOOGLE_MAX_CHARS) {
      groups.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(i);
    len += t.length + 1;
  });
  if (cur.length) groups.push(cur);

  for (const idxs of groups) {
    // 句子裡本來就有的換行先換成空白，換行只留給「句子之間」當分隔
    const joined = idxs.map((i) => texts[i].replace(/\s*\n\s*/g, " ")).join("\n");
    const parts = (await googleOnce(joined)).split("\n");
    if (parts.length === idxs.length) {
      idxs.forEach((i, k) => (out[i] = parts[k].trim()));
    } else {
      // 極少數情況拆回來的句數對不上（例如翻譯把兩句合成一句）：
      // 對不上就不猜，這一組改成一句一句翻，寧可慢一點也不要中英文錯位
      for (const i of idxs) out[i] = (await googleOnce(texts[i])).trim();
    }
  }
  return out;
}

// ---------- Gemini ----------

const SYSTEM_PROMPT = `你是影片字幕翻譯。把使用者給的英文字幕句子，逐句翻成台灣慣用的繁體中文。
規則：
- 輸出一個 JSON 陣列，長度必須和輸入完全相同，第 i 個元素就是第 i 句的翻譯。不要合併、拆開或省略任何一句。
- 這些句子是連續的口語，請參考前後文翻得自然通順，但每一句只放它自己的內容。
- 用台灣的說法（例如「影片」「軟體」「品質」），不要用中國大陸用語。
- 人名、品牌、歌名可保留英文原文。
- [music]、[laughter]、[applause] 這類標記翻成 [音樂]、[笑聲]、[掌聲]。
- 口吃或重複的詞（I I、the the）、語助詞（um、uh）不必照翻。
- 只輸出 JSON 陣列，不要任何說明文字。`;

function geminiBody(texts, title, withThinking) {
  const context = title ? `影片標題：${title}\n\n` : "";
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: `${context}字幕句子（JSON 陣列）：\n${JSON.stringify(texts)}` }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: { type: "ARRAY", items: { type: "STRING" } },
    },
  };
  // 翻譯不需要深度思考，用最低的等級換速度。
  // 伺服器不接受這個設定時（不同模型支援的值不同），拿掉它重送一次。
  if (withThinking) body.generationConfig.thinkingConfig = { thinkingLevel: "LOW" };
  return body;
}

class GeminiError extends Error {
  constructor(message, { status = 0, kind = "other" } = {}) {
    super(message);
    this.status = status;
    this.kind = kind; // auth | quota | model | thinking | format | other
  }
}

function explainGeminiError(status, message) {
  const low = String(message || "").toLowerCase();
  if (status === 401 || status === 403 || low.includes("api key not valid") || low.includes("api_key_invalid")) {
    return new GeminiError("Gemini 金鑰無效，請到設定頁確認金鑰有沒有貼錯", { status, kind: "auth" });
  }
  if (status === 429 || low.includes("quota") || low.includes("resource_exhausted")) {
    return new GeminiError("Gemini 免費額度暫時用完了，先改用 Google 翻譯", { status, kind: "quota" });
  }
  if (status === 404) return new GeminiError(`找不到 Gemini 模型：${message}`, { status, kind: "model" });
  if (status === 400 && (low.includes("thinking") || low.includes("thinkinglevel"))) {
    return new GeminiError(message, { status, kind: "thinking" });
  }
  if (status === 400 && low.includes("api key")) {
    return new GeminiError("Gemini 金鑰無效，請到設定頁確認金鑰有沒有貼錯", { status, kind: "auth" });
  }
  return new GeminiError(`Gemini 回應錯誤（HTTP ${status}）：${message}`, { status, kind: "other" });
}

async function geminiCall(apiKey, model, texts, title, withThinking) {
  const res = await fetch(`${GEMINI_ENDPOINT}/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(geminiBody(texts, title, withThinking)),
  });
  let data = null;
  try {
    data = await res.json();
  } catch (e) {}
  if (!res.ok) throw explainGeminiError(res.status, (data && data.error && data.error.message) || "");

  const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  // 有思考過程的模型，parts 裡可能夾著 thought 片段，只取真正的輸出
  const raw = parts.filter((p) => !p.thought).map((p) => p.text || "").join("").trim();
  let arr;
  try {
    arr = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch (e) {
    throw new GeminiError("Gemini 回傳的不是 JSON", { kind: "format" });
  }
  if (!Array.isArray(arr) || arr.length !== texts.length || !arr.every((x) => typeof x === "string")) {
    throw new GeminiError(`Gemini 回傳 ${Array.isArray(arr) ? arr.length : "非陣列"} 句，送出的是 ${texts.length} 句`, { kind: "format" });
  }
  return arr.map((s) => s.trim());
}

export async function translateWithGemini(apiKey, texts, title) {
  const models = workingModel ? [workingModel, ...GEMINI_MODELS.filter((m) => m !== workingModel)] : GEMINI_MODELS;
  let lastErr = null;
  for (const model of models) {
    let withThinking = true;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const out = await geminiCall(apiKey, model, texts, title, withThinking);
        workingModel = model;
        return out;
      } catch (err) {
        lastErr = err;
        if (err.kind === "thinking" && withThinking) {
          withThinking = false; // 這個模型不吃這個思考設定，拿掉再送
          continue;
        }
        if (err.kind === "format" && attempt === 0) continue; // 句數對不上，重試一次
        break;
      }
    }
    if (!lastErr || lastErr.kind !== "model") break; // 只有「找不到模型」才換下一個模型試
  }
  throw lastErr || new GeminiError("Gemini 翻譯失敗");
}

// ---------- 對外 ----------

async function getGeminiKey() {
  const data = await chrome.storage.local.get(GEMINI_KEY_STORAGE);
  const key = data[GEMINI_KEY_STORAGE];
  return typeof key === "string" && key.trim() ? key.trim() : "";
}

async function saveStatus(status) {
  try {
    await chrome.storage.local.set({ [TRANSLATE_STATUS_KEY]: { ...status, at: new Date().toISOString() } });
  } catch (e) {}
}

/**
 * 翻譯一批字幕句子。回傳 { translations, engine, notice }，translations 與 texts 一一對應。
 * 先查快取；快取沒有的才送出去翻。Gemini 失敗會自動改用 Google，不會讓使用者看不到中文。
 */
export async function translateSubtitleBatch({ texts, title = "" } = {}) {
  const list = (Array.isArray(texts) ? texts : []).map((t) => String(t || "").trim());
  if (!list.length) return { translations: [], engine: "none" };

  const apiKey = await getGeminiKey();
  const preferGemini = !!apiKey && Date.now() >= geminiBlockedUntil;
  const engine = preferGemini ? "gemini" : "google";

  const result = await readCache(engine, list);
  const missing = [];
  result.forEach((zh, i) => {
    if (zh === null && list[i]) missing.push(i);
    if (!list[i]) result[i] = "";
  });
  if (!missing.length) return { translations: result, engine };

  const missingTexts = missing.map((i) => list[i]);
  let usedEngine = engine;
  let notice = "";

  if (preferGemini) {
    try {
      const zh = await translateWithGemini(apiKey, missingTexts, title);
      missing.forEach((i, k) => (result[i] = zh[k]));
      await writeCache("gemini", missingTexts.map((t, k) => [t, zh[k]]));
      await saveStatus({ engine: "gemini", ok: true, model: workingModel });
      return { translations: result, engine: "gemini" };
    } catch (err) {
      notice = err.message;
      if (err.kind === "auth") geminiBlockedUntil = Date.now() + GEMINI_RETRY_AFTER_AUTH_ERROR_MS;
      await saveStatus({ engine: "gemini", ok: false, error: err.message });
      usedEngine = "google";
      // 往下改用 Google。這一批的 Google 翻譯另外存，下次有額度時仍會重新用 Gemini 翻。
    }
  }

  // Google 也先看看快取（Gemini 失敗改走這裡時，可能以前翻過）
  const fromGoogleCache = preferGemini ? await readCache("google", missingTexts) : missingTexts.map(() => null);
  const stillMissing = [];
  missing.forEach((i, k) => {
    if (fromGoogleCache[k] !== null) result[i] = fromGoogleCache[k];
    else stillMissing.push(i);
  });
  if (stillMissing.length) {
    const texts2 = stillMissing.map((i) => list[i]);
    let zh;
    try {
      zh = await translateWithGoogle(texts2);
    } catch (err) {
      if (err.kind !== "google-blocked") throw err;
      // 被擋了：回報給畫面，讓它停止送後面的批次，不要再重試（重試只會讓封鎖更久）
      await saveStatus({ engine: "google", ok: false, error: err.message, blocked: true });
      return { translations: null, engine: "google", blocked: true, notice: err.message };
    }
    stillMissing.forEach((i, k) => (result[i] = zh[k]));
    await writeCache("google", texts2.map((t, k) => [t, zh[k]]));
  }
  if (!preferGemini) await saveStatus({ engine: "google", ok: true });
  return { translations: result, engine: usedEngine, notice };
}

/**
 * 字幕上點一個字、選一段片語的翻譯。Google 最快，平常用它；
 * Google 暫時擋下這個網路時，有 Gemini 金鑰就改用 Gemini，沒有就丟出看得懂的原因。
 */
export async function translateWord(text) {
  if (!(await isGoogleBlocked())) {
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-TW&dt=t&q=${encodeURIComponent(text)}`;
      return (await googleFetch(url)).trim();
    } catch (err) {
      if (err.kind !== "google-blocked") throw err;
    }
  }
  const apiKey = await getGeminiKey();
  if (!apiKey) throw new GoogleBlockedError();
  const [zh] = await translateWithGemini(apiKey, [text], "");
  return zh;
}

/** 設定頁的「儲存並測試」：用一句話實際打一次 Gemini，確認金鑰能用。 */
export async function testGeminiKey(apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("請先貼上金鑰");
  const zh = await translateWithGemini(key, ["Hello, and welcome back to the channel."], "");
  geminiBlockedUntil = 0;
  return { sample: zh[0], model: workingModel };
}

export async function getTranslateStatus() {
  const data = await chrome.storage.local.get([TRANSLATE_STATUS_KEY, GEMINI_KEY_STORAGE]);
  return {
    hasGeminiKey: !!(data[GEMINI_KEY_STORAGE] && String(data[GEMINI_KEY_STORAGE]).trim()),
    last: data[TRANSLATE_STATUS_KEY] || null,
    googleBlocked: await isGoogleBlocked(),
  };
}

export async function setGeminiKey(apiKey) {
  const key = String(apiKey || "").trim();
  if (key) await chrome.storage.local.set({ [GEMINI_KEY_STORAGE]: key });
  else await chrome.storage.local.remove(GEMINI_KEY_STORAGE);
  geminiBlockedUntil = 0;
  workingModel = null;
  await chrome.storage.local.remove(TRANSLATE_STATUS_KEY);
}
