// ============================================================================
// 設定頁
// ============================================================================
// 四組設定：
//   帳號與雲端同步 —— Google 登入、同步狀態、立即同步、登出
//   每日沉浸目標   —— 滑桿，5 到 120 分鐘，每 5 分鐘一格
//   外觀          —— 淺色 / 深色
//   資料備份      —— 自動備份的狀態、立即備份、從備份檔還原
//
// 刻意沒有做的：訂閱、付費點數、語言偏好、發音語音、刪除帳戶。
// 這是個人使用的工具，不需要那些。
// ============================================================================

import { getSettings, saveSettings } from "../core/storage/settingsStore.js";
import { restoreBackupSnapshot, validateBackupSnapshot } from "../core/storage/backup.js";

const GOAL_MIN = 5;
const GOAL_MAX = 120;
const GOAL_STEP = 5;

const ICONS = {
  palette: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>`,
  target: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>`,
  cloud: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>`,
  // Google 官方登入按鈕的四色 G（登入按鈕依規範要用原色標誌）
  google: `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`,
  database: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/></svg>`,
};

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatHm(seconds) {
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h} 小時 ${m} 分` : `${m} 分`;
}

function formatDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function describeSummary(summary) {
  if (!summary) return "";
  return `${summary.words} 個單字、${formatHm(summary.immersionSeconds || 0)}沉浸紀錄`;
}

// 設定頁碰得到 IndexedDB，但下載檔案、排程這些事統一交給背景做，
// 自動備份和「立即備份」才會走同一條路、寫進同一個資料夾。
function askBackground(type) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ type }, (res) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!res || !res.ok) reject(new Error((res && res.error) || "背景沒有回應"));
        else resolve(res.data);
      });
    } catch (e) {
      reject(e);
    }
  });
}

// ---------- 帳號與雲端同步 ----------

function describeSync(sync) {
  if (!sync || !sync.at) return { text: "還沒有同步過", isError: false };
  if (!sync.ok) return { text: `${formatDateTime(sync.at)} 同步失敗：${sync.error || "未知錯誤"}`, isError: true };
  let text = `${formatDateTime(sync.at)}・拉回 ${sync.pulled || 0} 筆、上傳 ${sync.pushed || 0} 筆`;
  if (sync.recoveredFromLoss) text += "（偵測到本機資料遺失，已從雲端救回）";
  return { text, isError: false };
}

function renderAccountBody(card, state) {
  const body = card.querySelector("#accountBody");
  const user = state && state.user;

  if (!user) {
    body.innerHTML = `
      <p class="settings-hint">
        用 Google 帳號登入後，單字、沉浸時數、複習紀錄會自動同步到雲端。
        換電腦、或擴充功能被移除後重新安裝，只要登入就能全部拿回來。
      </p>
      <div class="data-actions">
        <button class="google-btn" id="signInBtn" type="button">${ICONS.google}<span>使用 Google 登入</span></button>
      </div>
      ${state && state.redirectUrl ? `
      <details class="account-help">
        <summary>登入視窗出現錯誤？</summary>
        <p class="settings-hint">
          Supabase 後台 → Authentication → URL Configuration → Redirect URLs 需要加入下面這個網址
          （它跟著擴充功能 ID 走，資料夾改名或搬家就會變）：
        </p>
        <code class="data-path account-redirect">${escapeHtml(state.redirectUrl)}</code>
      </details>` : ""}`;
    return;
  }

  const initial = (user.name || user.email || "?").trim().charAt(0).toUpperCase();
  const avatar = user.avatarUrl
    ? `<img class="account-avatar" src="${escapeHtml(user.avatarUrl)}" alt="" referrerpolicy="no-referrer" />`
    : `<span class="account-avatar account-avatar-fallback">${escapeHtml(initial)}</span>`;
  const sync = describeSync(state.sync);

  body.innerHTML = `
    <div class="account-row">
      ${avatar}
      <div class="account-id">
        <div class="account-name">${escapeHtml(user.name || user.email)}</div>
        ${user.name ? `<div class="account-email">${escapeHtml(user.email)}</div>` : ""}
      </div>
      <span class="account-badge">已登入</span>
    </div>
    <div class="data-row">
      <span class="data-label">上次同步</span>
      <span class="data-sub ${sync.isError ? "data-error" : ""}">${escapeHtml(sync.text)}</span>
    </div>
    <div class="data-actions">
      <button class="data-btn data-btn-primary" id="syncNowBtn" type="button">立即同步</button>
      <button class="data-btn" id="signOutBtn" type="button">登出</button>
    </div>`;
}

async function initAccountCard(root) {
  const card = root.querySelector("#accountCard");
  if (!card) return;
  const message = card.querySelector("#accountMessage");
  const showMessage = (text, isError = false) => {
    message.textContent = text;
    message.classList.toggle("data-error", isError);
  };

  let state = null;
  const refresh = async () => {
    state = await askBackground("auth:status");
    renderAccountBody(card, state);
  };

  // 按鈕每次重畫都會換掉，所以事件掛在卡片上統一處理
  card.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn || btn.disabled) return;

    if (btn.id === "signInBtn") {
      btn.disabled = true;
      showMessage("請在跳出的視窗選擇 Google 帳號…");
      try {
        const result = await askBackground("auth:signIn");
        await refresh();
        const s = result && result.sync;
        showMessage(
          s && s.ok
            ? `登入成功，已同步：拉回 ${s.pulled || 0} 筆、上傳 ${s.pushed || 0} 筆。`
            : `登入成功。${s && s.error ? "但第一次同步失敗：" + s.error : ""}`,
          !!(s && s.error)
        );
      } catch (err) {
        btn.disabled = false;
        showMessage(err.message || String(err), true);
      }
    } else if (btn.id === "syncNowBtn") {
      btn.disabled = true;
      showMessage("同步中…");
      try {
        const s = await askBackground("sync:now");
        await refresh();
        showMessage(s && s.ok ? "同步完成。" : "同步失敗：" + ((s && s.error) || "未知錯誤"), !(s && s.ok));
      } catch (err) {
        btn.disabled = false;
        showMessage("同步失敗：" + (err.message || err), true);
      }
    } else if (btn.id === "signOutBtn") {
      if (!confirm("確定要登出嗎？\n\n本機的學習資料都會留著，只是不再同步到雲端。")) return;
      btn.disabled = true;
      try {
        await askBackground("auth:signOut");
        await refresh();
        showMessage("已登出。本機資料都還在。");
      } catch (err) {
        btn.disabled = false;
        showMessage("登出失敗：" + (err.message || err), true);
      }
    }
  });

  try {
    await refresh();
  } catch (err) {
    card.querySelector("#accountBody").innerHTML = "";
    showMessage("讀取登入狀態失敗：" + (err.message || err), true);
  }
}

function renderBackupStatus(box, status) {
  const el = box.querySelector("#backupStatus");
  if (!el) return;
  if (!status || !status.at) {
    el.innerHTML = `<div class="data-row"><span class="data-label">最近一次備份</span><span class="data-sub">還沒有備份過</span></div>`;
  } else {
    el.innerHTML = `
      <div class="data-row">
        <span class="data-label">最近一次備份</span>
        <span class="data-value">${escapeHtml(formatDateTime(status.at))}</span>
      </div>
      <div class="data-row">
        <span class="data-label">內容</span>
        <span class="data-sub">${escapeHtml(describeSummary(status.summary))}</span>
      </div>
      <div class="data-row">
        <span class="data-label">檔案位置</span>
        <span class="data-path" title="${escapeHtml(status.file || "")}">${escapeHtml(status.file || "")}</span>
      </div>`;
  }
  if (status && status.error) {
    el.insertAdjacentHTML(
      "beforeend",
      `<p class="settings-hint data-error">上一次備份失敗：${escapeHtml(status.error)}</p>`
    );
  }
}

async function initBackupCard(root) {
  const box = root.querySelector("#backupCard");
  if (!box) return;
  const message = box.querySelector("#backupMessage");
  const backupBtn = box.querySelector("#backupNow");
  const fileInput = box.querySelector("#restoreFile");

  const showMessage = (text, isError = false) => {
    message.textContent = text;
    message.classList.toggle("data-error", isError);
  };

  try {
    renderBackupStatus(box, await askBackground("backup:status"));
  } catch (err) {
    showMessage("讀取備份狀態失敗：" + (err.message || err), true);
  }

  backupBtn.addEventListener("click", async () => {
    backupBtn.disabled = true;
    showMessage("備份中…");
    try {
      const result = await askBackground("backup:now");
      if (result && result.skipped === "empty") {
        showMessage("目前還沒有任何學習資料，不需要備份。");
      } else {
        renderBackupStatus(box, result && result.status);
        showMessage("備份完成。");
      }
    } catch (err) {
      showMessage("備份失敗：" + (err.message || err), true);
    } finally {
      backupBtn.disabled = false;
    }
  });

  box.querySelector("#restoreBtn").addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = ""; // 同一個檔案再選一次也要能觸發
    if (!file) return;

    let snapshot;
    try {
      snapshot = JSON.parse(await file.text());
    } catch (e) {
      showMessage("這個檔案不是有效的備份檔（JSON 格式錯誤）。", true);
      return;
    }
    const problem = validateBackupSnapshot(snapshot);
    if (problem) {
      showMessage(problem, true);
      return;
    }

    const when = formatDateTime(snapshot.exportedAt);
    const ok = confirm(
      `要從這份備份還原嗎？\n\n備份時間：${when}\n內容：${describeSummary(snapshot.summary)}\n\n` +
        "還原是「合併」：只會把目前沒有的單字和紀錄補回來，不會刪除或覆蓋你現在的任何資料。"
    );
    if (!ok) return;

    showMessage("還原中…");
    try {
      const r = await restoreBackupSnapshot(snapshot);
      // 補回來的單字要在 YouTube 字幕上畫底線，請背景重建索引
      askBackground("vocab:syncIndex").catch(() => {});
      const restored = r.words + r.occurrences + r.reviewEvents + r.immersionSessions + r.videos + r.settings;
      showMessage(
        restored
          ? `還原完成：補回 ${r.words} 個單字、${r.immersionSessions} 筆沉浸紀錄、${r.occurrences} 則例句。`
          : "還原完成：備份裡的資料目前都已經在了，沒有需要補回的東西。"
      );
    } catch (err) {
      console.error("[FlowStudy] 還原失敗：", err);
      showMessage("還原失敗：" + (err.message || err), true);
    }
  });
}

function formatGoal(minutes) {
  if (minutes < 60) return `${minutes} 分鐘`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} 小時` : `${h} 小時 ${m} 分`;
}

