// 這支程式會被注入到 YouTube 網頁裡執行

let wasPlayingBeforeHover = false;
let actionPaused = false; // 使用者點單字／選取片語查詢時設為 true，避免滑鼠移開字幕就自動續播

// ---------- 介面縮放：字幕條與翻譯框共用同一個比例 ----------
//
// 以前這是兩個各自獨立的設定：字幕大小在播放器的齒輪裡調，翻譯框大小要跑去
// 點工具列的擴充功能圖示調。兩邊互不相干，結果就是把字幕放大之後，
// 點單字跳出來的翻譯框還是原本那麼小，比例整個跑掉。
//
// 現在只有一個來源：CAPTION_SCALE_KEY（見下方 applyCaptionScale），
// 字幕與翻譯框一起縮放，相對比例永遠不變。

// ============================================================================
// 原生 CC 字幕的互動功能開關
// ============================================================================
//
// 目前設為 false：YouTube 原生 CC 字幕維持「完全原生」，不能點字查詢、
// 不能選取片語、滑過去也不會自動暫停，就是 YouTube 出廠的樣子。
// 所有學習用的互動只發生在我們自己畫的固定字幕條（#flowstudy-caption-bar）上。
//
// 這樣分工比較清楚：想隨便看片就關掉沉浸模式，用原生字幕，完全不受干擾；
// 想學習就開沉浸模式，用固定位置的自繪字幕條。
//
// 改回 true 就能讓原生 CC 字幕恢復所有互動功能——相關程式碼一行都沒有刪掉，
// 只是被這個旗標關起來而已。CSS 那邊也是由這個旗標控制（見下方 classList.toggle）。
const ENABLE_LOOKUP_ON_NATIVE_CAPTIONS = false;

// 「字幕區」的選擇器集中在這裡，避免日後改了 A 忘記改 B。
// 點字查詢、選取片語、滑入暫停、拖曳選字全部共用這兩個常數。
const CAPTION_AREA_SELECTOR = ENABLE_LOOKUP_ON_NATIVE_CAPTIONS
  ? ".ytp-caption-window-container, #flowstudy-caption-bar"
  : "#flowstudy-caption-bar";
const CAPTION_TEXT_SELECTOR = ENABLE_LOOKUP_ON_NATIVE_CAPTIONS
  ? ".ytp-caption-segment, .flowstudy-caption-text"
  : ".flowstudy-caption-text";

// content.css 裡「讓字幕文字可以被選取」那幾條規則也要跟著開關。
// CSS 讀不到 JS 變數，所以用 documentElement 上的一個 class 當橋樑。
document.documentElement.classList.toggle(
  "flowstudy-native-caption-lookup",
  ENABLE_LOOKUP_ON_NATIVE_CAPTIONS
);

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
  // 注意：即使不拆字，下面的 recordLiveCaptionCue() 仍然需要讀原生字幕的文字
  // （那是句子時間軸抓取失敗時的備援來源），所以這個 observer 不能整個停掉。
  if (ENABLE_LOOKUP_ON_NATIVE_CAPTIONS) {
    document.querySelectorAll(".ytp-caption-segment").forEach(wrapWords);
  }
  refreshMarkedHighlight();
  recordLiveCaptionCue();
});
observer.observe(document.body, {
  childList: true,
  subtree: true,
  characterData: true,
});

// 找出「目前真正在播的那個 <video>」。
// 不能直接用 document.querySelector("video")：YouTube 頁面上常常同時存在好幾個
// video 元素（滑鼠移到推薦影片縮圖上的預覽、迷你播放器、廣告播放器…），
// 隨便抓第一個會抓錯對象，造成 a/s/d 跳到不相干的影片上。
function getVideoEl() {
  const candidates = [
    "#movie_player video.html5-main-video",
    "#movie_player video",
    ".html5-video-player video.html5-main-video",
    "video.html5-main-video",
  ];
  for (const selector of candidates) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  // 全部落空時（YouTube 換了 class 名稱）退回「有長度的第一個 video」，
  // 至少能避開那些還沒載入內容的預覽用 video 元素。
  const all = Array.from(document.querySelectorAll("video"));
  return all.find((v) => v.duration > 0) || all[0] || null;
}

// ---------- 滑鼠移到字幕上自動暫停／移開自動續播 ----------
//
// 只認「滑鼠真的有移動」，所以用 mousemove 判斷進出，不用 mouseover／mouseout。
//
// 以前用 mouseover／mouseout，出過這個問題：滑鼠停在字幕附近不動，按空白鍵播放，
// 換到下一句時字幕框變寬、變高（長句、雙字幕的中文那一行），剛好蓋到游標底下，
// Chrome 就算滑鼠完全沒動也會送出 mouseover，影片播不到一秒就被自動暫停；
// 字幕框縮小、離開游標時又送出 mouseout，暫停中的影片自己開始播。
// 看起來就像空白鍵壞掉：「播放一秒又暫停、暫停一秒又播放」。
// 字幕框在游標底下變形不代表使用者想看字幕，mousemove 只有真的移動才會觸發，不會被騙。
let pointerOverCaption = false;

function onCaptionPointerEnter() {
  // 使用者自己關掉了這個行為，或這部影片的字幕不是英文
  if (!hoverPauseEnabled || !isLearningEnabled()) return;
  const video = getVideoEl();
  if (video && !video.paused) {
    wasPlayingBeforeHover = true;
    video.pause();
  }
}

function onCaptionPointerLeave() {
  if (!hoverPauseEnabled || !isLearningEnabled()) return;
  if (actionPaused) return; // 使用者點了單字或選取了片語，先不要自動續播
  const video = getVideoEl();
  if (video && wasPlayingBeforeHover && video.paused) {
    video.play().catch(() => {});
  }
  wasPlayingBeforeHover = false;
}

document.addEventListener(
  "mousemove",
  (e) => {
    // 在字幕裡的一個個單字之間移動，closest 都會找到同一個字幕區，不算離開又進入
    const over = !!(e.target.closest && e.target.closest(CAPTION_AREA_SELECTOR));
    if (over === pointerOverCaption) return;
    pointerOverCaption = over;
    if (over) onCaptionPointerEnter();
    else onCaptionPointerLeave();
  },
  { capture: true, passive: true }
);

// 滑鼠從字幕上直接移出瀏覽器視窗：外面收不到 mousemove，
// 只剩這個「移到哪裡都不是（relatedTarget 是 null）」的 mouseout 能當離開的訊號
document.addEventListener("mouseout", (e) => {
  if (e.relatedTarget || !pointerOverCaption) return;
  pointerOverCaption = false;
  onCaptionPointerLeave();
});

