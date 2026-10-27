// ============================================================================
// Google 登入與雲端硬碟同步的設定
// ============================================================================
//
// GOOGLE_CLIENT_ID 是 Google Cloud「OAuth 用戶端 ID」（類型：網頁應用程式）。
// 它本來就是公開的值（任何網站的 Google 登入按鈕都看得到），放在擴充功能裡沒有問題；
// 刻意不放「用戶端密碼」——擴充功能的原始碼誰都看得到，密碼放進來就不是密碼了。
//
// 這個用戶端的「已授權的重新導向 URI」必須加入 https://<擴充功能 ID>.chromiumapp.org/
// （設定頁「帳號與雲端同步」卡片裡會顯示這台電腦的確切網址）。
// 擴充功能 ID 是由資料夾路徑算出來的——資料夾改名或搬家，ID 就變了，要把新網址再加一次。
//
// 2026-10 起不再使用 Supabase：資料存在每個人自己的 Google 雲端硬碟（見 drive.js）。
// ============================================================================

export const GOOGLE_CLIENT_ID = "179560802326-eo4tm50cn1hjv62m7336ikiverudnkbt.apps.googleusercontent.com";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/drive.appdata",
  "openid",
  "email",
  "profile",
];
