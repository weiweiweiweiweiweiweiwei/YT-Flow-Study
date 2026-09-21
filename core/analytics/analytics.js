// ============================================================================
// 分析服務：所有統計公式的唯一來源
// ============================================================================
//
// 這裡的每一個函式都是純函式——吃陣列、吐數字，不碰資料庫也不碰 DOM。
// 好處有三個：
//   1. 可以直接寫單元測試驗證公式對不對。
//   2. 複習頁與分析頁呼叫同一個 calculateRetentionRate()，不可能算出不同答案。
//   3. 呼叫端自己決定何時載入資料、要不要快取，這一層不做 I/O。
//
// 公式全部是我們自己定義的、透明可檢查的。沒有抄任何人的專有演算法，
// 也不假裝跟別的產品算出來的數字一樣。每個公式都寫在註解裡。
// ============================================================================

import { toLocalDateKey, VOCAB_STATE, REVIEW_RATING } from "../models.js";

// ---------- 時間範圍 ----------

export const RANGE = {
  WEEK: "week",
  MONTH: "month",
  YEAR: "year",
  ALL: "all",
};

const RANGE_DAYS = {
  [RANGE.WEEK]: 7,
  [RANGE.MONTH]: 30,
  [RANGE.YEAR]: 365,
};

/**
 * 把範圍名稱轉成實際的起訖時間。
 * 起點取當地時間的 00:00，這樣「最近 7 天」是 7 個完整的日子，
 * 而不是「從現在往前推 168 小時」那種會把今天切一半的區間。
 */
export function resolveRange(range, now = new Date()) {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  if (range === RANGE.ALL) {
    return { startIso: new Date(0).toISOString(), endIso: end.toISOString(), days: null };
  }

  const days = RANGE_DAYS[range] || RANGE_DAYS[RANGE.WEEK];
  const start = new Date(now);
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);

  return { startIso: start.toISOString(), endIso: end.toISOString(), days };
}

