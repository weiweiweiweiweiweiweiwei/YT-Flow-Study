// ============================================================================
// 首頁
// ============================================================================
// 四個區塊（預設由上而下；使用者可以拖曳左上角的 ⠿ 自由調整順序）：
//   1. 每日目標（大數字 + 進度條 + 今日剩餘倒數）與 總沉浸時數 / 今日新單字
//   2. 學習成效 —— 最近 7 天每天沉浸幾分鐘的長條圖（看這一週）
//   3. 沉浸習慣 —— 最近 5 週的方格圖，顏色深淺用固定分鐘門檻（看這個月）
//   4. 年度沉浸 —— 一整年一天一格，跟 GitHub 貢獻圖一樣；右邊可以切換年份（看一整年）
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
import { getSettings, saveSettings } from "../core/storage/settingsStore.js";
import {
  aggregateDailyStats,
  calculateImmersionHabits,
  immersionLevelForMinutes,
  IMMERSION_LEVEL_THRESHOLDS,
} from "../core/analytics/analytics.js";
import { toLocalDateKey } from "../core/models.js";

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
  calendar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/><path d="M16 18h.01"/></svg>`,
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

    // 年度沉浸：可選的年份 = 最早一筆紀錄那年到今年。之前切到哪一年就停在哪一年
    const years = selectableYears(firstSessionAt, now);
    if (!years.includes(selectedYear)) selectedYear = years[0];
    const yearData = await loadYearData(selectedYear);

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

    const blockHtml = {
      overview: renderOverview({ todaySeconds, totalSeconds, words, goalMinutes, now }),
      weekly: renderWeeklyChart(dailyStats),
      habit: renderHeatmap(habits, start),
      year: renderYearCard(yearData, years, now),
    };
    const order = normalizeBlockOrder(settings.homeBlockOrder);

    root.innerHTML = `<div class="home-stack">
      ${isEmpty ? renderRestoreNotice() : ""}
      ${order.map((id) => wrapBlock(id, blockHtml[id])).join("")}
      <!-- 底部留白：讓最後一張卡片也能被捲到畫面正中央來看。
           沒有這段的話，最下面那張卡片永遠只能停在螢幕最下緣。 -->
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
    bindYearCard(root.querySelector("#yearCard"), yearData, years);
    initBlockReorder(root.querySelector(".home-stack"));
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
  // 刻意不跟昨天比（不顯示漲跌百分比）：每天學幾個字本來就起伏很大，
  // 「比昨天 -50%」只會讓人有壓力，對學習沒有幫助。
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  let todayNew = 0;
  for (const w of words) {
    // 只看 createdAt。複習動作不會改動這個欄位，
    // 所以「今日新單字」永遠不會因為複習而往下掉。
    if (new Date(w.createdAt).getTime() >= startOfToday.getTime()) todayNew++;
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
        <div class="summary-value">
          <span class="summary-value-num">${todayNew}</span>
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

// ---------- 年度沉浸（GitHub 貢獻圖的樣子）----------
//
// 沉浸習慣只看最近 5 週，一過就看不到了。這張一次攤開一整年、一天一格，
// 看的是「這一年的沉浸有沒有斷斷續續」。右邊的年份清單可以切到往年。
//
// 版型照 GitHub：一直行是一週、上方標月份、左邊標週一／週三／週五。
// 跟 GitHub 不同的是一週從週一開始（跟上面的沉浸習慣一致），顏色深淺也沿用同一組分鐘門檻，
// 兩張圖的同一天一定是同一個顏色。

const YEAR_DOW_LABELS = ["週一", "", "週三", "", "週五", "", ""];
const WEEKDAY_BY_GETDAY = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];
const DAY_MS = 24 * 3600 * 1000;

// 使用者切到哪一年。在首頁、記憶固化、設定之間切換時保留，重新開啟面板才回到今年
let selectedYear = null;

function selectableYears(firstSessionAt, now = new Date()) {
  const current = now.getFullYear();
  const firstYear = firstSessionAt ? new Date(firstSessionAt).getFullYear() : current;
  const years = [];
  for (let y = current; y >= Math.min(firstYear, current); y--) years.push(y);
  return years;
}

