package com.flowstudy.app

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore

/**
 * chrome.downloads.download 的替身：把自動備份寫進手機的「下載」資料夾。
 *
 * 跟電腦版一樣放在 下載/FlowStudy Backups/，所以就算把 App 解除安裝，備份檔也還在，
 * 重新安裝後可以在設定頁「從備份還原」。
 */
class BackupWriter(private val context: Context) {

    /** relativePath 例如 "FlowStudy Backups/flowstudy-backup-2026-10-30.json"。回傳實際寫入的完整路徑。 */
    fun save(relativePath: String, bytes: ByteArray, conflictAction: String): String {
        val clean = relativePath.replace('\\', '/').trim('/')
        val name = clean.substringAfterLast('/')
        val folder = clean.substringBeforeLast('/', "")
        val dir = Environment.DIRECTORY_DOWNLOADS + "/" + (if (folder.isEmpty()) "" else "$folder/")
        val resolver = context.contentResolver
        val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI

        var uri: Uri? = null
        if (conflictAction == "overwrite") uri = find(collection, dir, name)

        if (uri == null) {
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.MIME_TYPE, "application/json")
                put(MediaStore.MediaColumns.RELATIVE_PATH, dir)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            uri = resolver.insert(collection, values) ?: throw IllegalStateException("無法在下載資料夾建立備份檔")
            resolver.openOutputStream(uri, "w").use { out ->
                (out ?: throw IllegalStateException("無法寫入備份檔")).write(bytes)
            }
            resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
        } else {
            resolver.openOutputStream(uri, "wt").use { out ->
                (out ?: throw IllegalStateException("無法寫入備份檔")).write(bytes)
            }
        }

        val actualName = displayName(uri) ?: name
        return "/storage/emulated/0/$dir$actualName"
    }

    private fun find(collection: Uri, dir: String, name: String): Uri? {
        val projection = arrayOf(MediaStore.MediaColumns._ID)
        val selection = "${MediaStore.MediaColumns.RELATIVE_PATH}=? AND ${MediaStore.MediaColumns.DISPLAY_NAME}=?"
        context.contentResolver.query(collection, projection, selection, arrayOf(dir, name), null)?.use { c ->
            if (c.moveToFirst()) return Uri.withAppendedPath(collection, c.getLong(0).toString())
        }
        return null
    }

    private fun displayName(uri: Uri): String? {
        context.contentResolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) return c.getString(0)
        }
        return null
    }
}