// 使用者自己按播放（原生控制列 / 空白鍵）就解除「先不要自動續播」的狀態
document.addEventListener(
  "play",
  (e) => {
    if (e.target.tagName === "VIDEO") {
      actionPaused = false;
      wasPlayingBeforeHover = false;
      syncMediaSessionPlaybackState();

      // 影片繼續播 = 這個字已經看懂了，翻譯框框自動收掉。
      //
      // 查字時我們會把影片暫停，所以「恢復播放」本身就是最自然的
      // 「我看完了」訊號——不管使用者是按滑鼠多媒體鍵、空白鍵、播放器上的
      // 播放鈕，還是按 a/s/d 跳到別句，全部都會經過這裡，一次涵蓋。
      //
      // 只認主要的影片元素：YouTube 頁面上還有推薦影片縮圖的預覽 video，
      // 那些自動播放時不應該把使用者正在讀的翻譯關掉。
      if (e.target === getVideoEl()) closeBox();
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

  // 把「目前查詢中的單字」一併清掉，這樣還在路上的翻譯結果回來時會自己作廢。
  // 不清的話，框框關掉之後翻譯才回應，doLookup 的回呼會再把框框叫出來，
  // 看起來就像「明明關掉了卻自己又跳出來」。
  currentLookupText = null;

  // 發音也一起停掉。選到很長的句子時 Google 翻譯會念很久，
  // 影片一恢復播放，念稿聲就會跟影片聲音疊在一起變成一團亂。
  // 關掉字卡＝這個字已經看完了，發音沒有理由繼續。
  stopPronunciation();

  // 清掉字幕上殘留的選取範圍。留著會造成兩個問題：
  // 字幕條卡住不跟著播放前進，以及下一次點單字被誤判成「正在選片語」。
  // 只清字幕區內的選取，不去動使用者在頁面其他地方（留言、標題）的選取。
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.anchorNode) {
    const area = document.getElementById("flowstudy-caption-bar");
    const node = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
    if (area && node && area.contains(node)) sel.removeAllRanges();
  }
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
// 查到的中文翻譯。以前沒有留著這個值，收藏時 payload 裡的 translation 永遠是空字串，
// 結果記憶固化的卡片上全部顯示「（沒有儲存翻譯）」——畫面上明明看得到翻譯，
// 只是從來沒有被帶進儲存流程。
let currentLookupTranslation = "";

let currentAudio = null;
let pronunciationRequestId = 0;

// 立刻中斷發音。除了停掉正在播的音檔，也會讓「還在路上、還沒回來的發音請求」
// 作廢——選到很長的句子時，音檔可能要等一兩秒才下載完，
// 如果只停掉 currentAudio，那個晚到的音檔還是會開始播。
function stopPronunciation() {
  pronunciationRequestId++; // 讓所有還在等待回應的發音請求對不上號，自動作廢
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
  }
}

function playPronunciation(text) {
  // 連續點好幾個單字時，新的查詢要立刻打斷還在播放/還在等待回應的舊發音，
  // 不然舊的語音請求晚到達時還是會播，疊在一起變成一團亂。
  stopPronunciation();
  const requestId = pronunciationRequestId;

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
  // 非英文字幕不提供查詢。集中擋在這裡，
  // 不管是點單字、選片語還是自繪字幕條上的點擊，全部都會經過這個入口。
  if (!isLearningEnabled()) return;

  const video = getVideoEl();
  if (video && !video.paused) {
    video.pause();
  }
  actionPaused = true; // 查詢期間 & 查完之後，不要因為滑鼠移開字幕就自動續播

  currentLookupText = text;
  currentLookupSentence = sentence || "";
  currentLookupTranslation = ""; // 新的查詢，先把上一個字的翻譯清掉
  showBox({ loading: true, original: text }, rect);
  playPronunciation(text);

  chrome.runtime.sendMessage({ type: "translate", text }, (result) => {
    if (currentLookupText !== text) return; // 有更新的查詢了，這次的結果就不用顯示
    // 收下翻譯結果。使用者接著雙擊收藏時，才有東西可以一起存進去。
    currentLookupTranslation = (result && result.translated) || "";
    showBox({ original: text, translated: result?.translated, error: result?.error }, rect);
  });
}

// ---------- 點擊單字 ----------
document.addEventListener("click", (e) => {
  if (!e.target.classList.contains("my-word")) return;
  const sel = window.getSelection();
  if (sel && sel.toString().trim().length > 0) return; // 使用者其實是在選取片語，不當作單字點擊
  const sentence = e.target.closest(CAPTION_TEXT_SELECTOR)?.textContent?.trim() || "";
  doLookup(e.target.textContent, e.target.getBoundingClientRect(), sentence);
});

// ---------- 選取一段字幕文字（片語查詢） ----------
// 選取後，把範圍「吸附」成完整單字（例如選到 were 中間，也會自動補成整個 were），
// 不會切到單字一半。作法是看選取範圍碰到了哪些 .my-word（哪怕只碰到一部分），
// 就把選取範圍重新設定成從第一個字的開頭到最後一個字的結尾。
document.addEventListener("mouseup", (e) => {
  const downAt = captionPointerDownAt;
  captionPointerDownAt = null;
  isSelectingCaption = false;

  const captionArea = e.target.closest(CAPTION_AREA_SELECTOR);
  if (!captionArea) return;

  // 這次到底是「拖曳選片語」還是「點單字」？
  //
  // 關鍵情境：整句已經被選取的狀態下，使用者想點其中一個單字。
  // 瀏覽器不會在 mousedown 當下就取消既有的選取（它要保留給拖放功能用），
  // 所以到了 mouseup 時選取範圍還在，下面的片語邏輯就會把「整句」再查一次，
  // 使用者會覺得那句話變成一個黏在一起的模組，怎麼點都點不到裡面的單字。
  //
  // 用移動距離判斷：幾乎沒移動就是點擊——主動清掉殘留的選取範圍，
  // 讓接下來的 click 事件走「查單字」那條路。
  const moved = downAt ? Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) : Infinity;
  if (moved < CAPTION_CLICK_MOVE_THRESHOLD) {
    const existing = window.getSelection();
    if (existing && !existing.isCollapsed) existing.removeAllRanges();
    return;
  }

  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;

  const range = sel.getRangeAt(0);
  // 只看「這一塊字幕區裡」的單字。原生字幕視窗跟我們自己的字幕條可能同時存在，
  // 跨區塊收集會把兩邊的字混在一起。
  const words = Array.from(captionArea.querySelectorAll(".my-word")).filter((el) =>
    range.intersectsNode(el)
  );
  const sentence = e.target.closest(CAPTION_TEXT_SELECTOR)?.textContent?.trim() || "";

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
// 字幕上的滑鼠手勢有兩種，必須分得開：
//   「拖曳」＝ 選取片語查詢
//   「點一下」＝ 查詢單一個單字
// 瀏覽器不會幫我們分辨，所以記下按下的座標，放開時比對移動距離自行判斷。
let captionPointerDownAt = null;
let isSelectingCaption = false; // 目前是否正在字幕上拖曳選字
const CAPTION_CLICK_MOVE_THRESHOLD = 4; // 移動小於這個距離（px）就算「點一下」，不算拖曳

document.addEventListener(
  "mousedown",
  (e) => {
    // 我們自己的字幕條有專屬的拖曳把手（.flowstudy-caption-grip），
    // 按在把手上是要移動字幕條，不能被這裡攔掉。
    if (e.target.closest(".flowstudy-caption-grip")) return;
    if (e.target.closest(".my-word") || e.target.closest(CAPTION_TEXT_SELECTOR)) {
      captionPointerDownAt = { x: e.clientX, y: e.clientY };
      isSelectingCaption = true;
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
    if (e.target.closest(CAPTION_AREA_SELECTOR)) {
      e.preventDefault();
    }
  },
  true
);

// ==================== 句子導覽：a 上一句／s 重播這句／d 下一句／空白鍵 播放暫停 ====================
//
// 整體流程：
//   偵測影片 ID → 跟 MAIN world 橋接層要字幕 cue → 正規化 → 合併成句子時間軸
//   → video.currentTime 對應到目前第幾句 → a/s/d 在句子之間跳
//
// 為什麼要有 yt-player-bridge.js 這個橋接層？兩個原因（詳見該檔案開頭的說明）：
//   1. getPlayerResponse() 只有在頁面世界（MAIN world）拿得到，content script 看不到。
//   2. YouTube 現在對 /api/timedtext 強制要求 pot 參數，而 captionTracks 給的 baseUrl
//      裡沒有這個參數，直接抓會拿到「HTTP 200 但內容是空的」。唯一穩的作法是攔截
//      播放器自己發出的那次請求，而 hook 必須在 document_start 就掛好。
//
// 斷句本身是完全本機、完全決定性的（sentence-timeline.js），不呼叫任何 AI API。
// 時間軸只在「換影片」或「換字幕軌」時建一次，之後重複使用，按鍵時不會重算。

const Sentences = window.FlowStudySentences;

const BRIDGE_TO_PAGE = "flowstudy-to-page";
const BRIDGE_TO_CONTENT = "flowstudy-to-content";

// 目前這部影片的句子時間軸（記憶體內，換片才重建）
let sentenceTimeline = [];
let timelineVideoId = null;
let timelineTrack = null; // { languageCode, kind, label, isAutoGenerated }
let currentSentenceIndex = -1;

// 狀態：idle / loading / ready / unavailable
let timelineStatus = "idle";

// 快取：key = `videoId::語言代碼::kind`，避免使用者暫停、拖曳、切換 UI 時重新抓取。
// 用 Map 並限制筆數，長時間連續看影片才不會無限成長。
const timelineCache = new Map();
const TIMELINE_CACHE_MAX = 12;

function cacheKeyFor(videoId, track) {
  const lang = track ? track.languageCode || "" : "";
  const kind = track ? track.kind || "" : "";
  return `${videoId}::${lang}::${kind}`;
}

function putTimelineCache(key, value) {
  if (timelineCache.has(key)) timelineCache.delete(key);
  timelineCache.set(key, value);
  while (timelineCache.size > TIMELINE_CACHE_MAX) {
    timelineCache.delete(timelineCache.keys().next().value);
  }
}

function getVideoId() {
  // 一般觀看頁：/watch?v=xxxx
  const fromQuery = new URLSearchParams(location.search).get("v");
  if (fromQuery) return fromQuery;
  // Shorts：/shorts/xxxx
  const shorts = location.pathname.match(/^\/shorts\/([\w-]+)/);
  if (shorts) return shorts[1];
  return null;
}

// ---------- 與橋接層的通訊 ----------

let bridgeReady = false;
let pendingRequestId = 0;
const pendingRequests = new Map(); // requestId -> resolve

function requestCuesFromBridge(videoId) {
  return new Promise((resolve) => {
    const requestId = ++pendingRequestId;
    pendingRequests.set(requestId, resolve);

    // 橋接層萬一沒回應（例如注入失敗、YouTube 改版），不能讓 Promise 永遠卡住
    setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId);
        resolve({ ok: false, reason: "bridge-timeout" });
      }
    }, 8000);

    window.postMessage(
      {
        channel: BRIDGE_TO_PAGE,
        type: "request-cues",
        requestId,
        videoId,
        prefs: { preferredLangs: ["en"] }, // 學英文：優先英文原文字幕，不要翻譯軌
      },
      location.origin
    );
  });
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.channel !== BRIDGE_TO_CONTENT) return;

  if (msg.type === "bridge-ready") {
    bridgeReady = true;
    return;
  }

  if (msg.type === "timedtext-captured") {
    // 橋接層剛攔到這部影片的字幕網址（通常是使用者剛把 CC 打開）。
    // 這是事件驅動的重試時機，比盲目輪詢準確得多。
    if (msg.videoId === getVideoId() && timelineStatus !== "ready") {
      ensureTimelineForCurrentVideo({ force: true });
    }
    return;
  }

  if (msg.type === "cues-result") {
    const resolve = pendingRequests.get(msg.requestId);
    if (resolve) {
      pendingRequests.delete(msg.requestId);
      resolve(msg);
    }
  }
});

// ---------- 建立句子時間軸 ----------

let loadAttempts = 0;
let loadTimer = null;
let loadInFlight = false;
const MAX_LOAD_ATTEMPTS = 8;
// 逐次拉長的重試間隔，最後停下來——不做無止境的輪詢。
const RETRY_DELAYS_MS = [400, 800, 1500, 2500, 4000, 6000, 9000, 12000];

function clearLoadTimer() {
  if (loadTimer) {
    clearTimeout(loadTimer);
    loadTimer = null;
  }
}

function scheduleRetry() {
  clearLoadTimer();
  if (loadAttempts >= MAX_LOAD_ATTEMPTS) {
    // 已經試夠了。停止重試，但不代表永遠沒救——橋接層之後如果攔到字幕網址
    // （使用者手動打開 CC），會主動通知我們，那時候再重試一次。
    if (timelineStatus !== "ready") setTimelineStatus("unavailable");
    return;
  }
  const delay = RETRY_DELAYS_MS[Math.min(loadAttempts, RETRY_DELAYS_MS.length - 1)];
  loadTimer = setTimeout(() => ensureTimelineForCurrentVideo({}), delay);
}

async function ensureTimelineForCurrentVideo(opts) {
  const options = opts || {};
  const videoId = getVideoId();
  if (!videoId) return;

  if (!options.force && timelineVideoId === videoId && timelineStatus === "ready") return;
  if (loadInFlight) return;

  if (options.force) {
    loadAttempts = 0;
    clearLoadTimer();
  }

  if (timelineStatus !== "ready" || timelineVideoId !== videoId) setTimelineStatus("loading");

  loadInFlight = true;
  loadAttempts++;
  let result;
  try {
    result = await requestCuesFromBridge(videoId);
  } finally {
    loadInFlight = false;
  }

  // 等待期間使用者可能已經換片了，這份結果就沒有意義了
  if (getVideoId() !== videoId) return;

  if (!result || !result.ok) {
    const reason = result ? result.reason : "unknown";
    // 「這部影片根本沒有字幕軌」是確定的結論，不用再重試
    if (reason === "no-caption-track") {
      applyTimeline(videoId, [], null, "unavailable");
      console.log("[FlowStudy] 這部影片沒有字幕軌，句子導覽停用（播放與其他功能不受影響）");
      return;
    }
    scheduleRetry();
    return;
  }

  const track = result.track || null;
  const key = cacheKeyFor(videoId, track);
  const cached = timelineCache.get(key);
  if (cached) {
    applyTimeline(videoId, cached, track, "ready");
    return;
  }

  const sentences = Sentences.buildSentenceTimeline(result.cues || []);
  if (!sentences.length) {
    scheduleRetry();
    return;
  }

  putTimelineCache(key, sentences);
  applyTimeline(videoId, sentences, track, "ready");
  console.log(
    `[FlowStudy] 句子時間軸建立完成：${result.cues.length} 個字幕片段 → ${sentences.length} 個句子` +
      `（字幕軌：${track ? track.label || track.languageCode : "未知"}${track && track.isAutoGenerated ? "，自動產生" : ""}）`
  );
}

