// ============================================================================
// 首頁
// ============================================================================
// 由上而下三個區塊：
//   1. 每日目標（大數字 + 進度條 + 今日剩餘倒數）與 總沉浸時數 / 總詞彙量
//   2. 學習成效 —— 最近 7 天每天沉浸幾分鐘的長條圖
//   3. 沉浸習慣 —— 最近 5 週的方格圖，顏色深淺用固定分鐘門檻
//
// 刻意沒有做的（使用者明確表示不要）：
//   學習秘訣橫幅、跟讀模式、連續達標膠囊、詞彙量的綠色長條、
//   方格圖下方的連續天數統計
// ============================================================================

import {
  getTodaySeconds,
  getTotalSeconds,
  getSessionsBetween,
  getFirstSessionDate,
} from "../core/storage/immersionStore.js";
import { getAllWords } from "../core/storage/vocabularyStore.js";
import { getSettings } from "../core/storage/settingsStore.js";
import {
  aggregateDailyStats,
  calculateImmersionHabits,
  IMMERSION_LEVEL_THRESHOLDS,
} from "../core/analytics/analytics.js";

// 5 週 ≈ 一個月。使用者要的是「大致掌握這一個月的趨勢」，
// 拉到半年或一年對剛開始使用的人只會是一大片灰色。
const HEATMAP_WEEKS = 5;
const WEEKDAY_LABELS = ["週一", "週二", "週三", "週四", "週五", "週六", "週日"];

