// 這支程式會被注入到 YouTube 網頁裡執行

let wasPlayingBeforeHover = false;
let actionPaused = false; // 使用者點單字／選取片語查詢時設為 true，避免滑鼠移開字幕就自動續播

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

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
  refreshMarkedHighlight();
  recordLiveCaptionCue();
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
      syncMediaSessionPlaybackState();
    }
  },
  true
);
document.addEventListener(
  "pause",
  (e) => {
    if (e.target.tagName === "VIDEO") syncMediaSessionPlaybackState();
  },
  true
);

// ---------- 滑鼠多媒體鍵（播放/暫停二合一）雙向切換 ----------
// 像羅技滑鼠側鍵這類「硬體多媒體鍵」，Windows/Chrome 是透過 Media Session API
// 轉發的，不是單純的 keydown 事件。如果同時用 keydown 監聽 MediaPlayPause 又讓
// Chrome 自己內建的 Media Session 行為一起跑，兩邊會各自切換一次播放/暫停，
// 等於「雙重觸發」：按一下等於沒按，連續按幾次狀態就完全亂掉。
// 正確做法是改用 setActionHandler 直接接管，並且主動回報 playbackState，
// 這樣 Chrome 才知道目前真正是播放還暫停，不會兩邊各做各的。
function syncMediaSessionPlaybackState() {
  if (!("mediaSession" in navigator)) return;
  const video = getVideoEl();
  navigator.mediaSession.playbackState = video && !video.paused ? "playing" : "paused";
}

// YouTube 頁面自己也會註冊 play/pause 的 Media Session handler，而且會在換片、
// 廣告開始/結束、查字翻譯暫停等時機重新設定一次，把我們的 handler 蓋掉，
// 導致「有時候有效、有時候完全沒反應」。setActionHandler 沒有疊加機制，
// 後設定的會直接取代前面的，單靠它不夠可靠。
//
// 改用「雙保險 + 去重」：Media Session handler 跟原始 keydown 監聽同時開著，
// 不管當下是哪一個機制真正接住這次按鍵，都交給同一個 toggleVideoPlayback()
// 處理；用時間戳記把 250ms 內的重複觸發視為同一次實體按鍵、直接忽略，
// 這樣不管 Media Session 有沒有被 YouTube 蓋掉，都一定有另一條路徑能生效，
// 也不會因為兩條路徑「剛好都有效」而變成按一下同時切換兩次、等於沒按到。
let lastMediaToggleAt = 0;
const MEDIA_TOGGLE_DEBOUNCE_MS = 250;

function toggleVideoPlayback() {
  const now = Date.now();
  if (now - lastMediaToggleAt < MEDIA_TOGGLE_DEBOUNCE_MS) return;
  lastMediaToggleAt = now;

  const video = getVideoEl();
  if (!video) return;

  if (video.paused) {
    actionPaused = false;
    video.play().catch(() => {});
  } else {
    actionPaused = true;
    video.pause();
  }
}

function claimMediaSessionHandlers() {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.setActionHandler("play", toggleVideoPlayback);
  navigator.mediaSession.setActionHandler("pause", toggleVideoPlayback);
}

claimMediaSessionHandlers();

const MEDIA_TOGGLE_KEYS = new Set(["MediaPlayPause", "MediaPlay", "MediaPause"]);
document.addEventListener("keydown", (e) => {
  if (!MEDIA_TOGGLE_KEYS.has(e.key) && !MEDIA_TOGGLE_KEYS.has(e.code)) return;
  e.preventDefault();
  toggleVideoPlayback();
});

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
let currentLookupSentence = ""; // 目前查詢的單字/片語所在的整句字幕，雙擊收藏時一併存起來當作上下文

let currentAudio = null;
let pronunciationRequestId = 0;

function playPronunciation(text) {
  // 連續點好幾個單字時，新的查詢要立刻打斷還在播放/還在等待回應的舊發音，
  // 不然舊的語音請求晚到達時還是會播，疊在一起變成一團亂。
  const requestId = ++pronunciationRequestId;
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }

  chrome.runtime.sendMessage({ type: "speak", text }, (result) => {
    if (requestId !== pronunciationRequestId) return; // 已經有更新的查詢了，這個舊回應不要播
    if (result && result.audioDataUrl) {
      const audio = new Audio(result.audioDataUrl);
      currentAudio = audio;
      audio.play().catch(() => {});
    }
  });
}