function applyTimeline(videoId, sentences, track, status) {
  clearLoadTimer();
  sentenceTimeline = sentences;
  timelineVideoId = videoId;
  timelineTrack = track;
  currentSentenceIndex = -1;
  // 新的時間軸（換片、換字幕軌）：舊的中文對不上了，從目前位置重新翻（翻過的句子背景有快取，會瞬間回來）。
  // 一定要在 updateCurrentSentence 之前重設：它會觸發翻譯，若之後才重設，
  // 剛送出的那一批會被作廢、再送一次一模一樣的——每換一部影片就多浪費一次請求。
  resetDualSubs();
  setTimelineStatus(status);
  updateCurrentSentence();
  ensureDualSubsWindow(); // 還沒播到第一句時句子編號不會變，上一行不會觸發，這裡補一次（重複呼叫沒有副作用）
}

function resetTimelineState() {
  clearLoadTimer();
  loadAttempts = 0;
  sentenceTimeline = [];
  timelineVideoId = null;
  timelineTrack = null;
  currentSentenceIndex = -1;
  resetLiveRecorder();
  resetDualSubs();
  setTimelineStatus("idle");
}

// ---------- 目前播到第幾句 ----------
//
// 用 timeupdate 事件驅動（約每秒 4 次），而不是 requestAnimationFrame。
// 每次只做一個二分搜尋，就算影片有好幾千句也幾乎不花時間，
// 也不會像每一幀掃 DOM 那樣拖慢播放。
function activeSentences() {
  return sentenceTimeline.length ? sentenceTimeline : liveSentences;
}

function updateCurrentSentence() {
  const video = getVideoEl();
  const list = activeSentences();
  if (!video || !list.length) {
    if (currentSentenceIndex !== -1) {
      currentSentenceIndex = -1;
      renderSentenceChip();
    }
    return;
  }

  const idx = Sentences.getCurrentSentenceIndex(video.currentTime, list);
  if (idx !== currentSentenceIndex) {
    currentSentenceIndex = idx;
    renderSentenceChip();
    // 播到下一句、或跳到別的地方：看要不要翻下一段 10 分鐘
    ensureDualSubsWindow();
  }
}

// ---------- 句子導覽動作 ----------

function seekToSentence(index, list) {
  const video = getVideoEl();
  const sentences = list || activeSentences();
  if (!video || !sentences.length) return false;

  const clamped = Math.max(0, Math.min(index, sentences.length - 1));
  const target = sentences[clamped];
  if (!target) return false;

  // 往前退 60 毫秒。YouTube 的 seek 會對齊到最近的關鍵影格，
  // 剛好落在句首時偶爾會吃掉第一個音節，退一點點比較保險。
  video.currentTime = Math.max(0, target.start - 0.06);
  currentSentenceIndex = clamped;
  renderSentenceChip();

  if (video.paused) {
    actionPaused = false; // 使用者主動導覽，解除「查字後不要自動續播」的狀態
    video.play().catch(() => {});
  }
  return true;
}

function goToPreviousSentence() {
  const sentences = activeSentences();
  if (!sentences.length) return false;
  const idx = Sentences.getCurrentSentenceIndex(getVideoEl()?.currentTime ?? 0, sentences);
  if (idx <= 0) {
    // 已經在第一句（或還沒播到第一句）：跳到影片開頭，比完全沒反應合理
    const video = getVideoEl();
    if (video) video.currentTime = 0;
    return seekToSentence(0, sentences);
  }
  return seekToSentence(idx - 1, sentences);
}

function replayCurrentSentence() {
  const sentences = activeSentences();
  if (!sentences.length) return false;
  const idx = Sentences.getCurrentSentenceIndex(getVideoEl()?.currentTime ?? 0, sentences);
  return seekToSentence(idx < 0 ? 0 : idx, sentences);
}

function goToNextSentence() {
  const sentences = activeSentences();
  if (!sentences.length) return false;
  const idx = Sentences.getCurrentSentenceIndex(getVideoEl()?.currentTime ?? 0, sentences);
  return seekToSentence(idx < 0 ? 0 : Math.min(idx + 1, sentences.length - 1), sentences);
}

// ---------- 鍵盤 ----------

// 使用者正在打字時（留言、搜尋、改標題…）絕對不能誤觸
function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  // YouTube 的搜尋框、留言框都是自訂元件，用 role 再擋一層
  const role = el.getAttribute && el.getAttribute("role");
  if (role === "textbox" || role === "combobox" || role === "searchbox") return true;
  if (el.closest && el.closest('[contenteditable="true"], input, textarea, [role="textbox"]')) return true;
  return false;
}

// 空白鍵要特別小心：YouTube 自己也綁了空白鍵播放/暫停。如果兩邊都處理，
// 一次按鍵會切換兩次，等於沒按。所以這裡用 capture 階段攔截並停止傳遞，
// 確保「只有我們處理」。但按鈕、連結這類元件上的空白鍵是瀏覽器的無障礙行為
// （空白鍵 = 按下按鈕），必須放行，不然會破壞 YouTube 的介面操作。
function isInteractiveControl(el) {
  if (!el || !el.closest) return false;
  return !!el.closest('button, a[href], [role="button"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"], [role="option"], summary');
}

document.addEventListener(
  "keydown",
  (e) => {
    // 組合鍵交給瀏覽器/YouTube（Ctrl+A 全選、Cmd+D 加書籤…）
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.isComposing || e.keyCode === 229) return; // 輸入法組字中
    if (isTypingTarget(document.activeElement) || isTypingTarget(e.target)) return;

    const key = (e.key || "").toLowerCase();

    if (key === " " || e.code === "Space") {
      if (isInteractiveControl(document.activeElement)) return; // 讓空白鍵去按那個按鈕
      const video = getVideoEl();
      if (!video) return;
      e.preventDefault();
      // 這裡用 stopImmediatePropagation 而不是 stopPropagation：
      // stopPropagation 只擋「傳到下一個節點」，同一個節點（document）上其他的
      // 監聽器還是會跑。YouTube 如果也在 document 上掛了空白鍵處理，就會變成
      // 一次按鍵切換兩次＝等於沒按——跟之前多媒體鍵遇到的是同一類問題。
      e.stopImmediatePropagation();
      toggleVideoPlayback();
      return;
    }

    if (key !== "a" && key !== "s" && key !== "d") return;

    const video = getVideoEl();
    if (!video) return;

    const sentences = activeSentences();
    if (!sentences.length) {
      // 沒有句子資料：安靜地不做事，但也不要擋掉 YouTube 原本的按鍵行為，
      // 讓正常播放完全不受影響。
      return;
    }

    // 有句子資料時才攔截，避免跟 YouTube 自己的快捷鍵打架
    e.preventDefault();
    e.stopPropagation();

    if (key === "a") goToPreviousSentence();
    else if (key === "s") replayCurrentSentence();
    else if (key === "d") goToNextSentence();
  },
  true // capture 階段：比 YouTube 自己的 keydown 監聽更早拿到事件
);

// ---------- 控制列上的句子狀態小標籤 ----------
//
// 讓使用者一眼看出「句子導覽現在能不能用」。沒有字幕時顯示「無字幕」，
// 而不是讓 a/s/d 按了沒反應卻不知道為什麼。
function setTimelineStatus(status) {
  if (timelineStatus === status) return;
  timelineStatus = status;
  renderSentenceChip();
}

// 句數標籤（12/170）已經移除——它佔掉播放器控制列的空間，
// 又會把 YouTube 自己的全螢幕、劇場模式按鈕擠出畫面，而資訊價值有限。
// 這個函式保留成空殼，讓原本的呼叫點不用全部拆掉；
// 順手把舊版殘留在畫面上的標籤清掉（升級後第一次載入時會用到）。
function renderSentenceChip() {
  const stale = document.getElementById("zerostudy-sentence-chip");
  if (stale) stale.remove();
}

// ---------- 最後備援：從畫面上的字幕即時記錄 ----------
//
// 前面所有管道都失敗時（YouTube 又改版、字幕請求被擋…）至少讓 a/s/d 堪用。
// 這條路完全不依賴 YouTube 的內部格式，純粹把「已經顯示過」的字幕連同當下的
// 播放時間記下來。缺點很明顯：只能跳到已經看過的句子，沒辦法預先跳到還沒播到的地方。
// 所以它只在 sentenceTimeline 是空的時候才會被啟用與使用。
let liveSentences = []; // 跟 SentenceSegment 同樣的形狀
let liveVideoId = null;
let liveRawText = "";
let liveBuffer = "";
let liveBufferStart = null;
let liveMaxStart = -1;
const LIVE_MAX_SENTENCES = 500;

function resetLiveRecorder() {
  liveSentences = [];
  liveRawText = "";
  liveBuffer = "";
  liveBufferStart = null;
  liveMaxStart = -1;
}

function getCurrentCaptionSentence() {
  return Array.from(document.querySelectorAll(".ytp-caption-window-container .ytp-caption-segment"))
    .map((el) => el.textContent.trim())
    .filter(Boolean)
    .join(" ");
}

// YouTube 的自動語音辨識字幕是「一直往前滑動的視窗」：舊的字從前面被擠掉、
// 新的字從後面補上，不是從空白長成一句再清空。所以不能用「新內容是不是舊內容的延伸」
// 來判斷，要找出新視窗裡「真正沒看過的那一小段」。
function findNewSuffix(oldText, newText) {
  if (!oldText) return newText;
  const oldWords = oldText.split(" ");
  const newWords = newText.split(" ");
  const maxOverlap = Math.min(oldWords.length, newWords.length);
  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    if (oldWords.slice(oldWords.length - overlap).join(" ") === newWords.slice(0, overlap).join(" ")) {
      return newWords.slice(overlap).join(" ").trim();
    }
  }
  return newText;
}

