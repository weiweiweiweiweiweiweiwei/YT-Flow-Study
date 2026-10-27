// ============================================================================
// Google 登入（直接跟 Google 拿授權，不經過任何資料庫服務）
// ============================================================================
//
// 只在 background service worker 執行。登入狀態集中放在這裡，
// 設定頁、同步都透過背景訊息來問，不會各自持有一份過期的 token。
//
// 要的權限只有三樣：
//   drive.appdata —— 雲端硬碟裡「FlowStudy 專用的隱藏資料夾」，看不到使用者其他檔案
//   openid / email / profile —— 在設定頁顯示「目前登入的是哪個帳號」
//
// 流程：chrome.identity.launchWebAuthFlow 開 Google 的登入視窗，
// 使用者同意後 Google 把 access token 放在網址裡導回 https://<擴充功能ID>.chromiumapp.org/，
// Chrome 攔下這個網址交還給我們（視窗自動關閉）。
//
// 為什麼不拿 refresh token：那要把「用戶端密碼」放進擴充功能，任何人都能從原始碼裡看到。
// access token 一小時過期，到時候用同一個視窗「不顯示畫面」再要一次（interactive: false），
// 只要使用者的 Chrome 還登入著 Google、之前同意過，就會安靜地拿到新的，完全不用操作。
// 拿不到（例如使用者在 Google 那邊撤銷了授權）才請使用者到設定頁按「重新登入」。
// ============================================================================

import { GOOGLE_CLIENT_ID, GOOGLE_SCOPES } from "./config.js";

const SESSION_KEY = "flowstudyAuthGoogle";
const OLD_SESSION_KEY = "flowstudyAuthSession"; // 以前 Supabase 的登入狀態，用不到了，順手清掉
const REFRESH_MARGIN_SECONDS = 120;

let renewing = null; // 同一時間只換一次 token

async function loadSession() {
  const data = await chrome.storage.local.get(SESSION_KEY);
  return data[SESSION_KEY] || null;
}

async function saveSession(session) {
  await chrome.storage.local.set({ [SESSION_KEY]: session });
}

async function clearSession() {
  await chrome.storage.local.remove([SESSION_KEY, OLD_SESSION_KEY]);
}

// 給畫面顯示用的使用者資訊。token 不會離開背景。
export function publicUser(session) {
  const u = session && session.user;
  if (!u) return null;
  return { id: u.id, email: u.email || "", name: u.name || "", avatarUrl: u.picture || "" };
}

export function getRedirectUrl() {
  return chrome.identity.getRedirectURL();
}

export function isConfigured() {
  return !!GOOGLE_CLIENT_ID;
}

function authorizeUrl({ interactive, loginHint }) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", getRedirectUrl());
  url.searchParams.set("response_type", "token");
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("include_granted_scopes", "true");
  if (interactive) {
    url.searchParams.set("prompt", "select_account"); // 第一次登入讓使用者自己選帳號
  } else {
    url.searchParams.set("prompt", "none"); // 背景換 token：不顯示任何畫面
    if (loginHint) url.searchParams.set("login_hint", loginHint); // 有好幾個 Google 帳號時，指定要原本那一個
  }
  return url.toString();
}

async function requestToken({ interactive, loginHint }) {
  let responseUrl;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({ url: authorizeUrl({ interactive, loginHint }), interactive });
  } catch (err) {
    if (!interactive) throw new Error("Google 登入已過期，請在設定重新登入");
    throw new Error(
      `登入沒有完成（${(err && err.message) || err}）。` +
        `如果 Google 顯示「redirect_uri_mismatch」，代表 Google Cloud 的 OAuth 用戶端還沒加入 ${getRedirectUrl()}`
    );
  }
  const params = new URLSearchParams(new URL(responseUrl).hash.slice(1));
  const error = params.get("error");
  if (error) {
    if (!interactive) throw new Error("Google 登入已過期，請在設定重新登入");
    throw new Error("登入失敗：" + (params.get("error_description") || error));
  }
  const token = params.get("access_token");
  if (!token) throw new Error("登入失敗：沒有收到 Google 的授權");
  const granted = (params.get("scope") || "").split(" ");
  if (!granted.includes("https://www.googleapis.com/auth/drive.appdata")) {
    // Google 的同意畫面可以只勾一部分權限
    throw new Error("需要允許 FlowStudy 使用雲端硬碟的應用程式資料夾，才能同步。請重新登入並勾選。");
  }
  const expiresIn = Number(params.get("expires_in")) || 3600;
  return { accessToken: token, expiresAt: Math.floor(Date.now() / 1000) + expiresIn };
}

async function fetchProfile(accessToken) {
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`讀取 Google 帳號資料失敗（HTTP ${res.status}）`);
  const p = await res.json();
  // 同步狀態依 id 分開存；加上前綴，跟以前 Supabase 的使用者 id 不會混在一起
  return { id: "google:" + p.sub, email: p.email || "", name: p.name || "", picture: p.picture || "" };
}

// ---------- 對外 ----------

export async function getCurrentUser() {
  return publicUser(await loadSession());
}

/**
 * 拿一個「現在可以用」的 access token，快過期就先在背景換新。
 * 沒登入回傳 null；背景換不到新的就丟錯，請使用者重新登入（登入資訊留著，畫面上還看得到是誰）。
 */
export async function getValidSession() {
  const session = await loadSession();
  if (!session) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (session.expiresAt - REFRESH_MARGIN_SECONDS > nowSec) return session;
  return renewSession(session);
}

function renewSession(session) {
  if (!renewing) {
    renewing = (async () => {
      try {
        const t = await requestToken({ interactive: false, loginHint: session.user && session.user.email });
        const next = { ...session, ...t };
        await saveSession(next);
        return next;
      } finally {
        renewing = null;
      }
    })();
  }
  return renewing;
}

/** 雲端硬碟拒絕了 token（401）：強制換一次新的，回傳新的 token。 */
export async function forceRenewToken() {
  const session = await loadSession();
  if (!session) return null;
  const next = await renewSession(session);
  return next.accessToken;
}

export async function getAccessToken() {
  const session = await getValidSession();
  return session ? session.accessToken : null;
}

export async function signInWithGoogle() {
  if (!isConfigured()) {
    throw new Error("還沒設定 Google 登入用的用戶端 ID（core/cloud/config.js 的 GOOGLE_CLIENT_ID）");
  }
  const t = await requestToken({ interactive: true });
  const user = await fetchProfile(t.accessToken);
  const session = { ...t, user };
  await chrome.storage.local.remove(OLD_SESSION_KEY);
  await saveSession(session);
  return publicUser(session);
}

export async function signOut() {
  const session = await loadSession();
  if (session && session.accessToken) {
    try {
      // 撤銷這個 token。之後要再同步，得重新登入、重新同意
      await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(session.accessToken), { method: "POST" });
    } catch (e) {
      // 撤銷失敗也沒關係，本機的登入狀態照樣清掉
    }
  }
  await clearSession();
}
