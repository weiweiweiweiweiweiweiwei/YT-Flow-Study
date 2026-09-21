// ============================================================================
// 學習面板路由
// ============================================================================
// 四個頁面都在同一份 HTML 裡切換，不開新分頁。
// 這個檔案只負責「切換哪一個 view」與共用的主題套用，
// 每一頁的內容各自放在 pages/ 底下的模組裡。
// ============================================================================

import { getSettings } from "./core/storage/settingsStore.js";
import { renderHomePage, stopCountdown } from "./pages/homePage.js";
import { renderMemoryPage, getTotalWordCount } from "./pages/memoryPage.js";
import { renderSettingsPage } from "./pages/settingsPage.js";

// 注意：pages/reinforcePage.js（間隔重複複習）已經不在路由裡。
// 「記憶固化」這個名字現在給了以影片為核心的複習模組，兩者同名會混淆。
// 那支檔案還留在磁碟上，日後要接回來再加進這張表即可。
const VIEWS = {
  home: { title: "首頁", subtitle: "歡迎回來！保持習慣就會不斷進步", section: "homeView" },
  memory: { title: "記憶固化", subtitle: "", section: "memoryView" },
  settings: { title: "設定", subtitle: "調整每日目標與介面外觀", section: "settingsView" },
};

function getView() {
  const view = new URLSearchParams(location.search).get("view");
  return VIEWS[view] ? view : "home";
}

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

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  // localStorage 是同步的，theme-init.js 在畫面繪製前用它避免深色模式閃白
  try {
    localStorage.setItem("themePreference", theme);
  } catch (e) {}
}

async function renderCurrentView() {
  const view = getView();
  const meta = VIEWS[view];

  // 離開首頁時要停掉「今日剩餘」的每秒倒數，否則切走之後計時器還在背景跑
  stopCountdown();

  for (const [name, info] of Object.entries(VIEWS)) {
    const el = document.getElementById(info.section);
    if (el) el.style.display = name === view ? "block" : "none";
  }

  document.getElementById("pageTitle").textContent = meta.title;
  const subtitle = document.getElementById("pageSubtitle");
  subtitle.textContent = meta.subtitle;
  subtitle.style.display = meta.subtitle ? "block" : "none";

  document.querySelectorAll(".sidebar-link").forEach((link) => {
    link.classList.toggle("active", link.dataset.view === view);
  });

  const root = document.getElementById(meta.section);
  if (view === "home") await renderHomePage(root);
  else if (view === "memory") await renderMemoryPage(root);
  else await renderSettingsPage(root, { onThemeChange: applyTheme });

  // 記憶固化的副標要等資料載入後才知道收藏了幾個字
  if (view === "memory") {
    const n = getTotalWordCount();
    subtitle.textContent = n ? `已收藏 ${n} 個單字，點影片開始複習` : "還沒有收藏任何單字";
    subtitle.style.display = "block";
  }
}

async function init() {
  try {
    const settings = await getSettings();
    applyTheme(settings.theme === "dark" ? "dark" : "light");
    const badge = document.getElementById("langBadge");
    if (badge) badge.textContent = settings.targetLanguage === "en" ? "English" : settings.targetLanguage;
  } catch (e) {
    applyTheme("light");
  }
  renderCurrentView();
}

init();