function flushLiveBuffer() {
  if (!liveBuffer || liveBufferStart === null) return;
  const text = liveBuffer;
  const start = liveBufferStart;
  liveBuffer = "";
  liveBufferStart = null;

  // 倒轉重播時同一段內容可能已經記過了。重複加入會讓陣列的時間不再遞增，
  // 二分搜尋就會失準，a/s/d 開始在兩點之間跳來跳去。
  if (liveSentences.some((s) => s.text === text && Math.abs(s.start - start) < 1.5)) return;

  const video = getVideoEl();
  const end = video && video.currentTime > start ? video.currentTime : start + 2;
  liveSentences.push({
    index: 0,
    text,
    start,
    end,
    cueStartIndex: -1,
    cueEndIndex: -1,
  });
  liveSentences.sort((a, b) => a.start - b.start);
  if (liveSentences.length > LIVE_MAX_SENTENCES) liveSentences.shift();
  // 前一句的結束時間不該跨進後一句
  for (let i = 0; i < liveSentences.length; i++) {
    liveSentences[i].index = i;
    const next = liveSentences[i + 1];
    if (next && liveSentences[i].end > next.start) {
      liveSentences[i].end = Math.max(next.start, liveSentences[i].start + 0.05);
    }
  }
  liveMaxStart = Math.max(liveMaxStart, start);
  renderSentenceChip();
}