function doLookup(text, rect, sentence) {
  const video = getVideoEl();
  if (video && !video.paused) {
    video.pause();
  }
  actionPaused = true; // 查詢期間 & 查完之後，不要因為滑鼠移開字幕就自動續播

  currentLookupText = text;
  currentLookupSentence = sentence || "";
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
  const sentence = e.target.closest(".ytp-caption-segment")?.textContent?.trim() || "";
  doLookup(e.target.textContent, e.target.getBoundingClientRect(), sentence);
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
  const sentence = e.target.closest(".ytp-caption-segment")?.textContent?.trim() || "";

  if (words.length === 0) {
    const text = sel.toString().trim();
    if (!text) return;
    doLookup(text, range.getBoundingClientRect(), sentence);
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
  doLookup(text, snappedRange.getBoundingClientRect(), sentence);
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
//
// 字幕斷點資料有兩個來源：
// 1. 預先抓取（loadCaptionCues）：直接問 YouTube 要這部影片完整的字幕時間軸，
//    成功的話可以連「還沒播到」的未來句子都能跳，最完整。但依賴 YouTube 內部
//    API／網頁格式，這兩個管道都可能因為 YouTube 改版而失效。
// 2. 即時記錄（recordLiveCaptionCue）：不依賴任何 YouTube 內部格式，單純把
//    畫面上「已經顯示過」的字幕連同當下播放時間記下來，當作備援。缺點是只能
//    跳到已經看過（含倒轉回去看過）的句子，沒辦法預先跳到還沒播到的未來句子。
//    只要預先抓取還沒成功，就持續用這個方式即時累積，讓功能至少堪用。
let subtitleCues = []; // [{ start, text }]，依 start 由小到大排序
let cuesLoadedForVideoId = null;
let lastRecordedCueText = null;
let lastRecordedCueVideoId = null;
let maxRecordedCueStart = -1; // 目前已經記錄過、最晚的一句開始時間

function getVideoId() {
  return new URLSearchParams(location.search).get("v");
}

function getCurrentCaptionSentence() {
  return Array.from(document.querySelectorAll(".ytp-caption-window-container .ytp-caption-segment"))
    .map((el) => el.textContent.trim())
    .filter(Boolean)
    .join(" ");
}

let lastRawCaptionText = "";
let sentenceBuffer = "";
let sentenceBufferStart = null;

// 實測發現 YouTube 這種自動語音辨識字幕（caps=asr）是「一直往前滑動的視窗」：
// 舊的字會從前面被擠掉、新的字從後面補上（例如 "...decade of creating on YouTube.
// Um, I got started" 接著變成 "...on YouTube. Um, I got started in 2017. That's
// when I published my first YouTube"），不是從空白長成完整一句再清空換下一句。
// 所以不能再用「新內容是不是舊內容的延伸」判斷，要改成：找出新視窗裡「真正沒看過
// 的那一小段新字」，把它接到一個持續累積的緩衝區裡，遇到句尾標點（. ! ?）才把
// 緩衝區內容當作一句完整的斷點提交、重新開始累積下一句。
function findNewSuffix(oldText, newText) {
  if (!oldText) return newText;
  const oldWords = oldText.split(" ");
  const newWords = newText.split(" ");
  const maxOverlap = Math.min(oldWords.length, newWords.length);
  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    const oldTail = oldWords.slice(oldWords.length - overlap).join(" ");
    const newHead = newWords.slice(0, overlap).join(" ");
    if (oldTail === newHead) {
      return newWords.slice(overlap).join(" ").trim();
    }
  }
  return newText; // 完全沒有重疊，整段都算新的
}

function flushSentenceBuffer() {
  if (!sentenceBuffer) return;
  const text = sentenceBuffer;
  const start = sentenceBufferStart;
  sentenceBuffer = "";
  sentenceBufferStart = null;
  lastRecordedCueText = text;

  // 使用者倒轉/重播過的話，同一段內容、差不多的時間點可能已經記錄過一次了。
  // 這裡用「開始時間很接近 + 文字相同」判斷是不是重複，重複就不要再加一筆，
  // 不然陣列裡會出現時間不是遞增排列的重複項目，導致 a/s/d 在兩個點之間跳來跳去。
  const isDuplicate = subtitleCues.some((c) => c.text === text && Math.abs(c.start - start) < 1.5);
  if (!isDuplicate) {
    subtitleCues.push({ start, text });
    subtitleCues.sort((a, b) => a.start - b.start); // 保證陣列一直照時間先後排序
    if (subtitleCues.length > 500) subtitleCues.shift(); // 避免長時間播放無限增長
    maxRecordedCueStart = Math.max(maxRecordedCueStart, start);
    console.log(`[FlowStudy] 即時記錄新增一句：${start.toFixed(1)}s「${text}」`);
  } else {
    console.log(`[FlowStudy] 即時記錄判定為重複，跳過：${start.toFixed(1)}s「${text}」`);
  }
}

function recordLiveCaptionCue() {
  const videoId = getVideoId();
  if (!videoId) return;

  if (videoId !== lastRecordedCueVideoId) {
    // 換了一部影片：即時記錄要重新開始；如果這部影片也還沒有成功預先抓取過，
    // 舊影片留下的斷點資料就沒有意義了，一併清掉。
    lastRecordedCueVideoId = videoId;
    lastRecordedCueText = null;
    lastRawCaptionText = "";
    sentenceBuffer = "";
    sentenceBufferStart = null;
    maxRecordedCueStart = -1;
    if (cuesLoadedForVideoId !== videoId) subtitleCues = [];
  }

  if (cuesLoadedForVideoId === videoId) return; // 這部影片已經有完整的預先抓取資料，不需要即時記錄

  const video = getVideoEl();
  if (!video) return;

  // 使用者按了 a/s 往回跳、或自己倒轉了進度條：這段內容我們已經記錄過了，
  // 不要因為重播又把它當成新句子記一次（不然陣列會冒出時間亂序的重複片段，
  // 造成 a/s/d 在兩個點之間跳來跳去）。等播回「還沒記錄過」的新地方再繼續累積，
  // 這裡先把緩衝區清空，避免用舊的殘留內容去跟新內容做不正確的字串比對。
  if (video.currentTime < maxRecordedCueStart - 1) {
    if (lastRawCaptionText || sentenceBuffer) {
      lastRawCaptionText = "";
      sentenceBuffer = "";
      sentenceBufferStart = null;
    }
    return;
  }

  const sentence = getCurrentCaptionSentence();

  if (!sentence) {
    // 字幕窗口清空了：代表這句真的講完了，把緩衝區內容提交成一筆完整斷點
    flushSentenceBuffer();
    lastRawCaptionText = "";
    return;
  }
  if (sentence === lastRawCaptionText) return; // 內容沒變，不用做事

  const newSuffix = findNewSuffix(lastRawCaptionText, sentence);
  const hadOverlap = newSuffix.length < sentence.length;
  lastRawCaptionText = sentence;
  if (!newSuffix) return;

  if (!hadOverlap && sentenceBuffer) {
    // 完全沒有重疊：字幕內容整個被換掉了（例如中間有一段沒捕捉到的空檔），
    // 先把目前緩衝的內容當作一句提交，再從這段新內容重新開始累積。
    flushSentenceBuffer();
  }

  if (!sentenceBuffer) sentenceBufferStart = video.currentTime;
  sentenceBuffer = (sentenceBuffer + " " + newSuffix).trim();

  // 新增的這段字尾端有句尾標點，或緩衝區已經累積了不少字，代表一句話講完了。
  if (/[.!?]\s*$/.test(newSuffix) || sentenceBuffer.split(" ").length > 40) {
    flushSentenceBuffer();
  }
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

// 方法三（再備用）：YouTube 有一個獨立的公開 timedtext 列表 API，只要有影片 ID
// 就能直接問「這部影片有哪些字幕軌」，完全不需要經過播放器物件或網頁原始碼，
// 前兩個方法都失敗時（通常是 YouTube 調整了播放器物件／頁面格式）用這個頂上。
async function fetchTracksViaTimedTextList(videoId) {
  try {
    const xml = await fetch(`https://www.youtube.com/api/timedtext?type=list&v=${videoId}`).then((r) =>
      r.text()
    );
    console.log("[FlowStudy] 方法三 timedtext list 原始回應（前 300 字）：", (xml || "").slice(0, 300));
    if (!xml) return null;

    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const trackEls = Array.from(doc.getElementsByTagName("track"));
    console.log("[FlowStudy] 方法三解析出的字幕軌數量：", trackEls.length);
    if (!trackEls.length) return null;

    return trackEls.map((el) => {
      const lang = el.getAttribute("lang_code") || "";
      const kind = el.getAttribute("kind") || "";
      const params = new URLSearchParams({ v: videoId, lang });
      if (kind) params.set("kind", kind);
      return { languageCode: lang, baseUrl: `https://www.youtube.com/api/timedtext?${params.toString()}` };
    });
  } catch (e) {
    console.warn("[FlowStudy] 方法三發生例外：", e);
    return null;
  }
}

// 方法零（最優先）：直接問 YouTube 網頁本身「顯示字幕稿」那個面板實際呼叫的
// 內部 API（InnerTube get_transcript）。這是 YouTube 自己的字幕稿功能在用的
// 端點，理論上比舊版 timedtext 端點更不容易被伺服器擋下來——畢竟擋了等於
// YouTube 自己的字幕稿功能也會壞掉。所需的 API 金鑰跟請求參數，都直接從
// 網頁原始碼裡挖（跟方法二共用同一份抓回來的原始碼，不用多打一次）。
async function fetchCuesViaInnerTube(videoId, html) {
  try {
    const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
    const clientVersionMatch = html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/);
    const paramsMatch = html.match(/"getTranscriptEndpoint":\s*\{\s*"params":"([^"]+)"/);

    console.log(
      "[FlowStudy] 方法零：找到 API 金鑰？",
      !!apiKeyMatch,
      "找到字幕稿 params？",
      !!paramsMatch
    );
    if (!apiKeyMatch || !paramsMatch) return null;

    const body = {
      context: {
        client: {
          clientName: "WEB",
          clientVersion: clientVersionMatch ? clientVersionMatch[1] : "2.20240101.00.00",
        },
      },
      params: paramsMatch[1],
    };

    const res = await fetch(`https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKeyMatch[1]}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    console.log("[FlowStudy] 方法零回應：", data);

    const segments =
      data?.actions?.[0]?.updateEngagementPanelAction?.content?.transcriptRenderer?.content
        ?.transcriptSearchPanelRenderer?.body?.transcriptSegmentListRenderer?.initialSegments || [];

    const cues = segments
      .map((seg) => {
        const r = seg.transcriptSegmentRenderer;
        if (!r) return null;
        const text = (r.snippet?.runs || []).map((run) => run.text).join("");
        const startMs = Number(r.startMs);
        if (!text || Number.isNaN(startMs)) return null;
        return { start: startMs / 1000, text: text.trim() };
      })
      .filter(Boolean);

    console.log("[FlowStudy] 方法零解析出的字幕句數：", cues.length);
    return cues.length ? cues : null;
  } catch (e) {
    console.warn("[FlowStudy] 方法零發生例外：", e);
    return null;
  }
}

async function loadCaptionCues() {
  const videoId = getVideoId();
  if (!videoId || videoId === cuesLoadedForVideoId) return;

  // 網頁原始碼會被方法零跟方法二共用，只抓一次。
  let pageHtml = null;
  async function getPageHtml() {
    if (pageHtml === null) {
      try {
        pageHtml = await fetch(location.href).then((r) => r.text());
      } catch (e) {
        pageHtml = "";
      }
    }
    return pageHtml;
  }

  const html0 = await getPageHtml();
  if (html0) {
    const cuesFromInnerTube = await fetchCuesViaInnerTube(videoId, html0);
    if (cuesFromInnerTube && cuesFromInnerTube.length) {
      subtitleCues = cuesFromInnerTube;
      cuesLoadedForVideoId = videoId;
      console.log(
        `[FlowStudy] 方法零成功，已載入 ${subtitleCues.length} 句完整字幕稿（含尚未播放的句子），a/s/d 可以用了`
      );
      return;
    }
  }

  let tracks = null;

  // 方法一（備用）：直接問 YouTube 播放器物件本身要目前這部影片的字幕軌清單，
  // 這是播放器本來就有提供的方法，比較不受 YouTube 網頁原始碼格式變動影響。
  try {
    const player = document.getElementById("movie_player");
    const hasFn = !!(player && typeof player.getPlayerResponse === "function");
    console.log("[FlowStudy] 方法一：找到 player 元素？", !!player, "有 getPlayerResponse？", hasFn);
    if (hasFn) {
      const resp = player.getPlayerResponse();
      tracks = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks || null;
      console.log("[FlowStudy] 方法一結果：", tracks);
    }
  } catch (e) {
    console.warn("[FlowStudy] 方法一發生例外：", e);
    tracks = null;
  }

  // 方法二（備用）：方法一失敗的話，退回去從網頁原始碼裡挖字幕資料
  if (!tracks || !tracks.length) {
    try {
      const html = await getPageHtml();
      const raw = extractJsonArray(html, "captionTracks");
      console.log("[FlowStudy] 方法二：網頁原始碼裡有找到 captionTracks 區塊？", !!raw);
      if (raw) tracks = JSON.parse(raw.replace(/\\u0026/g, "&"));
      console.log("[FlowStudy] 方法二結果：", tracks);
    } catch (e) {
      console.warn("[FlowStudy] 方法二發生例外：", e);
      tracks = null;
    }
  }

  // 方法三（再備用）：改問獨立的 timedtext 列表 API
  if (!tracks || !tracks.length) {
    tracks = await fetchTracksViaTimedTextList(videoId);
    console.log("[FlowStudy] 方法三結果：", tracks);
  }

  if (!tracks || !tracks.length) {
    // 注意：這裡故意不清空 subtitleCues——即時記錄（recordLiveCaptionCue）
    // 可能已經累積了一些資料，預先抓取失敗不代表 a/s/d 完全不能用。
    console.warn(
      "[MyWordLookup] 這部影片抓不到完整字幕軌資料，改用「即時記錄目前看過的句子」當備援，a/s/d 只能跳到已經看過的句子"
    );
    return;
  }

  try {
    // 優先找英文字幕，沒有的話用第一個可用的字幕軌
    const track = tracks.find((t) => t.languageCode && t.languageCode.startsWith("en")) || tracks[0];
    console.log("[FlowStudy] 選中的字幕軌：", track);
    if (!track || !track.baseUrl) {
      console.warn("[FlowStudy] 選中的字幕軌沒有 baseUrl，放棄");
      return;
    }

    const capUrl = track.baseUrl + "&fmt=json3";
    console.log("[FlowStudy] 準備抓取字幕內容，URL：", capUrl);
    const raw = await fetch(capUrl).then((r) => r.text());
    console.log("[FlowStudy] 字幕內容回應長度：", raw ? raw.length : 0, "，前 200 字：", (raw || "").slice(0, 200));
    if (!raw) {
      console.warn("[FlowStudy] 字幕內容回應是空的（常見於被廣告攔截套件擋掉），改用即時記錄當備援");
      return;
    }

    const data = JSON.parse(raw);
    const fetchedCues = (data.events || [])
      .filter((ev) => ev.segs && ev.segs.length)
      .map((ev) => ({
        start: ev.tStartMs / 1000,
        text: ev.segs.map((s) => s.utf8 || "").join("").trim(),
      }))
      .filter((c) => c.text);
    console.log("[FlowStudy] 解析出的字幕句數：", fetchedCues.length);

    if (!fetchedCues.length) {
      console.warn("[FlowStudy] 字幕內容解析出來是 0 句，放棄");
      return;
    }

    subtitleCues = fetchedCues; // 預先抓取成功，用完整資料整批取代掉即時記錄的部分資料
    cuesLoadedForVideoId = videoId;
    console.log(`[MyWordLookup] 已載入 ${subtitleCues.length} 句字幕斷點，a/s/d 快捷鍵可以用了`);
  } catch (e) {
    console.warn("[MyWordLookup] 句子斷點資料載入失敗，改用即時記錄當備援：", e);
  }
}

function findCurrentCueIndex() {
  const video = getVideoEl();
  if (!video || !subtitleCues.length) return -1;
  const t = video.currentTime;
  // 找「開始時間 <= 目前播放時間」裡最晚的一句，就是目前正在播的這句
  // （加一點點誤差，避免卡在浮點數邊界剛好判斷不到）。
  let idx = -1;
  for (let i = subtitleCues.length - 1; i >= 0; i--) {
    if (subtitleCues[i].start <= t + 0.15) {
      idx = i;
      break;
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
  if (!video || !subtitleCues.length) {
    console.log(
      `[FlowStudy] 按了 ${key}，但 subtitleCues 是空的（長度 ${subtitleCues.length}），沒有東西可以跳`
    );
    return;
  }

  const idx = findCurrentCueIndex();
  console.log(
    `[FlowStudy] 按了 ${key}，目前 subtitleCues 共 ${subtitleCues.length} 筆，目前時間 ${video.currentTime.toFixed(
      1
    )}s，判斷 idx=${idx}`,
    subtitleCues.slice(Math.max(0, idx - 2), idx + 3)
  );
  if (idx === -1) return;

  if (key === "s") {
    video.currentTime = subtitleCues[idx].start;
  } else if (key === "a") {
    // idx===0 代表這已經是目前記錄到最早的一句，沒有更早的可以跳了——
    // 這種情況跳到影片開頭（0 秒），而不是完全沒反應，體驗上比較合理。
    video.currentTime = idx > 0 ? subtitleCues[idx - 1].start : 0;
  } else if (key === "d" && idx < subtitleCues.length - 1) {
    video.currentTime = subtitleCues[idx + 1].start;
  }
});

// ==================== 沉浸計時器（播放器控制列膠囊按鈕） ====================
//
// 顯示邏輯（Session，畫面上看到的數字）：
//   - 只在「沉浸模式開啟 + 影片播放中」時走動，用真實時間（Date.now() 差值）累計，
//     所以調整播放速度（0.5x / 2x）不會影響計時。
//   - 影片暫停（含滑鼠移到字幕自動暫停、查字）時，畫面數字停住但不歸零。
//   - 手動關閉或重新開啟沉浸模式時，畫面數字才會歸零重新算。
//
// 底層累計邏輯（Global，寫進 storage 的今日 / 總計秒數）：
//   - 不管 Session 有沒有歸零，只要真的累積到的秒數，都會即時寫回
//     immersion:YYYY-MM-DD 與 immersion_total_seconds，不會因為使用者手動關閉而消失。
//   - 切到背景分頁時 setInterval 可能被瀏覽器降頻，所以用時間戳記差值而不是「tick 次數」
//     來計算經過秒數，恢復到前景時會自動補上中間經過的時間。
let immersionActive = false;
let sessionSeconds = 0;
let tickAnchor = null; // 開始累計的時間戳記；null 代表目前沒有在累計
let pendingFlushSeconds = 0; // 還沒寫進 storage 的秒數
let lastCheckpointMinute = 0; // 上次寫入 F5 復原檢查點時的整分鐘數

function formatImmersionTime(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function flushPendingSeconds() {
  if (pendingFlushSeconds <= 0) return;
  const secondsToFlush = pendingFlushSeconds;
  pendingFlushSeconds = 0;

  const todayKey = "immersion:" + fmtDate(new Date());
  chrome.storage.local.get([todayKey, "immersion_total_seconds"], (data) => {
    chrome.storage.local.set({
      [todayKey]: (data[todayKey] || 0) + secondsToFlush,
      immersion_total_seconds: (data.immersion_total_seconds || 0) + secondsToFlush,
    });
  });
}

function maybeSaveSessionCheckpoint() {
  const currentMinute = Math.floor(sessionSeconds / 60);
  if (currentMinute > lastCheckpointMinute) {
    lastCheckpointMinute = currentMinute;
    chrome.storage.session.set({ immersion_session_seconds: currentMinute * 60 });
  }
}

function renderImmersionButton() {
  const btn = document.getElementById("zerostudy-immersion-btn");
  if (!btn) return;
  const label = btn.querySelector(".zerostudy-immersion-label");

  btn.classList.toggle("is-active", immersionActive);

  if (!immersionActive) {
    label.textContent = "關閉";
    btn.setAttribute("aria-label", "點擊開始沉浸計時");
    return;
  }

  label.textContent = formatImmersionTime(sessionSeconds);
  const video = getVideoEl();
  const isPaused = !video || video.paused;
  btn.setAttribute("aria-label", isPaused ? "影片已暫停，未記錄" : "沉浸計時中");
}

function onImmersionButtonClick() {
  immersionActive = !immersionActive;
  sessionSeconds = 0;
  lastCheckpointMinute = 0;

  if (!immersionActive) {
    flushPendingSeconds();
  }
  tickAnchor = null;

  chrome.storage.session.set({
    immersion_active: immersionActive,
    immersion_session_seconds: 0,
  });

  document.documentElement.classList.toggle("zerostudy-immersion-active", immersionActive);
  renderImmersionButton();
}

function ensureImmersionButton() {
  const controls = document.querySelector(".ytp-right-controls");
  if (!controls || document.getElementById("zerostudy-player-controls")) return;

  const wrapper = document.createElement("div");
  wrapper.id = "zerostudy-player-controls";
  wrapper.className = "zerostudy-player-controls";

  const btn = document.createElement("button");
  btn.id = "zerostudy-immersion-btn";
  btn.type = "button";
  btn.className = "zerostudy-immersion-btn";
  btn.innerHTML =
    '<span class="zerostudy-immersion-dot"></span><span class="zerostudy-immersion-label">關閉</span>';
  btn.addEventListener("click", onImmersionButtonClick);

  wrapper.appendChild(btn);
  controls.prepend(wrapper);
  renderImmersionButton();
}

let lastImmersionVideoId = null;

function immersionHeartbeatTick() {
  const video = getVideoEl();
  const isPlaying = !!(video && !video.paused && !video.ended);

  // 保險機制：萬一有漏接的 play/pause 事件（例如影片元素被 YouTube 換掉），
  // 每秒都順便校正一次 Media Session 回報的播放狀態，避免多媒體鍵長期對不起來。
  syncMediaSessionPlaybackState();
  claimMediaSessionHandlers(); // 每秒重新搶回 handler，避免被 YouTube 自己的程式碼蓋掉

  // YouTube 是 SPA，換一部影片不會整頁重新載入，content.js 不會重跑，
  // Session 秒數原本會直接沿用上一部影片的。這裡偵測「影片 ID 變了」，
  // 換片時主動把畫面上的 Session 數字歸零重算（今日/總計時數不受影響，
  // 换片前累積的秒數一樣會先寫進去，只是畫面顯示的「這次沉浸了多久」重新算）。
  const currentVideoId = getVideoId();
  if (immersionActive && currentVideoId && currentVideoId !== lastImmersionVideoId) {
    if (lastImmersionVideoId !== null) {
      flushPendingSeconds();
      sessionSeconds = 0;
      lastCheckpointMinute = 0;
      tickAnchor = null;
      chrome.storage.session.set({ immersion_session_seconds: 0 });
    }
    lastImmersionVideoId = currentVideoId;
  }

  if (immersionActive && isPlaying) {
    if (tickAnchor === null) tickAnchor = Date.now();
    const now = Date.now();
    const deltaSec = Math.floor((now - tickAnchor) / 1000);
    if (deltaSec > 0) {
      sessionSeconds += deltaSec;
      pendingFlushSeconds += deltaSec;
      tickAnchor += deltaSec * 1000;
      maybeSaveSessionCheckpoint();
      if (pendingFlushSeconds >= 5) flushPendingSeconds();
    }
  } else {
    if (tickAnchor !== null) flushPendingSeconds();
    tickAnchor = null;
  }

  renderImmersionButton();
}

function initImmersionTimer() {
  // 注意：這裡特意用 chrome.storage.session，不是 chrome.storage.local。
  // session 儲存區的資料在「重新整理分頁 / SPA 換片」時會保留（所以 F5 復原機制才有用），
  // 但只要整個瀏覽器關掉重開，就會自動清空——這樣昨晚忘記關閉沉浸模式，
  // 今天早上重開機再看影片時，畫面上的數字才會正確從 0:00 開始，不會沿用昨天的殘值。
  chrome.storage.session.get(["immersion_active", "immersion_session_seconds"], (data) => {
    if (data.immersion_active) {
      immersionActive = true;
      sessionSeconds = data.immersion_session_seconds || 0;
      lastCheckpointMinute = Math.floor(sessionSeconds / 60);
      document.documentElement.classList.add("zerostudy-immersion-active");
    }
    renderImmersionButton();
  });

  const injectObserver = new MutationObserver(() => ensureImmersionButton());
  injectObserver.observe(document.body, { childList: true, subtree: true });
  ensureImmersionButton();
  document.addEventListener("fullscreenchange", () => {
    ensureImmersionButton();
    // 全螢幕模式下 YouTube 自己的版面計算方式不一樣，強制隱藏推薦影片欄
    // 會跟它自己的版面邏輯打架、跑版。全螢幕時交給 YouTube 自己的全螢幕
    // 版面處理就好，我們只在「一般（非全螢幕）模式」隱藏推薦影片。
    document.documentElement.classList.toggle("zerostudy-fullscreen", !!document.fullscreenElement);
  });

  setInterval(immersionHeartbeatTick, 1000);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPendingSeconds();
  });
  window.addEventListener("pagehide", flushPendingSeconds);
  window.addEventListener("beforeunload", flushPendingSeconds);
}

// ==================== 單字標記「學習中」（雙擊翻譯彈窗收藏） ====================
// 右鍵選單會跟 YouTube 原生的右鍵選單衝突，改成：雙擊「Study 學習」翻譯彈窗，
// 把目前查詢的單字/片語收藏進「學習中」清單，並播放收藏成功的卡牌動畫。
let markedWordsMap = new Map(); // key: 單字小寫，value: { word, sentence, addedAt }

function loadMarkedWords(cb) {
  chrome.storage.local.get("learningWords", ({ learningWords }) => {
    markedWordsMap = new Map(Object.entries(learningWords || {}));
    if (cb) cb();
  });
}

function saveMarkedWords() {
  // 這裡特意檢查 chrome.runtime.lastError 並印出來：以前存檔失敗會整個被吞掉，
  // 畫面上的底線高亮是直接讀記憶體裡的 markedWordsMap，看起來像存成功了，
  // 但如果 chrome.storage.local.set 實際失敗（例如擴充功能重新載入後，
  // 這個分頁還在用舊的、已經失聯的 content script），review.html 就會讀到空的。
  try {
    chrome.storage.local.set({ learningWords: Object.fromEntries(markedWordsMap) }, () => {
      if (chrome.runtime.lastError) {
        console.error("[FlowStudy] 儲存「學習中」單字失敗：", chrome.runtime.lastError.message);
      }
    });
  } catch (err) {
    console.error(
      "[FlowStudy] 儲存「學習中」單字時發生例外，這個分頁的擴充功能連線可能已經失效，請整頁重新整理（F5）後再試一次：",
      err
    );
  }
}

function refreshMarkedHighlight() {
  document.querySelectorAll(".my-word").forEach((el) => {
    const key = el.textContent.trim().toLowerCase();
    el.classList.toggle("my-word-marked", markedWordsMap.has(key));
  });
}

function markWordAsLearning(word, sentence) {
  const key = (word || "").trim().toLowerCase();
  if (!key) return;
  markedWordsMap.set(key, { word: word.trim(), sentence: sentence || "", addedAt: Date.now() });
  saveMarkedWords();
  refreshMarkedHighlight();
}

function spawnCollectSparkles(box) {
  const count = 10;
  for (let i = 0; i < count; i++) {
    const sparkle = document.createElement("span");
    sparkle.className = "my-card-sparkle";
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
    const distance = 36 + Math.random() * 28;
    sparkle.style.setProperty("--tx", Math.cos(angle) * distance + "px");
    sparkle.style.setProperty("--ty", Math.sin(angle) * distance + "px");
    box.appendChild(sparkle);
  }
}

function playCollectAnimation(box) {
  if (box.classList.contains("is-collecting")) return; // 避免連續雙擊重複觸發
  box.classList.add("is-collecting");
  spawnCollectSparkles(box);

  setTimeout(() => {
    box.style.display = "none";
    box.classList.remove("is-collecting");
    box.querySelectorAll(".my-card-sparkle").forEach((s) => s.remove());
  }, 800); // 跟 content.css 裡 shake + flyup 動畫的總時長對齊
}

document.addEventListener("dblclick", (e) => {
  const box = document.getElementById("my-translate-box");
  if (!box || box.style.display === "none" || !box.contains(e.target)) return;
  if (!currentLookupText) return;
  e.preventDefault();

  markWordAsLearning(currentLookupText, currentLookupSentence);
  playCollectAnimation(box);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.learningWords) {
    markedWordsMap = new Map(Object.entries(changes.learningWords.newValue || {}));
    refreshMarkedHighlight();
  }
});

loadMarkedWords(refreshMarkedHighlight);
initImmersionTimer();

loadCaptionCues();
// YouTube 是 SPA，換片不會整頁重新載入，定期確認是否要重新抓字幕句子資料
setInterval(loadCaptionCues, 3000);
