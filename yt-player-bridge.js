// ============================================================================
// YouTube 播放器橋接層（在「頁面世界 / MAIN world」執行，document_start）
// ============================================================================
//
// 為什麼需要這一層？content.js 不能直接做嗎？不行，有兩個硬限制：
//
// 1. Chrome 的 content script 跑在「隔離世界（isolated world）」。
//    隔離世界看得到 DOM，但看不到頁面自己的 JavaScript 掛在 DOM 元素上的屬性。
//    也就是說，在 content.js 裡寫：
//        document.getElementById("movie_player").getPlayerResponse()
//    永遠會失敗——getPlayerResponse 是 YouTube 頁面腳本加上去的方法，
//    隔離世界根本看不到它。只有在 MAIN world 才拿得到。
//
// 2. 更關鍵的一點：YouTube 現在對字幕端點（/api/timedtext）強制要求 `pot` 參數
//    （proof-of-origin token，由 YouTube 自己的 BotGuard 產生）。
//    而 getPlayerResponse() 給的 captionTracks[].baseUrl 裡「沒有」這個參數。
//    實測結果：直接 fetch 那個 baseUrl 會拿到 HTTP 200 但 body 完全是空的。
//    （這常被誤判成「被廣告攔截套件擋掉」，其實不是。）
//
//    唯一可靠的解法是：攔截播放器自己發出的那一次 timedtext 請求，
//    那個 URL 帶著有效的 pot。而要攔得到，就必須在播放器發請求「之前」
//    就掛好 hook——只有 document_start + MAIN world 做得到。
//
//    幸運的是實測發現，URL 的簽章參數 sparams 是
//        ip,ipbits,expire,v,ei,caps,opi,exp,xoaf
//    並「不包含 lang」。所以同一部影片攔到任何一軌的 URL 之後，
//    把 lang / kind 換掉就能拿到別軌的字幕（實測 ja→en、en→asr 都成功）。
//    但 pot 綁在單一影片上，換一部影片就得重新攔一次。
//
// 這一層只做「拿資料」，不碰 UI、不碰鍵盤，結果透過 window.postMessage
// 交給 content.js（隔離世界）去做斷句、快取與鍵盤操作。
// ============================================================================