// 由 content.js 最上面那個 MutationObserver 呼叫（字幕文字一變動就觸發）
function recordLiveCaptionCue() {
  const videoId = getVideoId();
  if (!videoId) return;

  if (videoId !== liveVideoId) {
    liveVideoId = videoId;
    resetLiveRecorder();
  }

  if (sentenceTimeline.length) return; // 已經有完整時間軸，不需要這條備援

  const video = getVideoEl();
  if (!video) return;

  // 使用者倒轉、或按 a/s 往回跳：這段已經記錄過了，不要重複記。
  // 等播回「還沒記錄過」的地方再繼續累積。
  if (video.currentTime < liveMaxStart - 1) {
    liveRawText = "";
    liveBuffer = "";
    liveBufferStart = null;
    return;
  }

  const sentence = getCurrentCaptionSentence();
  if (!sentence) {
    flushLiveBuffer(); // 字幕窗口清空 = 這句講完了
    liveRawText = "";
    return;
  }
  if (sentence === liveRawText) return;

  const newSuffix = findNewSuffix(liveRawText, sentence);
  const hadOverlap = newSuffix.length < sentence.length;
  liveRawText = sentence;
  if (!newSuffix) return;

  // 完全沒重疊代表中間有一段沒捕捉到，先把目前累積的內容收成一句
  if (!hadOverlap && liveBuffer) flushLiveBuffer();

  if (!liveBuffer) liveBufferStart = video.currentTime;
  liveBuffer = (liveBuffer + " " + newSuffix).trim();

  if (/[.!?…]["'’”)\]]*\s*$/.test(newSuffix) || liveBuffer.split(" ").length > 40) {
    flushLiveBuffer();
  }
}

// ---------- 啟動與 SPA 換片偵測 ----------
//
// YouTube 是單頁應用程式（SPA），換一部影片不會重新載入頁面，content.js 也不會重跑。
// 所以要主動偵測影片 ID 變化，而且「只有 ID 真的變了」才重建時間軸——
// 暫停、拖曳、切換全螢幕都不該觸發重建。
let lastSeenVideoId = null;

function onPossibleNavigation() {
  const videoId = getVideoId();
  if (videoId === lastSeenVideoId) return;
  lastSeenVideoId = videoId;

  resetTimelineState();

  // SPA 換片時 YouTube 會把整個播放器 DOM 換掉，舊的字幕條也跟著消失。
  // 用 force 重新套用一次，讓字幕條掛回新的播放器上。
  applyCaptionOverlayMode(true);

  if (!videoId) return;
  // 換片後播放器需要一點時間重新初始化，稍等一下再要資料
  setTimeout(() => ensureTimelineForCurrentVideo({ force: true }), 300);
}

function initSentenceNavigation() {
  if (!Sentences) {
    console.error("[FlowStudy] sentence-timeline.js 沒有載入，句子導覽無法啟用");
    return;
  }

  // YouTube 自己在 SPA 換頁完成時會發這些事件，比輪詢即時
  document.addEventListener("yt-navigate-finish", onPossibleNavigation);
  document.addEventListener("yt-page-data-updated", onPossibleNavigation);
  window.addEventListener("popstate", onPossibleNavigation);

  // 保險：上面的事件名稱是 YouTube 內部的，有可能改掉。用低頻輪詢兜底，
  // 而且只做一次字串比對，成本幾乎是零。
  // 順便重畫狀態標籤——播放器控制列有可能比我們晚出現，只靠「狀態改變時重畫」
  // 會讓標籤永遠掛不上去。
  setInterval(() => {
    onPossibleNavigation();
    renderSentenceChip();
  }, 1000);

  // 目前播到第幾句：用 timeupdate（約每秒 4 次），不用 requestAnimationFrame
  document.addEventListener("timeupdate", (e) => {
    if (e.target && e.target.tagName === "VIDEO") updateCurrentSentence();
  }, true);
  document.addEventListener("seeked", (e) => {
    if (e.target && e.target.tagName === "VIDEO") updateCurrentSentence();
  }, true);

  onPossibleNavigation();
}

// ==================== 沉浸計時器（播放器控制列膠囊按鈕） ====================
//
// 顯示邏輯（Session，畫面上看到的數字）：
//   - 只在「沉浸模式開啟 + 影片播放中」時走動，用真實時間（Date.now() 差值）累計，
//     所以調整播放速度（0.5x / 2x）不會影響計時。
//   - 影片暫停（含滑鼠移到字幕自動暫停、查字）時，畫面數字停住但不歸零。
//   - 手動關閉或重新開啟沉浸模式時，畫面數字才會歸零重新算。
//
// 底層累計邏輯（寫進資料庫的 ImmersionSession）：
//   - 每一段「沉浸模式開啟 + 有在播放」的連續觀看是一筆 ImmersionSession，
//     記錄看了哪部影片、從什麼時候開始、實際看了幾秒。
//   - 累計的是「真實流逝的時間」而不是影片播放位置的差值。這一點同時解決了
//     兩個需求：拖曳進度條從 02:00 跳到 20:00，中間 18 分鐘不會被算成沉浸時間
//     （牆上的時鐘不會因為你拖進度條就走比較快）；調整播放速度也不會扭曲數字。
//   - 換影片時關掉舊 session、開新的，這樣分析頁才能算「學習次數」。
//   - 切到背景分頁時 setInterval 可能被瀏覽器降頻，所以用時間戳記差值而不是
//     「tick 次數」來計算經過秒數，恢復到前景時會自動補上中間經過的時間。
let immersionActive = false;
let sessionSeconds = 0;
let tickAnchor = null; // 開始累計的時間戳記；null 代表目前沒有在累計
let pendingFlushSeconds = 0; // 還沒寫進資料庫的秒數
let lastCheckpointMinute = 0; // 上次寫入 F5 復原檢查點時的整分鐘數

// 目前這一段觀看在資料庫裡的 session ID；null 代表現在沒有進行中的 session
let currentImmersionSessionId = null;
let immersionSessionVideoId = null;
let startingSession = false; // 避免心跳在上一次建立還沒回來時又建一個

function formatImmersionTime(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// 包一層 sendMessage，讓「擴充功能連線失效」這種情況不會噴一堆未捕捉的錯誤。
// 沉浸統計掉幾秒不是大問題，絕對不能因此影響影片播放。
function sendToBackground(type, payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, payload }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response && response.ok ? response.data : null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

async function ensureImmersionSession() {
  const videoId = getVideoId();
  if (!videoId) return null;

  // 換影片了：先把舊的 session 結束掉，再開新的
  if (currentImmersionSessionId && immersionSessionVideoId !== videoId) {
    await endImmersionSession();
  }
  if (currentImmersionSessionId) return currentImmersionSessionId;
  if (startingSession) return null; // 已經有一個建立中的請求，不要重複建立

  startingSession = true;
  try {
    const session = await sendToBackground("immersion:start", {
      videoId,
      videoTitle: getVideoTitle(),
      language: "en",
    });
    if (session && session.id) {
      currentImmersionSessionId = session.id;
      immersionSessionVideoId = videoId;
    }
    return currentImmersionSessionId;
  } finally {
    startingSession = false;
  }
}

async function endImmersionSession() {
  const id = currentImmersionSessionId;
  if (!id) return;
  // 先清掉本地狀態再送訊息，避免結束的過程中又有心跳寫進同一個 session
  currentImmersionSessionId = null;
  immersionSessionVideoId = null;
  flushPendingSeconds(id);
  await sendToBackground("immersion:end", { sessionId: id });
}

function flushPendingSeconds(explicitSessionId) {
  if (pendingFlushSeconds <= 0) return;
  const sessionId = explicitSessionId || currentImmersionSessionId;
  if (!sessionId) return;

  const secondsToFlush = pendingFlushSeconds;
  pendingFlushSeconds = 0;
  // 送的是「增量」而不是總值：萬一某一次訊息漏掉，也只會少算那幾秒，
  // 不會用一個錯的總值把資料庫裡正確的累計覆蓋掉。
  sendToBackground("immersion:tick", { sessionId, deltaSeconds: secondsToFlush });
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

  // 非英文字幕時把膠囊做成停用的樣子，讓使用者看得懂「為什麼數字不動」
  const blocked = isEnglishCaption() === false;
  btn.classList.toggle("is-blocked", blocked);
  if (blocked) {
    const langName = timelineTrack ? timelineTrack.label || timelineTrack.languageCode : "非英文";
    btn.setAttribute("aria-label", `字幕語言是${langName}，沉浸時數不計入`);
    btn.title = `目前字幕不是英文（${langName}），沉浸時數不會計入`;
    return;
  }
  btn.removeAttribute("title");

  const video = getVideoEl();
  const isPaused = !video || video.paused;
  btn.setAttribute("aria-label", isPaused ? "影片已暫停，未記錄" : "沉浸計時中");
}

// YouTube 播放器只在「視窗大小改變」時才重算 <video> 的尺寸。
// 沉浸模式用 CSS 藏掉右側推薦欄、或退出全螢幕時，播放器外框的寬度變了，
// 但視窗本身沒變，YouTube 不知道要重算——影片就卡在舊尺寸：
// 關閉沉浸時影片比外框大、蓋到右欄；開啟時影片縮在左上角。以前只能重新整理才恢復。
// 這裡補發 resize 事件，讓 YouTube 用它自己的邏輯重新排一次。
// 發兩次：第一次在下一個畫面，第二次等全螢幕切換這類有過場的變化定案之後。
function nudgeYouTubeLayout() {
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  setTimeout(() => window.dispatchEvent(new Event("resize")), 400);
}

function onImmersionButtonClick() {
  immersionActive = !immersionActive;
  sessionSeconds = 0;
  lastCheckpointMinute = 0;

  if (!immersionActive) {
    // 關閉沉浸模式 = 這一段學習結束，把 session 收掉存進資料庫
    endImmersionSession();
  }
  tickAnchor = null;

  chrome.storage.session.set({
    immersion_active: immersionActive,
    immersion_session_seconds: 0,
  });

  document.documentElement.classList.toggle("zerostudy-immersion-active", immersionActive);
  nudgeYouTubeLayout(); // 推薦欄出現／消失，播放器寬度跟著變
  renderImmersionButton();
  // 沉浸模式是自繪字幕條的總開關，按下去要立刻反映，不要等下一次心跳
  applyCaptionOverlayMode();
  renderSentenceChip();
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

  // 齒輪：打開設定面板（懸停暫停、字幕大小、學習中心）
  const gear = document.createElement("button");
  gear.id = "zerostudy-settings-btn";
  gear.type = "button";
  gear.className = "zerostudy-settings-btn";
  gear.title = "FlowStudy 設定";
  gear.setAttribute("aria-label", "FlowStudy 設定");
  gear.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/></svg>`;
  gear.addEventListener("click", (e) => {
    e.stopPropagation(); // 不要讓 YouTube 把這次點擊當成「點畫面暫停」
    toggleSettingsPanel();
  });

  wrapper.appendChild(btn);
  wrapper.appendChild(gear);
  controls.prepend(wrapper);
  renderImmersionButton();
  observePlayerWidth();
}

// ==================== 播放器內的設定面板 ====================
//
// 放在播放器裡而不是擴充功能的彈出視窗，是因為這幾項設定都是「看影片當下」
// 才會想調整的：字幕太小看不清、不想被懸停暫停打斷。
// 要跳出 YouTube 去點擴充功能圖示才能改，實際上等於不會去改。

// ---------- 字幕語言判定 ----------
//
// 目標語言是英文。看中文、泰文等其他語言的影片時，字幕照樣顯示
// （版面、拖曳、大小都保留），但「學習相關」的行為全部關掉：
//   沉浸時數不計入、滑鼠懸停不暫停、點字不查翻譯。
//
// 語言來自句子時間軸實際選用的那一軌（yt-player-bridge 回報的 languageCode）。
//
// 回傳 null 代表「還不知道」——字幕還在載入、或這部影片根本沒有字幕。
// 這種情況一律當成可以學習，不要因為抓取失敗就把使用者的沉浸時數鎖住。
function isEnglishCaption() {
  const lang = timelineTrack && timelineTrack.languageCode;
  if (!lang) return null;
  return String(lang).toLowerCase().startsWith("en");
}

// 學習用的互動現在可不可以用？只有「明確不是英文」時才關掉。
function isLearningEnabled() {
  return isEnglishCaption() !== false;
}

const CAPTION_SCALE_KEY = "flowstudyCaptionScale";
const HOVER_PAUSE_KEY = "flowstudyHoverPause";
const CAPTION_SCALE_MIN = 50;
const CAPTION_SCALE_MAX = 200;
const CAPTION_SCALE_STEP = 10;

let captionScale = 100; // 百分比
let hoverPauseEnabled = true;
let settingsPanelEl = null;

function applyCaptionScale() {
  const ratio = captionScale / 100;
  document.documentElement.style.setProperty("--flowstudy-caption-scale", ratio);
  // 翻譯框跟著一起縮放。兩者共用同一個比例，放大字幕時翻譯框不會留在原地變小一號。
  document.documentElement.style.setProperty("--my-box-scale", ratio);
  const label = settingsPanelEl && settingsPanelEl.querySelector("#fsCaptionScaleValue");
  if (label) label.textContent = captionScale + "%";
}

function setCaptionScale(next) {
  captionScale = Math.min(CAPTION_SCALE_MAX, Math.max(CAPTION_SCALE_MIN, next));
  applyCaptionScale();
  try {
    chrome.storage.local.set({ [CAPTION_SCALE_KEY]: captionScale });
  } catch (e) {}
}

function setHoverPause(enabled) {
  hoverPauseEnabled = !!enabled;
  try {
    chrome.storage.local.set({ [HOVER_PAUSE_KEY]: hoverPauseEnabled });
  } catch (e) {}
}

function buildSettingsPanel() {
  const blocked = isEnglishCaption() === false;
  const langName = timelineTrack ? timelineTrack.label || timelineTrack.languageCode : "";

  // 整個視窗由「半透明黑色遮罩」與「置中的白色卡片」兩層組成。
  // 遮罩本身就是 flex 容器，卡片用 align/justify center 對齊到畫面正中央。
  const backdrop = document.createElement("div");
  backdrop.id = "zerostudy-settings-panel";
  backdrop.className = "fs-modal-backdrop";
  backdrop.innerHTML = `
    <div class="fs-modal" role="dialog" aria-modal="true" aria-label="擴充功能設定">
      <div class="fs-modal-head">
        <span class="fs-modal-title">擴充功能設定</span>
        <button class="fs-modal-close" id="fsModalClose" type="button" aria-label="關閉">×</button>
      </div>

      ${
        blocked
          ? `<div class="fs-lang-notice">
               <span>⚠️</span>
               <span>目前字幕語言是<strong>${escapeAttr(langName)}</strong>，不是英文。
               沉浸時數不會計入，點字查詢與懸停暫停也已停用。</span>
             </div>`
          : ""
      }

      <div class="fs-panel-row">
        <span>
          <div class="fs-panel-label">懸停自動暫停</div>
          <div class="fs-panel-sub">滑鼠懸停在字幕上時暫停影片</div>
        </span>
        <button class="fs-switch" id="fsHoverPause" type="button" role="switch"
                aria-checked="true" ${blocked ? "disabled" : ""}>
          <span class="fs-switch-knob"></span>
        </button>
      </div>

      <div class="fs-panel-row">
        <span>
          <div class="fs-panel-label">字幕大小</div>
          <div class="fs-panel-sub">字幕與翻譯框一起縮放（50%–200%）</div>
        </span>
        <span class="fs-stepper">
          <button class="fs-step-btn" id="fsScaleDown" type="button" aria-label="縮小字幕">−</button>
          <span class="fs-step-value" id="fsCaptionScaleValue">100%</span>
          <button class="fs-step-btn" id="fsScaleUp" type="button" aria-label="放大字幕">＋</button>
        </span>
      </div>

      <div class="fs-panel-row">
        <span>
          <div class="fs-panel-label">中英雙字幕</div>
          <div class="fs-panel-sub" id="fsDualSubsSub">英文下方同時顯示中文翻譯</div>
        </span>
        <button class="fs-switch" id="fsDualSubs" type="button" role="switch"
                aria-checked="false" ${blocked ? "disabled" : ""}>
          <span class="fs-switch-knob"></span>
        </button>
      </div>

      <!-- 設定一改就生效，「完成」只是關掉視窗；點卡片外面、按 Esc、右上角 × 也都能關 -->
      <button class="fs-modal-done" id="fsModalDone" type="button">完成</button>
    </div>`;

  // 視窗內的所有滑鼠事件都不要傳出去，否則會被 YouTube 當成「點播放器 = 播放／暫停」
  backdrop.addEventListener("click", (e) => e.stopPropagation());
  backdrop.addEventListener("mousedown", (e) => e.stopPropagation());
  backdrop.addEventListener("dblclick", (e) => e.stopPropagation());

  // 點遮罩（卡片以外的區域）關閉
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeSettingsPanel();
  });

  backdrop.querySelector("#fsModalClose").addEventListener("click", closeSettingsPanel);
  backdrop.querySelector("#fsModalDone").addEventListener("click", closeSettingsPanel);

  backdrop.querySelector("#fsScaleDown").addEventListener("click", () =>
    setCaptionScale(captionScale - CAPTION_SCALE_STEP)
  );
  backdrop.querySelector("#fsScaleUp").addEventListener("click", () =>
    setCaptionScale(captionScale + CAPTION_SCALE_STEP)
  );

  const hoverBtn = backdrop.querySelector("#fsHoverPause");
  hoverBtn.addEventListener("click", () => {
    if (hoverBtn.disabled) return;
    setHoverPause(!hoverPauseEnabled);
    hoverBtn.setAttribute("aria-checked", String(hoverPauseEnabled));
    hoverBtn.classList.toggle("is-on", hoverPauseEnabled);
  });

  const dualBtn = backdrop.querySelector("#fsDualSubs");
  dualBtn.addEventListener("click", () => {
    if (dualBtn.disabled) return;
    setDualSubs(!dualSubsEnabled);
  });

  return backdrop;
}

function escapeAttr(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function syncSettingsPanel() {
  if (!settingsPanelEl) return;
  const hoverBtn = settingsPanelEl.querySelector("#fsHoverPause");
  if (hoverBtn) {
    const on = hoverPauseEnabled && isEnglishCaption() !== false;
    hoverBtn.setAttribute("aria-checked", String(on));
    hoverBtn.classList.toggle("is-on", on);
  }
  applyCaptionScale();

  const down = settingsPanelEl.querySelector("#fsScaleDown");
  const up = settingsPanelEl.querySelector("#fsScaleUp");
  if (down) down.disabled = captionScale <= CAPTION_SCALE_MIN;
  if (up) up.disabled = captionScale >= CAPTION_SCALE_MAX;

  syncDualSubsPanel();
}

function syncDualSubsPanel() {
  if (!settingsPanelEl) return;
  const btn = settingsPanelEl.querySelector("#fsDualSubs");
  const sub = settingsPanelEl.querySelector("#fsDualSubsSub");
  const on = dualSubsEnabled && isEnglishCaption() !== false;
  if (btn) {
    btn.setAttribute("aria-checked", String(on));
    btn.classList.toggle("is-on", on);
  }
  if (sub) sub.textContent = describeDualSubs();
}

function toggleSettingsPanel() {
  if (settingsPanelEl) {
    closeSettingsPanel();
    return;
  }
  // 全螢幕時必須掛在全螢幕元素底下，否則整個視窗會被蓋掉看不見。
  // 一般情況掛在 body；兩種情況都用 position: fixed 對齊畫面正中央。
  const host = document.fullscreenElement || document.body;
  // 查字的翻譯小框框收掉：它的層級比設定視窗高，留著會蓋在設定上面。
  // 打開設定＝這個字看完了，跟恢復播放時收掉框框是同一個道理。
  closeBox();
  settingsPanelEl = buildSettingsPanel();
  host.appendChild(settingsPanelEl);
  syncSettingsPanel();

  const gear = document.getElementById("zerostudy-settings-btn");
  if (gear) gear.classList.add("is-open");

  document.addEventListener("keydown", onSettingsEscape, true);
}

function closeSettingsPanel() {
  if (!settingsPanelEl) return;
  settingsPanelEl.remove();
  settingsPanelEl = null;
  document.removeEventListener("keydown", onSettingsEscape, true);
  const gear = document.getElementById("zerostudy-settings-btn");
  if (gear) gear.classList.remove("is-open");
}

// Escape 關閉。用 capture 並擋下傳遞，避免同一次按鍵又被
// 翻譯框的 Escape 處理或 YouTube 自己的全螢幕退出接手。
function onSettingsEscape(e) {
  if (e.key !== "Escape" || !settingsPanelEl) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  closeSettingsPanel();
}

function initPlayerSettings() {
  chrome.storage.local.get([CAPTION_SCALE_KEY, HOVER_PAUSE_KEY, DUAL_SUBS_KEY], (data) => {
    const scale = data && data[CAPTION_SCALE_KEY];
    if (Number.isFinite(scale)) captionScale = scale;
    if (data && data[HOVER_PAUSE_KEY] === false) hoverPauseEnabled = false;
    if (data && data[DUAL_SUBS_KEY] === true) {
      dualSubsEnabled = true;
      ensureDualSubsWindow(); // 字幕時間軸可能比這裡早載入好，補翻一次目前位置
    }
    applyCaptionScale();
    syncSettingsPanel();
  });
}

// ==================== 中英雙字幕 ====================
//
// 英文字幕下方同時顯示中文。翻譯在背景做（Gemini，沒有金鑰就用 Google 翻譯，
// 見 core/translate/subtitleTranslator.js），這裡只負責「送哪些句子去翻」與「顯示」。
//
// 邊看邊翻，一次只翻「目前位置往後 10 分鐘」：
//   以前是時間軸一載入就整部送出去。2026-09-29 開了一部 12 小時的影片、只看了 2 分鐘，
//   整部 12 小時的字幕全部丟給 Google，Google 就把整個網路擋了下來。現在的規則：
//     - 翻的範圍是「目前位置往前 30 秒 ～ 往後 10 分鐘」（往前一點，按 a 回上一句也有中文）
//     - 播到離「還沒翻的地方」剩不到 3 分鐘時，才往後再翻 10 分鐘——
//       一次一小段地送，不會每幾秒就零碎地送一兩句
//     - 跳到影片別的地方，就從那裡開始翻 10 分鐘；翻好之前的十幾秒先只有英文
//   翻過的句子背景有快取，倒回去看、同一部影片重看都不會再翻一次。
//
// 只在「有完整字幕時間軸」時提供。即時記錄的備援模式句子是邊播邊長出來的，沒辦法預先翻。
const DUAL_SUBS_KEY = "flowstudyDualSubs";
const DUAL_SUBS_BATCH = 40; // 一批幾句：夠給 Gemini 看上下文，又不會一批等太久
const DUAL_SUBS_WINDOW_SECONDS = 10 * 60; // 一次往後翻多遠
const DUAL_SUBS_LOOKBACK_SECONDS = 30; // 也順便翻目前位置往前這麼多
const DUAL_SUBS_PREFETCH_SECONDS = 3 * 60; // 還沒翻的地方離目前位置剩這麼近，就開始翻下一段
const DUAL_SUBS_FAIL_PAUSE_MS = 15 * 1000; // 一般失敗（網路斷一下）之後，隔多久才再試
const DUAL_SUBS_BLOCKED_PAUSE_MS = 5 * 60 * 1000; // Google 擋下網路之後，這麼久內不再送（背景另有 30 分鐘冷卻）

let dualSubsEnabled = false;
let zhByIndex = []; // 跟 sentenceTimeline 一一對應的中文；undefined = 還沒翻好
let zhJobToken = 0; // 換片、關閉開關時遞增，讓還在路上的舊批次回來時直接作廢
let zhBusyToken = -1; // 正在翻的那一段屬於哪個 token；同一時間只翻一段
let zhPausedUntil = 0; // 失敗或被擋之後，這個時間點之前不再送
let zhProgress = { engine: "", notice: "", running: false };

function setDualSubs(enabled) {
  dualSubsEnabled = !!enabled;
  try {
    chrome.storage.local.set({ [DUAL_SUBS_KEY]: dualSubsEnabled });
  } catch (e) {}
  if (dualSubsEnabled) {
    // 使用者自己重新打開 = 想馬上再試一次，不必等失敗後的暫停時間
    zhPausedUntil = 0;
    zhProgress.notice = "";
    ensureDualSubsWindow();
  } else {
    zhJobToken++; // 關掉就停止送新的批次；已經翻好的留著，再打開不用重翻
    zhProgress.running = false;
  }
  renderCaptionBar();
  syncDualSubsPanel();
}

function resetDualSubs() {
  zhJobToken++;
  zhByIndex = [];
  zhPausedUntil = 0;
  zhProgress = { engine: "", notice: "", running: false };
  syncDualSubsPanel();
}

function describeDualSubs() {
  if (isEnglishCaption() === false) return "目前字幕不是英文，無法使用";
  if (!dualSubsEnabled) return "英文下方同時顯示中文翻譯";
  if (!sentenceTimeline.length) return "等字幕載入後開始翻譯";
  if (zhProgress.running) return "翻譯中…";
  if (zhProgress.notice) return zhProgress.notice;

  const list = sentenceTimeline;
  const engine = zhProgress.engine === "gemini" ? "・Gemini" : zhProgress.engine === "google" ? "・Google 翻譯" : "";
  if (list.every((_, i) => zhByIndex[i] !== undefined)) return `已翻好全部 ${list.length} 句${engine}`;
  // 從目前這句往後數，連續翻好到哪裡
  const from = Math.max(currentSentenceIndex, 0);
  let i = from;
  while (i < list.length && zhByIndex[i] !== undefined) i++;
  if (i >= list.length) return `已翻好到影片結尾${engine}`;
  if (i === from) return "邊看邊翻，一次翻 10 分鐘";
  return `已翻好到 ${formatImmersionTime(Math.floor(list[i].start))}（邊看邊翻）${engine}`;
}

// 翻譯範圍的起點：「往前 30 秒時正在播的那一句」
function dualSubsWindowStart(list, t) {
  return Math.max(0, Sentences.getCurrentSentenceIndex(Math.max(0, t - DUAL_SUBS_LOOKBACK_SECONDS), list));
}

// 只有「還沒翻的句子」出現在往後 3 分鐘內（或就是目前這句）才需要動手
function dualSubsNeedsMore(list, t) {
  for (let i = dualSubsWindowStart(list, t); i < list.length && list[i].start < t + DUAL_SUBS_PREFETCH_SECONDS; i++) {
    if (zhByIndex[i] === undefined) return true;
  }
  return false;
}

// 一動手就翻到 10 分鐘後，播放中大約每 7 分鐘才送一小段
function dualSubsIndicesToTranslate(list, t) {
  const out = [];
  for (let i = dualSubsWindowStart(list, t); i < list.length && list[i].start < t + DUAL_SUBS_WINDOW_SECONDS; i++) {
    if (zhByIndex[i] === undefined) out.push(i);
  }
  return out;
}

// 看目前播到哪裡，需要的話翻「往後 10 分鐘」。
// 呼叫時機：字幕時間軸載入好、打開開關、播到下一句或跳到別的地方（updateCurrentSentence）。
// 沒有需要時什麼都不做，所以頻繁呼叫也沒關係。
async function ensureDualSubsWindow() {
  const list = sentenceTimeline;
  if (!dualSubsEnabled || !list.length || isEnglishCaption() === false) return;
  if (zhBusyToken === zhJobToken) return; // 這一段還在翻，翻完會自己再檢查一次
  if (Date.now() < zhPausedUntil) return;
  const video = getVideoEl();
  const t = video ? video.currentTime : 0;
  if (!dualSubsNeedsMore(list, t)) return;

  const token = zhJobToken;
  zhBusyToken = token;
  const idxs = dualSubsIndicesToTranslate(list, t);
  zhProgress.running = true;
  zhProgress.notice = "";
  syncDualSubsPanel();

  const title = getVideoTitle();
  let failed = false;
  let blocked = false;
  try {
    // 一批接一批送，不同時送好幾批（背景對 Google 另外還有排隊與間隔）
    for (let k = 0; k < idxs.length; k += DUAL_SUBS_BATCH) {
      const batch = idxs.slice(k, k + DUAL_SUBS_BATCH);
      const res = await sendToBackground("subs:translate", { texts: batch.map((i) => list[i].text), title });
      if (token !== zhJobToken) return; // 換片或關掉了，這段作廢
      if (res && res.blocked) {
        // Google 暫時擋下這個網路：停下來，一段時間內不再送（再送只會讓封鎖更久）
        blocked = true;
        zhProgress.notice = res.notice || "Google 翻譯暫時限制使用，約 30 分鐘後再試";
        zhPausedUntil = Date.now() + DUAL_SUBS_BLOCKED_PAUSE_MS;
        return;
      }
      if (!res || !Array.isArray(res.translations)) {
        failed = true;
        zhProgress.notice = "翻譯失敗，稍後自動再試";
        zhPausedUntil = Date.now() + DUAL_SUBS_FAIL_PAUSE_MS;
        return;
      }
      batch.forEach((i, j) => (zhByIndex[i] = res.translations[j] || ""));
      zhProgress.engine = res.engine || zhProgress.engine;
      if (res.notice) zhProgress.notice = res.notice;
      renderCaptionBar();
      syncDualSubsPanel();
    }
  } finally {
    if (token === zhJobToken) {
      zhBusyToken = -1;
      zhProgress.running = false;
      syncDualSubsPanel();
    }
  }
  // 翻這一段的時候，使用者可能已經跳到別的地方了，再檢查一次
  if (!failed && !blocked && token === zhJobToken) ensureDualSubsWindow();
}

// 現在這一句的中文。即時記錄模式、或這句還沒翻好時是空字串。
function getCaptionZhForNow() {
  if (!dualSubsEnabled || !sentenceTimeline.length || isEnglishCaption() === false) return "";
  if (currentSentenceIndex < 0) return "";
  return zhByIndex[currentSentenceIndex] || "";
}

// 播放器控制列的空間是「剛好用完」的：實測 1920 寬的視窗，YouTube 自己的
// 左右控制區加起來就填滿整條，剩餘空間是 0。我們額外插進去的沉浸膠囊 + 句數標籤
// 約佔 160px，播放器一變窄就會把 YouTube 自己的按鈕（劇場模式、全螢幕）擠出可視範圍。
//
// 所以空間不夠時要主動退讓：先收起句數標籤（資訊性的），保留沉浸膠囊（要點的）。
let playerWidthObserver = null;

function observePlayerWidth() {
  const player = getPlayerContainer();
  if (!player || playerWidthObserver) return;

  playerWidthObserver = new ResizeObserver((entries) => {
    const width = entries[0] && entries[0].contentRect.width;
    if (!width) return;
    document.documentElement.classList.toggle("zerostudy-narrow-player", width < 880);
  });
  playerWidthObserver.observe(player);
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
      // 換片：先把上一部影片的 session 好好結束掉，再從 0 重新算這一部的
      endImmersionSession();
      sessionSeconds = 0;
      lastCheckpointMinute = 0;
      tickAnchor = null;
      chrome.storage.session.set({ immersion_session_seconds: 0 });
    }
    lastImmersionVideoId = currentVideoId;
  }

  // 非英文字幕不計入沉浸時數：不建立 session、不累加秒數，畫面固定在 0:00。
  // 看中文或泰文影片就是娛樂，不該灌水成英文學習時間。
  const learningEnabled = isLearningEnabled();
  if (!learningEnabled) {
    if (currentImmersionSessionId) endImmersionSession(); // 播到一半換成非英文字幕軌
    if (sessionSeconds !== 0) {
      sessionSeconds = 0;
      lastCheckpointMinute = 0;
      chrome.storage.session.set({ immersion_session_seconds: 0 });
    }
    pendingFlushSeconds = 0;
    tickAnchor = null;
    renderImmersionButton();
    return;
  }

  if (immersionActive && isPlaying) {
    // 有在看才需要 session。沒開沉浸模式、或影片暫停時完全不建立，
    // 這樣「只是開著 YouTube 分頁」不會被算成學習時間。
    ensureImmersionSession();

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
    // 暫停了：把還沒寫進去的秒數送出去，但「不」結束 session——
    // 使用者只是暫停查個單字，馬上就會繼續看，沒必要切成兩段。
    // 真正結束 session 的時機是換片、關閉沉浸模式或離開頁面。
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
      // 這裡是非同步讀回來的，YouTube 早就用「有推薦欄」的寬度排好播放器了，
      // 重新整理後影片偏小、偏左就是這個原因
      nudgeYouTubeLayout();
    }
    renderImmersionButton();
    // immersionActive 是非同步讀回來的，而字幕條的顯示取決於它。
    // 這裡讀到之後要立刻重新套用一次，否則重新整理頁面後、
    // 沉浸模式明明是開著的，字幕條卻要等一秒才出現。
    applyCaptionOverlayMode();
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
    // 退出全螢幕時推薦欄又被藏起來，YouTube 卻是照「有推薦欄」算的寬度
    if (immersionActive) nudgeYouTubeLayout();
  });
  // SPA 換頁（例如從首頁點進影片）時，確保播放器照「沒有推薦欄」的寬度排版
  document.addEventListener("yt-navigate-finish", () => {
    if (immersionActive) nudgeYouTubeLayout();
  });

  setInterval(immersionHeartbeatTick, 1000);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPendingSeconds();
  });
  // 離開頁面：把剩下的秒數寫出去並結束 session。
  // 就算這裡沒送成功也不會遺失資料——background 啟動時的 closeStaleSessions()
  // 會把沒正常結束的 session 收乾淨，而秒數在每次心跳時就已經寫進去了。
  window.addEventListener("pagehide", () => {
    flushPendingSeconds();
    endImmersionSession();
  });
  window.addEventListener("beforeunload", () => {
    flushPendingSeconds();
    endImmersionSession();
  });
}

// ==================== 單字收藏（雙擊翻譯彈窗） ====================
//
// 右鍵選單會跟 YouTube 原生的右鍵選單衝突，改成：雙擊翻譯彈窗收藏單字。
//
// 資料流：
//   content.js（youtube.com origin）
//       │ chrome.runtime.sendMessage
//       ▼
//   background.js（擴充功能 origin）──► IndexedDB
//
// 為什麼不直接在這裡寫 IndexedDB？因為 content script 跑在 youtube.com 的
// origin，這裡的 indexedDB 是 YouTube 自己的資料庫，不是我們的。
//
// 畫面上的底線高亮則讀一份輕量索引（只有正規化後的單字字串），
// 由 background 在每次收藏後重建。它是唯讀的快取，真相永遠在 IndexedDB。
const normalizeTerm = globalThis.FlowStudyNormalize.normalizeTerm;

let markedTerms = new Set();

function loadMarkedWords(cb) {
  chrome.storage.local.get(["flowstudyMarkedTerms", "learningWords"], (data) => {
    if (Array.isArray(data.flowstudyMarkedTerms)) {
      markedTerms = new Set(data.flowstudyMarkedTerms);
    } else {
      // 索引還沒建立（剛升級、background 還沒跑完搬移）：
      // 先用舊的 learningWords 頂著，畫面不會突然少一堆底線。
      markedTerms = new Set(Object.keys(data.learningWords || {}).map(normalizeTerm).filter(Boolean));
    }
    if (cb) cb();
  });
}

// 從句子時間軸取得目前這一句的完整內容與精確起訖時間。
// 這是收藏單字時最有價值的上下文——有了 startTime，之後在單字頁就能
// 一鍵跳回影片裡這個字出現的那一刻。
function getCurrentSentenceContext() {
  const list = activeSentences();
  const sentence = list[currentSentenceIndex];
  if (sentence) {
    return { sentence: sentence.text, startTime: sentence.start, endTime: sentence.end };
  }
  // 沒有時間軸時退回畫面上的字幕文字，至少保留學習情境
  const fallback = getCurrentCaptionSentence();
  const video = getVideoEl();
  const t = video ? video.currentTime : 0;
  return { sentence: fallback, startTime: t, endTime: t };
}

function getVideoTitle() {
  // YouTube 改版時這些選擇器可能失效，所以逐一嘗試，全部落空就退回分頁標題
  const selectors = [
    "h1.ytd-watch-metadata yt-formatted-string",
    "h1.title yt-formatted-string",
    "#title h1",
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    const text = el && el.textContent.trim();
    if (text) return text;
  }
  return (document.title || "").replace(/ - YouTube$/, "").trim();
}

function refreshMarkedHighlight() {
  document.querySelectorAll(".my-word").forEach((el) => {
    const key = normalizeTerm(el.textContent);
    el.classList.toggle("my-word-marked", !!key && markedTerms.has(key));
  });
}

function markWordAsLearning(word, sentence) {
  const term = (word || "").trim();
  const key = normalizeTerm(term);
  if (!key) return;

  // 先更新本地的底線狀態再送出請求。收藏的動畫是即時的，使用者不該為了
  // 看到底線而等待一次跨 context 的訊息往返。萬一儲存失敗，下面會退回來。
  const wasMarked = markedTerms.has(key);
  markedTerms.add(key);
  refreshMarkedHighlight();

  const context = getCurrentSentenceContext();
  const videoId = getVideoId();

  const payload = {
    term,
    language: "en",
    translation: currentLookupTranslation,
    // sentence 參數是呼叫端從字幕元素抓的文字；句子時間軸有更完整的整句，優先用它。
    sentence: context.sentence || sentence || "",
    startTime: context.startTime,
    endTime: context.endTime,
    videoId: videoId || "",
    videoTitle: getVideoTitle(),
    videoUrl: videoId ? `https://www.youtube.com/watch?v=${videoId}` : "",
  };

  try {
    chrome.runtime.sendMessage({ type: "vocab:save", payload }, (response) => {
      if (chrome.runtime.lastError) {
        // 擴充功能重新載入後，舊分頁的 content script 會失去連線。
        // 明確告知使用者要重新整理，而不是默默失敗讓他以為存好了。
        if (!wasMarked) markedTerms.delete(key);
        refreshMarkedHighlight();
        console.error(
          "[FlowStudy] 收藏失敗，這個分頁的擴充功能連線可能已經失效，請重新整理頁面（F5）後再試：",
          chrome.runtime.lastError.message
        );
        return;
      }
      if (!response || !response.ok) {
        if (!wasMarked) markedTerms.delete(key);
        refreshMarkedHighlight();
        console.error("[FlowStudy] 收藏失敗：", response && response.error);
        return;
      }
      const { isNewWord } = response.data || {};
      console.log(`[FlowStudy] 已收藏「${term}」${isNewWord ? "（新單字）" : "（已存在，新增一筆出現紀錄）"}`);
    });
  } catch (err) {
    if (!wasMarked) markedTerms.delete(key);
    refreshMarkedHighlight();
    console.error("[FlowStudy] 收藏時發生例外，請重新整理頁面（F5）後再試：", err);
  }
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
    // 用 closeBox() 而不是直接設 display:none —— 收藏時翻譯可能都還沒回來，
    // 走同一個關閉流程才會一併作廢那個還在路上的查詢，
    // 不然動畫播完之後框框會自己又冒出來。
    closeBox();
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

// 在單字頁刪除或編輯單字時，background 會重建索引，這裡即時跟著更新底線，
// 不用重新整理 YouTube 分頁。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.flowstudyMarkedTerms) {
    markedTerms = new Set(changes.flowstudyMarkedTerms.newValue || []);
    refreshMarkedHighlight();
  }
});

