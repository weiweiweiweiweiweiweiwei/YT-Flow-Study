package com.flowstudy.app

import android.net.Uri

/**
 * 擋廣告的第一層：網路請求。
 *
 * 廣告伺服器、廣告追蹤的請求直接回空白，不送出去。
 * 影片「裡」的廣告跟正片走同一個影片伺服器，網路層分不出來，那部分交給 assets/shell/adblock.js。
 */
object AdBlock {
    private val blockedHosts = listOf(
        "doubleclick.net",
        "googlesyndication.com",
        "googleadservices.com",
        "googletagservices.com",
        "adservice.google.com",
        "imasdk.googleapis.com",
    )

    private val blockedYoutubePaths = listOf(
        "/pagead/",
        "/api/stats/ads",
        "/ptracking",
        "/get_midroll_info",
        "/youtubei/v1/player/ad_break",
    )

    fun shouldBlock(uri: Uri): Boolean {
        val host = uri.host ?: return false
        if (blockedHosts.any { host == it || host.endsWith(".$it") }) return true
        if (host.endsWith("youtube.com")) {
            val path = uri.path ?: return false
            return blockedYoutubePaths.any { path.startsWith(it) }
        }
        return false
    }
}
