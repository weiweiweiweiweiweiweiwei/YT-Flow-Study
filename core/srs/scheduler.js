// ============================================================================
// 間隔重複排程器（SRS）
// ============================================================================
//
// 這是整個系統裡「唯一」擁有排程公式的地方。
// UI 只負責問「使用者按了 Again 還是 Good」，其餘一律交給這裡決定。
// 任何頁面都不可以自己算到期時間、自己判斷單字熟不熟。
//
// 關於 ts-fsrs：
//   原本考慮直接用 ts-fsrs 這類成熟套件，但這個專案刻意維持「零建置流程」
//   ——沒有 npm、沒有打包器，所有檔案都是瀏覽器直接載入的。
//   為了一個排程器導入整套建置工具，會動到目前正常運作的所有東西，代價太大。
//   所以這裡實作一個經過驗證的 SM-2 衍生演算法（Anki 用的就是這一系）。
//   介面設計成可抽換：之後若真的要換 FSRS，只要換掉 schedule() 的內部實作，
//   其他地方完全不用動。
//
// 演算法概要（跟 Anki 的行為接近，但簡化成只有 Again / Good 兩個選項）：
//
//   新卡片 ──Good/Again──► 學習階段（分鐘級間隔）
//   學習階段 ──連續 Good 通過所有步驟──► 畢業（間隔 1 天起跳）
//   已畢業 ──Good──► 間隔 × 難易係數
//           ──Again──► 記一次 lapse、難易係數下降、打回學習階段
//
// 「熟悉（mature）」的判定規則是明確且可推導的：間隔達到 21 天才算熟。
// 刻意不採用「按一次 Good 就變熟」——那只證明使用者當下記得，不代表長期記憶。
// ============================================================================

import { VOCAB_STATE, REVIEW_RATING, nowIso } from "../models.js";

export const SRS_CONFIG = {
  // 學習階段的間隔（分鐘）。連續答對走完這些步驟才畢業。
  LEARNING_STEPS_MINUTES: [1, 10],

  // 畢業後的第一個間隔（天）
  GRADUATING_INTERVAL_DAYS: 1,

  // 間隔達到幾天算「熟悉」。21 天是 Anki 沿用已久的慣例，
  // 大約對應「已經跨過遺忘曲線最陡的那一段」。
  MATURE_INTERVAL_DAYS: 21,

  // 難易係數：數字越大，下次間隔拉得越長
  INITIAL_EASE: 2.5,
  MIN_EASE: 1.3,
  EASE_PENALTY_ON_LAPSE: 0.2,

  // 答錯時，原本的間隔要保留多少
  LAPSE_INTERVAL_MULTIPLIER: 0.5,
  MIN_INTERVAL_DAYS: 1,

  // 間隔上限，避免出現「下次複習在 2090 年」這種實際上等於永遠不再出現的排程
  MAX_INTERVAL_DAYS: 365 * 2,
};

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- 狀態推導 ----------
//
// state 不是「另外存的一個欄位」，而是從複習紀錄推導出來的結果。
// 寫成函式而不是分散在各頁面各自判斷，就不會出現「單字頁說是熟悉、
// 分析頁卻算成學習中」這種前後矛盾。
export function deriveState(word) {
  if (!word || !word.reviewCount) return VOCAB_STATE.NEW;
  if (word.intervalDays >= SRS_CONFIG.MATURE_INTERVAL_DAYS) return VOCAB_STATE.MATURE;
  return VOCAB_STATE.LEARNING;
}

function clampInterval(days) {
  return Math.min(Math.max(days, SRS_CONFIG.MIN_INTERVAL_DAYS), SRS_CONFIG.MAX_INTERVAL_DAYS);
}

function isGraduated(word) {
  // 已經走完學習階段的卡片，間隔是以「天」為單位的
  return word.reviewCount > 0 && word.intervalDays >= SRS_CONFIG.GRADUATING_INTERVAL_DAYS;
}

/**
 * 計算一次複習之後這張卡片的新排程。
 *
 * 這是純函式：不碰資料庫、不碰 DOM，同樣的輸入永遠得到同樣的輸出，
 * 所以可以直接寫單元測試驗證。
 *
 * @param {object} word   目前的 VocabularyWord
 * @param {"again"|"good"} rating
 * @param {Date}   now    現在時間（測試時可注入固定時間）
 * @returns {{ patch: object, event: object }}
 *          patch = 要寫回 VocabularyWord 的欄位
 *          event = 建立 ReviewEvent 需要的前後狀態
 */