// ==================== 固定位置字幕條（取代會跟著控制列上下跑的原生 CC） ====================
//
// 要解決的問題：YouTube 原生字幕會跟著播放器控制列連動——滑鼠移進影片，控制列升起，
// 字幕也跟著往上跳；滑鼠移開又降回去。對一般觀眾無所謂，但我們的核心操作就是
// 「把滑鼠移到字幕上點單字」，一移過去字幕就跑掉，等於永遠對不準。
//
// 作法：自己畫一條字幕，放在播放器容器內部（這樣全螢幕時會一起進入全螢幕），
// 用絕對定位固定在使用者指定的位置，完全不理會控制列的升降。原生字幕視窗則用
// opacity 藏起來——刻意不用 display:none，因為 YouTube 必須繼續更新那些文字節點，
// 「即時記錄備援」跟下面的鏡像模式都要靠讀取它。
//
// 顯示內容優先用句子時間軸的「完整邏輯句」，而不是 YouTube 的碎片 cue。
// 這比原生字幕好用很多：一句話在畫面上只出現一次、不會逐字跳動，
// 停頓時也不會消失，要點哪個字都能慢慢對準。
//
// 顯示與否由兩個條件決定，兩者都成立才會出現：
//   immersionActive       —— 沉浸模式（播放器控制列的膠囊按鈕）是否開啟
//   captionOverlayEnabled —— 使用者是否偏好自繪字幕（點句數小標籤切換）
//
// 沉浸模式是「總開關」：關掉沉浸模式就回到完全原生的 YouTube 觀看體驗，
// 自繪字幕條消失、原生 CC 恢復。這樣「隨便看看」跟「專心學習」兩種模式
// 有明確的界線，不會在不想學習的時候還被我們的介面干擾。
let captionOverlayEnabled = true;
let captionBarEl = null;
let captionBarTextEl = null;
let captionBarZhEl = null; // 中英雙字幕的中文那一行
let lastRenderedZh = "";
let captionBarPos = { leftPct: 50, topPct: 82 };
let lastRenderedCaptionText = "";

