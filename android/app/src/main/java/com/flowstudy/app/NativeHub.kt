package com.flowstudy.app

import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/**
 * 三個 WebView 之間的總機，扮演 Chrome 擴充功能執行環境的角色：
 *
 *   YouTube 頁面（content.js）  ─┐
 *   學習面板（review.html）      ─┼─ FlowStudyNative ─→ 這裡 ─→ 背景頁（background.js）
 *                                ─┘
 *
 * - chrome.storage：資料存在這裡，任何一邊改了，三邊都收到 onChanged
 * - chrome.runtime.sendMessage：轉給背景頁，等它回覆再送回原本的頁面
 * - fetch / 登入 / 寫備份檔：只有 App 自己的頁面（學習面板、背景頁）可以要求
 *
 * YouTube 頁面是別人的網頁，它自己的程式碼也碰得到 FlowStudyNative，
 * 所以那邊能做的事刻意限縮：看不到 Google 登入 token 與 Gemini 金鑰，也只能送 content.js 會送的訊息。
 */
class NativeHub(private val activity: MainActivity, userAgent: String) {

    private class Frame(val view: WebView, val proxy: JavaScriptReplyProxy, val trusted: Boolean, val ctx: String)

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newCachedThreadPool()

    val local = KeyValueStore(File(activity.filesDir, "chrome-storage-local.json"))
    private val session = KeyValueStore(null)

    private val fetcher = NativeFetch(userAgent)
    private val backups = BackupWriter(activity)
    val auth = LoopbackAuth(activity)

    private val frames = ArrayList<Frame>()
    private var background: Frame? = null
    private val backgroundQueue = ArrayList<String>()
    private val pendingRuntime = HashMap<Int, (Any?) -> Unit>()
    private var runtimeSeq = 0

    val listener = WebViewCompat.WebMessageListener { view, message, sourceOrigin, isMainFrame, replyProxy ->
        onMessage(view, message, sourceOrigin, isMainFrame, replyProxy)
    }

