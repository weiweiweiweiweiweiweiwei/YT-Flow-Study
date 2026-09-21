// ============================================================================
// 設定頁
// ============================================================================
// 只保留兩組設定（使用者明確指定）：
//   外觀        —— 淺色 / 深色
//   每日沉浸目標 —— 滑桿，5 到 120 分鐘，每 5 分鐘一格
//
// 刻意沒有做的：訂閱、付費點數、語言偏好、發音語音、刪除帳戶。
// 這是個人使用的工具，不需要那些。
// ============================================================================

import { getSettings, saveSettings } from "../core/storage/settingsStore.js";
import {
  getDailyBreakdown,
  deleteSession,
  getLegacySession,
  setLegacySeconds,
  getTotalSeconds,
} from "../core/storage/immersionStore.js";

const GOAL_MIN = 5;
const GOAL_MAX = 120;
const GOAL_STEP = 5;

const ICONS = {
  palette: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>`,
  target: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>`,
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

// 單日超過這個時數就列出來讓使用者檢查。
// 影片整夜沒關、或瀏覽器當掉留下沒結束的 session，都可能灌出離譜的數字。
const SUSPICIOUS_HOURS = 6;

async function renderDataMaintenance(root) {
  const box = root.querySelector("#dataMaintenance");
  if (!box) return;

  let days, legacy, total;
  try {
    [days, legacy, total] = await Promise.all([
      getDailyBreakdown(),
      getLegacySession(),
      getTotalSeconds(),
    ]);
  } catch (err) {
    box.innerHTML = `<div class="settings-hint">資料讀取失敗：${escapeHtml(err.message || err)}</div>`;
    return;
  }

  const legacySeconds = legacy ? legacy.watchedSeconds : 0;
  const legacyH = Math.floor(legacySeconds / 3600);
  const legacyM = Math.round((legacySeconds % 3600) / 60);

  // 只看真實記錄到的日子（排除帶入的那一筆），才找得出真正異常的一天
  const suspicious = days.filter(
    (d) => d.seconds >= SUSPICIOUS_HOURS * 3600 && !d.sessions.every((s) => s.source === "legacy-zerostudy")
  );

  box.innerHTML = `
    <div class="data-row">
      <span class="data-label">目前總沉浸時數</span>
      <strong class="data-value">${formatHm(total)}</strong>
    </div>

    <div class="data-block">
      <div class="data-block-title">從其他工具帶入的時數</div>
      <p class="settings-hint">
        這筆紀錄的日期刻意放在所有真實紀錄之前，所以它會計進總時數，
        但不會在首頁「最近 7 天」的長條圖裡長出柱子。
      </p>
      <div class="data-inline">
        <input type="number" id="legacyH" min="0" max="9999" value="${legacyH}" aria-label="小時" />
        <span class="data-unit">小時</span>
        <input type="number" id="legacyM" min="0" max="59" value="${legacyM}" aria-label="分鐘" />
        <span class="data-unit">分</span>
        <button class="data-btn data-btn-primary" id="saveLegacy" type="button">儲存</button>
      </div>
      <div class="settings-hint" id="legacyStatus"></div>
    </div>

    <div class="data-block">
      <div class="data-block-title">異常紀錄檢查（單日超過 ${SUSPICIOUS_HOURS} 小時）</div>
      ${
        suspicious.length
          ? `<p class="settings-hint">影片放著整夜沒關、或瀏覽器當掉留下未結束的紀錄，都會造成離譜的單日時數。確認不是真的看了這麼久，就刪掉它。</p>
             ${suspicious
               .map(
                 (d) => `<div class="data-row data-suspicious">
                   <span>
                     <span class="data-label">${escapeHtml(d.date)}</span>
                     <span class="data-sub">${d.sessions.length} 筆紀錄</span>
                   </span>
                   <span class="data-inline">
                     <strong class="data-value">${formatHm(d.seconds)}</strong>
                     <button class="data-btn data-btn-danger" data-delete-date="${escapeHtml(d.date)}" type="button">刪除這天</button>
                   </span>
                 </div>`
               )
               .join("")}`
          : `<p class="settings-hint">沒有發現異常的單日紀錄。</p>`
      }
    </div>`;

  box.querySelector("#saveLegacy").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const h = Number(box.querySelector("#legacyH").value) || 0;
    const m = Number(box.querySelector("#legacyM").value) || 0;
    try {
      await setLegacySeconds(h * 3600 + m * 60);
      box.querySelector("#legacyStatus").textContent = `已更新為 ${h} 小時 ${m} 分。回首頁即可看到新的總時數。`;
      await renderDataMaintenance(root);
    } catch (err) {
      btn.disabled = false;
      box.querySelector("#legacyStatus").textContent = "儲存失敗：" + (err.message || err);
    }
  });

  box.querySelectorAll("[data-delete-date]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const date = btn.dataset.deleteDate;
      const day = days.find((d) => d.date === date);
      if (!day) return;
      if (!confirm(`確定要刪除 ${date} 的 ${formatHm(day.seconds)} 沉浸紀錄嗎？\n這個動作無法復原。`)) return;

      btn.disabled = true; // 連點不要送出兩次
      try {
        for (const s of day.sessions) await deleteSession(s.id);
        await renderDataMaintenance(root);
      } catch (err) {
        btn.disabled = false;
        console.error("[FlowStudy] 刪除沉浸紀錄失敗：", err);
      }
    });
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

    <div class="card settings-card" id="dataCard">
      <div class="settings-head">${ICONS.database} 沉浸時數維護</div>
      <p class="settings-hint">
        總沉浸時數是由每一筆觀看紀錄加總而來的，不是一個可以單獨改的數字——
        這樣首頁的總時數與長條圖才不會各說各話。要調整總時數，就是在這裡增減紀錄。
      </p>
      <div id="dataMaintenance"><div class="settings-hint">載入中…</div></div>
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

  renderDataMaintenance(root);
}