async function loadYearData(year) {
  const start = new Date(year, 0, 1, 0, 0, 0, 0);
  const end = new Date(year, 11, 31, 23, 59, 59, 999);
  const sessions = await getSessionsBetween(start.toISOString(), end.toISOString());
  const stats = aggregateDailyStats({
    sessions,
    reviewEvents: [],
    words: [],
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  });
  const days = stats.map((d) => {
    const minutes = d.immersionSeconds / 60;
    return { date: d.date, minutes, level: immersionLevelForMinutes(minutes) };
  });
  return {
    year,
    days,
    totalSeconds: stats.reduce((sum, d) => sum + d.immersionSeconds, 0),
    activeDays: days.filter((d) => d.minutes > 0).length,
  };
}

function formatMinutesLong(minutes) {
  if (minutes <= 0) return "沒有沉浸紀錄";
  if (minutes < 1) return "不到 1 分鐘";
  const m = Math.round(minutes);
  return m < 60 ? `${m} 分鐘` : `${Math.floor(m / 60)} 小時 ${m % 60} 分`;
}

function renderYearCard(data, years, now = new Date()) {
  const { year, days } = data;
  const jan1 = new Date(year, 0, 1);
  const offset = (jan1.getDay() + 6) % 7; // 1 月 1 日落在那一週的第幾格（週一 = 0）
  const weeks = Math.ceil((offset + days.length) / 7);
  const todayKey = toLocalDateKey(now);

  // 月份標籤放在「這個月 1 號所在的那一週」上方。
  // 1 號如果是週五到週日，那一直行大半還是上個月，標籤就往後挪一格，看起來才對得上。
  const months = [];
  for (let m = 0; m < 12; m++) {
    const cellIndex = offset + Math.round((new Date(year, m, 1) - jan1) / DAY_MS);
    const col = Math.floor(cellIndex / 7) + (cellIndex % 7 >= 4 ? 1 : 0);
    months.push(`<span class="year-month" style="grid-column:${col + 2} / span 4">${m + 1}月</span>`);
  }

  // 依「列（星期）」輸出，每一列 = 星期標籤 + 每一週一格。
  // 年初與年末不屬於這一年的格子保留位置但不顯示，整張圖才是對齊的長方形。
  let cells = "";
  for (let dow = 0; dow < 7; dow++) {
    cells += `<span class="year-dow">${YEAR_DOW_LABELS[dow]}</span>`;
    for (let w = 0; w < weeks; w++) {
      const i = w * 7 + dow - offset;
      const day = i >= 0 ? days[i] : null;
      if (!day) {
        cells += `<span class="year-cell is-out"></span>`;
        continue;
      }
      const future = day.date > todayKey;
      cells += `<span class="year-cell l${future ? 0 : day.level}${future ? " is-future" : ""}" data-i="${i}"></span>`;
    }
  }

  const { h, m } = formatTotalTime(data.totalSeconds);
  const total = h > 0 ? `${h} 小時 ${m} 分` : `${m} 分鐘`;
  const t = IMMERSION_LEVEL_THRESHOLDS;
  const legendTitles = [
    `不足 ${t[0]} 分鐘`,
    `${t[0]}–${t[1]} 分鐘`,
    `${t[1]}–${t[2]} 分鐘`,
    `${t[2]}–${t[3]} 分鐘`,
    `${t[3]} 分鐘以上`,
  ];

  return `
  <div class="card year-card" id="yearCard">
    <div class="year-head">
      <span class="heatmap-title">${ICONS.calendar} 年度沉浸</span>
    </div>
    <div class="year-body">
      <div class="year-main">
        <div class="year-scroll">
          <div class="year-months" style="--weeks:${weeks}">${months.join("")}</div>
          <div class="year-grid" style="--weeks:${weeks}">${cells}</div>
        </div>
        <div class="year-foot">
          <span class="year-summary">${year} 年共沉浸 <strong>${total}</strong>・${data.activeDays} 天</span>
          <span class="heatmap-legend">
            少
            ${legendTitles.map((title, i) => `<i class="l${i}" title="${escapeHtml(title)}"></i>`).join("")}
            多
          </span>
        </div>
      </div>
      <nav class="year-list" aria-label="選擇年份">
        ${years
          .map(
            (y) =>
              `<button type="button" class="year-btn${y === year ? " is-active" : ""}" data-year="${y}" aria-pressed="${y === year}">${y}</button>`
          )
          .join("")}
      </nav>
    </div>
    <!-- 提示框放在捲動容器外面，理由同沉浸習慣：放在裡面，最上排的提示框會被裁掉 -->
    <div class="heatmap-tooltip" id="yearTooltip" hidden></div>
  </div>`;
}

