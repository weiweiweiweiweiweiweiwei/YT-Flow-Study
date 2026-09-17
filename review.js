const DEFAULT_GOAL_MINUTES = 30;
const GOAL_STOPS = [15, 30, 60, 120, 180]; // 15分鐘 / 30分鐘 / 1小時 / 2小時 / 3小時
const GOAL_STOP_LABELS = ["15 分鐘", "30 分鐘", "1 小時", "2 小時", "3 小時"];

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function weekdayLabel(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
}

function todayLabel() {
  const d = new Date();
  const weekday = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][d.getDay()];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${weekday}`;
}

function formatTotalTime(totalSeconds) {
  const totalMinutes = Math.round(totalSeconds / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h} h ${m} m` : `${m} m`;
}

function nearestGoalStopIndex(minutes) {
  let bestIndex = 0;
  let bestDiff = Infinity;
  GOAL_STOPS.forEach((stop, i) => {
    const diff = Math.abs(stop - minutes);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIndex = i;
    }
  });
  return bestIndex;
}

function getView() {
  const view = new URLSearchParams(location.search).get("view");
  return view === "words" || view === "settings" ? view : "home";
}

// ---------- 分頁切換：全部在同一個頁面內完成，不開新分頁 / 新視窗 ----------
function navigateTo(view) {
  const url = view === "home" ? "review.html" : `review.html?view=${view}`;
  history.pushState({ view }, "", url);
  renderCurrentView();
}

document.querySelectorAll(".sidebar-link").forEach((link) => {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    navigateTo(link.dataset.view);
  });
});

window.addEventListener("popstate", renderCurrentView);

// ---------- 首頁：每日目標 / 總時數 / 7 天長條圖 ----------
function renderHome() {
  chrome.storage.local.get(null, (all) => {
    const goalMinutes = all.dailyGoalMinutes || DEFAULT_GOAL_MINUTES;
    const todaySeconds = all["immersion:" + fmtDate(new Date())] || 0;
    const todayMinutes = Math.round(todaySeconds / 60);
    const totalSeconds = all.immersion_total_seconds || 0;

    document.getElementById("todayMinutesValue").textContent = todayMinutes;
    document.getElementById("goalMinutesLabel").textContent = `${todayMinutes} / ${goalMinutes} mins`;

    const progressPct = Math.min(100, Math.round((todayMinutes / goalMinutes) * 100));
    document.getElementById("goalProgressFill").style.width = progressPct + "%";

    const remaining = Math.max(0, goalMinutes - todayMinutes);
    document.getElementById("goalRemainingText").textContent =
      remaining > 0 ? `還差 ${remaining} 分鐘達成今日目標` : "🎉 今日目標已達成！";

    document.getElementById("totalTimeValue").textContent = formatTotalTime(totalSeconds);

    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(fmtDate(d));
    }
    const maxMinutes = Math.max(1, ...days.map((day) => Math.round((all["immersion:" + day] || 0) / 60)));

    const barChart = document.getElementById("barChart");
    barChart.innerHTML = days
      .map((day) => {
        const minutes = Math.round((all["immersion:" + day] || 0) / 60);
        const heightPct = Math.max(4, (minutes / maxMinutes) * 100);
        return `<div class="bar-col">
          <div class="bar-minutes">${minutes > 0 ? minutes : ""}</div>
          <div class="bar" style="height:${heightPct}%"></div>
          <div class="bar-day">${weekdayLabel(day)}</div>
        </div>`;
      })
      .join("");
  });
}

