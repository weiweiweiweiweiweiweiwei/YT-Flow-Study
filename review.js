const DEFAULT_GOAL_MINUTES = 30;

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

function getView() {
  return new URLSearchParams(location.search).get("view") === "words" ? "words" : "home";
}

// ---------- 分頁切換：全部在同一個頁面內完成，不開新分頁 / 新視窗 ----------
function navigateTo(view) {
  const url = view === "words" ? "review.html?view=words" : "review.html";
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

// ---------- 每日目標：直接在首頁卡片上編輯，不用跳去 popup ----------
const goalEditBtn = document.getElementById("goalEditBtn");
const goalEditRow = document.getElementById("goalEditRow");
const goalEditInput = document.getElementById("goalEditInput");
const goalSaveBtn = document.getElementById("goalSaveBtn");

goalEditBtn.addEventListener("click", () => {
  chrome.storage.local.get("dailyGoalMinutes", ({ dailyGoalMinutes }) => {
    goalEditInput.value = dailyGoalMinutes || DEFAULT_GOAL_MINUTES;
    goalEditRow.hidden = false;
    goalEditInput.focus();
    goalEditInput.select();
  });
});

function saveGoal() {
  const value = Math.max(1, Number(goalEditInput.value) || DEFAULT_GOAL_MINUTES);
  chrome.storage.local.set({ dailyGoalMinutes: value }, () => {
    goalEditRow.hidden = true;
    renderHome();
  });
}

goalSaveBtn.addEventListener("click", saveGoal);
goalEditInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveGoal();
  if (e.key === "Escape") goalEditRow.hidden = true;
});

// ---------- 收藏單字 ----------
function renderWords() {
  chrome.storage.local.get("learningWords", ({ learningWords }) => {
    const words = Object.entries(learningWords || {}).sort(
      (a, b) => (b[1].addedAt || 0) - (a[1].addedAt || 0)
    );
    const list = document.getElementById("wordList");

    if (words.length === 0) {
      list.innerHTML = `<div class="glass-card empty-hint">目前沒有標記「學習中」的單字，去 YouTube 雙擊翻譯彈窗就可以收藏。</div>`;
      return;
    }

    list.innerHTML = words
      .map(
        ([key, w]) => `<div class="glass-card word-card" data-key="${key}">
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

function renderCurrentView() {
  const view = getView();
  document.getElementById("homeView").style.display = view === "home" ? "" : "none";
  document.getElementById("wordsView").style.display = view === "words" ? "" : "none";
  document.getElementById("pageTitle").textContent = view === "words" ? "收藏單字" : "首頁";
  document.querySelectorAll(".sidebar-link").forEach((link) => {
    link.classList.toggle("active", link.dataset.view === view);
  });
  goalEditRow.hidden = true;

  if (view === "home") {
    renderHome();
  } else {
    renderWords();
  }
}

function init() {
  document.getElementById("todayDateLabel").textContent = " · " + todayLabel();
  renderCurrentView();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (getView() === "home") {
    renderHome();
  } else if (changes.learningWords) {
    renderWords();
  }
});

init();