function bindYearCard(card, data, years) {
  if (!card) return;
  const scroll = card.querySelector(".year-scroll");
  const tip = card.querySelector("#yearTooltip");

  scroll.addEventListener("mouseover", (e) => {
    const cell = e.target.closest(".year-cell");
    if (!cell || cell.classList.contains("is-out") || cell.classList.contains("is-future")) return;
    const day = data.days[Number(cell.dataset.i)];
    if (!day) return;

    const [y, mo, d] = day.date.split("-").map(Number);
    const weekday = WEEKDAY_BY_GETDAY[new Date(y, mo - 1, d).getDay()];
    tip.innerHTML = `
      <div class="heatmap-tooltip-title">${mo}月${d}日 ${weekday}</div>
      <div class="heatmap-tooltip-sub">${escapeHtml(formatMinutesLong(day.minutes))}</div>`;
    tip.hidden = false;

    const box = card.getBoundingClientRect();
    const rect = cell.getBoundingClientRect();
    const left = rect.left - box.left + rect.width / 2 - tip.offsetWidth / 2;
    tip.style.left = Math.max(4, Math.min(left, box.width - tip.offsetWidth - 4)) + "px";
    tip.style.top = rect.top - box.top - tip.offsetHeight - 8 + "px";
  });
  scroll.addEventListener("mouseleave", () => {
    tip.hidden = true;
  });

  // 切換年份：只重畫這一張卡片，上面三張不動，也不會跳回頁面頂端
  card.querySelector(".year-list").addEventListener("click", async (e) => {
    const btn = e.target.closest(".year-btn");
    if (!btn || btn.classList.contains("is-active")) return;
    selectedYear = Number(btn.dataset.year);
    try {
      const next = await loadYearData(selectedYear);
      const holder = document.createElement("div");
      holder.innerHTML = renderYearCard(next, years);
      const fresh = holder.firstElementChild;
      card.replaceWith(fresh);
      bindYearCard(fresh, next, years);
    } catch (err) {
      console.error("[FlowStudy] 年度沉浸載入失敗：", err);
    }
  });
}

// ---------- 首頁區塊：拖曳左上角的 ⠿ 調整上下順序 ----------
//
// 四個區塊哪個放上面由使用者決定，順序存在設定裡（flowstudySettings.homeBlockOrder），
// 重新打開面板、從備份還原都會保留。
//
// 把手「⠿」跟字幕條左上角那個是同一個符號，平常看不到，滑鼠靠近區塊左上角才浮現。
// 把手用 absolute 掛在區塊「左邊的留白」裡，不佔區塊的寬度——
// 排進版面的話，區塊會被往右推一點點，就不再置中了。
//
// 拖曳用 pointer 事件自己做，不用 HTML5 的 drag and drop：原生拖曳只會拖著一張
// 半透明截圖走，放開之前看不出其他區塊會怎麼讓位。這裡是整個區塊浮起來跟著滑鼠走，
// 原位留一個虛線框，其他區塊即時滑開讓出位置。

