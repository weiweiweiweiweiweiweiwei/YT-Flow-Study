package com.flowstudy.app

import android.util.Base64
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * 背景頁與學習面板的跨網域請求（Google 翻譯、發音、Gemini、雲端硬碟…）。
 *
 * 擴充功能有 host_permissions，可以無視 CORS；App 裡的網頁沒有，
 * 所以 chrome-shim.js 把這些請求轉到這裡，由 App 原生端代發。
 */
class NativeFetch(private val userAgent: String) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    /** 在背景執行緒呼叫。回傳 { status, statusText, url, headers, body(base64) }，網路錯誤直接丟例外。 */
    fun fetch(req: JSONObject): JSONObject {
        val method = req.optString("method", "GET").uppercase()
        val headers = req.optJSONObject("headers") ?: JSONObject()
        val contentType = headers.optString("content-type", "")

        val bodyBytes = if (req.isNull("body")) null else Base64.decode(req.getString("body"), Base64.DEFAULT)
        val body = when {
            method == "GET" || method == "HEAD" -> null
            else -> (bodyBytes ?: ByteArray(0)).toRequestBody(contentType.toMediaTypeOrNull())
        }

        val builder = Request.Builder().url(req.getString("url")).method(method, body)
        builder.header("User-Agent", userAgent)
        val names = headers.keys()
        while (names.hasNext()) {
            val name = names.next()
            if (name.equals("content-length", true) || name.equals("host", true)) continue
            builder.header(name, headers.getString(name))
        }

        client.newCall(builder.build()).execute().use { res ->
            val outHeaders = JSONObject()
            for (name in res.headers.names()) {
                outHeaders.put(name.lowercase(), res.headers.values(name).joinToString(", "))
            }
            val bytes = res.body?.bytes() ?: ByteArray(0)
            return JSONObject()
                .put("status", res.code)
                .put("statusText", res.message)
                .put("url", res.request.url.toString())
                .put("headers", outHeaders)
                .put("body", Base64.encodeToString(bytes, Base64.NO_WRAP))
        }
    }
}