export async function renderSettingsPage(root, { onThemeChange } = {}) {
  root.innerHTML = `<div class="card empty-hint">載入中…</div>`;

  let settings;
  try {
    settings = await getSettings();
  } catch (err) {
    console.error("[FlowStudy] 設定載入失敗：", err);
    root.innerHTML = `<div class="card empty-hint">設定讀取失敗，請重新整理頁面。</div>`;
    return;
  }

  // 把存起來的數值夾回合法範圍並對齊 5 分鐘的格點，
  // 避免舊版存的 30 以外數值（例如 25）讓滑桿停在格子中間。
  const goal = Math.min(
    GOAL_MAX,
    Math.max(GOAL_MIN, Math.round((settings.dailyGoalMinutes || 30) / GOAL_STEP) * GOAL_STEP)
  );
  const theme = settings.theme === "dark" ? "dark" : "light";

  root.innerHTML = `
    <div class="card settings-card" id="accountCard">
      <div class="settings-head">${ICONS.cloud} 帳號與雲端同步</div>
      <div id="accountBody"><div class="settings-hint">載入中…</div></div>
      <div class="settings-hint" id="accountMessage" role="status"></div>
    </div>

    <div class="card settings-card">
      <div class="settings-head">${ICONS.target} 每日沉浸目標</div>
      <p class="settings-hint">設定每天想沉浸多久，首頁的進度條會依這個目標計算。</p>

      <div class="goal-slider-row">
        <span class="goal-slider-name">每日沉浸目標</span>
        <span class="goal-slider-value" id="goalValue">${formatGoal(goal)}</span>
      </div>
      <input type="range" id="goalSlider"
             min="${GOAL_MIN}" max="${GOAL_MAX}" step="${GOAL_STEP}" value="${goal}"
             aria-label="每日沉浸目標" />
      <div class="goal-slider-scale">
        <span>${GOAL_MIN}m</span><span>60m</span><span>${GOAL_MAX}m</span>
      </div>
    </div>

    <div class="card settings-card">
      <div class="settings-head">${ICONS.palette} 外觀</div>
      <p class="settings-hint">選擇淺色或深色介面。</p>
      <div class="theme-toggle-row">
        <button class="theme-btn ${theme === "light" ? "active" : ""}" data-theme-value="light" type="button">☀️ 淺色</button>
        <button class="theme-btn ${theme === "dark" ? "active" : ""}" data-theme-value="dark" type="button">🌙 深色</button>
      </div>
    </div>

    <div class="card settings-card" id="backupCard">
      <div class="settings-head">${ICONS.database} 資料備份</div>
      <p class="settings-hint">
        學習資料會自動備份到「下載」資料夾裡的 <b>FlowStudy Backups</b>，一天一個檔案。
        每次更新擴充功能、之後每小時有變動時都會備份；舊的檔案不會被覆蓋。
        萬一資料不見了，用下面的「從備份檔還原」選最新的檔案就能救回來。
      </p>
      <div id="backupStatus"><div class="settings-hint">載入中…</div></div>
      <div class="data-actions">
        <button class="data-btn data-btn-primary" id="backupNow" type="button">立即備份</button>
        <button class="data-btn" id="restoreBtn" type="button">從備份檔還原…</button>
        <input type="file" id="restoreFile" accept=".json,application/json" hidden />
      </div>
      <div class="settings-hint" id="backupMessage" role="status"></div>
    </div>`;

  const slider = root.querySelector("#goalSlider");
  const valueLabel = root.querySelector("#goalValue");

  // input 事件只更新畫面上的數字（拖曳過程會連續觸發，不適合每次都寫入儲存）；
  // change 事件才真正存檔（放開滑鼠時才觸發一次）。
  slider.addEventListener("input", () => {
    valueLabel.textContent = formatGoal(Number(slider.value));
  });
  slider.addEventListener("change", async () => {
    try {
      await saveSettings({ dailyGoalMinutes: Number(slider.value) });
    } catch (err) {
      console.error("[FlowStudy] 每日目標儲存失敗：", err);
    }
  });

  root.querySelectorAll(".theme-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const next = btn.dataset.themeValue;
      root.querySelectorAll(".theme-btn").forEach((b) => {
        b.classList.toggle("active", b === btn);
      });
      if (onThemeChange) onThemeChange(next);
      try {
        await saveSettings({ theme: next });
      } catch (err) {
        console.error("[FlowStudy] 外觀設定儲存失敗：", err);
      }
    });
  });

  initAccountCard(root);
  initBackupCard(root);
}