const HOME_BLOCKS = [
  { id: "overview", label: "每日目標" },
  { id: "weekly", label: "學習成效" },
  { id: "habit", label: "沉浸習慣" },
  { id: "year", label: "年度沉浸" },
];
const HOME_BLOCK_IDS = HOME_BLOCKS.map((b) => b.id);
const HANDLE_REVEAL_RADIUS = 72; // 滑鼠離區塊左上角多近（px），把手才浮現
const REORDER_ANIM_MS = 180;
const AUTO_SCROLL_EDGE = 70; // 拖到離可視範圍上下緣這麼近時，頁面自動捲動
const AUTO_SCROLL_MAX_SPEED = 18; // 每一幀最多捲幾 px

let blockDrag = null; // 拖曳中的狀態；null = 沒有在拖
let blockDragSettling = false; // 放開後區塊正滑回版面的那一小段時間，不接受新的拖曳
let revealBound = false;
let lastPointer = null;

// 存起來的順序可能是舊版的、缺了某個區塊、或有重複——整理成「每個區塊剛好一次」，
// 認不得的丟掉，缺的照預設順序補在最後。
function normalizeBlockOrder(saved) {
  const valid = Array.isArray(saved)
    ? saved.filter((id, i, arr) => HOME_BLOCK_IDS.includes(id) && arr.indexOf(id) === i)
    : [];
  return [...valid, ...HOME_BLOCK_IDS.filter((id) => !valid.includes(id))];
}

function wrapBlock(id, html) {
  const label = HOME_BLOCKS.find((b) => b.id === id).label;
  return `<div class="home-block" data-block="${id}">
    <button class="home-block-handle" type="button" title="拖曳調整順序"
            aria-label="調整「${label}」的位置：拖曳，或按上下鍵">⠿</button>
    ${html}
  </div>`;
}

function blocksIn(stack) {
  return [...stack.querySelectorAll(":scope > .home-block")];
}

function currentBlockOrder(stack) {
  return blocksIn(stack).map((b) => b.dataset.block);
}

async function saveBlockOrder(order) {
  try {
    await saveSettings({ homeBlockOrder: order });
  } catch (err) {
    console.error("[FlowStudy] 首頁區塊順序儲存失敗：", err);
  }
}

function initBlockReorder(stack) {
  if (!stack) return;
  for (const handle of stack.querySelectorAll(".home-block-handle")) {
    handle.addEventListener("pointerdown", (e) => startBlockDrag(e, handle, stack));
    handle.addEventListener("keydown", (e) => moveBlockByKey(e, handle, stack));
  }
  // 「靠近左上角」的範圍包含區塊左邊的留白，那裡已經在首頁容器外面了，所以掛在 document 上。
  // 只掛一次：每次回到首頁都會重畫區塊，但這個監聽器是找當下畫面上的區塊，不需要重掛。
  // 每次移動直接算（只讀 4 個區塊的位置，成本很低），不排進 requestAnimationFrame——
  // 分頁在背景時瀏覽器會暫停 animation frame，排進去就等不到了。
  if (!revealBound) {
    revealBound = true;
    document.addEventListener(
      "mousemove",
      (e) => {
        lastPointer = { x: e.clientX, y: e.clientY };
        updateHandleReveal();
      },
      { passive: true }
    );
  }
}

// 只讓「離滑鼠最近、而且夠近」的那一個區塊亮出把手
function updateHandleReveal() {
  if (!lastPointer || blockDrag) return;
  const blocks = document.querySelectorAll(".home-block");
  let nearest = null;
  let best = Infinity;
  for (const block of blocks) {
    const r = block.getBoundingClientRect();
    if (!r.width) continue; // 首頁目前沒在畫面上（切到別頁了）
    const d = Math.hypot(lastPointer.x - r.left, lastPointer.y - r.top);
    if (d < best) {
      best = d;
      nearest = block;
    }
  }
  for (const block of blocks) {
    block.classList.toggle("is-near", block === nearest && best <= HANDLE_REVEAL_RADIUS);
  }
}

// FLIP：先記下每個區塊現在畫在哪裡，改完 DOM 之後，讓它們從舊位置滑到新位置
function animateReflow(elements, mutate) {
  const before = new Map(elements.map((el) => [el, el.getBoundingClientRect().top]));
  mutate();
  for (const el of elements) {
    const dy = before.get(el) - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 0.5) continue;
    el.style.transition = "none";
    el.style.transform = `translateY(${dy}px)`;
    el.getBoundingClientRect(); // 讓瀏覽器先套用起點，下一步的動畫才會真的播出來
    el.style.transition = `transform ${REORDER_ANIM_MS}ms ease`;
    el.style.transform = "";
  }
}