    private fun onMessage(view: WebView, message: WebMessageCompat, origin: Uri, isMainFrame: Boolean, proxy: JavaScriptReplyProxy) {
        val m = try {
            JSONObject(message.data ?: return)
        } catch (e: Exception) {
            return
        }
        val trusted = origin.toString().trimEnd('/') == Scripts.APP_ORIGIN
        val op = m.optString("op")
        val id = m.optInt("id")
        try {
            when (op) {
                "hello" -> {
                    val ctx = m.optString("ctx")
                    if (!isMainFrame) return
                    frames.removeAll { it.view === view }
                    val frame = Frame(view, proxy, trusted, ctx)
                    frames.add(frame)
                    if (ctx == "background" && trusted) {
                        background = frame
                        backgroundQueue.forEach { proxy.postMessage(it) }
                        backgroundQueue.clear()
                    }
                }

                "storageGet" -> {
                    val keys = if (m.isNull("keys")) null else m.getJSONArray("keys")
                    var found = area(m).get(keys)
                    if (!trusted) found = withoutPrivateKeys(found)
                    reply(proxy, id, found)
                }

                "storageSet" -> {
                    var items = m.getJSONObject("items")
                    if (!trusted) items = withoutPrivateKeys(items)
                    broadcastChanges(m.optString("area"), area(m).set(items))
                    reply(proxy, id, null)
                }

                "storageRemove" -> {
                    val keys = m.getJSONArray("keys")
                    val allowed = JSONArray()
                    for (i in 0 until keys.length()) {
                        val k = keys.optString(i)
                        if (trusted || !isPrivateKey(k)) allowed.put(k)
                    }
                    broadcastChanges(m.optString("area"), area(m).remove(allowed))
                    reply(proxy, id, null)
                }

                "storageClear" -> {
                    if (!trusted) return replyError(proxy, id, "not allowed")
                    broadcastChanges(m.optString("area"), area(m).clear())
                    reply(proxy, id, null)
                }

                "sendMessage" -> {
                    val msg = m.optJSONObject("msg") ?: return reply(proxy, id, null)
                    if (!trusted && msg.optString("type") !in CONTENT_MESSAGE_TYPES) {
                        return replyError(proxy, id, "not allowed")
                    }
                    val sender = JSONObject().put("url", m.optString("url")).put("origin", origin.toString())
                    if (!trusted) sender.put("tab", JSONObject().put("id", 1).put("url", view.url ?: ""))
                    sendToBackground(msg, sender) { response -> reply(proxy, id, response) }
                }

                "runtimeResponse" -> {
                    if (!trusted) return
                    pendingRuntime.remove(m.optInt("mid"))?.invoke(m.opt("response"))
                }

                "fetch" -> {
                    if (!trusted) return replyError(proxy, id, "not allowed")
                    io.execute {
                        try {
                            val result = fetcher.fetch(m)
                            main.post { reply(proxy, id, result) }
                        } catch (e: Exception) {
                            main.post { replyError(proxy, id, e.message ?: e.toString()) }
                        }
                    }
                }

                "authFlow" -> {
                    if (!trusted) return replyError(proxy, id, "not allowed")
                    auth.start(m.getString("url"), m.optBoolean("interactive")) { url, error ->
                        if (url != null) reply(proxy, id, url) else replyError(proxy, id, error ?: "登入失敗")
                    }
                }

                "saveDownload" -> {
                    if (!trusted) return replyError(proxy, id, "not allowed")
                    io.execute {
                        try {
                            val bytes = Base64.decode(m.getString("base64"), Base64.DEFAULT)
                            val path = backups.save(m.getString("filename"), bytes, m.optString("conflictAction"))
                            main.post { reply(proxy, id, JSONObject().put("filename", path)) }
                        } catch (e: Exception) {
                            Log.e(TAG, "寫入備份檔失敗", e)
                            main.post { replyError(proxy, id, e.message ?: e.toString()) }
                        }
                    }
                }

                // 影片開始／暫停（mobile.js 回報），決定切到背景時要不要繼續播
                "playbackState" -> {
                    activity.onVideoPlaying(m.optBoolean("playing"))
                }

                // 播放器齒輪裡的「同步到電腦」：只是打開設定頁，YouTube 頁面也可以要求
                "openSync" -> {
                    activity.showSettings()
                    reply(proxy, id, null)
                }

                "openUrl" -> {
                    activity.openUrl(m.optString("url"))
                    reply(proxy, id, null)
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "處理 $op 失敗", e)
            if (id != 0) replyError(proxy, id, e.message ?: e.toString())
        }
    }

    /** 送一則 chrome.runtime 訊息給背景頁（App 自己也會用，例如回到 App 時要求同步）。 */
    fun sendToBackground(msg: JSONObject, sender: JSONObject = JSONObject().put("id", "native"), onResponse: (Any?) -> Unit = {}) {
        val mid = ++runtimeSeq
        pendingRuntime[mid] = onResponse
        val text = JSONObject().put("op", "runtimeMessage").put("mid", mid).put("msg", msg).put("sender", sender).toString()
        val bg = background
        if (bg != null) bg.proxy.postMessage(text) else backgroundQueue.add(text)
    }

    /** 背景頁重新載入時，還在等它回覆的訊息都不會有結果了，先回一個空值，不要讓呼叫端一直等。 */
    fun onBackgroundReloading() {
        background = null
        val waiting = pendingRuntime.values.toList()
        pendingRuntime.clear()
        waiting.forEach { it(null) }
    }

    fun forgetFrames(view: WebView) {
        frames.removeAll { it.view === view }
        if (background?.view === view) background = null
    }

    fun flush() = local.flush()

    // ---------- 小工具 ----------

    private fun area(m: JSONObject) = if (m.optString("area") == "session") session else local

    private fun broadcastChanges(area: String, changes: JSONObject) {
        if (changes.length() == 0) return
        for (frame in frames.toList()) {
            val visible = if (frame.trusted) changes else withoutPrivateKeys(changes)
            if (visible.length() == 0) continue
            try {
                frame.proxy.postMessage(
                    JSONObject().put("op", "storageChanged").put("area", area).put("changes", visible).toString()
                )
            } catch (e: Exception) {
                frames.remove(frame)
            }
        }
    }

    private fun reply(proxy: JavaScriptReplyProxy, id: Int, result: Any?) {
        try {
            proxy.postMessage(JSONObject().put("op", "reply").put("id", id).put("result", result ?: JSONObject.NULL).toString())
        } catch (e: Exception) {
            Log.w(TAG, "回覆頁面失敗（頁面可能已經關閉）", e)
        }
    }

    private fun replyError(proxy: JavaScriptReplyProxy, id: Int, error: String) {
        try {
            proxy.postMessage(JSONObject().put("op", "reply").put("id", id).put("error", error).toString())
        } catch (e: Exception) {
            Log.w(TAG, "回覆頁面失敗（頁面可能已經關閉）", e)
        }
    }

    private fun isPrivateKey(key: String) = key.startsWith("flowstudyAuth") || key.startsWith("flowstudySecret")

    private fun withoutPrivateKeys(obj: JSONObject): JSONObject {
        val out = JSONObject()
        val it = obj.keys()
        while (it.hasNext()) {
            val k = it.next()
            if (!isPrivateKey(k)) out.put(k, obj.get(k))
        }
        return out
    }

    companion object {
        private const val TAG = "FlowStudy"

        /** YouTube 頁面（content.js、web-lookup.js）會送的訊息種類，其他一律拒絕。 */
        private val CONTENT_MESSAGE_TYPES = setOf(
            "translate", "speak", "vocab:save", "vocab:syncIndex",
            "immersion:start", "immersion:tick", "immersion:end", "immersion:today",
            "video:upsert", "subs:translate", "subs:status", "dict:lookup",
        )
    }
}
