// ============================================================================
// Google 登入（透過 Supabase Auth）
// ============================================================================
//
// 只在 background service worker 執行。登入狀態集中放在這裡，
// 設定頁、同步引擎都透過背景訊息來問，不會各自持有一份過期的 token。
//
// 流程（OAuth 授權碼 + PKCE）：
//   1. 產生一次性的 code_verifier，把它的 SHA-256 當 code_challenge 送出去
//   2. chrome.identity.launchWebAuthFlow 開一個登入視窗 → Supabase → Google
//   3. 使用者選好帳號，Supabase 把使用者導回 https://<擴充功能ID>.chromiumapp.org/?code=…
//      Chrome 攔下這個網址，把 code 交還給我們（視窗自動關閉）
//   4. 拿 code + code_verifier 換 access_token / refresh_token
// 用 PKCE 而不是直接把 token 放在網址裡回傳：就算 code 在過程中外洩，
// 沒有 code_verifier 也換不到 token。
//
// 刻意不用 supabase-js：它要打包工具才能進 MV3 擴充功能，
// 而我們只需要四個 HTTP 請求（authorize / token / refresh / logout）。
// ============================================================================

import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

const SESSION_KEY = "flowstudyAuthSession";
const REFRESH_MARGIN_SECONDS = 60; // 還剩一分鐘就過期時先換新，免得請求送到一半失效

let refreshing = null; // 同一時間只換一次 token：refresh_token 用過一次就作廢

// ---------- 小工具 ----------

function base64url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomVerifier() {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return base64url(bytes); // 64 個字元，落在 PKCE 規定的 43–128 之間
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function authFetch(path, { method = "GET", body, accessToken } = {}) {
  const headers = { apikey: SUPABASE_PUBLISHABLE_KEY };
  if (body) headers["Content-Type"] = "application/json";
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(`${SUPABASE_URL}/auth/v1${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch (e) {}
  if (!res.ok) {
    const err = new Error((data && (data.error_description || data.msg || data.message)) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toSession(tokenResponse) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token,
    expires_at: tokenResponse.expires_at || nowSec + (tokenResponse.expires_in || 3600),
    user: tokenResponse.user || null,
  };
}

async function loadSession() {
  const data = await chrome.storage.local.get(SESSION_KEY);
  return data[SESSION_KEY] || null;
}

async function saveSession(session) {
  await chrome.storage.local.set({ [SESSION_KEY]: session });
}

async function clearSession() {
  await chrome.storage.local.remove(SESSION_KEY);
}

// 給畫面顯示用的使用者資訊。token 不會離開背景。
export function publicUser(session) {
  const u = session && session.user;
  if (!u) return null;
  const meta = u.user_metadata || {};
  return {
    id: u.id,
    email: u.email || "",
    name: meta.full_name || meta.name || "",
    avatarUrl: meta.avatar_url || meta.picture || "",
  };
}

// ---------- 對外 ----------

export function getRedirectUrl() {
  return chrome.identity.getRedirectURL();
}

export async function getCurrentUser() {
  return publicUser(await loadSession());
}

/**
 * 拿一個「現在可以用」的 access token，快過期就先換新。
 * 沒登入回傳 null。refresh_token 已經失效（例如在別處登出）就清掉登入狀態。
 */
export async function getValidSession() {
  const session = await loadSession();
  if (!session) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (session.expires_at - REFRESH_MARGIN_SECONDS > nowSec) return session;

  if (!refreshing) {
    refreshing = (async () => {
      try {
        const data = await authFetch("/token?grant_type=refresh_token", {
          method: "POST",
          body: { refresh_token: session.refresh_token },
        });
        const next = toSession(data);
        if (!next.user) next.user = session.user;
        await saveSession(next);
        return next;
      } catch (err) {
        // 400/401 代表 refresh_token 本身已經無效，留著也沒用，改成登出狀態。
        // 網路斷線之類的暫時性錯誤則保留登入狀態，下次再試。
        if (err.status === 400 || err.status === 401) {
          await clearSession();
          const expired = new Error("登入已過期，請重新登入");
          expired.code = "SIGNED_OUT";
          throw expired;
        }
        throw err;
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

/** access token 被伺服器拒絕（401）時呼叫：強制換一次新的。 */
export async function forceRefresh() {
  const session = await loadSession();
  if (!session) return null;
  await saveSession({ ...session, expires_at: 0 });
  return getValidSession();
}

export async function signInWithGoogle() {
  // 先確認 Supabase 那邊已經啟用 Google 登入。沒啟用的話登入視窗只會顯示一段 JSON 錯誤，
  // 使用者看不懂，這裡直接給一句人話。
  const settings = await authFetch("/settings");
  if (!settings || !settings.external || !settings.external.google) {
    throw new Error("Supabase 還沒啟用 Google 登入（Authentication → Sign In / Providers → Google）");
  }

  const verifier = randomVerifier();
  const challenge = base64url(await sha256(verifier));
  const redirectTo = getRedirectUrl();

  const url = new URL(`${SUPABASE_URL}/auth/v1/authorize`);
  url.searchParams.set("provider", "google");
  url.searchParams.set("redirect_to", redirectTo);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "s256");
  url.searchParams.set("prompt", "select_account"); // 每次都讓使用者選帳號，不要默默用上次那個

  let responseUrl;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true });
  } catch (err) {
    // 最常見的兩種：使用者自己關掉視窗；或 Supabase 不認得我們的回傳網址，
    // 把人導到預設的 Site URL（通常是 localhost:3000），Chrome 等不到回傳網址。
    throw new Error(
      `登入沒有完成（${(err && err.message) || err}）。` +
        `如果登入後出現打不開的 localhost 頁面，代表 Supabase 的 Redirect URLs 還沒加入 ${redirectTo}`
    );
  }

  const back = new URL(responseUrl);
  const hash = new URLSearchParams(back.hash.slice(1));
  const oauthError =
    back.searchParams.get("error_description") || hash.get("error_description") || back.searchParams.get("error");
  if (oauthError) throw new Error("登入失敗：" + oauthError);

  const code = back.searchParams.get("code");
  if (!code) throw new Error("登入失敗：沒有收到授權碼");

  const data = await authFetch("/token?grant_type=pkce", {
    method: "POST",
    body: { auth_code: code, code_verifier: verifier },
  });
  const session = toSession(data);
  await saveSession(session);
  return publicUser(session);
}

export async function signOut() {
  const session = await loadSession();
  if (session) {
    try {
      // scope=local：只登出這個瀏覽器，不影響使用者在其他地方的登入
      await authFetch("/logout?scope=local", { method: "POST", accessToken: session.access_token });
    } catch (e) {
      // 伺服器那邊失敗也沒關係，本機的登入狀態照樣清掉
    }
  }
  await clearSession();
}
