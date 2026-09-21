// ============================================================================
// 單字釋義查詢（可抽換）
// ============================================================================
//
// 詞彙庫的單字詳細頁需要「多個詞性 × 中文意思 × 英文例句 × 例句中譯」。
// 這支檔案就是唯一負責產生那份資料的地方。
//
// 目前的實作只用 Google 翻譯的公開端點，免金鑰、免額外權限：
//   dt=bd  →  依詞性分組的中文意思
//   dt=md  →  依詞性分組的英文釋義與例句（Oxford 來源，品質意外地好）
//   dt=t   →  單字本身的中文翻譯
// 例句的中譯則是再對每一句各打一次翻譯。
//
// 【為什麼寫成獨立模組】
// 這個免費方案的極限很明顯：中文釋義是機器直譯，讀起來不如人工潤飾的自然。
// 之後如果要換成 LLM 產生更好的釋義，只要改寫 fetchFromNetwork() 一個函式，
// 呼叫端（詞彙庫頁面）跟快取邏輯完全不用動——就跟 SRS 排程器一樣的設計。
//
// 音標刻意沒有做：免費的 dictionaryapi.dev 實測不穩（blown 回 522），
// 而且資料品質差（run 的第一條釋義是 "To run."），不值得為它加一個外部依賴。
// ============================================================================

import { STORES, getById, put } from "../storage/db.js";
import { normalizeTerm } from "../models.js";

const TRANSLATE_BASE = "https://translate.googleapis.com/translate_a/single";

// 一個單字最多顯示幾個詞性、每個詞性最多幾條例句。
// 設上限不只是為了版面，也是為了控制翻譯請求數（每條例句都要再打一次）。
const MAX_POS_GROUPS = 4;
const MAX_EXAMPLES_PER_POS = 2;

// Google 在 tl=zh-TW 時回傳的是中文詞性名稱，轉成卡片上的短標籤
const POS_BADGES = {
  動詞: "V.",
  名詞: "N.",
  形容詞: "ADJ.",
  副詞: "ADV.",
  介係詞: "PREP.",
  介詞: "PREP.",
  連接詞: "CONJ.",
  代名詞: "PRON.",
  代詞: "PRON.",
  感嘆詞: "INT.",
  冠詞: "ART.",
  縮寫: "ABBR.",
};

function posBadge(pos) {
  return POS_BADGES[pos] || (pos ? pos.slice(0, 4) : "");
}

async function translateText(text, target = "zh-TW", source = "en") {
  if (!text) return "";
  const url = `${TRANSLATE_BASE}?client=gtx&sl=${source}&tl=${target}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("翻譯請求失敗：" + res.status);
  const data = await res.json();
  return (data[0] || []).map((chunk) => chunk[0]).join("");
}

/**
 * 從 Google 的回傳陣列裡找出「依詞性分組」的那兩段。
 *
 * 刻意不寫死索引：回傳陣列的長度與各段位置會隨著送出的 dt 參數組合改變，
 * 寫死索引在 Google 調整參數時會無聲地抓到錯的東西。改用形狀比對比較耐用。
 */
function findSections(data) {
  let meanings = null; // dt=bd： [詞性, [中文意思...], [[意思,[同義字]]], 單字, 分數]
  let definitions = null; // dt=md： [詞性, [[英文釋義, id, 例句?]...], 單字, 分數]

  for (const section of data) {
    if (!Array.isArray(section) || !section.length) continue;
    const first = section[0];
    if (!Array.isArray(first) || typeof first[0] !== "string" || !Array.isArray(first[1])) continue;

    const inner = first[1][0];
    if (Array.isArray(inner) && typeof inner[0] === "string") {
      // 內層還是陣列 → 是 md（釋義＋例句）
      if (!definitions) definitions = section;
    } else if (typeof inner === "string") {
      // 內層是字串 → 是 bd（中文意思清單）
      if (!meanings) meanings = section;
    }
  }
  return { meanings, definitions };
}

async function fetchFromNetwork(term) {
  // dt=ex 看起來像是「只拿例句」的參數，實際上它還會讓 dt=md 那一段
  // 多吐出第三個元素（例句本身）。少了它，釋義就只有定義沒有例句——
  // 實測過：沒有 dt=ex 時 md 的每一筆只有 [定義, id] 兩個元素。
  const url =
    `${TRANSLATE_BASE}?client=gtx&sl=en&tl=zh-TW&dt=t&dt=bd&dt=md&dt=ex&q=${encodeURIComponent(term)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("查詢失敗：" + res.status);
  const data = await res.json();

  const translation = (data[0] || [])
    .map((chunk) => (Array.isArray(chunk) ? chunk[0] : ""))
    .filter(Boolean)
    .join("");

  const { meanings, definitions } = findSections(data);

  // 以詞性為 key 把兩邊合併起來
  const byPos = new Map();
  const ensure = (pos) => {
    if (!byPos.has(pos)) byPos.set(pos, { pos, badge: posBadge(pos), meanings: [], examples: [] });
    return byPos.get(pos);
  };

  for (const group of meanings || []) {
    const pos = group[0];
    const list = Array.isArray(group[1]) ? group[1] : [];
    if (!pos || !list.length) continue;
    ensure(pos).meanings = list.slice(0, 4);
  }

  for (const group of definitions || []) {
    const pos = group[0];
    const list = Array.isArray(group[1]) ? group[1] : [];
    if (!pos || !list.length) continue;
    const entry = ensure(pos);
    for (const item of list) {
      if (entry.examples.length >= MAX_EXAMPLES_PER_POS) break;
      const definition = item[0];
      const example = item[2];
      if (!definition) continue;
      entry.examples.push({ definition, example: example || "" });
    }
  }

  const entries = Array.from(byPos.values())
    .filter((e) => e.meanings.length || e.examples.length)
    .slice(0, MAX_POS_GROUPS);

  // 把需要中譯的句子一次收集起來平行送出。
  // 逐條 await 的話，4 個詞性 × 2 句就要等 8 個往返，開一次詳細頁會慢得很明顯。
  const pending = [];
  for (const entry of entries) {
    for (const ex of entry.examples) {
      if (ex.example) pending.push({ ex, field: "exampleZh", text: ex.example });
      if (!entry.meanings.length) pending.push({ ex, field: "definitionZh", text: ex.definition });
    }
  }

  const results = await Promise.allSettled(pending.map((p) => translateText(p.text)));
  results.forEach((r, i) => {
    if (r.status === "fulfilled") pending[i].ex[pending[i].field] = r.value;
  });

  return {
    term,
    translation,
    entries,
    fetchedAt: new Date().toISOString(),
    source: "google-translate",
  };
}

/**
 * 查一個單字的完整釋義。查過的會存進 IndexedDB，之後都直接讀快取。
 *
 * 只能在擴充功能的 origin（background / 擴充功能頁面）呼叫：
 * content script 碰不到我們的 IndexedDB，也會被 CORS 擋住。
 */
export async function lookupWord(rawTerm) {
  const term = normalizeTerm(rawTerm);
  if (!term) return null;

  try {
    const cached = await getById(STORES.DICTIONARY, term);
    if (cached) return cached;
  } catch (e) {
    // 快取讀不到就當作沒查過，繼續往下走
  }

  const result = await fetchFromNetwork(term);

  try {
    await put(STORES.DICTIONARY, result);
  } catch (e) {
    // 存不進去不影響這次的顯示
  }
  return result;
}

export { posBadge };
