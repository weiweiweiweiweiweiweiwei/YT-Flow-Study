let allWords = [];

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function weekdayLabel(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
}

async function loadData() {
  const all = await chrome.storage.local.get(null);

  allWords = all.savedWords || [];

  // ---- 統計卡片 ----
  document.getElementById("totalWordsValue").textContent = allWords.length;

  // ---- 沉浸時數 ----
  const immersionEntries = Object.entries(all).filter(([k]) => k.startsWith("immersion:"));
  const today = fmtDate(new Date());
  const todaySeconds = all["immersion:" + today] || 0;
  const totalSeconds = immersionEntries.reduce((sum, [, v]) => sum + v, 0);

  document.getElementById("todayMinutesValue").textContent = Math.round(todaySeconds / 60);
  document.getElementById("totalMinutesValue").textContent = Math.round(totalSeconds / 60);

  // ---- 最近 7 天長條圖 ----
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(fmtDate(d));
  }
  const maxMinutes = Math.max(
    1,
    ...days.map((day) => Math.round((all["immersion:" + day] || 0) / 60))
  );

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

  renderWordList();
}

function renderWordList() {
  const list = document.getElementById("wordList");

  if (allWords.length === 0) {
    list.innerHTML = `<div class="empty-hint">目前沒有單字，去 YouTube 點幾個字幕單字吧！</div>`;
    return;
  }

  list.innerHTML = allWords
    .slice()
    .reverse()
    .map(
      (w) => `<div class="word-card">
        <div class="word-main">
          <div class="word-title">${w.word}</div>
          <div class="word-def">${w.definition || ""}</div>
        </div>
      </div>`
    )
    .join("");
}

loadData();
