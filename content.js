// 這支程式會被注入到 YouTube 網頁裡執行

let wasPlayingBeforeHover = false;
let actionPaused = false; // 使用者點單字／選取片語查詢時設為 true，避免滑鼠移開字幕就自動續播

// ---------- 翻譯框框大小（在擴充功能圖示的小面板裡設定：75/100/150/200%） ----------
chrome.storage.local.get("boxScale", ({ boxScale }) => {
  document.documentElement.style.setProperty("--my-box-scale", (boxScale || 100) / 100);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.boxScale) {
    document.documentElement.style.setProperty("--my-box-scale", changes.boxScale.newValue / 100);
  }
});

// ---------- 字幕拆字 ----------
function wrapWords(el) {
  const currentText = el.textContent;
  if (el.dataset.rawText === currentText) return;
  el.dataset.rawText = currentText;
  el.innerHTML = currentText
    .split(" ")
    .map((w) => (w.trim() ? `<span class="my-word">${w}</span>` : w))
    .join(" ");
}

const observer = new MutationObserver(() => {
  document.querySelectorAll(".ytp-caption-segment").forEach(wrapWords);
});
observer.observe(document.body, {
  childList: true,
  subtree: true,
  characterData: true,
});

function getVideoEl() {
  return document.querySelector("video");
}

// ---------- 滑鼠移到字幕上自動暫停／移開自動續播 ----------
// 用 relatedTarget 判斷「是不是真的離開整個字幕區」，
// 避免滑鼠在字幕裡的一個個單字（子元素）之間移動時，被誤判成離開又進入，造成暫停/播放狀態錯亂。
document.addEventListener("mouseover", (e) => {
  const container = e.target.closest(".ytp-caption-window-container");
  if (!container) return;
  if (container.contains(e.relatedTarget)) return; // 只是在字幕內部的單字之間移動，不算真正進入

  const video = getVideoEl();
  if (video && !video.paused) {
    wasPlayingBeforeHover = true;
    video.pause();
  }
});

document.addEventListener("mouseout", (e) => {
  const container = e.target.closest(".ytp-caption-window-container");
  if (!container) return;
  if (container.contains(e.relatedTarget)) return; // 還在字幕內部移動，不算真正離開

  if (actionPaused) return; // 使用者點了單字或選取了片語，先不要自動續播
  const video = getVideoEl();
  if (video && wasPlayingBeforeHover && video.paused) {
    video.play().catch(() => {});
  }
  wasPlayingBeforeHover = false;
});

// 使用者自己按播放（原生控制列 / 空白鍵）就解除「先不要自動續播」的狀態
document.addEventListener(
  "play",
  (e) => {
    if (e.target.tagName === "VIDEO") {
      actionPaused = false;
      wasPlayingBeforeHover = false;
    }
  },
  true
);

// ---------- 翻譯小框框：只顯示在點擊的單字（或選取的片語）正上方 ----------
function ensureBox() {
  let box = document.getElementById("my-translate-box");
  if (!box) {
    box = document.createElement("div");
    box.id = "my-translate-box";
    box.style.display = "none";
  }
  return box;
}

function closeBox() {
  const box = document.getElementById("my-translate-box");
  if (box) box.style.display = "none";
}

function placeBoxAt(rect) {
  const box = ensureBox();
  const fsEl = document.fullscreenElement;

  if (fsEl) {
    if (box.parentElement !== fsEl) fsEl.appendChild(box);
    if (getComputedStyle(fsEl).position === "static") {
      fsEl.style.position = "relative"; // 讓 box 的 absolute 定位是相對於全螢幕容器，而不是整個畫面
    }
    const fsRect = fsEl.getBoundingClientRect();
    box.style.position = "absolute";
    const left = rect.left - fsRect.left + rect.width / 2;
    const top = rect.top - fsRect.top;
    box.style.left = left + "px";
    box.style.top = Math.max(top - 12, 8) + "px";
    box.style.transform = top - 12 < 8 ? "translate(-50%, 8px)" : "translate(-50%, -100%)";
  } else {
    if (box.parentElement !== document.body) document.body.appendChild(box);
    box.style.position = "absolute";
    const left = rect.left + window.scrollX + rect.width / 2;
    const top = rect.top + window.scrollY;
    box.style.left = left + "px";
    box.style.top = top - 12 + "px";
    box.style.transform = "translate(-50%, -100%)";
  }

  box.style.display = "block";
}

