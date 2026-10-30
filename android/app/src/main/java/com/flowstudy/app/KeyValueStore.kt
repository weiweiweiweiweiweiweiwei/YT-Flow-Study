package com.flowstudy.app

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * chrome.storage 的一個區域（local 或 session）。
 *
 * 值一律是 JSON。local 會存成 App 私有目錄裡的一個檔案；session 只放記憶體，
 * App 被系統關掉就清空——跟 Chrome 的 storage.session 一樣是「這次開啟期間」的資料。
 *
 * 所有方法都在主執行緒呼叫；寫檔延後一點、在背景執行緒做，連續寫入只會寫一次。
 */
class KeyValueStore(private val file: File?) {
    private var data = JSONObject()
    private val saveScheduled = AtomicBoolean(false)
    private val writer = Executors.newSingleThreadScheduledExecutor()

    init {
        if (file != null && file.exists()) {
            try {
                data = JSONObject(file.readText())
            } catch (e: Exception) {
                // 檔案壞了：留一份起來，不要直接覆蓋掉，萬一之後要救資料
                Log.e(TAG, "chrome.storage 檔案無法讀取，另存後重新開始", e)
                file.renameTo(File(file.path + ".broken-" + System.currentTimeMillis()))
            }
        }
    }

    @Synchronized
    fun get(keys: JSONArray?): JSONObject {
        if (keys == null) return JSONObject(data.toString())
        val out = JSONObject()
        for (i in 0 until keys.length()) {
            val key = keys.optString(i)
            if (data.has(key)) out.put(key, data.get(key))
        }
        return out
    }

    /** 回傳 chrome.storage.onChanged 格式的變動：{ key: { oldValue, newValue } }。值沒變的不算。 */
    @Synchronized
    fun set(items: JSONObject): JSONObject {
        val changes = JSONObject()
        val it = items.keys()
        while (it.hasNext()) {
            val key = it.next()
            val newValue = items.get(key)
            val oldValue = data.opt(key)
            if (oldValue != null && encode(oldValue) == encode(newValue)) continue
            val change = JSONObject()
            if (oldValue != null) change.put("oldValue", oldValue)
            change.put("newValue", newValue)
            data.put(key, newValue)
            changes.put(key, change)
        }
        if (changes.length() > 0) scheduleSave()
        return changes
    }

    @Synchronized
    fun remove(keys: JSONArray): JSONObject {
        val changes = JSONObject()
        for (i in 0 until keys.length()) {
            val key = keys.optString(i)
            val oldValue = data.opt(key) ?: continue
            data.remove(key)
            changes.put(key, JSONObject().put("oldValue", oldValue))
        }
        if (changes.length() > 0) scheduleSave()
        return changes
    }

    @Synchronized
    fun clear(): JSONObject {
        val changes = JSONObject()
        val it = data.keys()
        while (it.hasNext()) {
            val key = it.next()
            changes.put(key, JSONObject().put("oldValue", data.get(key)))
        }
        data = JSONObject()
        if (changes.length() > 0) scheduleSave()
        return changes
    }

    private fun scheduleSave() {
        if (file == null) return
        if (!saveScheduled.compareAndSet(false, true)) return
        writer.schedule({ writeNow() }, 400, TimeUnit.MILLISECONDS)
    }

    /** App 退到背景時呼叫：還沒寫進檔案的變動立刻寫掉。 */
    fun flush() {
        if (file == null || !saveScheduled.get()) return
        writer.execute { writeNow() }
    }

    private fun writeNow() {
        if (file == null || !saveScheduled.getAndSet(false)) return
        val text = synchronized(this) { data.toString() }
        try {
            val tmp = File(file.path + ".tmp")
            tmp.writeText(text)
            if (!tmp.renameTo(file)) {
                file.writeText(text)
                tmp.delete()
            }
        } catch (e: Exception) {
            Log.e(TAG, "chrome.storage 寫檔失敗", e)
        }
    }

    private fun encode(value: Any): String = JSONArray().put(value).toString()

    companion object {
        private const val TAG = "FlowStudy"
    }
}