export function schedule(word, rating, now = new Date()) {
  const nowMs = now.getTime();

  const previousState = word.state || deriveState(word);
  const previousDueAt = word.dueAt || null;
  const previousInterval = Number.isFinite(word.intervalDays) ? word.intervalDays : 0;

  let intervalDays = previousInterval;
  let ease = Number.isFinite(word.ease) ? word.ease : SRS_CONFIG.INITIAL_EASE;
  let learningStep = Number.isFinite(word.learningStep) ? word.learningStep : 0;
  let lapseCount = word.lapseCount || 0;
  // 答錯被打回學習階段後，「重新畢業時要回到的間隔」。
  // 沒有這個欄位的話，一張已經排到 180 天的卡片只要失手一次就得從 1 天重新爬，
  // 幾個月的累積等於歸零，對使用者太苛刻。
  let relearnTargetDays = Number.isFinite(word.relearnTargetDays) ? word.relearnTargetDays : 0;
  let dueMs;

  const graduated = isGraduated(word);

  if (rating === REVIEW_RATING.AGAIN) {
    if (graduated) {
      // 已經記熟過又忘了：這才算一次真正的 lapse。
      // 還在學習階段時答錯不計 lapse——那本來就是還沒學會，不是「忘記」。
      lapseCount += 1;
      ease = Math.max(SRS_CONFIG.MIN_EASE, ease - SRS_CONFIG.EASE_PENALTY_ON_LAPSE);
      // 保留原本間隔的一半當作重新畢業的目標：失手要付出代價，但不是全部歸零。
      relearnTargetDays = clampInterval(
        Math.round(previousInterval * SRS_CONFIG.LAPSE_INTERVAL_MULTIPLIER)
      );
    }
    learningStep = 0;
    intervalDays = 0; // 回到學習階段（間隔以分鐘計）
    dueMs = nowMs + SRS_CONFIG.LEARNING_STEPS_MINUTES[0] * MINUTE_MS;
  } else {
    // Good
    if (graduated) {
      intervalDays = clampInterval(Math.round(previousInterval * ease));
      dueMs = nowMs + intervalDays * DAY_MS;
    } else {
      const nextStep = learningStep + 1;
      if (nextStep >= SRS_CONFIG.LEARNING_STEPS_MINUTES.length) {
        // 畢業：從分鐘級間隔轉成天級間隔。
        // 如果是「答錯後重新學會」，回到的是先前保留的一半間隔，而不是從 1 天開始。
        learningStep = 0;
        intervalDays = clampInterval(relearnTargetDays || SRS_CONFIG.GRADUATING_INTERVAL_DAYS);
        relearnTargetDays = 0; // 用掉了
        dueMs = nowMs + intervalDays * DAY_MS;
      } else {
        learningStep = nextStep;
        intervalDays = 0;
        dueMs = nowMs + SRS_CONFIG.LEARNING_STEPS_MINUTES[nextStep] * MINUTE_MS;
      }
    }
  }

  const reviewCount = (word.reviewCount || 0) + 1;
  const newDueAt = new Date(dueMs).toISOString();
  const reviewedAt = new Date(nowMs).toISOString();

  const patch = {
    intervalDays,
    ease,
    learningStep,
    relearnTargetDays,
    reviewCount,
    lapseCount,
    dueAt: newDueAt,
    lastReviewedAt: reviewedAt,
  };
  patch.state = deriveState({ ...word, ...patch });

  return {
    patch,
    event: {
      rating,
      reviewedAt,
      previousState,
      newState: patch.state,
      previousDueAt,
      newDueAt,
      previousInterval,
      newInterval: intervalDays,
    },
  };
}

// 給 UI 顯示「按下去之後下次什麼時候再出現」的預覽。
// 用的是同一個 schedule()，所以預覽跟實際結果一定一致——
// 不會發生「畫面說 3 天後，實際排到 5 天後」這種對不上的情況。
export function previewSchedule(word, rating, now = new Date()) {
  const { patch } = schedule(word, rating, now);
  return { dueAt: patch.dueAt, intervalDays: patch.intervalDays, state: patch.state };
}

// 把到期時間轉成好讀的相對時間
export function formatDueIn(dueAt, now = new Date()) {
  if (!dueAt) return "—";
  const diffMs = new Date(dueAt).getTime() - now.getTime();
  if (Number.isNaN(diffMs)) return "—";
  if (diffMs <= 0) return "現在";

  const minutes = Math.round(diffMs / MINUTE_MS);
  if (minutes < 60) return `${minutes} 分鐘後`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小時後`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天後`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} 個月後`;
  return `${Math.round(months / 12)} 年後`;
}

export { REVIEW_RATING, VOCAB_STATE };