const CAPTION_POS_KEY = "flowstudyCaptionPos";
const CAPTION_ENABLED_KEY = "flowstudyCaptionOverlay";

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getPlayerContainer() {
  return document.getElementById("movie_player") || document.querySelector(".html5-video-player");
}

function ensureCaptionBar() {
  const player = getPlayerContainer();
  if (!player) return null;

  // 播放器 DOM 被 YouTube 換掉時（SPA 換片），舊的字幕條會跟著消失，這裡要重建
  if (captionBarEl && captionBarEl.isConnected && captionBarEl.parentElement === player) {
    return captionBarEl;
  }

  const bar = document.createElement("div");
  bar.id = "flowstudy-caption-bar";
  bar.className = "flowstudy-caption-bar";
  // 中文放在英文「旁邊」的獨立元素，而不是塞進英文那一行：
  // 收藏單字時會把 .flowstudy-caption-text 的內容當成例句存起來，不能混進中文。
  bar.innerHTML =
    '<span class="flowstudy-caption-grip" title="拖曳可以移動字幕位置；雙擊還原到預設位置">⠿</span>' +
    '<span class="flowstudy-caption-lines">' +
    '<span class="flowstudy-caption-text"></span>' +
    '<span class="flowstudy-caption-zh" lang="zh-Hant"></span>' +
    "</span>";

  // 點字查詢：這裡特意攔下 click 不讓它繼續往上傳，否則會被 YouTube 當成
  // 「點擊畫面 = 播放／暫停」，每點一個單字影片就暫停一次。
  bar.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!e.target.classList.contains("my-word")) return;
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) return; // 其實是在選取片語
    const sentence = captionBarTextEl ? captionBarTextEl.textContent.trim() : "";
    doLookup(e.target.textContent, e.target.getBoundingClientRect(), sentence);
  });

  attachCaptionBarDrag(bar);

  player.appendChild(bar);
  captionBarEl = bar;
  captionBarTextEl = bar.querySelector(".flowstudy-caption-text");
  captionBarZhEl = bar.querySelector(".flowstudy-caption-zh");
  lastRenderedCaptionText = "";
  lastRenderedZh = "";
  applyCaptionBarPosition();
  return bar;
}

