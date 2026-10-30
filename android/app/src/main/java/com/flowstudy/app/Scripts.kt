package com.flowstudy.app

import android.content.Context
import org.json.JSONObject

/**
 * 組出要注入各個 WebView 的 JavaScript。
 *
 * 擴充功能的檔案原封不動放在 assets/ext/（打包時從 repo 根目錄複製），
 * 這裡只負責「照 manifest.json 的規則把它們串起來」，再補上 Android 需要的替身。
 */
object Scripts {
    const val APP_HOST = "appassets.androidplatform.net"
    const val APP_ORIGIN = "https://$APP_HOST"
    const val EXT_BASE = "$APP_ORIGIN/assets/ext/"
    const val BACKGROUND_URL = "$APP_ORIGIN/assets/shell/background.html"
    const val SETTINGS_URL = "${EXT_BASE}review.html?view=settings"

    val YOUTUBE_ORIGINS = setOf("https://www.youtube.com", "https://m.youtube.com")

    private val cache = HashMap<String, String>()

    private fun asset(context: Context, path: String): String =
        cache.getOrPut(path) { context.assets.open(path).bufferedReader().use { it.readText() } }

    private fun config(context: Context, installReason: String?): String =
        JSONObject()
            .put("manifest", JSONObject(asset(context, "ext/manifest.json")))
            .put("extBase", EXT_BASE)
            .put("redirectUrl", LoopbackAuth.REDIRECT_URL)
            .put("installReason", installReason ?: JSONObject.NULL)
            .toString()

    /**
     * YouTube 頁面：對應 manifest.json 的三組 content_scripts，再加上 Android 版自己的擋廣告與手機版轉接。
     *
     *   0. adblock.js —— 要比 YouTube 的程式更早，才攔得到播放器資料裡的廣告
     *   1. yt-player-bridge.js —— MAIN world、document_start（原樣執行，越早越好）
     *   2. normalize.js + sentence-timeline.js + content.js + content.css —— 等 DOM 好了再跑
     *   3. web-lookup.js（任何網頁反白按 Z 查字）
     *
     * 2、3 包在一個函式裡，`chrome` 是那個函式裡的區域變數，不會蓋到 YouTube 自己的 window.chrome，
     * content.js 裡的 let/const 也不會跟 YouTube 的全域變數撞名。
     */
    fun youtube(context: Context): String {
        val parts = listOf(
            "core/normalize.js" to "ext/core/normalize.js",
            "sentence-timeline.js" to "ext/sentence-timeline.js",
            "content.js" to "ext/content.js",
            "web-lookup.js" to "ext/web-lookup.js",
            "touch.js" to "shell/touch.js",
            "mobile.js" to "shell/mobile.js",
        )
        return buildString {
            append(asset(context, "shell/youtube-prelude.js")).append("\n;\n")
            append(asset(context, "shell/adblock.js")).append("\n;\n")
            append("if (window.top === window) {\n")
            append(asset(context, "ext/yt-player-bridge.js"))
            append("\n}\n;\n")

            append("(function () {\n")
            append("if (window.top !== window || window.__flowstudyContentLoaded) return;\n")
            append("Object.defineProperty(window, '__flowstudyContentLoaded', { value: true });\n")
            append("const __FS_CONFIG = ").append(config(context, null)).append(";\n")
            append(asset(context, "shell/chrome-shim.js")).append("\n")
            append("const chrome = makeFlowStudyChrome('content', __FS_CONFIG);\n")
            append("const __fsCss = ").append(JSONObject.quote(asset(context, "ext/content.css"))).append(";\n")
            parts.forEachIndexed { i, (_, path) ->
                append("function __fsPart$i() {\n").append(asset(context, path)).append("\n}\n")
            }
            append("const __fsParts = [")
            parts.forEachIndexed { i, (name, _) -> append("[").append(JSONObject.quote(name)).append(", __fsPart$i],") }
            append("];\n")
            append(
                """
                function __fsStart() {
                  const style = document.createElement("style");
                  style.id = "flowstudy-content-css";
                  style.textContent = __fsCss;
                  (document.head || document.documentElement).appendChild(style);
                  for (const [name, run] of __fsParts) {
                    try { run(); } catch (err) { console.error("[FlowStudy] 載入 " + name + " 失敗：", err); }
                  }
                }
                if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", __fsStart, { once: true });
                else __fsStart();
                })();
                """.trimIndent()
            )
        }
    }

    /** 學習面板與背景頁：在 App 自己的網域上，chrome 直接掛在 window 上，跨網域 fetch 交給原生端。 */
    fun page(context: Context, installReason: String?): String = buildString {
        append("(function () {\n")
        append("if (window.chrome && window.chrome.__flowstudy) return;\n")
        append("const __FS_CONFIG = ").append(config(context, installReason)).append(";\n")
        append(asset(context, "shell/chrome-shim.js")).append("\n")
        append(
            """
            const ctx = location.pathname.endsWith("/shell/background.html") ? "background" : "page";
            const api = makeFlowStudyChrome(ctx, __FS_CONFIG);
            Object.defineProperty(api, "__flowstudy", { value: true });
            Object.defineProperty(window, "chrome", { value: api, configurable: true, writable: true });
            installNativeFetch();
            // 手機上只用設定頁（Google 登入同步），不顯示首頁、記憶固化這些側邊欄連結
            if (ctx === "page") {
              const hideNav = () => {
                const style = document.createElement("style");
                style.textContent = ".sidebar, .topbar { display: none !important; } .main { padding-left: 0 !important; }";
                document.head.appendChild(style);
              };
              if (document.head) hideNav();
              else document.addEventListener("DOMContentLoaded", hideNav, { once: true });
            }
            })();
            """.trimIndent()
        )
    }

    /** 模擬鍵盤按鍵（a/s/d 句子導覽、z 查字），content.js / web-lookup.js 本來就聽這些鍵。 */
    fun pressKey(key: String): String {
        val k = JSONObject.quote(key)
        return """
            (function (k) {
              var o = { key: k, code: "Key" + k.toUpperCase(), keyCode: k.toUpperCase().charCodeAt(0), which: k.toUpperCase().charCodeAt(0), bubbles: true, cancelable: true, composed: true };
              var a = document.activeElement;
              if (a && a !== document.body && a.blur && !(window.getSelection() && !window.getSelection().isCollapsed)) a.blur();
              var t = document.body || document.documentElement;
              t.dispatchEvent(new KeyboardEvent("keydown", o));
              t.dispatchEvent(new KeyboardEvent("keyup", o));
            })($k);
        """.trimIndent()
    }
}