let countdownTimer = null;

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const ICONS = {
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6v6l4 2"/><circle cx="12" cy="12" r="10"/></svg>`,
  timer: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/></svg>`,
  zap: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg>`,
  book: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>`,
  dots: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>`,
  up: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 7h6v6"/><path d="m22 7-8.5 8.5-5-5L2 17"/></svg>`,
  down: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 17h6v-6"/><path d="m22 17-8.5-8.5-5 5L2 7"/></svg>`,
  target: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/></svg>`,
};

function formatTotalTime(totalSeconds) {
  const minutes = Math.round(totalSeconds / 60);
  return { h: Math.floor(minutes / 60), m: minutes % 60 };
}

// 距離今天結束還有多久。提醒「今天還有時間可以達標」。
function timeLeftToday(now = new Date()) {
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const diff = Math.max(0, midnight - now);
  return {
    hh: String(Math.floor(diff / 3600000)).padStart(2, "0"),
    mm: String(Math.floor((diff % 3600000) / 60000)).padStart(2, "0"),
    ss: String(Math.floor((diff % 60000) / 1000)).padStart(2, "0"),
  };
}

// 方格圖的起點：從「本週的週一」往回推整數週。
//
// 先前的寫法是「往回推 N×7−1 天再對齊週一」，那會依照今天是星期幾而多出
// 半截的一欄（實測今天是週五時就變成 6 欄而不是 5 欄）。
// 從本週一往回推整數週，欄數才會固定是 HEATMAP_WEEKS，版面也不會忽寬忽窄。
function heatmapStart(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // 本週一
  start.setDate(start.getDate() - (HEATMAP_WEEKS - 1) * 7);
  return start;
}

function renderRestoreNotice() {
  return `<div class="card restore-notice">
    <div>
      <div class="restore-notice-title">目前沒有任何學習紀錄</div>
      <p class="restore-notice-text">
        如果之前的單字或沉浸時數不見了，可以從「下載」資料夾裡的
        <b>FlowStudy Backups</b> 選最新的備份檔還原。
      </p>
    </div>
    <a class="data-btn data-btn-primary restore-notice-btn" href="review.html?view=settings">前往還原</a>
  </div>`;
}

export async function renderHomePage(root) {
  stopCountdown();
  root.innerHTML = `<div class="card empty-hint">載入中…</div>`;

  try {
    const now = new Date();
    const settings = await getSettings();
    const goalMinutes = settings.dailyGoalMinutes || 30;

    const start = heatmapStart(now);
    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);

    const [todaySeconds, totalSeconds, words, sessions, firstSessionAt] = await Promise.all([
      getTodaySeconds(now),
      getTotalSeconds(),
      getAllWords(),
      getSessionsBetween(start.toISOString(), endOfToday.toISOString()),
      getFirstSessionDate(),
    ]);

    const dailyStats = aggregateDailyStats({
      sessions,
      reviewEvents: [],
      words,
      startIso: start.toISOString(),
      endIso: endOfToday.toISOString(),
    });
    const habits = calculateImmersionHabits(dailyStats, goalMinutes);

    // 完全沒有資料時，最可能的情況是「資料被清掉了」（擴充功能被移除後重裝、資料夾改名）。
    // 這正是使用者最需要知道「可以從備份救回來」的時刻，所以直接在首頁提示。
    const isEmpty = words.length === 0 && totalSeconds === 0;

    root.innerHTML = `<div class="home-stack">
      ${isEmpty ? renderRestoreNotice() : ""}
      ${renderOverview({ todaySeconds, totalSeconds, words, goalMinutes, now })}
      ${renderWeeklyChart(dailyStats)}
      ${renderHeatmap(habits, start)}
      <!-- 底部留白：讓最後一張卡片也能被捲到畫面正中央來看。
           沒有這段的話，沉浸習慣永遠只能停在螢幕最下緣。 -->
      <div class="home-bottom-spacer" aria-hidden="true"></div>
    </div>`;

    // 每一直行對應的那個週一，方格圖的提示框要靠它算 Week N
    const weekStartDates = [];
    for (let w = 0; w * 7 < habits.days.length; w++) {
      const d = new Date(start);
      d.setDate(d.getDate() + w * 7);
      weekStartDates.push(d);
    }
    // 開始學習的那一天：以最早一筆沉浸紀錄為準，
    // 沒有沉浸紀錄（例如只收藏過單字）就退回最早收藏的單字
    const earliestWord = words.reduce(
      (min, w) => (!min || w.createdAt < min ? w.createdAt : min),
      null
    );
    const studyStart = firstSessionAt || earliestWord || start.toISOString();

    bindChartTooltip(root);
    bindHeatmapTooltip(root, weekStartDates, studyStart);
    startCountdown(root);
  } catch (err) {
    console.error("[FlowStudy] 首頁載入失敗：", err);
    root.innerHTML = `<div class="card empty-hint">學習資料讀取失敗：${escapeHtml(err.message || err)}</div>`;
  }
}

function renderOverview({ todaySeconds, totalSeconds, words, goalMinutes, now }) {
  const todayMinutes = Math.round(todaySeconds / 60);
  const pct = goalMinutes > 0 ? Math.min(100, Math.round((todayMinutes / goalMinutes) * 100)) : 0;
  const remaining = Math.max(0, goalMinutes - todayMinutes);
  const total = formatTotalTime(totalSeconds);
  const { hh, mm, ss } = timeLeftToday(now);

  // 「今天標記了幾個新單字」。每天從 0 開始重新累積——
  // 累計總量只會一路往上，看久了沒有感覺；今天的數字才會讓人想再多學一個。
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  let todayNew = 0;
  let yesterdayNew = 0;
  for (const w of words) {
    const t = new Date(w.createdAt).getTime();
    // 只看 createdAt。複習動作不會改動這個欄位，
    // 所以「今日新單字」永遠不會因為複習而往下掉。
    if (t >= startOfToday.getTime()) todayNew++;
    else if (t >= startOfYesterday.getTime()) yesterdayNew++;
  }

  // 跟昨天比。昨天是 0 的話不顯示變化率——除以零沒有意義，
  // 而且「昨天沒學、今天學了 3 個」硬要說成 +300% 只是灌水。
  let deltaHtml = "";
  if (yesterdayNew > 0) {
    const delta = Math.round(((todayNew - yesterdayNew) / yesterdayNew) * 100);
    const up = delta >= 0;
    deltaHtml = `<span class="delta-badge ${up ? "up" : "down"}" title="相較昨天">
      ${up ? ICONS.up : ICONS.down}${up ? "+" : ""}${delta}%
    </span>`;
  }

  return `
  <div class="overview-grid">
    <div class="card goal-card">
      <div class="goal-card-glyph">${ICONS.zap}</div>

      <div class="goal-card-top">
        <span class="pill">${ICONS.clock} 每日目標</span>
        <span class="goal-remaining">
          <span class="goal-remaining-label">今日剩餘</span>
          <span class="goal-remaining-value">${ICONS.timer}<span id="countdown">${hh}:${mm}<span class="goal-remaining-sec">:${ss}</span></span></span>
        </span>
      </div>

      <div class="goal-figure">
        <span class="goal-figure-value">${todayMinutes}</span>
        <span class="goal-figure-label">今日沉浸分鐘數</span>
      </div>

      <div class="goal-progress-caption">${todayMinutes} / ${goalMinutes} mins</div>
      <div class="progress-track"><div class="progress-fill is-live" style="width:${pct}%"></div></div>

      <div class="goal-footer ${remaining === 0 ? "is-done" : ""}">
        ${remaining === 0 ? "🎉 已達成目標！做得很棒！" : `${remaining} 分鐘即可達成目標`}
      </div>
    </div>

    <div class="card card-2xl summary-card">
      <div class="summary-section">
        <div class="summary-head">
          <span class="summary-label">總沉浸時數</span>
          <span class="summary-icon indigo">${ICONS.clock}</span>
        </div>
        <p class="summary-value">
          <span class="summary-value-num">${total.h}</span><span class="summary-value-unit">h</span>
          <span class="summary-value-num" style="margin-left:4px">${total.m}</span><span class="summary-value-unit">m</span>
        </p>
      </div>

      <div class="summary-section">
        <div class="summary-head">
          <span class="summary-label">今日新單字</span>
          <span class="summary-icon emerald">${ICONS.book}</span>
        </div>
        <div class="summary-value" style="gap:14px;flex-wrap:wrap">
          <span class="summary-value-num">${todayNew}</span>
          ${deltaHtml}
        </div>
        <div class="summary-breakdown">
          <span class="summary-breakdown-item">
            <span class="dot-blue">${ICONS.dots}</span>累積收藏 <strong>${words.length} 詞</strong>
          </span>
        </div>
      </div>
    </div>
  </div>`;
}

// ---------- 學習成效：最近 7 天的沉浸分鐘數與新單字數 ----------
//
// 刻度規則：「等比例，但有下限 30」。
//
//   一整週都沒超過 30  → 以 30 為攻頂值。20 分鐘就是三分之二高，
//                        不會因為它剛好是本週最高就假裝攻頂。
//   某天超過 30        → 那天成為新的攻頂值，其他天依比例縮放。
//                        今天 100 分鐘、昨天 20 分鐘，昨天就該看起來很短——
//                        那正是真實的差距。
//
// 下限的存在是為了避免「相對刻度」說謊：沒有下限的話，全週最高只有 5 分鐘
// 也會攻頂，看起來像很拚的一天。
//
// 分鐘與單字數各自算自己的刻度——單位不同，硬共用一個基準沒有意義。
const CHART_SCALE_FLOOR = 30;

function scaleFor(values) {
  return Math.max(CHART_SCALE_FLOOR, ...values);
}

function barHeightPct(value, scale) {
  if (!value) return 0;
  // 有資料的日子至少給一點高度，否則 1 分鐘的柱子會完全看不見
  return Math.max(4, Math.min(100, (value / scale) * 100));
}

function renderWeeklyChart(dailyStats) {
  const days = dailyStats.slice(-7);
  if (!days.length) return "";

  const allMinutes = days.map((d) => Math.round(d.immersionSeconds / 60));
  const allWords = days.map((d) => d.newWordCount || 0);
  const minuteScale = scaleFor(allMinutes);
  const wordScale = scaleFor(allWords);

  const bars = days
    .map((d, i) => {
      const m = allMinutes[i];
      const w = allWords[i];
      const date = new Date(d.date + "T12:00:00");
      const label = WEEKDAY_LABELS[(date.getDay() + 6) % 7];

      // 數值不直接標在柱子上——平常保持乾淨，滑上去才用提示框顯示。
      // 把資料放在 data-* 屬性裡，提示框直接讀，不必再回頭查一次原始資料。
      return `<div class="bar-col" data-weekday="${label}" data-minutes="${m}" data-words="${w}">
        <div class="bar-slot">
          <div class="bar bar-minutes" style="height:${barHeightPct(m, minuteScale)}%"></div>
          <div class="bar bar-words" style="height:${barHeightPct(w, wordScale)}%"></div>
        </div>
        <div class="bar-label">${label}</div>
      </div>`;
    })
    .join("");

  return `
  <div class="card chart-card">
    <div class="chart-title">學習成效</div>
    <div class="bar-chart">
      <div class="bar-cols" id="barCols">${bars}</div>
      <div class="chart-tooltip" id="chartTooltip" hidden></div>
    </div>
    <div class="chart-legend">
      <span class="legend-item"><span class="legend-dot dot-minutes"></span>總沉浸時間</span>
      <span class="legend-item"><span class="legend-dot dot-words"></span>新單詞</span>
    </div>
  </div>`;
}

// 長條圖的滑鼠提示框。
// 綁在整個 .bar-cols 上用事件委派，而不是每根柱子各綁一次——
// 重畫圖表時不用擔心有沒有漏解綁，也不會累積監聽器。
function bindChartTooltip(root) {
  const cols = root.querySelector("#barCols");
  const tip = root.querySelector("#chartTooltip");
  if (!cols || !tip) return;

  const show = (col) => {
    tip.innerHTML = `
      <div class="chart-tooltip-title">${escapeHtml(col.dataset.weekday)}</div>
      <div class="chart-tooltip-row">
        <span class="legend-dot dot-minutes"></span>總沉浸時間: ${col.dataset.minutes} min
      </div>
      <div class="chart-tooltip-row">
        <span class="legend-dot dot-words"></span>新單詞: ${col.dataset.words}
      </div>`;
    tip.hidden = false;

    // 只算水平位置。垂直位置由 CSS 固定在柱子區域的正上方（bottom: 100%），
    // 刻意不跟著柱子高度浮動——跟著跑的話，攻頂那天提示框會整個蓋住柱體。
    const chartRect = cols.parentElement.getBoundingClientRect();
    const colRect = col.getBoundingClientRect();
    const left = colRect.left - chartRect.left + colRect.width / 2 - tip.offsetWidth / 2;
    tip.style.left = Math.max(0, Math.min(left, chartRect.width - tip.offsetWidth)) + "px";
  };

  cols.addEventListener("mouseover", (e) => {
    const col = e.target.closest(".bar-col");
    if (col) show(col);
  });
  cols.addEventListener("mouseleave", () => {
    tip.hidden = true;
  });
}

// ---------- 沉浸習慣方格圖 ----------
// 一直行是一週（週一在最上），顏色深淺用固定的分鐘門檻，
// 這樣「深綠」永遠代表同一個投入程度，跨月份比較才有意義。
function renderHeatmap(habits, start) {
  const days = habits.days;
  if (!days.length) return "";

  const weeks = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));

  // 每一直行上方標出那一週的起始日期
  const headers = weeks
    .map((_, w) => {
      const d = new Date(start);
      d.setDate(d.getDate() + w * 7);
      return `<div class="heatmap-col-label">${d.getMonth() + 1}月${d.getDate()}日</div>`;
    })
    .join("");

  // 依「列（星期）」而不是「行（週）」輸出，才能把星期標籤放在最左邊
  let rows = "";
  for (let dow = 0; dow < 7; dow++) {
    const cells = weeks
      .map((week, weekIndex) => {
        const day = week[dow];
        if (!day) return `<div class="heatmap-cell is-empty"></div>`;
        return `<div class="heatmap-cell l${day.level}"
                     data-dow="${dow}" data-week="${weekIndex}"
                     data-minutes="${Math.round(day.minutes)}"></div>`;
      })
      .join("");
    rows += `<div class="heatmap-row-label">${WEEKDAY_LABELS[dow]}</div>${cells}`;
  }

  const t = IMMERSION_LEVEL_THRESHOLDS;
  const legendTitles = [
    `不足 ${t[0]} 分鐘`,
    `${t[0]}–${t[1]} 分鐘`,
    `${t[1]}–${t[2]} 分鐘`,
    `${t[2]}–${t[3]} 分鐘`,
    `${t[3]} 分鐘以上`,
  ];

  return `
  <div class="card heatmap-card">
    <div class="heatmap-head">
      <span class="heatmap-title">${ICONS.target} 沉浸習慣</span>
      <span class="heatmap-legend">
        少
        ${legendTitles
          .map((title, i) => `<i class="l${i}" title="${escapeHtml(title)}"></i>`)
          .join("")}
        多
      </span>
    </div>
    <div class="heatmap-scroll">
      <div class="heatmap-grid" style="--weeks:${weeks.length}">
        <div class="heatmap-corner"></div>
        ${headers}
        ${rows}
      </div>
    </div>
    <!-- 提示框刻意放在捲動容器「外面」。
         CSS 規範規定：overflow-x 是 auto 時，overflow-y 的 visible 會被強制當成 auto，
         所以只要放在 .heatmap-scroll 裡面，往上溢出的提示框就一定會被裁掉——
         最上排（週一）的方格因此永遠顯示不出正上方的提示框。 -->
    <div class="heatmap-tooltip" id="heatTooltip" hidden></div>
  </div>`;
}

const DOW_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// 方格圖的提示框：顯示「Wed, Week 4」而不是日期。
//
// Week N 是從「開始學習的那一天」算起的第幾週，不是月份裡的第幾週——
// 對學習者有意義的是「我已經練到第幾週了」，日曆上的第幾週沒有意義。
function bindHeatmapTooltip(root, weekStartDates, studyStartIso) {
  const card = root.querySelector(".heatmap-card");
  const scroll = root.querySelector(".heatmap-scroll");
  const tip = root.querySelector("#heatTooltip");
  if (!card || !scroll || !tip) return;

  // 起算點對齊到那一週的週一，之後相減才會是整數週
  const origin = studyStartIso ? new Date(studyStartIso) : null;
  if (origin) {
    origin.setHours(0, 0, 0, 0);
    origin.setDate(origin.getDate() - ((origin.getDay() + 6) % 7));
  }

  scroll.addEventListener("mouseover", (e) => {
    const cell = e.target.closest(".heatmap-cell");
    if (!cell || cell.classList.contains("is-empty")) return;

    const dow = Number(cell.dataset.dow);
    const weekIndex = Number(cell.dataset.week);
    const monday = weekStartDates[weekIndex];

    let weekLabel = "";
    if (origin && monday) {
      const diffWeeks = Math.round((monday - origin) / (7 * 24 * 3600 * 1000));
      weekLabel = `, Week ${diffWeeks + 1}`;
    }

    const mins = Number(cell.dataset.minutes);
    tip.innerHTML = `
      <div class="heatmap-tooltip-title">${DOW_SHORT[dow]}${escapeHtml(weekLabel)}</div>
      <div class="heatmap-tooltip-sub">${mins >= 60 ? "1+ hour" : mins + " min"}</div>`;
    tip.hidden = false;

    // 定位基準是整張卡片（不是捲動容器），這樣提示框才能往上溢出到日期標籤之上
    const box = card.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    const left = cellRect.left - box.left + cellRect.width / 2 - tip.offsetWidth / 2;
    // top 不做下限夾制：最上排的方格就是要讓提示框浮在它正上方，
    // 即使超出卡片邊界也沒關係，跟其他列的行為才會一致。
    const top = cellRect.top - box.top - tip.offsetHeight - 8;
    tip.style.left = Math.max(4, Math.min(left, box.width - tip.offsetWidth - 4)) + "px";
    tip.style.top = top + "px";
  });

  scroll.addEventListener("mouseleave", () => {
    tip.hidden = true;
  });
}

function startCountdown(root) {
  countdownTimer = setInterval(() => {
    const el = root.querySelector("#countdown");
    if (!el) {
      stopCountdown();
      return;
    }
    const { hh, mm, ss } = timeLeftToday();
    el.innerHTML = `${hh}:${mm}<span class="goal-remaining-sec">:${ss}</span>`;
  }, 1000);
}

export function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}