function applyCaptionBarPosition() {
  if (!captionBarEl) return;
  captionBarEl.style.left = captionBarPos.leftPct + "%";
  captionBarEl.style.top = captionBarPos.topPct + "%";
}

function saveCaptionBarPosition() {
  try {
    chrome.storage.local.set({ [CAPTION_POS_KEY]: captionBarPos });
  } catch (e) {
    /* 擴充功能重新載入後舊分頁會失去連線，存不了就算了，不影響當下使用 */
  }
}

// 拖曳把手：刻意「不」讓整條字幕都能拖，因為在文字上按住拖曳是「選取片語查詢」，
// 兩個手勢會打架。所以只有左側那個把手能移動位置。
function attachCaptionBarDrag(bar) {
  const grip = bar.querySelector(".flowstudy-caption-grip");
  if (!grip) return;

  let dragging = false;
  let pointerOffsetX = 0;
  let pointerOffsetY = 0;

  const onMove = (e) => {
    if (!dragging) return;
    const player = getPlayerContainer();
    if (!player) return;
    const playerRect = player.getBoundingClientRect();
    if (!playerRect.width || !playerRect.height) return;

    const barRect = bar.getBoundingClientRect();
    // 位置用百分比儲存，這樣切換全螢幕、調整視窗大小時字幕會待在同樣的相對位置
    const centerX = e.clientX - pointerOffsetX + barRect.width / 2;
    const top = e.clientY - pointerOffsetY;

    let leftPct = ((centerX - playerRect.left) / playerRect.width) * 100;
    let topPct = ((top - playerRect.top) / playerRect.height) * 100;

    // 夾在播放器範圍內，避免拖到畫面外就再也抓不回來
    const halfWidthPct = (barRect.width / 2 / playerRect.width) * 100;
    const heightPct = (barRect.height / playerRect.height) * 100;
    leftPct = Math.min(Math.max(leftPct, halfWidthPct), 100 - halfWidthPct);
    topPct = Math.min(Math.max(topPct, 0), 100 - heightPct);

    captionBarPos = { leftPct, topPct };
    applyCaptionBarPosition();
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove("is-dragging");
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("mouseup", onUp, true);
    saveCaptionBarPosition();
  };

  grip.addEventListener(
    "mousedown",
    (e) => {
      e.preventDefault();
      e.stopPropagation(); // 不要讓 YouTube 把這次按下當成點擊播放器
      const barRect = bar.getBoundingClientRect();
      pointerOffsetX = e.clientX - barRect.left;
      pointerOffsetY = e.clientY - barRect.top;
      dragging = true;
      bar.classList.add("is-dragging");
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup", onUp, true);
    },
    true
  );

  grip.addEventListener("click", (e) => e.stopPropagation());

  // 雙擊把手 = 還原預設位置（拖到奇怪的地方時的救命繩）
  grip.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    captionBarPos = { leftPct: 50, topPct: 82 };
    applyCaptionBarPosition();
    saveCaptionBarPosition();
  });
}

// 目前這一刻該顯示什麼字？
// 首選是句子時間軸裡的完整句子；沒有時間軸時退回「鏡像原生字幕的文字」，
// 這樣至少「位置固定」這個好處還在。
function getCaptionTextForNow() {
  const list = activeSentences();
  if (list.length && currentSentenceIndex >= 0 && list[currentSentenceIndex]) {
    return list[currentSentenceIndex].text;
  }
  if (!list.length) return getCurrentCaptionSentence();
  return "";
}

// 自繪字幕條現在應該顯示嗎？沉浸模式是總開關，使用者偏好是次要開關。
function shouldShowCaptionOverlay() {
  return immersionActive && captionOverlayEnabled;
}

function renderCaptionBar() {
  if (!shouldShowCaptionOverlay()) return;
  const bar = ensureCaptionBar();
  if (!bar || !captionBarTextEl) return;

  const text = getCaptionTextForNow();

  if (!text) {
    bar.classList.add("is-empty");
    if (lastRenderedCaptionText !== "") {
      captionBarTextEl.innerHTML = "";
      lastRenderedCaptionText = "";
    }
    renderCaptionZh("");
    return;
  }
  bar.classList.remove("is-empty");
  // 中文跟選取狀態無關（不能點、不會被選來查字），每次都照播放進度更新
  renderCaptionZh(getCaptionZhForNow());

  if (text !== lastRenderedCaptionText) {
    // 只有在「正在按著滑鼠拖曳選字」的當下才暫緩重畫，避免把選到一半的範圍弄掉。
    //
    // 原本這裡的判斷是「畫面上有沒有選取範圍」，但那個範圍會一直留著，
    // 直到使用者點別的地方才消失。結果影片都播到第六句了，字幕條還卡在第一句。
    // 字幕必須以播放進度為準，選取狀態不該讓它停住。
    if (!isSelectingCaption) {
      // 非英文字幕就不把字拆成可點擊的 .my-word：字幕照樣顯示，
      // 但不會有虛線底線、滑鼠指標也不會變成可點的樣子，
      // 使用者一眼就知道這部影片不提供查詢。
      captionBarTextEl.innerHTML = isLearningEnabled()
        ? text
            .split(" ")
            .map((w) => (w.trim() ? `<span class="my-word">${escapeHtml(w)}</span>` : w))
            .join(" ")
        : escapeHtml(text);
      lastRenderedCaptionText = text;
      refreshMarkedHighlight(); // 讓「學習中」的單字底線立刻套用到新句子上
    }
  }

  // 這句其實已經播完了（長時間沒人說話）：淡一點，但保留在畫面上，
  // 使用者還是可以慢慢點裡面的單字。
  const video = getVideoEl();
  const list = activeSentences();
  const active = list[currentSentenceIndex];
  const stale = !!(video && active && video.currentTime > active.end + 2);
  bar.classList.toggle("is-stale", stale);
}

function renderCaptionZh(zh) {
  if (!captionBarZhEl || zh === lastRenderedZh) return;
  captionBarZhEl.textContent = zh;
  lastRenderedZh = zh;
}

// 記住上次實際套用的狀態，這樣每秒的同步檢查在狀態沒變時是零成本的，
// 不會每秒都去動 DOM。
let lastAppliedOverlayState = null;

function applyCaptionOverlayMode(force = false) {
  const shouldShow = shouldShowCaptionOverlay();
  if (!force && shouldShow === lastAppliedOverlayState) return;
  lastAppliedOverlayState = shouldShow;

  // 這個 class 控制「原生 CC 是否隱藏」。關閉時務必移除，
  // 否則原生字幕會維持透明，變成兩邊都看不到字幕。
  document.documentElement.classList.toggle("flowstudy-overlay-on", shouldShow);

  if (shouldShow) {
    renderCaptionBar();
    return;
  }

  if (captionBarEl) {
    captionBarEl.remove();
    captionBarEl = null;
    captionBarTextEl = null;
    captionBarZhEl = null;
    lastRenderedCaptionText = "";
    lastRenderedZh = "";
  }
}

function initCaptionOverlay() {
  chrome.storage.local.get([CAPTION_POS_KEY, CAPTION_ENABLED_KEY], (data) => {
    const pos = data && data[CAPTION_POS_KEY];
    if (pos && Number.isFinite(pos.leftPct) && Number.isFinite(pos.topPct)) {
      captionBarPos = { leftPct: pos.leftPct, topPct: pos.topPct };
    }
    if (data && data[CAPTION_ENABLED_KEY] === false) captionOverlayEnabled = false;
    applyCaptionOverlayMode();
  });

  // 字幕內容跟著播放進度更新。timeupdate 約每秒 4 次，只做字串比對，成本很低；
  // 真正重畫 DOM 只發生在「句子換了」的那一刻。
  document.addEventListener(
    "timeupdate",
    (e) => {
      if (e.target && e.target.tagName === "VIDEO") renderCaptionBar();
    },
    true
  );

  // 播放器被 YouTube 換掉、或進出全螢幕時，字幕條要重新掛回去
  document.addEventListener("fullscreenchange", () => renderCaptionBar());

  // 每秒同步一次。這一個迴圈同時覆蓋了三種需要重新套用的情況：
  //   - 頁面初始化時 immersionActive 是非同步從 storage.session 讀回來的
  //   - 使用者按下沉浸模式按鈕
  //   - SPA 換片後播放器 DOM 被換掉，字幕條要重新掛上去
  // 狀態沒變時 applyCaptionOverlayMode 會直接返回，不會每秒動 DOM。
  setInterval(() => {
    applyCaptionOverlayMode();
    renderCaptionBar();
  }, 1000);
}

loadMarkedWords(refreshMarkedHighlight);
initPlayerSettings();
initImmersionTimer();
initSentenceNavigation();
initCaptionOverlay();
