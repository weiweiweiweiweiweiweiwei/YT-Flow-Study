// ============================================================================
// Supabase 連線設定
// ============================================================================
//
// 這把 publishable key 本來就是設計給前端公開使用的（等同舊版的 anon key），
// 放在擴充功能裡沒有問題：資料安全靠的是資料庫的 Row Level Security——
// 每一列都綁著 user_id，登入的人只讀得到、寫得到自己的那幾列。
//
// Google 登入完成後，Supabase 會把使用者導回 chrome.identity.getRedirectURL()，
// 也就是 https://<擴充功能 ID>.chromiumapp.org/。這個網址必須加進 Supabase 的
// Redirect URLs 允許清單。擴充功能 ID 是由資料夾路徑算出來的——
// 資料夾改名或搬家，ID 就變了，登入會失敗，要把新的網址再加一次。
// ============================================================================

export const SUPABASE_URL = "https://algdqnztwyrcxuxqnzyp.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_hZfo8Yz1j1-f5AitbN0c4g_bW0cBapR";
