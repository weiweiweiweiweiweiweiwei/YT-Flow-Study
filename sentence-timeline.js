// ============================================================================
// 句子時間軸引擎：把「字幕片段（cue）」重組成「完整句子（sentence）」
// ============================================================================
//
// 這支檔案刻意寫成「純函式、不碰 DOM、不碰 chrome API」，原因有三個：
//   1. 斷句規則是整個 a/s/d 體驗的核心，之後一定會反覆調整。抽成獨立檔案後，
//      改斷句邏輯不用去動 content.js 裡的鍵盤／UI 程式碼。
//   2. 可以直接用 Node 跑測試（檔案底部有 module.exports），不用每次都開瀏覽器
//      載入擴充功能才能驗證斷句對不對。
//   3. 完全本機、完全決定性（deterministic）——同樣的輸入永遠得到同樣的輸出，
//      不呼叫任何 AI API。之後要加 AI 輔助斷句，可以包在這層外面當可選加強。
//
// 為什麼不能「一個 cue = 一句」？
//   YouTube 的 cue 是「畫面上一次顯示多少字」，跟語意上的句子沒有關係：
//     cue 1: "Today we're going to"
//     cue 2: "talk about something interesting."
//   這是一句，不是兩句。反過來，一個 cue 裡也可能塞了「上一句的結尾 + 下一句的開頭」。
//
// 所以這裡的作法是「先打散成帶時間的詞（token），再重新組成句子」：
//   cues → 正規化 → 詞流（每個詞都有自己的開始/結束時間）→ 依語言規則切句
//   這樣「句中被切開的 cue」和「一個 cue 裡有兩句」兩種狀況可以用同一套邏輯處理，
//   而且句子的 start/end 會落在「詞」的邊界上，比落在 cue 邊界上精準很多。
//
// 時間精度的來源：
//   YouTube 自動產生字幕（ASR）的 json3 裡，每個字都附有 tOffsetMs（字級時間戳）。
//   有這個就直接用，沒有的話（人工字幕通常只有整個 cue 的時間）就在 cue 的時間範圍內
//   依字元數比例內插，當作近似值。
// ============================================================================

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api; // Node：給測試用
  } else {
    root.FlowStudySentences = api; // 瀏覽器：content script 之間共用同一個 isolated world 全域
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ---------- 可調參數：斷句的鬆緊都集中在這裡，方便日後微調 ----------
  //
  // 下面幾個 PAUSE_* 指的是「殘餘停頓」，不是單純兩個詞的時間差：
  // 講完一個詞本來就要花時間，長的詞花得更久。所以真正代表「說話者停頓」的，
  // 是「兩個詞開始時間的間隔」減掉「講完前一個詞大概需要多久」之後剩下的部分。
  //
  // 門檻是拿真實的 YouTube 自動字幕（2280 個詞的演講）量出來的分布來定的：
  //   兩詞間隔中位數 0.24 秒；殘餘停頓 p90 = 0.56、p95 = 0.73、p99 = 1.20 秒。
  // 取 0.55（約 p90）可以抓到絕大多數真正的句界，而少數「停頓很長但其實話沒講完」
  // 的情況（例如停在 the / my / your 後面）則交給接續詞清單擋下來。
  const TUNING = {
    PAUSE_STRONG: 0.55, // 「沒有標點」模式下，殘餘停頓超過這個秒數就算一句結束
    PAUSE_SOFT: 0.3, // 較短的停頓，需要搭配「下一個詞是大寫」等其他線索才算數
    PAUSE_LONG_SILENCE: 1.5, // 「有標點」模式下，長到這種程度的沉默才允許無標點斷句
    MIN_WORDS: 3, // 一句至少要幾個詞，避免把 "thank" 這種單字切成一句
    SOFT_WORDS: 10, // 搭配 PAUSE_SOFT 使用的長度門檻
    HARD_MAX_WORDS: 32, // 保險絲：再怎麼找不到斷點，超過這個長度就強制切開
    SECONDS_PER_CHAR: 0.055, // 估計「講完一個詞要多久」用的語速（實測中位數換算出來的）
    MIN_WORD_SECONDS: 0.1,
    MAX_WORD_SECONDS: 0.9,
    PUNCTUATION_DENSITY_THRESHOLD: 0.02, // 句尾標點佔比低於這個值，就判定這軌字幕「沒有標點」
    MIN_SENTENCE_DURATION: 0.25, // 句子最短長度，避免 end <= start 造成判斷異常
    DEDUPE_TIME_WINDOW: 0.3, // 內容相同且開始時間差距小於這個值，視為重複 cue
  };

  // 句尾標點（含全形）。後面允許跟著引號／括號，例如 ...that."  ...really?)
  const STRONG_END_RE = /[.!?…。！？]["'’”')\]]*$/;

  // 常見縮寫：這些字後面的句點不是句尾，例如 "Mr. Smith" 不能斷成兩句
  const ABBREVIATIONS = new Set([
    "mr", "mrs", "ms", "dr", "prof", "st", "sr", "jr", "vs", "etc", "inc", "ltd", "co",
    "dept", "est", "fig", "no", "vol", "approx", "apt", "univ", "gov", "sen", "rep",
    "gen", "col", "lt", "sgt", "capt", "rev", "hon", "ave", "blvd", "rd", "mt", "ft",
    "al", "ca", "cf", "ed", "eds", "pp", "ph", "jan", "feb", "mar", "apr", "jun",
    "jul", "aug", "sep", "sept", "oct", "nov", "dec", "mon", "tue", "wed", "thu", "fri",
  ]);

  // 接續詞：一句話不可能停在這些字後面。例如 "Yesterday I went to" / "the store."
  // 就是因為 "to" 在這張表裡，才不會被中間那個小停頓切成兩句。
  const CONTINUATION_WORDS = new Set([
    "a", "an", "the", "and", "but", "or", "nor", "so", "yet", "because", "since", "although",
    "though", "while", "whereas", "if", "unless", "until", "when", "whenever", "where",
    "wherever", "that", "which", "who", "whom", "whose", "what", "how", "than", "then",
    "to", "of", "in", "on", "at", "by", "for", "with", "within", "without", "from", "into",
    "onto", "upon", "about", "above", "across", "after", "against", "along", "among",
    "around", "as", "before", "behind", "below", "beneath", "beside", "between", "beyond",
    "during", "except", "inside", "like", "near", "off", "outside", "over", "past",
    "through", "throughout", "toward", "towards", "under", "underneath", "up", "via",
    "is", "are", "was", "were", "am", "be", "been", "being", "will", "would", "shall",
    "should", "can", "could", "may", "might", "must", "do", "does", "did", "have", "has",
    "had", "my", "your", "his", "her", "its", "our", "their", "this", "these", "those",
    "i", "we", "you", "they", "he", "she", "it", "very", "just", "also", "not", "no",
    "more", "most", "some", "any", "all", "every", "each", "both", "such", "quite",
  ]);

  // ---------- 文字正規化 ----------

  const NAMED_ENTITIES = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'",
    "&nbsp;": " ", "&#39;": "'", "&#34;": '"',
  };

  // YouTube 的字幕有時候會「重複編碼」，例如 &amp;#39; 其實是一個單引號。
  // 所以這裡跑兩輪解碼，而不是只解一次。
  function decodeEntities(str) {
    let out = String(str);
    for (let pass = 0; pass < 2; pass++) {
      if (out.indexOf("&") === -1) break;
      out = out
        .replace(/&[a-zA-Z]+;|&#\d+;|&#x[0-9a-fA-F]+;/g, (m) => {
          if (NAMED_ENTITIES[m] !== undefined) return NAMED_ENTITIES[m];
          if (m.charAt(1) === "#") {
            const isHex = m.charAt(2) === "x" || m.charAt(2) === "X";
            const code = parseInt(isHex ? m.slice(3, -1) : m.slice(2, -1), isHex ? 16 : 10);
            if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
              try { return String.fromCodePoint(code); } catch (e) { return m; }
            }
          }
          return m;
        });
    }
    return out;
  }

  // 注意：這裡「不」做 trim。字幕片段（seg）的前後空白是詞與詞之間的分隔資訊，
  // 提前 trim 掉的話，"We're" + " no" 會黏成 "We'reno"。
  function cleanSegmentText(str) {
    return decodeEntities(String(str == null ? "" : str))
      .replace(/<[^>]*>/g, "") // 去掉 <b> <i> 這類格式標籤，以及 srv3 的時間標記
      .replace(/\s+/g, " "); // 換行、Tab、連續空白一律收斂成單一空格
  }

  function toFiniteNumber(value) {
    const n = typeof value === "number" ? value : parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }

  // ---------- 第一步：把原始 cue 正規化 ----------
  //
  // 輸入可以是 { text, start, end } 或帶字級時間的 { text, start, end, words: [{text, start}] }。
  // 這一步負責處理所有「髒資料」：空白 cue、重複 cue、壞掉的時間戳、時間重疊等等。
  function normalizeCues(rawCues) {
    if (!Array.isArray(rawCues)) return [];

    const cleaned = [];
    for (const raw of rawCues) {
      if (!raw) continue;

      const start = toFiniteNumber(raw.start);
      if (start === null || start < 0) continue; // 壞掉的時間戳直接丟掉

      // 有字級時間就保留下來，之後切句才能精準對到「詞」而不是整個 cue
      let segments = null;
      if (Array.isArray(raw.words) && raw.words.length) {
        segments = [];
        for (const w of raw.words) {
          if (!w) continue;
          const text = cleanSegmentText(w.text);
          if (!text) continue;
          const wStart = toFiniteNumber(w.start);
          segments.push({ text, start: wStart === null ? start : Math.max(wStart, 0) });
        }
        if (!segments.length) segments = null;
      }

      const text = (segments ? segments.map((s) => s.text).join("") : cleanSegmentText(raw.text)).trim();
      if (!text) continue; // 空 cue（ASR 的純換行 event 就會落在這裡）

      let end = toFiniteNumber(raw.end);
      if (end === null || end <= start) end = start + 2; // 缺少或不合理的 end 先給個暫時值，下面會用下一句夾住

      cleaned.push({ text, start, end, segments });
    }

    if (!cleaned.length) return [];

    // 依開始時間排序。YouTube 回傳通常已排序，但即時記錄的備援資料不保證，
    // 而「排序」是後面二分搜尋能成立的前提。
    cleaned.sort((a, b) => a.start - b.start || a.end - b.end);

    // 去重：使用者倒轉重播、或 ASR 的滑動視窗，都可能產生內容一樣的相鄰 cue
    const deduped = [];
    for (const cue of cleaned) {
      const prev = deduped[deduped.length - 1];
      if (prev && prev.text === cue.text && Math.abs(prev.start - cue.start) < TUNING.DEDUPE_TIME_WINDOW) {
        prev.end = Math.max(prev.end, cue.end); // 合併成同一筆，取比較晚的結束時間
        continue;
      }
      deduped.push(cue);
    }

    // 修正時間重疊。這一步對 YouTube 自動產生字幕特別重要：
    // ASR 的 cue 是「滑動視窗」，dDurationMs 常常長到跨過後面好幾個 cue
    // （實測：某個 cue 從 18.8s 持續 7.16s，但下一個 cue 18.8+3 = 21.8s 就開始了）。
    // 不夾住的話，「目前這句」會同時符合好幾個 cue，導致 a/s/d 跳來跳去。
    for (let i = 0; i < deduped.length - 1; i++) {
      const next = deduped[i + 1];
      if (deduped[i].end > next.start) {
        deduped[i].end = Math.max(next.start, deduped[i].start + 0.05);
      }
    }

    return deduped;
  }

  // ---------- 第二步：把 cue 打散成「帶時間的詞」 ----------
  //
  // 作法是先算出「這個 cue 的每一個字元分別對應到什麼時間」，再用空白切詞，
  // 每個詞的開始時間就取它第一個字元的時間。
  // 這樣不管字級時間是真的（ASR 的 tOffsetMs）還是內插出來的，處理方式都一樣。
  function buildTokens(cues) {
    const tokens = [];

    for (let cueIndex = 0; cueIndex < cues.length; cueIndex++) {
      const cue = cues[cueIndex];
      const duration = Math.max(cue.end - cue.start, 0.01);

      let text = "";
      let charTimes = [];

      if (cue.segments) {
        // 有字級時間：每個 seg 的時間套用到它自己的每一個字元
        for (const seg of cue.segments) {
          const segStart = Math.min(Math.max(seg.start, cue.start), cue.end);
          for (let i = 0; i < seg.text.length; i++) charTimes.push(segStart);
          text += seg.text;
        }
      } else {
        text = cue.text;
      }

      if (!charTimes.length) {
        // 沒有字級時間：在 cue 的時間範圍內依字元位置線性內插
        const len = Math.max(text.length, 1);
        charTimes = new Array(text.length);
        for (let i = 0; i < text.length; i++) {
          charTimes[i] = cue.start + (duration * i) / len;
        }
      }

      // 用空白切詞
      let i = 0;
      while (i < text.length) {
        while (i < text.length && /\s/.test(text[i])) i++;
        if (i >= text.length) break;
        const wordStart = i;
        while (i < text.length && !/\s/.test(text[i])) i++;
        const word = text.slice(wordStart, i);
        if (!word) continue;

        const t = charTimes[wordStart];
        tokens.push({
          text: word,
          start: Number.isFinite(t) ? t : cue.start,
          end: cue.end, // 暫時值，下面統一用「下一個詞的開始時間」修正
          cueIndex,
          cueEnd: cue.end,
          timed: !!cue.segments, // 這個詞的開始時間是真的（字級時間戳），還是內插猜的？
        });
      }
    }

    // 每個詞的結束時間 = 下一個詞的開始時間，但不能超過自己所屬 cue 的結束時間。
    // 這是給「句子的起訖時間」用的。
    //
    // 但要注意：句子的 end 這樣算會讓「同一個 cue 內相鄰兩個詞」的間隔恆為 0，
    // 停頓資訊就消失了。而自動產生字幕整軌可能一個標點都沒有，斷句完全要靠停頓，
    // 所以另外算一個 pauseAfter 保留這個資訊——它才是後面判斷句界的依據。
    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i];
      const next = tokens[i + 1];
      const limit = next ? Math.min(next.start, tk.cueEnd) : tk.cueEnd;
      tk.end = Math.max(limit, tk.start + 0.02);
      if (tk.start > tk.end) tk.end = tk.start + 0.02; // 時間戳錯亂時的保險

      if (!next) {
        tk.pauseAfter = 0;
      } else if (tk.timed) {
        // 有真實的字級時間戳：可以直接算出這個詞之後到底停了多久
        tk.pauseAfter = Math.max(next.start - tk.start - expectedSpeakingSeconds(tk.text), 0);
      } else if (next.cueIndex === tk.cueIndex) {
        // 沒有字級時間戳時，同一個 cue 內的時間是我們自己按字元數內插出來的，
        // 算出來的「停頓」純粹是內插誤差，不是真的停頓——必須當成 0。
        // 不這樣做的話，語速較慢的字幕會每隔幾個字就被誤判成句界。
        tk.pauseAfter = 0;
      } else {
        // cue 與 cue 之間的空檔是真實可觀測的，這個可以信
        tk.pauseAfter = Math.max(next.start - tk.cueEnd, 0);
      }
    }

    return tokens;
  }

  // 講完這個詞大概需要多久。用字元數乘上語速估算，並夾在合理範圍內，
  // 避免超長的詞（網址、連字號組合）或單字母的詞算出離譜的值。
  function expectedSpeakingSeconds(word) {
    const raw = word.length * TUNING.SECONDS_PER_CHAR;
    return Math.min(Math.max(raw, TUNING.MIN_WORD_SECONDS), TUNING.MAX_WORD_SECONDS);
  }

  // ---------- 斷句判斷用的小工具 ----------

  function stripEdgePunctuation(word) {
    return word.replace(/^["'‘“(\[]+/, "").replace(/["'’”)\]]+$/, "");
  }

  function isAbbreviation(word) {
    const bare = stripEdgePunctuation(word);
    if (!/\.$/.test(bare)) return false;

    const stem = bare.slice(0, -1).toLowerCase();
    if (ABBREVIATIONS.has(stem)) return true;
    // U.S. / a.m. / e.g. 這類「字母中間夾句點」的縮寫
    if (/^[a-z](\.[a-z])+$/i.test(stem)) return true;
    return false;
  }

  // 「J.」這種單一大寫字母加句點是姓名縮寫（J. K. Rowling），不是句尾。
  // 但要特別把 "I." 排除掉——那是英文的第一人稱代名詞，而且
  // 「...and so do I.」這種結尾非常常見，誤判會讓整軌字幕被當成「沒有標點」。
  function isSingleInitial(word) {
    const bare = stripEdgePunctuation(word);
    if (bare === "I.") return false;
    return /^[A-Z]\.$/.test(bare);
  }

  function startsUppercase(word) {
    const bare = stripEdgePunctuation(word);
    return /^[A-ZÀ-Þ]/.test(bare);
  }

  function startsLowercase(word) {
    const bare = stripEdgePunctuation(word);
    return /^[a-zß-ÿ]/.test(bare);
  }

  function endsWithContinuationWord(word) {
    const bare = stripEdgePunctuation(word).replace(/[.,;:!?…]+$/, "").toLowerCase();
    return CONTINUATION_WORDS.has(bare);
  }

  // [Music] [Applause] ♪♪ 這類非語音標記：本身自成一句，而且是天然的句子分界
  function isSoundCue(word) {
    return /^[\[(♪♫]/.test(word) || /^[♪♫]+$/.test(word);
  }

  // >> 或 » 是字幕慣用的「換人說話」標記
  function isSpeakerMarker(word) {
    return /^(>>|»)/.test(word);
  }

  // 這一軌字幕到底有沒有標點？自動產生字幕常常整軌完全沒有句點，
  // 這種情況必須改用「停頓 + 詞性」來斷句，不能死等句號。
  function detectPunctuated(tokens) {
    if (!tokens.length) return false;
    let strongEnds = 0;
    for (const tk of tokens) {
      if (STRONG_END_RE.test(tk.text) && !isAbbreviation(tk.text) && !isSingleInitial(tk.text)) {
        strongEnds++;
      }
    }
    return strongEnds / tokens.length >= TUNING.PUNCTUATION_DENSITY_THRESHOLD;
  }

  // 在「這個詞之前」就要斷開嗎？（換人說話、音效標記）
  // words 是目前這一句已經累積的詞，需要往回看才能判斷音效標記是不是插在句子中間。
  function shouldBreakBefore(token, words) {
    if (!words.length) return false;
    const prevToken = words[words.length - 1];
    if (isSpeakerMarker(token.text)) return true;

    const crossesSoundBoundary = isSoundCue(token.text) !== isSoundCue(prevToken.text);
    if (!crossesSoundBoundary) return false;

    // 音效標記（[Music]、[Applause]）通常自成一句，但它也可能「插在一句話中間」，
    // 例如實測到的「...universities in the [Applause] world truth be told...」。
    // 這種時候硬切會產生一句以 the 結尾的破碎殘句，反而更難用。
    // 判斷方式：看音效標記前面接的是不是接續詞，是的話代表這句話還沒講完，兩邊都不切。
    if (isSoundCue(token.text)) {
      return !endsWithContinuationWord(prevToken.text);
    }

    // 正在離開音效標記：往回跳過連續的音效標記，看它們插進來之前的那個詞
    let i = words.length - 1;
    while (i >= 0 && isSoundCue(words[i].text)) i--;
    if (i >= 0 && endsWithContinuationWord(words[i].text)) return false;
    return true;
  }

  // 這個詞是不是一句的結尾？
  function shouldBreakAfter(token, nextToken, wordCount, punctuated) {
    if (!nextToken) return true; // 整段字幕的最後一個詞，一定是結尾

    // 「殘餘停頓」：兩個詞開始時間的間隔，扣掉講完前一個詞需要的時間。
    // 用這個而不是單純的時間差，是因為長的詞本來就講得久，不代表有停頓。
    const pause = token.pauseAfter || 0;
    const hasStrongEnd =
      STRONG_END_RE.test(token.text) && !isAbbreviation(token.text) && !isSingleInitial(token.text);

    if (hasStrongEnd) {
      // 防守：漏網的縮寫或小數點。句點結尾、下一個詞卻是小寫、又幾乎沒有停頓、
      // 而且目前這句短得不像一句話 —— 這種組合比較可能是縮寫，不是真的句尾。
      const endsWithPeriod = /\.["'’”')\]]*$/.test(token.text);
      if (endsWithPeriod && startsLowercase(nextToken.text) && pause < 0.4 && wordCount < TUNING.MIN_WORDS) {
        return false;
      }
      return true;
    }

    // 逗號、分號、冒號結尾：句子還沒完
    if (/[,;:，；：、]$/.test(token.text)) return false;

    if (!punctuated) {
      // 「沒有標點」模式：只能靠停頓長度和詞性判斷
      //
      // 這裡刻意「不」單用停頓當唯一依據。實測真實演講字幕時，殘餘停頓最長的那幾個
      // 位置裡，誤判的全都停在接續詞上（the / my / your / be），例如
      // 「that will make all the ‖ difference」——停頓很長，但話根本沒講完。
      // 接續詞清單就是專門擋這一類的。
      if (endsWithContinuationWord(token.text)) {
        return wordCount >= TUNING.HARD_MAX_WORDS; // 除非已經長到誇張，否則一律往下接
      }
      if (pause >= TUNING.PAUSE_STRONG && wordCount >= TUNING.MIN_WORDS) return true;
      if (pause >= TUNING.PAUSE_SOFT && wordCount >= TUNING.SOFT_WORDS && startsUppercase(nextToken.text)) {
        return true;
      }
      return wordCount >= TUNING.HARD_MAX_WORDS;
    }

    // 「有標點」模式：原則上只認標點。但如果出現很長的沉默，
    // 而且下一句明顯是新的開始（大寫開頭、目前這句也沒停在接續詞上），就允許斷開
    // ——常見於字幕漏打句號，或演講中間的長停頓。
    if (
      pause >= TUNING.PAUSE_LONG_SILENCE &&
      startsUppercase(nextToken.text) &&
      !endsWithContinuationWord(token.text) &&
      wordCount >= TUNING.MIN_WORDS
    ) {
      return true;
    }

    return wordCount >= TUNING.HARD_MAX_WORDS;
  }

  // ---------- 第三步：組成句子時間軸 ----------
  //
  // buildSentenceTimeline(cues) -> SentenceSegment[]
  //   SentenceSegment = { index, text, start, end, cueStartIndex, cueEndIndex }
  //
  // 整個流程完全在本機執行、完全決定性，不呼叫任何外部 API。
  function buildSentenceTimeline(rawCues) {
    const cues = normalizeCues(rawCues);
    if (!cues.length) return [];

    const tokens = buildTokens(cues);
    if (!tokens.length) return [];

    const punctuated = detectPunctuated(tokens);
    const sentences = [];
    let current = null;

    const flush = () => {
      if (!current || !current.words.length) return;
      const first = current.words[0];
      const last = current.words[current.words.length - 1];
      sentences.push({
        index: sentences.length,
        text: current.words.map((w) => w.text).join(" "),
        start: first.start,
        end: Math.max(last.end, first.start + TUNING.MIN_SENTENCE_DURATION),
        cueStartIndex: first.cueIndex,
        cueEndIndex: last.cueIndex,
      });
      current = null;
    };

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const next = tokens[i + 1];

      if (current && current.words.length && shouldBreakBefore(token, current.words)) {
        flush();
      }
      if (!current) current = { words: [] };
      current.words.push(token);

      if (shouldBreakAfter(token, next, current.words.length, punctuated)) flush();
    }
    flush();

    // 最後再把句子之間的時間夾乾淨：句子的結束時間不可以跨進下一句。
    // 這是 getCurrentSentenceIndex 能穩定判斷「現在在第幾句」的前提。
    for (let i = 0; i < sentences.length - 1; i++) {
      const s = sentences[i];
      const nextStart = sentences[i + 1].start;
      if (s.end > nextStart) s.end = Math.max(nextStart, s.start + 0.05);
    }

    return sentences;
  }

  // ---------- 第四步：目前播到第幾句 ----------
  //
  // getCurrentSentenceIndex(currentTime, sentences) -> number
  //
  // 用二分搜尋，因為一部 1~3 小時的影片可能有好幾千句，而這個函式會被
  // timeupdate 事件頻繁呼叫，不能用線性掃描。
  //
  // 定義：找出「開始時間 <= 現在時間」裡最晚的那一句。
  // 為什麼不是嚴格的 start <= t < end？因為句子與句子之間一定有空檔（換氣、停頓）。
  // 如果空檔就回傳「沒有句子」，畫面上的高亮會在每句之間閃一下，
  // 而且使用者在空檔按 d 會不知道該從哪一句算起。改成「停在剛才那一句」，
  // 索引就是單調穩定的，不會來回跳動。
  function getCurrentSentenceIndex(currentTime, sentences) {
    if (!Array.isArray(sentences) || !sentences.length) return -1;

    const t = toFiniteNumber(currentTime);
    if (t === null) return -1;

    const probe = t + 0.12; // 容忍浮點誤差與 seek 後的些微落差
    if (probe < sentences[0].start) return -1; // 還沒播到第一句（片頭音樂等）

    let lo = 0;
    let hi = sentences.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sentences[mid].start <= probe) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  return {
    TUNING,
    normalizeCues,
    buildTokens,
    buildSentenceTimeline,
    getCurrentSentenceIndex,
    // 匯出內部小工具，方便單元測試逐條驗證斷句規則
    _internals: { decodeEntities, cleanSegmentText, detectPunctuated, isAbbreviation, endsWithContinuationWord },
  };
});