// ---------- 收藏單字 ----------
function renderWords() {
  chrome.storage.local.get("learningWords", ({ learningWords }) => {
    const words = Object.entries(learningWords || {}).sort(
      (a, b) => (b[1].addedAt || 0) - (a[1].addedAt || 0)
    );
    const list = document.getElementById("wordList");

    if (words.length === 0) {
      list.innerHTML = `<div class="card empty-hint">目前沒有標記「學習中」的單字，去 YouTube 雙擊翻譯彈窗就可以收藏。</div>`;
      return;
    }

    list.innerHTML = words
      .map(
        ([key, w]) => `<div class="card word-card" data-key="${key}">
          <div class="word-main">
            <div class="word-title">${w.word}</div>
            ${w.sentence ? `<div class="word-def">${w.sentence}</div>` : ""}
          </div>
          <div class="word-actions">
            <span class="word-status-tag">學習中</span>
            <button class="word-unmark-btn" data-key="${key}">取消標記</button>
          </div>
        </div>`
      )
      .join("");

    list.querySelectorAll(".word-unmark-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.key;
        chrome.storage.local.get("learningWords", ({ learningWords }) => {
          const updated = { ...(learningWords || {}) };
          delete updated[key];
          chrome.storage.local.set({ learningWords: updated }, renderWords);
        });
      });
    });
  });
}

// ---------- 設定：每日目標（斷點式滑桿）/ 深淺色模式 ----------
const goalSlider = document.getElementById("goalSlider");
const goalSliderValue = document.getElementById("goalSliderValue");

function renderSettings() {
  chrome.storage.local.get(["dailyGoalMinutes", "themePreference"], (data) => {
    const goalMinutes = data.dailyGoalMinutes || DEFAULT_GOAL_MINUTES;
    const index = nearestGoalStopIndex(goalMinutes);
    goalSlider.value = index;
    goalSliderValue.textContent = GOAL_STOP_LABELS[index];

    applyTheme(data.themePreference || "light");
  });
}

goalSlider.addEventListener("input", () => {
  goalSliderValue.textContent = GOAL_STOP_LABELS[goalSlider.value];
});
goalSlider.addEventListener("change", () => {
  const minutes = GOAL_STOPS[goalSlider.value];
  chrome.storage.local.set({ dailyGoalMinutes: minutes });
});

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem("themePreference", theme);
  } catch (e) {}
  document.getElementById("themeLightBtn").classList.toggle("active", theme === "light");
  document.getElementById("themeDarkBtn").classList.toggle("active", theme === "dark");
}

document.querySelectorAll(".theme-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const theme = btn.dataset.themeValue;
    applyTheme(theme);
    chrome.storage.local.set({ themePreference: theme });
  });
});

function renderCurrentView() {
  const view = getView();
  // 注意：這裡要明確指定 "block"，不能用空字串 ""。空字串只是清掉 inline
  // style，元素會退回去看 review.css 裡 #wordsView/#settingsView 預設的
  // display:none，等於怎麼切都切不出來——這正是單字清單一直顯示不出來的原因。
  document.getElementById("homeView").style.display = view === "home" ? "block" : "none";
  document.getElementById("wordsView").style.display = view === "words" ? "block" : "none";
  document.getElementById("settingsView").style.display = view === "settings" ? "block" : "none";

  const titles = { home: "首頁", words: "收藏單字", settings: "設定" };
  document.getElementById("pageTitle").textContent = titles[view];

  document.querySelectorAll(".sidebar-link").forEach((link) => {
    link.classList.toggle("active", link.dataset.view === view);
  });

  if (view === "home") renderHome();
  else if (view === "words") renderWords();
  else renderSettings();
}

function init() {
  document.getElementById("todayDateLabel").textContent = " · " + todayLabel();
  // 一開始就把主題套用一次（不用等切到設定頁），確保首頁/收藏單字頁也是正確的深淺色。
  chrome.storage.local.get("themePreference", ({ themePreference }) => {
    applyTheme(themePreference || "light");
  });
  renderCurrentView();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const view = getView();
  if (view === "home") renderHome();
  else if (view === "words" && changes.learningWords) renderWords();
  else if (view === "settings" && (changes.dailyGoalMinutes || changes.themePreference)) renderSettings();
});

init();
