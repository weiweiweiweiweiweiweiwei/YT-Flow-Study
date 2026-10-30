package com.flowstudy.app

import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.browser.customtabs.CustomTabsIntent
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import kotlin.concurrent.thread

/**
 * chrome.identity.launchWebAuthFlow 的替身：Google 登入。
 *
 * Google 不讓 App 內嵌的 WebView 登入（會顯示「這個瀏覽器或應用程式可能不安全」），
 * 所以改成開一個真正的瀏覽器分頁（Custom Tab）。登入完 Google 把 access token 放在
 * http://localhost:47391/#access_token=… 交回來，這裡在手機本機開一個只聽 127.0.0.1 的小伺服器接住它。
 *
 * core/cloud/auth.js 完全不用改：它照樣組授權網址、照樣解析回傳網址的 #hash，
 * 只是 redirect_uri 從 https://<擴充功能ID>.chromiumapp.org/ 變成上面那個 localhost 網址
 * （設定頁會顯示，要把它加進 Google Cloud OAuth 用戶端的「已授權的重新導向 URI」）。
 */
class LoopbackAuth(private val activity: MainActivity) {

    companion object {
        const val PORT = 47391
        const val REDIRECT_URL = "http://localhost:$PORT/"
        const val RETURN_SCHEME = "flowstudy-auth"
        private const val TAG = "FlowStudy"
        private const val TIMEOUT_MS = 5 * 60 * 1000L
    }

    private val main = Handler(Looper.getMainLooper())
    private var pending: ((String?, String?) -> Unit)? = null
    private var servers: List<ServerSocket> = emptyList()
    private var launchedAt = 0L
    private val timeout = Runnable { finish(null, "登入逾時，請再試一次") }

    /** 主執行緒呼叫。callback(回傳網址, 錯誤訊息) 只會被呼叫一次。 */
    fun start(url: String, interactive: Boolean, callback: (String?, String?) -> Unit) {
        // 背景換 token 也得開一下瀏覽器分頁（畫面會閃一下）。只在剛打開 App、或正在看學習面板時才做，
        // 不在看影片的途中突然跳出來。拿不到 token 的這次同步會延到下次打開 App。
        if (!interactive && !activity.allowSilentAuth()) {
            callback(null, "需要回到 App 畫面才能更新 Google 登入")
            return
        }
        pending?.invoke(null, "有新的登入要求，這一次取消")
        pending = callback
        try {
            startServers()
        } catch (e: IOException) {
            finish(null, "無法啟動登入接收器（連接埠 $PORT 被占用？）：${e.message}")
            return
        }
        launchedAt = SystemClock.elapsedRealtime()
        main.removeCallbacks(timeout)
        main.postDelayed(timeout, TIMEOUT_MS)
        try {
            CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(activity, Uri.parse(url))
        } catch (e: Exception) {
            finish(null, "找不到可以開啟登入畫面的瀏覽器：${e.message}")
        }
    }

    /** 使用者直接關掉登入分頁回到 App：等一下，確定沒有結果送進來就當作取消。 */
    fun onActivityResumed() {
        if (pending == null || SystemClock.elapsedRealtime() - launchedAt < 800) return
        main.postDelayed({
            if (pending != null && SystemClock.elapsedRealtime() - launchedAt > 2000) {
                finish(null, "登入視窗已關閉，登入沒有完成")
            }
        }, 2500)
    }

    private fun finish(responseUrl: String?, error: String?) {
        main.removeCallbacks(timeout)
        stopServers()
        val cb = pending ?: return
        pending = null
        cb(responseUrl, error)
    }

    // ---------- 本機小伺服器 ----------

    private fun startServers() {
        if (servers.isNotEmpty()) return
        val list = ArrayList<ServerSocket>()
        // localhost 可能被解析成 IPv4 或 IPv6，兩個都聽；IPv6 沒有就算了
        for ((address, required) in listOf("127.0.0.1" to true, "::1" to false)) {
            try {
                val s = ServerSocket()
                s.reuseAddress = true
                s.bind(InetSocketAddress(InetAddress.getByName(address), PORT))
                list.add(s)
            } catch (e: IOException) {
                if (required) {
                    list.forEach { runCatching { it.close() } }
                    throw e
                }
            }
        }
        servers = list
        for (s in list) {
            thread(name = "flowstudy-auth-$PORT", isDaemon = true) {
                while (!s.isClosed) {
                    val socket = try {
                        s.accept()
                    } catch (e: IOException) {
                        break
                    }
                    try {
                        handle(socket)
                    } catch (e: Exception) {
                        Log.w(TAG, "登入接收器處理請求失敗", e)
                    } finally {
                        runCatching { socket.close() }
                    }
                }
            }
        }
    }

    private fun stopServers() {
        servers.forEach { runCatching { it.close() } }
        servers = emptyList()
    }

    private fun handle(socket: Socket) {
        socket.soTimeout = 10_000
        val reader = BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.UTF_8))
        val requestLine = reader.readLine() ?: return
        while (true) {
            val line = reader.readLine() ?: break
            if (line.isEmpty()) break
        }
        val target = requestLine.split(" ").getOrNull(1) ?: "/"
        val path = target.substringBefore('?')
        val query = target.substringAfter('?', "")

        when (path) {
            // Google 導回來的第一站。token 在 #hash 裡，瀏覽器不會送到伺服器，
            // 所以先回一個小頁面，讓頁面自己把 hash 交過來
            "/" -> respond(socket, 200, CALLBACK_PAGE)
            "/done" -> {
                respond(socket, 200, "ok", "text/plain")
                main.post {
                    finish(REDIRECT_URL + "#" + query, null)
                    activity.bringToFront()
                }
            }
            else -> respond(socket, 404, "not found", "text/plain")
        }
    }

    private fun respond(socket: Socket, status: Int, body: String, type: String = "text/html") {
        val bytes = body.toByteArray(Charsets.UTF_8)
        val head = "HTTP/1.1 $status ${if (status == 200) "OK" else "Not Found"}\r\n" +
            "Content-Type: $type; charset=utf-8\r\n" +
            "Content-Length: ${bytes.size}\r\n" +
            "Cache-Control: no-store\r\n" +
            "Connection: close\r\n\r\n"
        val out = socket.getOutputStream()
        out.write(head.toByteArray(Charsets.US_ASCII))
        out.write(bytes)
        out.flush()
    }

    private val CALLBACK_PAGE = """
        <!DOCTYPE html>
        <html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>FlowStudy 登入</title>
        <style>
          body { font-family: system-ui, sans-serif; text-align: center; padding: 48px 20px; color: #0f172a; }
          a { display: inline-block; margin-top: 20px; padding: 12px 28px; border-radius: 10px; background: #2563eb; color: #fff; text-decoration: none; font-weight: 600; }
        </style></head>
        <body>
          <h2 id="t">正在完成登入…</h2>
          <p id="m"></p>
          <a id="back" href="$RETURN_SCHEME://done" hidden>回到 FlowStudy</a>
          <script>
            var params = (location.hash || "").slice(1) || location.search.slice(1);
            fetch("/done?" + params).then(function () {
              document.getElementById("t").textContent = /error=/.test(params) ? "登入沒有完成" : "登入完成";
              document.getElementById("m").textContent = "可以回到 FlowStudy 了。";
              document.getElementById("back").hidden = false;
              location.replace("$RETURN_SCHEME://done");
            }, function () {
              document.getElementById("t").textContent = "FlowStudy 沒有收到登入結果";
              document.getElementById("m").textContent = "請回到 App 再試一次。";
            });
          </script>
        </body></html>
    """.trimIndent()
}
