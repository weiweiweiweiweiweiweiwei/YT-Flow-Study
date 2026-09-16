// 這支負責在背景處理翻譯查詢，改用 Google 翻譯，免金鑰、免存個人學習紀錄。

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "translate") {
    translateText(msg.text).then(sendResponse);
    return true; // 保持通道開啟，等待非同步回覆
  }
  if (msg.type === "speak") {
    speakWord(msg.text).then(sendResponse);
    return true;
  }
});

// ---------- 基礎翻譯：Google 翻譯的單字／片語查詢，秒回、免金鑰 ----------
async function translateText(text) {
  const cacheKey = "tr:" + text.toLowerCase();

  try {
    const cached = await chrome.storage.local.get(cacheKey);
    if (cached[cacheKey]) {
      return { original: text, translated: cached[cacheKey] };
    }
  } catch (e) {
    // 快取讀取失敗就當作沒快取，繼續往下即時查詢
  }

  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-TW&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    const data = await res.json();
    const translated = (data[0] || []).map((chunk) => chunk[0]).join("");

    if (!translated) {
      return { original: text, error: "查無翻譯結果" };
    }

    try {
      await chrome.storage.local.set({ [cacheKey]: translated }); // 只快取翻譯結果本身，不記錄查過哪些字
    } catch (e) {}

    return { original: text, translated };
  } catch (err) {
    console.error("翻譯失敗：", err);
    return { original: text, error: "翻譯失敗，請檢查網路連線" };
  }
}

// ---------- 發音：直接使用 Google 翻譯的朗讀語音 ----------
// 在背景這裡發出請求（而不是在網頁內容腳本裡），可以避開 YouTube 網頁本身的安全性設定（CSP）
// 對外部音檔的限制；抓回來的音檔轉成 data URL 傳回去，content.js 收到後直接播放。
async function speakWord(text) {
  try {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=en&client=tw-ob`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("TTS 請求失敗：" + res.status);
    const buf = await res.arrayBuffer();
    const base64 = arrayBufferToBase64(buf);
    return { audioDataUrl: `data:audio/mpeg;base64,${base64}` };
  } catch (err) {
    console.error("發音取得失敗：", err);
    return { error: "發音取得失敗" };
  }
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