(function () {
  "use strict";

  if (window.__flowStudyBridgeInstalled) return; // 避免重複注入時掛上兩份 hook
  window.__flowStudyBridgeInstalled = true;

  const CHANNEL_TO_PAGE = "flowstudy-to-page";
  const CHANNEL_TO_CONTENT = "flowstudy-to-content";
  const TIMEDTEXT_PATH = "/api/timedtext";

  // 每部影片攔到的 timedtext URL（帶有效 pot）。key = videoId
  const capturedUrls = new Map();

  function post(payload) {
    try {
      window.postMessage(Object.assign({ channel: CHANNEL_TO_CONTENT }, payload), location.origin);
    } catch (e) {
      /* 序列化失敗就算了，不能讓橋接層的錯誤影響 YouTube 本身 */
    }
  }

  // ---------- 攔截：把播放器自己打出去的 timedtext URL 記下來 ----------

  function noteTimedTextUrl(rawUrl) {
    if (typeof rawUrl !== "string" || rawUrl.indexOf(TIMEDTEXT_PATH) === -1) return;
    let url;
    try {
      url = new URL(rawUrl, location.origin);
    } catch (e) {
      return;
    }
    if (url.pathname.indexOf(TIMEDTEXT_PATH) === -1) return;

    const videoId = url.searchParams.get("v");
    if (!videoId) return;

    // 只留「帶 pot」的那一次。沒有 pot 的請求可能是我們自己發的，記下來沒有意義。
    if (!url.searchParams.has("pot")) return;

    const isNew = !capturedUrls.has(videoId);
    capturedUrls.set(videoId, url.toString());
    if (isNew) {
      // 通知隔離世界：這部影片現在有可用的字幕 URL 了，可以來要資料
      post({ type: "timedtext-captured", videoId });
    }
  }

  // hook fetch。用 apply(this, arguments) 原樣轉發，確保不改變 YouTube 原本的行為。
  try {
    const originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
      window.fetch = function (input, init) {
        try {
          noteTimedTextUrl(typeof input === "string" ? input : input && input.url);
        } catch (e) {}
        return originalFetch.apply(this, arguments);
      };
    }
  } catch (e) {}

  // hook XMLHttpRequest。YouTube 兩種都用過，兩邊都要攔才保險。
  try {
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        noteTimedTextUrl(url);
      } catch (e) {}
      return originalOpen.apply(this, arguments);
    };
  } catch (e) {}

  // ---------- 取得播放器資料 ----------
  //
  // YouTube 改版頻繁，所以這裡把「可能拿得到 playerResponse 的地方」全部試一遍，
  // 而不是死綁單一路徑。任何一條通了就算成功。
  function getPlayer() {
    const candidates = [
      document.getElementById("movie_player"),
      document.querySelector("#movie_player"),
      document.querySelector(".html5-video-player"),
      document.querySelector("ytd-player"),
    ];
    for (const el of candidates) {
      if (el && typeof el.getPlayerResponse === "function") return el;
    }
    // ytd-player 元件要再往內拿一層
    try {
      const ytdPlayer = document.querySelector("ytd-player");
      const inner = ytdPlayer && typeof ytdPlayer.getPlayer === "function" ? ytdPlayer.getPlayer() : null;
      if (inner && typeof inner.getPlayerResponse === "function") return inner;
    } catch (e) {}
    return null;
  }

  function getPlayerResponse() {
    const player = getPlayer();
    if (player) {
      try {
        const resp = player.getPlayerResponse();
        if (resp && typeof resp === "object") return resp;
      } catch (e) {}
    }
    // 播放器還沒準備好時，頁面初始化時塞進來的這份資料通常已經在了
    try {
      if (window.ytInitialPlayerResponse && typeof window.ytInitialPlayerResponse === "object") {
        return window.ytInitialPlayerResponse;
      }
    } catch (e) {}
    return null;
  }

  function getCaptionTracks(resp) {
    try {
      const tracks = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (Array.isArray(tracks) && tracks.length) return tracks;
    } catch (e) {}
    return [];
  }

  function trackLabel(track) {
    try {
      return track.name?.simpleText || track.name?.runs?.[0]?.text || track.languageCode || "";
    } catch (e) {
      return track.languageCode || "";
    }
  }

  // 目前播放器實際選中的是哪一軌？這是「優先使用使用者選的字幕」的依據。
  function getSelectedTrackInfo() {
    const player = getPlayer();
    if (!player || typeof player.getOption !== "function") return null;
    try {
      const t = player.getOption("captions", "track");
      if (t && (t.languageCode || t.vss_id)) {
        return { languageCode: t.languageCode || "", kind: t.kind || "", vssId: t.vss_id || "" };
      }
    } catch (e) {}
    return null;
  }

  // ---------- 字幕軌選擇 ----------
  //
  // 規則（依序）：
  //   1. 使用者目前在播放器上選的那一軌（最符合直覺）
  //   2. 偏好語言的「人工字幕」
  //   3. 偏好語言的「自動產生字幕」
  //   4. 第一軌
  // 刻意不選「翻譯字幕（tlang）」——使用者是來學原文的，自動塞翻譯反而礙事。
  function chooseTrack(tracks, prefs) {
    if (!tracks.length) return null;
    const preferredLangs = (prefs && prefs.preferredLangs) || ["en"];

    const selected = getSelectedTrackInfo();
    if (selected) {
      const byVss = tracks.find((t) => selected.vssId && t.vssId === selected.vssId);
      if (byVss) return byVss;
      const byLangKind = tracks.find(
        (t) => t.languageCode === selected.languageCode && (t.kind || "") === (selected.kind || "")
      );
      if (byLangKind) return byLangKind;
      const byLang = tracks.find((t) => t.languageCode === selected.languageCode);
      if (byLang) return byLang;
    }

    for (const lang of preferredLangs) {
      const manual = tracks.find((t) => (t.languageCode || "").startsWith(lang) && !t.kind);
      if (manual) return manual;
    }
    for (const lang of preferredLangs) {
      const asr = tracks.find((t) => (t.languageCode || "").startsWith(lang));
      if (asr) return asr;
    }
    return tracks.find((t) => !t.kind) || tracks[0];
  }

  // ---------- 組出可用的字幕網址 ----------
  //
  // 先用「攔到的 URL」當模板（它帶著有效的 pot），把 lang / kind 換成我們要的那一軌。
  // 攔不到才退回裸 baseUrl——那條路現在多半會拿到空回應，但 YouTube 政策哪天放寬、
  // 或某些影片不強制 pot 時，它還是能用，所以保留。
  function buildCandidateUrls(videoId, track) {
    const urls = [];
    const captured = capturedUrls.get(videoId);

    if (captured) {
      try {
        const u = new URL(captured);
        u.searchParams.delete("tlang"); // 絕對不要翻譯軌
        if (track) {
          u.searchParams.set("lang", track.languageCode || "en");
          if (track.kind) u.searchParams.set("kind", track.kind);
          else u.searchParams.delete("kind");
        }
        u.searchParams.set("fmt", "json3");
        urls.push(u.toString());
      } catch (e) {}

      // 換 lang 失敗（例如那一軌其實不存在）時，至少把攔到的原樣請求試一次
      try {
        const asIs = new URL(captured);
        asIs.searchParams.delete("tlang");
        asIs.searchParams.set("fmt", "json3");
        urls.push(asIs.toString());
      } catch (e) {}
    }

    if (track && track.baseUrl) {
      try {
        const u = new URL(track.baseUrl, location.origin);
        u.searchParams.delete("tlang");
        u.searchParams.set("fmt", "json3");
        urls.push(u.toString());
        // 少數情況 json3 不給，改用預設的 XML 格式再試一次
        const xml = new URL(track.baseUrl, location.origin);
        xml.searchParams.delete("tlang");
        xml.searchParams.delete("fmt");
        urls.push(xml.toString());
      } catch (e) {}
    }

    return urls.filter((u, i) => urls.indexOf(u) === i); // 去重
  }

  // ---------- 解析字幕格式 ----------

  // json3：YouTube 目前的主力格式。自動產生字幕還會附「字級時間戳」（tOffsetMs），
  // 有這個就能把句子的起訖時間對到「詞」而不是整個 cue，精度高很多。
  function parseJson3(raw) {
    const data = JSON.parse(raw);
    const events = Array.isArray(data.events) ? data.events : [];
    const cues = [];

    for (const ev of events) {
      if (!ev || !Array.isArray(ev.segs) || !ev.segs.length) continue;

      // ASR 的滑動視窗會插入大量「只有換行、aAppend=1」的假事件
      // （實測某部影片 104 個事件裡有 51 個是這種），必須丟掉，
      // 否則會變成一堆空白斷點，a/s/d 就會跳到莫名其妙的位置。
      if (ev.aAppend) continue;

      const start = Number(ev.tStartMs);
      if (!Number.isFinite(start)) continue;
      const startSec = start / 1000;

      const durMs = Number(ev.dDurationMs);
      const endSec = Number.isFinite(durMs) && durMs > 0 ? startSec + durMs / 1000 : startSec + 2;

      let text = "";
      const words = [];
      let hasWordTiming = false;
      for (const seg of ev.segs) {
        if (!seg || typeof seg.utf8 !== "string") continue;
        text += seg.utf8;
        const off = Number(seg.tOffsetMs);
        if (Number.isFinite(off)) hasWordTiming = true;
        words.push({ text: seg.utf8, start: startSec + (Number.isFinite(off) ? off / 1000 : 0) });
      }

      if (!text.trim()) continue;
      // 只有真的帶 tOffsetMs（自動產生字幕）才附上字級時間。
      // 人工字幕整個 cue 只有一個 seg、沒有任何 tOffsetMs——以前照樣附上 words，
      // 等於宣稱「這個 cue 裡每個字都在 cue 開始的那一刻說出來」。
      // 一個 cue 常常是「上一句的結尾 + 下一句的開頭」，兩句於是拿到同一個開始時間，
      // 播放時永遠顯示後面那句：前一句從來不會出現，字幕也比畫面提早好幾秒。
      // 不附 words，斷句引擎就會在 cue 的時間範圍內依字元位置估算，誤差約 0.2 秒。
      cues.push(hasWordTiming ? { text, start: startSec, end: endSec, words } : { text, start: startSec, end: endSec });
    }

    return cues;
  }

  // XML（srv1 / srv3 / 無 fmt 參數時的預設格式）：備援用
  function parseTimedTextXml(raw) {
    const doc = new DOMParser().parseFromString(raw, "text/xml");
    if (doc.querySelector("parsererror")) return [];

    const nodes = Array.from(doc.getElementsByTagName("text"));
    const cues = [];
    for (const node of nodes) {
      const start = parseFloat(node.getAttribute("start"));
      if (!Number.isFinite(start)) continue;
      const dur = parseFloat(node.getAttribute("dur"));
      const text = node.textContent || "";
      if (!text.trim()) continue;
      cues.push({ text, start, end: start + (Number.isFinite(dur) && dur > 0 ? dur : 2) });
    }
    return cues;
  }

  function parseCaptionPayload(raw) {
    const trimmed = (raw || "").trim();
    if (!trimmed) return [];
    try {
      if (trimmed.charAt(0) === "{") return parseJson3(trimmed);
    } catch (e) {}
    try {
      if (trimmed.charAt(0) === "<") return parseTimedTextXml(trimmed);
    } catch (e) {}
    return [];
  }

  // ---------- 對外的主要動作：把某部影片的字幕 cue 取回來 ----------

  async function fetchCues(videoId, prefs) {
    const resp = getPlayerResponse();
    if (!resp) return { ok: false, reason: "player-not-ready" };

    const tracks = getCaptionTracks(resp);
    // 播放器資料拿到了，但這部影片真的沒有字幕 —— 這是「確定沒有」，不是「還沒好」，
    // 隔離世界收到這個原因就可以停止重試，直接顯示「無字幕」。
    if (!tracks.length && !capturedUrls.has(videoId)) {
      return { ok: false, reason: "no-caption-track" };
    }

    const track = chooseTrack(tracks, prefs);
    const urls = buildCandidateUrls(videoId, track);
    if (!urls.length) return { ok: false, reason: "no-url" };

    for (const url of urls) {
      let raw;
      try {
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) continue;
        raw = await res.text();
      } catch (e) {
        continue;
      }

      // 這是最常見的失敗樣態：HTTP 200，但 body 是空的（缺 pot）。
      // 不算錯誤，就是還沒攔到有效的 URL，等下次重試。
      if (!raw || !raw.trim()) continue;

      const cues = parseCaptionPayload(raw);
      if (cues.length) {
        return {
          ok: true,
          cues,
          track: track
            ? {
                languageCode: track.languageCode || "",
                kind: track.kind || "",
                vssId: track.vssId || "",
                label: trackLabel(track),
                isAutoGenerated: track.kind === "asr",
              }
            : null,
          trackCount: tracks.length,
        };
      }
    }

    return { ok: false, reason: capturedUrls.has(videoId) ? "empty-response" : "awaiting-timedtext" };
  }

  // ---------- 與 content.js（隔離世界）的通訊 ----------

  window.addEventListener("message", (event) => {
    // 只接受同一個視窗、同源、而且是我們自己的頻道的訊息
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.channel !== CHANNEL_TO_PAGE) return;

    if (msg.type === "request-cues") {
      const requestId = msg.requestId;
      const videoId = msg.videoId;
      fetchCues(videoId, msg.prefs)
        .then((result) => post(Object.assign({ type: "cues-result", requestId, videoId }, result)))
        .catch((err) =>
          post({ type: "cues-result", requestId, videoId, ok: false, reason: "exception: " + String(err) })
        );
    }
  });

  // 橋接層就緒。content.js 收到這個才開始要資料，避免它比我們早跑而錯過第一次請求。
  post({ type: "bridge-ready" });
})();