function startBlockDrag(e, handle, stack) {
  if (blockDrag || blockDragSettling || e.button !== 0) return;
  e.preventDefault(); // 拖曳時不要選到文字
  const block = handle.closest(".home-block");
  const rect = block.getBoundingClientRect();

  // 原位留一個一樣高的虛線框，版面才不會因為區塊浮起來而整個往上縮
  const placeholder = document.createElement("div");
  placeholder.className = "home-block-placeholder";
  placeholder.style.height = rect.height + "px";
  block.before(placeholder);

  // 浮起來：改成 fixed 跟著滑鼠走，寬度鎖住，離開版面也不會變寬變窄
  Object.assign(block.style, {
    position: "fixed",
    left: rect.left + "px",
    top: rect.top + "px",
    width: rect.width + "px",
    zIndex: "50",
  });
  block.classList.add("is-lifted");
  document.documentElement.classList.add("home-block-dragging");
  try {
    handle.setPointerCapture(e.pointerId);
  } catch (err) {}

  blockDrag = {
    stack,
    block,
    handle,
    placeholder,
    pointerId: e.pointerId,
    offsetY: e.clientY - rect.top,
    pointerY: e.clientY,
    startOrder: currentBlockOrder(stack),
    scrollFrame: 0,
  };
  // 掛在 window 上：就算指標捕捉失敗、滑鼠跑出把手範圍，也收得到移動與放開
  window.addEventListener("pointermove", onBlockDragMove);
  window.addEventListener("pointerup", onBlockDragEnd);
  window.addEventListener("pointercancel", onBlockDragCancel);
  window.addEventListener("keydown", onBlockDragKey, true);
  blockDrag.scrollFrame = requestAnimationFrame(autoScrollWhileDragging);
}

function onBlockDragMove(e) {
  if (!blockDrag || e.pointerId !== blockDrag.pointerId) return;
  blockDrag.pointerY = e.clientY;
  blockDrag.block.style.top = blockDrag.pointerY - blockDrag.offsetY + "px";
  placeBlockPlaceholder();
}

// 虛線框該放在哪：往上拖時，看浮起區塊的「上緣」有沒有越過別人的中線；往下拖時看「下緣」。
// 不用中心點：區塊很高，中心點離左上角的把手很遠，實測拖到別的區塊上面了還不會換位。
// 比的是版面位置（offsetTop），不是畫面上正在滑動中的位置——
// 用後者的話，判斷結果會跟著讓位動畫一起抖。
function placeBlockPlaceholder() {
  const { stack, block, placeholder } = blockDrag;
  const others = blocksIn(stack).filter((b) => b !== block);
  const top = blockDrag.pointerY - blockDrag.offsetY - stack.getBoundingClientRect().top;
  const bottom = top + block.offsetHeight;
  // 第一個「該排在浮起區塊下面」的區塊，虛線框就插在它前面
  const target =
    others.find((b) => {
      const mid = b.offsetTop + b.offsetHeight / 2;
      return b.offsetTop < placeholder.offsetTop ? top < mid : bottom <= mid;
    }) || null;

  // 虛線框現在後面接的是哪個區塊（跳過還待在原位、已經浮起來的那個）
  let next = placeholder.nextElementSibling;
  while (next && !(next.classList.contains("home-block") && next !== block)) {
    next = next.classList.contains("home-bottom-spacer") ? null : next.nextElementSibling;
  }
  if (next === target) return;

  animateReflow(others, () => {
    stack.insertBefore(placeholder, target || stack.querySelector(":scope > .home-bottom-spacer"));
  });
}