// 產生範圍內每一天的日期字串，讓圖表即使某幾天沒資料也有完整的 X 軸
export function listDateKeys(startIso, endIso) {
  const keys = [];
  const cursor = new Date(startIso);
  cursor.setHours(12, 0, 0, 0);
  const end = new Date(endIso);

  while (cursor.getTime() <= end.getTime()) {
    keys.push(toLocalDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
    if (keys.length > 4000) break; // 保險，避免壞掉的時間戳造成無限迴圈
  }
  return keys;
}

// ---------- 記憶保留率 ----------
//
// 公式：答對的複習次數 / 完成的複習總次數
//   Good = 答對，Again = 答錯。
//
// 刻意只看「已完成的複習」，不把「還沒複習過的新單字」算進分母——
// 沒複習過的字既不算記得也不算忘記，放進分母只會讓數字無意義地被稀釋。
//
// 沒有任何複習紀錄時回傳 null，而不是 0。這個差別很重要：
// 「還沒有資料」和「全部答錯」是完全不同的兩件事，UI 必須能區分。
export function calculateRetentionRate(reviewEvents) {
  if (!Array.isArray(reviewEvents) || reviewEvents.length === 0) {
    return { rate: null, successful: 0, total: 0 };
  }

  let successful = 0;
  for (const e of reviewEvents) {
    if (e && e.rating === REVIEW_RATING.GOOD) successful++;
  }

  return {
    rate: successful / reviewEvents.length,
    successful,
    total: reviewEvents.length,
  };
}

// ---------- 每日彙總 ----------
//
// 所有以「天」為單位的圖表都從這裡出發，只走訪原始事件一次。
// 不這樣做的話，每個圖表各自把幾千筆事件重掃一遍，切換範圍就會卡頓。
export function aggregateDailyStats({ sessions = [], reviewEvents = [], words = [], startIso, endIso }) {
  const dateKeys = listDateKeys(startIso, endIso);
  const byDate = {};
  for (const key of dateKeys) {
    byDate[key] = {
      date: key,
      immersionSeconds: 0,
      sessionCount: 0,
      reviewCount: 0,
      reviewSuccessCount: 0,
      newWordCount: 0,
    };
  }

  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();
  const inRange = (iso) => {
    const t = new Date(iso).getTime();
    return Number.isFinite(t) && t >= startMs && t <= endMs;
  };

  for (const s of sessions) {
    if (!s || !s.startedAt || !inRange(s.startedAt)) continue;
    const key = toLocalDateKey(s.startedAt);
    const bucket = byDate[key];
    if (!bucket) continue;
    bucket.immersionSeconds += s.watchedSeconds || 0;
    bucket.sessionCount += 1;
  }

  for (const e of reviewEvents) {
    if (!e || !e.reviewedAt || !inRange(e.reviewedAt)) continue;
    const key = toLocalDateKey(e.reviewedAt);
    const bucket = byDate[key];
    if (!bucket) continue;
    bucket.reviewCount += 1;
    if (e.rating === REVIEW_RATING.GOOD) bucket.reviewSuccessCount += 1;
  }

  for (const w of words) {
    if (!w || !w.createdAt || !inRange(w.createdAt)) continue;
    const key = toLocalDateKey(w.createdAt);
    const bucket = byDate[key];
    if (!bucket) continue;
    bucket.newWordCount += 1;
  }

  return dateKeys.map((k) => byDate[k]);
}

// ---------- 學習效率 ----------
//
// 公式：這段期間新增的單字數 / 這段期間的沉浸小時數
// 意義是「每小時觀看能帶走幾個新單字」。
//
// 沉浸時數為 0 時回傳 null 而不是 Infinity——沒看影片卻加了單字，
// 這個比值在數學上沒有意義，不該顯示成一個爆表的數字。
export function calculateLearningEfficiency(dailyStats) {
  let newWords = 0;
  let seconds = 0;
  for (const d of dailyStats) {
    newWords += d.newWordCount;
    seconds += d.immersionSeconds;
  }
  const hours = seconds / 3600;
  return {
    newWords,
    immersionHours: hours,
    wordsPerHour: hours > 0 ? newWords / hours : null,
  };
}

// ---------- 每日平均沉浸 ----------
//
// 公式：總沉浸分鐘數 / 有實際學習的天數
//
// 分母刻意用「有學習的天數」而不是「範圍內的總天數」。
// 用總天數的話，只要中間休息幾天，平均值就會被大量的 0 拉垮，
// 看起來像在退步，但其實有學的那幾天強度並沒有下降。
// 兩個數字都回傳，UI 可以自行選擇要呈現哪一個。
export function calculateDailyAverage(dailyStats) {
  const totalSeconds = dailyStats.reduce((a, d) => a + d.immersionSeconds, 0);
  const activeDays = dailyStats.filter((d) => d.immersionSeconds > 0).length;
  const totalDays = dailyStats.length;

  return {
    totalMinutes: totalSeconds / 60,
    activeDays,
    totalDays,
    averageMinutesPerActiveDay: activeDays > 0 ? totalSeconds / 60 / activeDays : 0,
    averageMinutesPerCalendarDay: totalDays > 0 ? totalSeconds / 60 / totalDays : 0,
  };
}

// ---------- 學習次數 ----------
// 有意義的沉浸 session 數量。太短的 session 在寫入時就已經被 immersionStore
// 過濾掉了，所以這裡直接數就好。
export function calculateStudySessions(dailyStats) {
  const total = dailyStats.reduce((a, d) => a + d.sessionCount, 0);
  const activeDays = dailyStats.filter((d) => d.sessionCount > 0).length;
  return {
    totalSessions: total,
    activeDays,
    averagePerActiveDay: activeDays > 0 ? total / activeDays : 0,
  };
}

// ---------- 單字量成長 ----------
//
// 累積曲線：每一天的值是「到那天為止總共學了幾個字」。
// baseline 是範圍開始之前就已經累積的數量，這樣切到「最近一週」時，
// 曲線是從既有的總量繼續往上長，而不是每次都從 0 重新開始。
export function calculateVocabularyGrowth(dailyStats, baselineCount = 0) {
  let cumulative = baselineCount;
  return dailyStats.map((d) => {
    cumulative += d.newWordCount;
    return { date: d.date, added: d.newWordCount, total: cumulative };
  });
}

// 計算 baseline：範圍開始之前建立的單字數
export function countWordsBefore(words, startIso) {
  const startMs = new Date(startIso).getTime();
  let n = 0;
  for (const w of words) {
    const t = new Date(w.createdAt).getTime();
    if (Number.isFinite(t) && t < startMs) n++;
  }
  return n;
}

// ---------- 學習速度 ----------
//
// 兩種角度：
//   每天幾個字   —— 看的是投入的一致性
//   每小時幾個字 —— 看的是觀看時的吸收密度
export function calculateLearningVelocity(dailyStats) {
  const totalNew = dailyStats.reduce((a, d) => a + d.newWordCount, 0);
  const totalSeconds = dailyStats.reduce((a, d) => a + d.immersionSeconds, 0);
  const activeDays = dailyStats.filter((d) => d.newWordCount > 0 || d.immersionSeconds > 0).length;
  const hours = totalSeconds / 3600;

  return {
    totalNewWords: totalNew,
    perDay: dailyStats.length > 0 ? totalNew / dailyStats.length : 0,
    perActiveDay: activeDays > 0 ? totalNew / activeDays : 0,
    perHour: hours > 0 ? totalNew / hours : null,
    series: dailyStats.map((d) => ({ date: d.date, value: d.newWordCount })),
  };
}

// ---------- 沉浸習慣（日曆熱力圖）----------
//
// 強度用「固定的分鐘門檻」分成 0~4 級，不是相對於期間最大值。
//
// 為什麼選固定門檻？因為相對門檻會讓同一個顏色在不同時期代表不同的投入程度
// ——這個月最深的綠可能只是 20 分鐘，下個月最深的綠卻是 2 小時，看久了反而
// 分不清自己到底進步還是退步。固定門檻讓「深綠」永遠等於「今天真的有練」。
//
// 門檻設計的理由：5 分鐘以下多半只是不小心點開影片，不算進入學習狀態，
// 所以直接歸零（灰色），不給任何顏色獎勵。
export const IMMERSION_LEVEL_THRESHOLDS = [5, 15, 30, 60]; // 單位：分鐘

export function immersionLevelForMinutes(minutes) {
  const t = IMMERSION_LEVEL_THRESHOLDS;
  if (!Number.isFinite(minutes) || minutes < t[0]) return 0; // 灰：不足 5 分鐘
  if (minutes < t[1]) return 1; // 最淡：5–14 分鐘
  if (minutes < t[2]) return 2; // 15–29 分鐘
  if (minutes < t[3]) return 3; // 30–59 分鐘
  return 4; // 最深：60 分鐘以上
}

export function calculateImmersionHabits(dailyStats, goalMinutes = 30) {
  const days = dailyStats.map((d) => {
    const minutes = d.immersionSeconds / 60;
    return {
      date: d.date,
      minutes,
      level: immersionLevelForMinutes(minutes),
      metGoal: goalMinutes > 0 && minutes >= goalMinutes,
    };
  });

  const activeDays = days.filter((d) => d.minutes > 0).length;
  const goalDays = days.filter((d) => d.metGoal).length;

  return {
    days,
    activeDays,
    goalDays,
    currentStreak: calculateStreak(days),
    longestStreak: calculateLongestStreak(days),
  };
}

// 目前連續學習天數。從最後一天往回數。
// 「今天還沒學」不算中斷——一天還沒過完，現在就宣告連續紀錄斷掉並不合理。
function calculateStreak(days) {
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].minutes > 0) streak++;
    else if (i === days.length - 1) continue;
    else break;
  }
  return streak;
}