function showBox({ loading, original, translated, error }, rect) {
  const box = ensureBox();

  if (loading) {
    box.innerHTML = `<div class="my-box-original">${original}</div><div class="my-box-loading">翻譯中...</div>`;
  } else if (error) {
    box.innerHTML = `<div class="my-box-original">${original}</div><div class="my-box-loading">${error}</div>`;
  } else {
    box.innerHTML = `<div class="my-box-original">${original}</div><div class="my-box-translated">${translated}</div>`;
  }

  placeBoxAt(rect);
}

// 點擊框框以外的地方，或按 Escape，就把框框關掉
document.addEventListener("click", (e) => {
  const box = document.getElementById("my-translate-box");
  if (!box || box.style.display === "none") return;
  if (box.contains(e.target) || e.target.classList.contains("my-word")) return;
  closeBox();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeBox();
});

// ---------- 共用查詢邏輯 ----------
let currentLookupText = null;

function playPronunciation(text) {
  chrome.runtime.sendMessage({ type: "speak", text }, (result) => {
    if (result && result.audioDataUrl) {
      new Audio(result.audioDataUrl).play().catch(() => {});
    }
  });
}

function doLookup(text, rect) {
  const video = getVideoEl();
  if (video && !video.paused) {
    video.pause();
  }
  actionPaused = true; // 查詢期間 & 查完之後，不要因為滑鼠移開字幕就自動續播

  currentLookupText = text;
  showBox({ loading: true, original: text }, rect);
  playPronunciation(text);

  chrome.runtime.sendMessage({ type: "translate", text }, (result) => {
    if (currentLookupText !== text) return; // 有更新的查詢了，這次的結果就不用顯示
    showBox({ original: text, translated: result?.translated, error: result?.error }, rect);
  });
}

// ---------- 點擊單字 ----------
document.addEventListener("click", (e) => {
  if (!e.target.classList.contains("my-word")) return;
  const sel = window.getSelection();
  if (sel && sel.toString().trim().length > 0) return; // 使用者其實是在選取片語，不當作單字點擊
  doLookup(e.target.textContent, e.target.getBoundingClientRect());
});

// ---------- 選取一段字幕文字（片語查詢） ----------
// 選取後，把範圍「吸附」成完整單字（例如選到 were 中間，也會自動補成整個 were），
// 不會切到單字一半。作法是看選取範圍碰到了哪些 .my-word（哪怕只碰到一部分），
// 就把選取範圍重新設定成從第一個字的開頭到最後一個字的結尾。
document.addEventListener("mouseup", (e) => {
  if (!e.target.closest(".ytp-caption-window-container")) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;

  const range = sel.getRangeAt(0);
  const words = Array.from(document.querySelectorAll(".ytp-caption-window-container .my-word")).filter((el) =>
    range.intersectsNode(el)
  );

  if (words.length === 0) {
    const text = sel.toString().trim();
    if (!text) return;
    doLookup(text, range.getBoundingClientRect());
    return;
  }

  const firstWord = words[0];
  const lastWord = words[words.length - 1];
  const snappedRange = document.createRange();
  snappedRange.setStart(firstWord.firstChild || firstWord, 0);
  snappedRange.setEnd(lastWord.firstChild || lastWord, (lastWord.textContent || "").length);

  sel.removeAllRanges();
  sel.addRange(snappedRange);

  const text = words.map((w) => w.textContent).join(" ").trim();
  if (!text) return;
  doLookup(text, snappedRange.getBoundingClientRect());
});

// 讓「在字幕文字上按住拖曳」變成選字，而不是被 YouTube 原生的拖曳字幕位置功能搶走。
// 用 capture 階段攔截，只要滑鼠是從文字本身按下去的，就不讓事件傳到 YouTube 自己的拖曳判斷邏輯，
// 但如果是按在文字以外的空白／把手區域，就放行，YouTube 原本「拖曳移動字幕」的功能還是可以用。
document.addEventListener(
  "mousedown",
  (e) => {
    if (e.target.closest(".my-word") || e.target.classList.contains("ytp-caption-segment")) {
      e.stopPropagation();
    }
  },
  true
);

// 瀏覽器原生也有一個「把選取的文字拖走」的功能（拖曳時會出現一個半透明的文字殘影，
// 也就是你看到的「鬼影」），這跟我們要的「拖曳來選字」互相衝突。把它擋掉：
// 只要是從字幕文字身上開始的拖曳，一律取消瀏覽器原生的拖曳行為，但不影響正常的滑鼠選字。
document.addEventListener(
  "dragstart",
  (e) => {
    if (e.target.closest(".ytp-caption-window-container")) {
      e.preventDefault();
    }
  },
  true
);

// ---------- 句子斷點：a 上一句／s 重播這句／d 下一句 ----------
let subtitleCues = []; // [{ start, end, text }]
let cuesLoadedForVideoId = null;

function getVideoId() {
  return new URLSearchParams(location.search).get("v");
}