// 拖到可視範圍的上緣或下緣時自動捲動，才能把最下面的區塊一路拖到最上面。
// 上緣從頂欄下方算起（頂欄是黏在上面的，底下的內容看不到）。
function autoScrollWhileDragging() {
  if (!blockDrag) return;
  const topbar = document.querySelector(".topbar");
  const top = (topbar ? topbar.getBoundingClientRect().bottom : 0) + AUTO_SCROLL_EDGE;
  const bottom = window.innerHeight - AUTO_SCROLL_EDGE;
  const y = blockDrag.pointerY;
  let dy = 0;
  if (y < top) dy = -((top - y) / AUTO_SCROLL_EDGE) * AUTO_SCROLL_MAX_SPEED;
  else if (y > bottom) dy = ((y - bottom) / AUTO_SCROLL_EDGE) * AUTO_SCROLL_MAX_SPEED;
  if (dy) {
    const before = window.scrollY;
    window.scrollBy(0, Math.max(-AUTO_SCROLL_MAX_SPEED, Math.min(AUTO_SCROLL_MAX_SPEED, Math.round(dy))));
    if (window.scrollY !== before) placeBlockPlaceholder();
  }
  blockDrag.scrollFrame = requestAnimationFrame(autoScrollWhileDragging);
}

function onBlockDragEnd(e) {
  if (!blockDrag || e.pointerId !== blockDrag.pointerId) return;
  finishBlockDrag(false);
}

function onBlockDragCancel(e) {
  if (!blockDrag || e.pointerId !== blockDrag.pointerId) return;
  finishBlockDrag(true);
}

// 拖到一半按 Esc：放棄，區塊回到原位
function onBlockDragKey(e) {
  if (!blockDrag || e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  finishBlockDrag(true);
}

function finishBlockDrag(cancelled) {
  const d = blockDrag;
  blockDrag = null;
  blockDragSettling = true;
  cancelAnimationFrame(d.scrollFrame);
  window.removeEventListener("pointermove", onBlockDragMove);
  window.removeEventListener("pointerup", onBlockDragEnd);
  window.removeEventListener("pointercancel", onBlockDragCancel);
  window.removeEventListener("keydown", onBlockDragKey, true);
  try {
    d.handle.releasePointerCapture(d.pointerId);
  } catch (err) {}

  const others = blocksIn(d.stack).filter((b) => b !== d.block);
  if (cancelled) {
    // 浮起來的區塊在 DOM 裡一直待在原位，虛線框放回它前面就是原本的位置
    animateReflow(others, () => d.block.before(d.placeholder));
  }

  // 浮起的區塊滑進虛線框，滑到了再真正放回版面
  const target = d.placeholder.getBoundingClientRect();
  d.block.style.transition = `top ${REORDER_ANIM_MS}ms ease, left ${REORDER_ANIM_MS}ms ease`;
  d.block.style.top = target.top + "px";
  d.block.style.left = target.left + "px";

  setTimeout(() => {
    d.placeholder.replaceWith(d.block);
    d.block.removeAttribute("style");
    d.block.classList.remove("is-lifted");
    for (const b of others) b.removeAttribute("style");
    document.documentElement.classList.remove("home-block-dragging");
    blockDragSettling = false;
    const order = currentBlockOrder(d.stack);
    if (order.join() !== d.startOrder.join()) saveBlockOrder(order);
    updateHandleReveal();
  }, REORDER_ANIM_MS);
}

// 鍵盤操作：焦點在把手上時，按上下鍵把區塊往上／往下移一格
function moveBlockByKey(e, handle, stack) {
  if (blockDrag || blockDragSettling || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
  e.preventDefault(); // 不要捲動頁面
  const blocks = blocksIn(stack);
  const block = handle.closest(".home-block");
  const i = blocks.indexOf(block);
  const j = e.key === "ArrowUp" ? i - 1 : i + 1;
  if (j < 0 || j >= blocks.length) return;
  // 搬的是「旁邊那個區塊」而不是自己：焦點所在的元素一被搬動，鍵盤焦點就會掉
  animateReflow(blocks, () => {
    if (e.key === "ArrowUp") block.after(blocks[j]);
    else block.before(blocks[j]);
  });
  saveBlockOrder(currentBlockOrder(stack));
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