function calculateLongestStreak(days) {
  let longest = 0;
  let current = 0;
  for (const d of days) {
    if (d.minutes > 0) {
      current++;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

// ---------- 單字狀態分布 ----------
export function calculateStateBreakdown(words, now = new Date()) {
  const nowMs = now.getTime();
  const breakdown = { total: 0, new: 0, learning: 0, mature: 0, dueNow: 0 };
  for (const w of words) {
    if (!w) continue;
    breakdown.total++;
    if (w.state === VOCAB_STATE.NEW) breakdown.new++;
    else if (w.state === VOCAB_STATE.MATURE) breakdown.mature++;
    else breakdown.learning++;

    const due = new Date(w.dueAt).getTime();
    if (Number.isFinite(due) && due <= nowMs) breakdown.dueNow++;
  }
  return breakdown;
}

// ---------- 一次算完所有分析頁需要的數字 ----------
//
// 分析頁只呼叫這一個函式。原始事件只會被走訪一次，其餘全部從 dailyStats 推導，
// 不會發生「六張圖表各自把幾千筆事件重掃一遍」的情況。
export function buildAnalyticsSnapshot({
  sessions,
  reviewEvents,
  words,
  allWords,
  range,
  goalMinutes = 30,
  now = new Date(),
}) {
  const { startIso, endIso } = resolveRange(range, now);
  const dailyStats = aggregateDailyStats({ sessions, reviewEvents, words, startIso, endIso });
  const baseline = countWordsBefore(allWords || words, startIso);

  return {
    range,
    startIso,
    endIso,
    dailyStats,
    retention: calculateRetentionRate(reviewEvents),
    efficiency: calculateLearningEfficiency(dailyStats),
    dailyAverage: calculateDailyAverage(dailyStats),
    studySessions: calculateStudySessions(dailyStats),
    vocabularyGrowth: calculateVocabularyGrowth(dailyStats, baseline),
    learningVelocity: calculateLearningVelocity(dailyStats),
    immersionHabits: calculateImmersionHabits(dailyStats, goalMinutes),
    stateBreakdown: calculateStateBreakdown(allWords || words, now),
  };
}
