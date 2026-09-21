// ============================================================================
// 資料模型：所有實體的欄位定義與建構函式
// ============================================================================
//
// 這一層只負責「資料長什麼樣子」，不碰儲存、不碰 UI、不碰排程演算法。
// 四個頁面（複習 / 分析 / 單字 / 設定）共用這些定義，避免同一個概念在不同頁面
// 各自長出不一樣的欄位名稱。
//
// 兩個貫穿整個系統的規則：
//   1. 時間一律用 ISO 8601 字串（new Date().toISOString()）。
//      絕對不要拿「2026/09/18」這種顯示用格式當資料庫的 key——換個時區或語系就爆了。
//   2. ID 一律用 UUID，跟內容無關。單字的文字會被使用者編輯，不能拿來當 ID。
// ============================================================================

export const VOCAB_STATE = {
  NEW: "new",
  LEARNING: "learning",
  MATURE: "mature",
};

export const REVIEW_RATING = {
  AGAIN: "again",
  GOOD: "good",
};

export function newId() {
  // crypto.randomUUID 在 Chrome 92+ 都有，擴充功能頁面與 service worker 都可用
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  // 極端情況的後備方案，確保不會因為拿不到 UUID 就整個壞掉
  return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

export function nowIso() {
  return new Date().toISOString();
}

// 把 ISO 時間字串轉成「本地時區的 YYYY-MM-DD」。
// 特意用本地時區而不是 UTC：使用者晚上 11 點學的單字，應該算在「今天」，
// 而不是因為 UTC 已經跨日就被算到明天。
export function toLocalDateKey(isoOrDate) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------- 單字正規化 ----------
//
// 實作放在 core/normalize.js，因為 content.js（傳統 script，不能用 import）
// 也要用同一套規則判斷「這個字收藏過了沒」。兩邊如果各寫一份，哪天規則改了
// 就會出現「明明收藏過卻不畫底線」這種很難查的問題。詳見該檔案開頭說明。
import "./normalize.js";

const _normalizeApi = (typeof globalThis !== "undefined" ? globalThis : self).FlowStudyNormalize;

export const normalizeTerm = _normalizeApi.normalizeTerm;

// ---------- VocabularyWord：一個單字/片語，全域唯一 ----------
// 「run」不管在幾部影片裡出現過，都只有一筆 VocabularyWord。
// 每次出現的上下文則分開存成 VocabularyOccurrence。
export function createVocabularyWord({
  term,
  language = "en",
  translation = "",
  definition = "",
  createdAt = nowIso(),
} = {}) {
  return {
    id: newId(),
    term: String(term || "").trim(),
    normalizedTerm: normalizeTerm(term),
    language,

    translation: translation || "",
    definition: definition || "",

    state: VOCAB_STATE.NEW,

    // 使用者在「記憶固化」頁按下「學會了」的宣告。
    //
    // 這跟上面的 state 是兩回事，刻意分開：
    //   state    —— SRS 排程器依照「複習間隔有沒有超過 21 天」自動推導出來的
    //   mastered —— 使用者自己主觀判斷「我記住了」
    // 混用的話會出現「明明按了學會了，過幾天又被排程器抓回來複習」這種矛盾。
    //
    // 被標記為 mastered 的單字「不會」從資料庫刪除，只是移到「學會了」分頁，
    // 這樣首頁的「今日新單字」不會因為複習動作而莫名減少。
    mastered: false,
    masteredAt: null,

    // 新單字一建立就是「到期」的，這樣複習佇列只要查一個 dueAt 索引就好，
    // 不必額外處理「新卡片」這個特例。
    dueAt: createdAt,
    lastReviewedAt: null,

    reviewCount: 0,
    lapseCount: 0,

    // 排程器用的內部欄位。公式只存在於 core/srs/scheduler.js，
    // UI 一律不可以直接改這幾個值。
    intervalDays: 0,
    ease: 2.5,
    learningStep: 0,
    relearnTargetDays: 0, // 答錯打回學習階段後，重新畢業時要回到的間隔

    createdAt,
    updatedAt: createdAt,
  };
}

// ---------- VocabularyOccurrence：某個單字在某部影片某一句裡的出現 ----------
// 同一個單字可以有很多筆。這就是為什麼它要跟 VocabularyWord 分開。
export function createVocabularyOccurrence({
  vocabularyWordId,
  videoId,
  videoTitle = "",
  videoUrl = "",
  sentence = "",
  startTime = 0,
  endTime = 0,
  createdAt = nowIso(),
} = {}) {
  return {
    id: newId(),
    vocabularyWordId,

    videoId: videoId || "",
    videoTitle: videoTitle || "",
    videoUrl: videoUrl || "",

    sentence: sentence || "",

    // 這兩個時間來自既有的句子時間軸（sentence-timeline.js），
    // 所以「跳回這個單字出現的地方」才會精準落在整句的開頭。
    startTime: Number.isFinite(startTime) ? startTime : 0,
    endTime: Number.isFinite(endTime) ? endTime : 0,

    createdAt,
  };
}

// ---------- ReviewEvent：每一次複習都留下一筆，不可變更 ----------
//
// 為什麼不只存「目前的 SRS 狀態」就好？因為分析頁需要歷史：
// 記憶保留率、複習次數趨勢、哪天複習了幾張——這些都不可能從「目前狀態」回推。
// 這些事件是 append-only 的，寫進去就不再修改。
export function createReviewEvent({
  vocabularyWordId,
  rating,
  previousState,
  newState,
  previousDueAt = null,
  newDueAt = null,
  previousInterval = null,
  newInterval = null,
  reviewedAt = nowIso(),
} = {}) {
  return {
    id: newId(),
    vocabularyWordId,
    reviewedAt,
    rating,

    previousState,
    newState,
    previousDueAt,
    newDueAt,
    previousInterval,
    newInterval,
  };
}

// ---------- ImmersionSession：一段真正有在看影片的時間 ----------
//
// watchedSeconds 累計的是「真實流逝的時間」，不是影片的播放位置差。
// 這點很重要：使用者如果從 02:00 拖到 20:00，中間跳過的 18 分鐘不該算成沉浸時間。
// 用真實時間累計就天然避開了這個問題——拖曳進度條並不會讓牆上的時鐘走得比較快。
export function createImmersionSession({
  videoId,
  videoTitle = "",
  language = "en",
  startedAt = nowIso(),
  source = "player",
} = {}) {
  return {
    id: newId(),
    videoId: videoId || "",
    videoTitle: videoTitle || "",

    startedAt,
    endedAt: null,

    watchedSeconds: 0,

    language,
    // "player" = 實際記錄到的觀看；"legacy-daily" = 從舊版每日累計搬過來的資料。
    // 標記來源才能誠實區分「真的有這段 session」和「只知道那天總共看了多久」。
    source,
  };
}

// ---------- Video：輕量的影片資料，讓單字與分析能指回實際影片 ----------
export function createVideo({ videoId, title = "", duration = 0, lastWatchedAt = nowIso() } = {}) {
  return {
    videoId,
    title: title || "",
    duration: Number.isFinite(duration) ? duration : 0,
    lastWatchedAt,
  };
}

// ---------- Settings：型別明確的單一設定物件 ----------
// 刻意用「一個物件」而不是散落各處的 storage key，這樣新增設定項目時
// 不用到處找哪裡還要改，也不會出現某個頁面讀得到、另一個頁面讀不到的情況。
export const DEFAULT_SETTINGS = {
  nativeLanguage: "zh-TW",
  targetLanguage: "en",

  pronunciationVoice: "",
  playbackSpeed: 1,

  dailyGoalMinutes: 30,

  activeRecallDefault: true,
  autoPlayAfterReview: false,

  theme: "light",

  shortcuts: {
    previousSentence: "a",
    replaySentence: "s",
    nextSentence: "d",
    playPause: " ",
  },
};

// 合併使用者設定與預設值。
//
// 有兩個陷阱這裡特別處理掉：
//
//   1. 物件展開會把「明確是 undefined 的值」也蓋上去：
//        { ...{ dailyGoalMinutes: 30 }, ...{ dailyGoalMinutes: undefined } }
//        → { dailyGoalMinutes: undefined }   ← 預設值被清掉了
//      首次安裝時從舊 key 讀設定，那些 key 全都不存在（undefined），
//      結果每日目標會變成 undefined，進度條就會顯示 NaN。
//      所以要先濾掉 undefined / null 再合併。
//
//   2. shortcuts 是巢狀物件，淺層展開會讓舊存檔裡缺少的快捷鍵欄位整組消失，
//      所以要分開再合併一次。
export function mergeSettings(saved) {
  const s = saved && typeof saved === "object" ? saved : {};

  const definedOnly = (obj) => {
    const out = {};
    for (const key of Object.keys(obj || {})) {
      if (obj[key] !== undefined && obj[key] !== null) out[key] = obj[key];
    }
    return out;
  };

  const top = definedOnly(s);
  const shortcuts = definedOnly(s.shortcuts);
  delete top.shortcuts; // 巢狀物件在下面單獨處理

  return {
    ...DEFAULT_SETTINGS,
    ...top,
    shortcuts: { ...DEFAULT_SETTINGS.shortcuts, ...shortcuts },
  };
}
