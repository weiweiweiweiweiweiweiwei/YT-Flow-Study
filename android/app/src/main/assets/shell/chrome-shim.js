// ============================================================================
// Android 版的 chrome.* 替身
// ============================================================================
//
// 擴充功能的程式碼（background.js、content.js、pages/…）到處都在用 chrome.storage、
// chrome.runtime.sendMessage 這些 API。Android 的 WebView 裡沒有它們，
// 這支檔案就是用同樣的介面重做一份，讓那些檔案一行都不用改就能跑。
//
// 底層只有一條路：App 用 WebViewCompat.addWebMessageListener 注入的 FlowStudyNative 物件。
// 所有資料（chrome.storage）都存在 App 原生那一邊，所以 YouTube 頁面、學習面板、
// 背景頁三個 WebView 看到的是同一份，onChanged 也會同時通知三邊——跟 Chrome 一樣。
//
// 這支檔案本身不執行任何東西，只定義 makeFlowStudyChrome()。
// App 會把它跟其他檔案串在一起再注入（見 MainActivity.kt 的 buildYoutubeScript / buildPageScript）。
// ============================================================================

function makeFlowStudyChrome(ctx, config) {
  "use strict";

  // ---------- 跟 App 原生端的連線（同一個頁面裡共用一條） ----------
  function getTransport() {
    if (window.__fsTransport) return window.__fsTransport;

    const pending = new Map();
    const handlers = { storageChanged: new Set(), runtimeMessage: new Set() };
    const queue = [];
    let seq = 0;
    let port = null;

    function onNativeMessage(event) {
      let m;
      try {
        m = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      if (m.op === "reply") {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.error !== undefined && m.error !== null) p.reject(new Error(m.error));
        else p.resolve(m.result);
      } else if (handlers[m.op]) {
        handlers[m.op].forEach((fn) => {
          try {
            fn(m);
          } catch (err) {
            console.error("[FlowStudy] 處理原生訊息時發生錯誤：", err);
          }
        });
      }
    }

    function attach() {
      if (port) return true;
      const p = window.FlowStudyNative;
      if (!p) return false;
      port = p;
      port.addEventListener("message", onNativeMessage);
      while (queue.length) port.postMessage(queue.shift());
      return true;
    }

    function post(obj) {
      const text = JSON.stringify(obj);
      if (port) port.postMessage(text);
      else queue.push(text);
    }

    // 理論上原生物件在頁面一建立就在了；萬一還沒，就每 50ms 看一次，訊息先排隊
    if (!attach()) {
      const timer = setInterval(() => {
        if (attach()) clearInterval(timer);
      }, 50);
    }

    const transport = {
      call(op, args) {
        return new Promise((resolve, reject) => {
          const id = ++seq;
          pending.set(id, { resolve, reject });
          post(Object.assign({ op, id }, args));
        });
      },
      post,
      on(op, fn) {
        handlers[op].add(fn);
      },
    };
    Object.defineProperty(window, "__fsTransport", { value: transport, enumerable: false });
    post({ op: "hello", ctx, url: location.href });
    return transport;
  }

  const transport = getTransport();

  // ---------- callback / Promise 兩種寫法都要支援 ----------
  // chrome.* 的每個非同步 API 都可以傳 callback，也可以不傳、改用回傳的 Promise。
  // 用 callback 時錯誤放在 chrome.runtime.lastError，只在 callback 執行期間有值。
  let lastError = undefined;

  function settle(promise, callback) {
    if (typeof callback !== "function") return promise;
    promise.then(
      (value) => callback(value),
      (err) => {
        lastError = { message: String((err && err.message) || err) };
        try {
          callback();
        } finally {
          lastError = undefined;
        }
      }
    );
    return undefined;
  }

  function makeEvent() {
    const listeners = new Set();
    return {
      addListener: (fn) => listeners.add(fn),
      removeListener: (fn) => listeners.delete(fn),
      hasListener: (fn) => listeners.has(fn),
      _emit: (...args) => {
        listeners.forEach((fn) => {
          try {
            fn(...args);
          } catch (err) {
            console.error("[FlowStudy] 事件處理錯誤：", err);
          }
        });
      },
      _listeners: listeners,
    };
  }

  // ---------- chrome.storage ----------
  const storageChanged = makeEvent();
  transport.on("storageChanged", (m) => storageChanged._emit(m.changes, m.area));

  function makeArea(area) {
    return {
      get(keys, callback) {
        if (typeof keys === "function") {
          callback = keys;
          keys = null;
        }
        let list = null;
        let defaults = {};
        if (typeof keys === "string") list = [keys];
        else if (Array.isArray(keys)) list = keys;
        else if (keys && typeof keys === "object") {
          defaults = keys;
          list = Object.keys(keys);
        }
        const p = transport
          .call("storageGet", { area, keys: list })
          .then((found) => Object.assign({}, defaults, found || {}));
        return settle(p, callback);
      },
      set(items, callback) {
        // 跟 Chrome 一樣先轉成 JSON 能表示的形式（undefined 的欄位會消失）
        const p = transport.call("storageSet", { area, items: JSON.parse(JSON.stringify(items || {})) }).then(() => undefined);
        return settle(p, callback);
      },
      remove(keys, callback) {
        const list = typeof keys === "string" ? [keys] : keys || [];
        return settle(transport.call("storageRemove", { area, keys: list }).then(() => undefined), callback);
      },
      clear(callback) {
        return settle(transport.call("storageClear", { area }).then(() => undefined), callback);
      },
      setAccessLevel() {
        return Promise.resolve();
      },
      onChanged: {
        addListener: (fn) => storageChanged.addListener((changes, a) => a === area && fn(changes)),
      },
    };
  }

  // ---------- chrome.runtime ----------
  const onMessage = makeEvent();
  const onInstalled = makeEvent();
  const onStartup = makeEvent();

  // 背景頁收到別人送來的訊息：照 Chrome 的規則呼叫 onMessage 的監聽者，
  // 有人同步回覆、或回傳 true 表示稍後回覆，就把答案送回去；都沒有就回 undefined。
  transport.on("runtimeMessage", (m) => {
    let answered = false;
    let willAnswer = false;
    const sendResponse = (response) => {
      if (answered) return;
      answered = true;
      transport.post({ op: "runtimeResponse", mid: m.mid, response: response === undefined ? null : response });
    };
    onMessage._listeners.forEach((fn) => {
      try {
        if (fn(m.msg, m.sender || {}, sendResponse) === true) willAnswer = true;
      } catch (err) {
        console.error("[FlowStudy] onMessage 處理錯誤：", err);
      }
    });
    if (!willAnswer && !answered) sendResponse(undefined);
  });

  // 原本 offscreen.html 做的事：背景頁本身就是一般網頁，直接產生 blob 網址即可
  function handleOffscreenLocally(msg) {
    if (msg.type === "backup:makeUrl") {
      return { url: URL.createObjectURL(new Blob([msg.json], { type: "application/json" })) };
    }
    return undefined;
  }

  const runtime = {
    id: "flowstudy-android",
    get lastError() {
      return lastError;
    },
    getManifest: () => config.manifest,
    getURL: (path) => config.extBase + String(path || "").replace(/^\//, ""),
    sendMessage(msg, callback) {
      let p;
      if (msg && msg.target === "offscreen") p = Promise.resolve(handleOffscreenLocally(msg));
      else p = transport.call("sendMessage", { msg }).then((r) => (r === null ? undefined : r));
      return settle(p, callback);
    },
    onMessage,
    onInstalled,
    onStartup,
  };

  if (ctx === "background") {
    // 擴充功能裝好／更新時 Chrome 會送 onInstalled，平常啟動送 onStartup
    setTimeout(() => {
      if (config.installReason) onInstalled._emit({ reason: config.installReason });
      else onStartup._emit();
    }, 0);
  }

  // ---------- chrome.alarms（只有背景頁用；App 開著的時候背景頁一直活著，用計時器就夠了） ----------
  const alarmTimers = new Map();
  const onAlarm = makeEvent();
  const alarms = {
    create(name, info) {
      if (typeof name === "object") {
        info = name;
        name = "";
      }
      alarms.clear(name);
      const period = info && info.periodInMinutes;
      const delay = (info && (info.delayInMinutes !== undefined ? info.delayInMinutes : period)) || 0;
      const alarm = { name, periodInMinutes: period, scheduledTime: Date.now() + delay * 60000 };
      const fire = () => {
        alarm.scheduledTime = Date.now() + (period || 0) * 60000;
        onAlarm._emit(Object.assign({}, alarm));
      };
      const entry = { alarm, timeout: null, interval: null };
      entry.timeout = setTimeout(() => {
        fire();
        if (period) entry.interval = setInterval(fire, period * 60000);
        else alarmTimers.delete(name);
      }, delay * 60000);
      alarmTimers.set(name, entry);
      return Promise.resolve();
    },
    get(name, callback) {
      const entry = alarmTimers.get(name);
      return settle(Promise.resolve(entry ? Object.assign({}, entry.alarm) : undefined), callback);
    },
    clear(name, callback) {
      const entry = alarmTimers.get(name);
      if (entry) {
        clearTimeout(entry.timeout);
        clearInterval(entry.interval);
        alarmTimers.delete(name);
      }
      return settle(Promise.resolve(!!entry), callback);
    },
    onAlarm,
  };

  // ---------- chrome.identity：Google 登入改用 App 開的瀏覽器分頁 ----------
  const identity = {
    getRedirectURL: () => config.redirectUrl,
    launchWebAuthFlow(details, callback) {
      const p = transport.call("authFlow", { url: details.url, interactive: !!details.interactive });
      return settle(p, callback);
    },
  };

  // ---------- chrome.downloads：備份檔改由 App 寫進手機的「下載」資料夾 ----------
  const onDownloadChanged = makeEvent();
  const downloadItems = new Map();
  let downloadSeq = 0;
  const downloads = {
    async download(options) {
      const res = await fetch(options.url);
      const base64 = bytesToBase64(new Uint8Array(await res.arrayBuffer()));
      const saved = await transport.call("saveDownload", {
        filename: options.filename,
        conflictAction: options.conflictAction || "uniquify",
        base64,
      });
      const id = ++downloadSeq;
      downloadItems.set(id, { id, filename: saved.filename, state: "complete" });
      // 呼叫端會在拿到 id 之後才開始聽 onChanged，所以晚一拍再通知
      setTimeout(() => onDownloadChanged._emit({ id, state: { previous: "in_progress", current: "complete" } }), 0);
      return id;
    },
    search(query) {
      const item = query && downloadItems.get(query.id);
      return Promise.resolve(item ? [Object.assign({}, item)] : []);
    },
    erase(query) {
      if (query) downloadItems.delete(query.id);
      return Promise.resolve([]);
    },
    setUiOptions: () => Promise.resolve(),
    onChanged: onDownloadChanged,
  };

  // offscreen 文件在這裡不需要（見 handleOffscreenLocally）
  const offscreen = {
    hasDocument: () => Promise.resolve(false),
    createDocument: () => Promise.resolve(),
    closeDocument: () => Promise.resolve(),
  };

  const tabs = {
    create(props, callback) {
      return settle(transport.call("openUrl", { url: props && props.url }), callback);
    },
  };

  return {
    storage: {
      local: makeArea("local"),
      session: makeArea("session"),
      onChanged: storageChanged,
    },
    runtime,
    alarms,
    identity,
    downloads,
    offscreen,
    tabs,
  };
}

// ---------- 小工具 ----------
function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// 學習面板與背景頁的 fetch：跨網域的請求改由 App 原生端代發。
// 擴充功能靠 manifest 的 host_permissions 免除 CORS 限制，一般網頁沒有這個待遇，
// Google 翻譯、發音這些端點不一定回 CORS 標頭，直接打會被 WebView 擋下。
function installNativeFetch() {
  const pageFetch = window.fetch.bind(window);
  const transport = window.__fsTransport;
  const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

  window.fetch = async function (input, init) {
    const request = new Request(input, init);
    let url;
    try {
      url = new URL(request.url);
    } catch (e) {
      return pageFetch(input, init);
    }
    if (url.origin === location.origin || (url.protocol !== "https:" && url.protocol !== "http:")) {
      return pageFetch(input, init);
    }

    const signal = request.signal;
    if (signal && signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");

    const headers = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const body = hasBody ? bytesToBase64(new Uint8Array(await request.arrayBuffer())) : null;

    const call = transport.call("fetch", { url: request.url, method: request.method, headers, body });
    const result = await (signal
      ? Promise.race([
          call,
          new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), {
              once: true,
            })
          ),
        ])
      : call
    ).catch((err) => {
      if (err && err.name === "AbortError") throw err;
      throw new TypeError("Failed to fetch（" + ((err && err.message) || err) + "）");
    });

    const bytes = result.body && !NULL_BODY_STATUS.has(result.status) ? base64ToBytes(result.body) : null;
    const response = new Response(bytes, {
      status: result.status,
      statusText: result.statusText || "",
      headers: result.headers || {},
    });
    // 有些程式會看 res.url 判斷有沒有被轉址（例如 Google 翻譯被擋時會跳到 /sorry/）
    Object.defineProperty(response, "url", { value: result.url || request.url });
    Object.defineProperty(response, "redirected", { value: !!result.url && result.url !== request.url });
    return response;
  };
}
