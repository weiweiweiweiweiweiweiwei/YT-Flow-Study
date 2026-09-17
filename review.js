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

// 連續達標天數：從今天往回數；如果「今天」還沒達到目標，先跳過今天再往回算，
// 這樣還沒過完的一天不會把前面已經累積的連續紀錄歸零。
function computeStreak(all, goalMinutes) {
  const cursor = new Date();
  const todayMinutes = Math.round((all["immersion:" + fmtDate(cursor)] || 0) / 60);
  if (todayMinutes < goalMinutes) {
    cursor.setDate(cursor.getDate() - 1);
  }

  let streak = 0;
  for (let i = 0; i < 3650; i++) {
    const minutes = Math.round((all["immersion:" + fmtDate(cursor)] || 0) / 60);
    if (minutes < goalMinutes) break;
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

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

    document.getElementById("streakValue").textContent = computeStreak(all, goalMinutes);
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

function renderWords() {
  chrome.storage.local.get("learningWords", ({ learningWords }) => {
    const words = Object.entries(learningWords || {}).sort(
      (a, b) => (b[1].addedAt || 0) - (a[1].addedAt || 0)
    );
    const list = document.getElementById("wordList");

    if (words.length === 0) {
      list.innerHTML = `<div class="empty-hint">目前沒有標記「學習中」的單字，在 YouTube 字幕的單字上按右鍵就可以標記。</div>`;
      return;
    }

    list.innerHTML = words
      .map(
        ([key, w]) => `<div class="word-card">
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

function init() {
  document.getElementById("todayDateLabel").textContent = " · " + todayLabel();

  const view = getView();
  document.getElementById("homeView").style.display = view === "home" ? "" : "none";
  document.getElementById("wordsView").style.display = view === "words" ? "" : "none";
  document.getElementById("pageTitle").textContent = view === "words" ? "學習中單字" : "首頁";
  document.querySelector(".sidebar-link").classList.toggle("active", view === "home");

  if (view === "home") {
    renderHome();
  } else {
    renderWords();
  }
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