// 從整段 HTML 文字裡，找出 "captionTracks": [ ... ] 這個區塊，用括號配對的方式抓出完整陣列
// （不是用單純的正規表達式，因為裡面的 JSON 有很多層巢狀物件，正規表達式容易抓錯範圍）
function extractJsonArray(text, key) {
  const marker = `"${key}":`;
  const start = text.indexOf(marker);
  if (start === -1) return null;

  let i = start + marker.length;
  while (i < text.length && text[i] !== "[") i++;
  if (text[i] !== "[") return null;

  const arrStart = i;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(arrStart, i + 1);
    }
  }
  return null;
}

async function loadCaptionCues() {
  const videoId = getVideoId();
  if (!videoId || videoId === cuesLoadedForVideoId) return;

  let tracks = null;

  // 方法一（優先）：直接問 YouTube 播放器物件本身要目前這部影片的字幕軌清單，
  // 這是播放器本來就有提供的方法，比較不受 YouTube 網頁原始碼格式變動影響。
  try {
    const player = document.getElementById("movie_player");
    if (player && typeof player.getPlayerResponse === "function") {
      const resp = player.getPlayerResponse();
      tracks = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks || null;
    }
  } catch (e) {
    tracks = null;
  }

  // 方法二（備用）：方法一失敗的話，退回去從網頁原始碼裡挖字幕資料
  if (!tracks || !tracks.length) {
    try {
      const html = await fetch(location.href).then((r) => r.text());
      const raw = extractJsonArray(html, "captionTracks");
      if (raw) tracks = JSON.parse(raw.replace(/\\u0026/g, "&"));
    } catch (e) {
      tracks = null;
    }
  }

  if (!tracks || !tracks.length) {
    console.warn("[MyWordLookup] 這部影片找不到字幕軌資料，a/s/d 快捷鍵暫時無法使用（可能這部影片沒有字幕）");
    subtitleCues = [];
    return;
  }

  try {
    // 優先找英文字幕，沒有的話用第一個可用的字幕軌
    const track = tracks.find((t) => t.languageCode && t.languageCode.startsWith("en")) || tracks[0];
    if (!track || !track.baseUrl) {
      subtitleCues = [];
      return;
    }
    const capUrl = track.baseUrl + "&fmt=json3";
    const data = await fetch(capUrl).then((r) => r.json());
    subtitleCues = (data.events || [])
      .filter((ev) => ev.segs && ev.segs.length)
      .map((ev) => ({
        start: ev.tStartMs / 1000,
        end: (ev.tStartMs + (ev.dDurationMs || 0)) / 1000,
        text: ev.segs.map((s) => s.utf8 || "").join("").trim(),
      }))
      .filter((c) => c.text);
    cuesLoadedForVideoId = videoId;
    console.log(`[MyWordLookup] 已載入 ${subtitleCues.length} 句字幕斷點，a/s/d 快捷鍵可以用了`);
  } catch (e) {
    console.warn("[MyWordLookup] 句子斷點資料載入失敗，快捷鍵功能可能暫時無法使用：", e);
    subtitleCues = [];
  }
}

function findCurrentCueIndex() {
  const video = getVideoEl();
  if (!video || !subtitleCues.length) return -1;
  const t = video.currentTime;
  let idx = subtitleCues.findIndex((c) => t >= c.start && t < c.end);
  if (idx === -1) {
    // 落在兩句字幕的空檔，找最近一句已經開始播放的
    for (let i = subtitleCues.length - 1; i >= 0; i--) {
      if (subtitleCues[i].start <= t) {
        idx = i;
        break;
      }
    }
  }
  return idx;
}

document.addEventListener("keydown", (e) => {
  const active = document.activeElement;
  const tag = active && active.tagName;
  // 使用者在輸入框（留言、搜尋等）打字時不要誤觸
  if (tag === "INPUT" || tag === "TEXTAREA" || (active && active.isContentEditable)) return;

  const key = e.key.toLowerCase();
  if (key !== "a" && key !== "s" && key !== "d") return;

  const video = getVideoEl();
  if (!video || !subtitleCues.length) return;

  const idx = findCurrentCueIndex();
  if (idx === -1) return;

  if (key === "s") {
    video.currentTime = subtitleCues[idx].start;
  } else if (key === "a" && idx > 0) {
    video.currentTime = subtitleCues[idx - 1].start;
  } else if (key === "d" && idx < subtitleCues.length - 1) {
    video.currentTime = subtitleCues[idx + 1].start;
  }
});

loadCaptionCues();
// YouTube 是 SPA，換片不會整頁重新載入，定期確認是否要重新抓字幕句子資料
setInterval(loadCaptionCues, 3000);
