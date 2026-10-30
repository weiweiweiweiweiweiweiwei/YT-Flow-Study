package com.flowstudy.app

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.widget.Toast
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.UserAgentMetadata
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream

/**
 * 整個 App 就是一個手機版 YouTube（m.youtube.com），注入 content.js 等，跟電腦上裝擴充功能一樣。
 *
 * - 全螢幕時右側可以顯示一排半透明的「◀ ↻ ▶」（a/s/d 的按鈕版，設定裡打開）
 * - 切到背景時影片繼續播（PlaybackService）；Shorts 一律不開
 * - 另外有一個 1×1、看不見的 WebView 跑 background.js
 * - 同步設定頁（review.html 的設定）平常不出現，只在播放器齒輪裡點「同步到電腦」時才打開
 */
class MainActivity : ComponentActivity() {

    private lateinit var hub: NativeHub
    private lateinit var youtube: FlowWebView
    private lateinit var settingsView: WebView
    private lateinit var backgroundView: WebView

    private lateinit var root: FrameLayout
    private lateinit var fullscreenHost: FrameLayout
    private lateinit var sentencePill: View

    private var settingsVisible = false
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    private var isResumedNow = false
    private var firstResume = true
    private var lastResumeAt = 0L
    private var lastResumeSyncAt = 0L
    private var videoPlaying = false

    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    private val pickFile = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        filePathCallback?.onReceiveValue(uri?.let { arrayOf(it) })
        filePathCallback = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        ) {
            AlertDialog.Builder(this)
                .setTitle("需要更新 WebView")
                .setMessage("FlowStudy 需要較新版的「Android System WebView」。請到 Play 商店更新 Android System WebView 與 Chrome 後再開啟。")
                .setPositiveButton("好") { _, _ -> finish() }
                .setCancelable(false)
                .show()
            return
        }

        // 只給自己用：開著方便用電腦的 chrome://inspect 除錯
        WebView.setWebContentsDebuggingEnabled(true)

        val defaultUa = WebSettings.getDefaultUserAgent(this)
        hub = NativeHub(this, defaultUa.replace("; wv)", ")"))
        val installReason = computeInstallReason()

        buildLayout()
        setupBackground(installReason)
        setupSettings(installReason)
        setupYoutube(defaultUa)

        onBackPressedDispatcher.addCallback(this) { handleBack() }

        // 背景播放的通知按「停止」：把影片暫停
        PlaybackService.onStopRequested = { runOnUiThread { pauseVideos() } }
        // Android 13 起要允許通知，背景播放時通知列才看得到「停止」按鈕
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        if (!handleIntent(intent)) youtube.loadUrl(HOME_URL)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        if (!::hub.isInitialized) return
        isResumedNow = true
        lastResumeAt = SystemClock.elapsedRealtime()
        stopService(Intent(this, PlaybackService::class.java))
        hub.auth.onActivityResumed()

        // 回到 App 時跟雲端對一次帳（剛啟動時 background.js 自己會做，不用重複；沒登入就什麼都不做）
        if (!firstResume && lastResumeAt - lastResumeSyncAt > RESUME_SYNC_INTERVAL_MS) {
            lastResumeSyncAt = lastResumeAt
            hub.sendToBackground(JSONObject().put("type", "sync:now"))
        }
        if (firstResume) lastResumeSyncAt = lastResumeAt
        firstResume = false
    }

    override fun onPause() {
        super.onPause()
        if (!::hub.isInitialized) return
        isResumedNow = false
        // 背景播放：影片正在播就開前景服務，系統才不會把 App 凍結、聲音才會繼續。
        // 影片沒在播就什麼都不做（WebView 不暫停，回來時畫面還在原處）。
        if (videoPlaying && !settingsVisible) {
            try {
                startForegroundService(Intent(this, PlaybackService::class.java))
            } catch (e: Exception) {
                Log.w(TAG, "無法開始背景播放", e)
            }
        }
        hub.flush()
    }

    override fun onDestroy() {
        PlaybackService.onStopRequested = null
        stopService(Intent(this, PlaybackService::class.java))
        if (::hub.isInitialized) {
            hub.flush()
            listOf(youtube, settingsView, backgroundView).forEach { it.destroy() }
        }
        super.onDestroy()
    }

    // ---------- 給 NativeHub / LoopbackAuth 用 ----------

    /** 背景換 Google token 會閃一下瀏覽器分頁，只在「剛打開 App」或「正在看同步設定」時允許。 */
    fun allowSilentAuth(): Boolean =
        isResumedNow && (settingsVisible || SystemClock.elapsedRealtime() - lastResumeAt < 20_000)

    fun copyToClipboard(text: String) {
        val clipboard = getSystemService(android.content.ClipboardManager::class.java)
        clipboard.setPrimaryClip(android.content.ClipData.newPlainText("FlowStudy 版面資訊", text))
        Toast.makeText(this, "已複製，貼到對話裡就可以", Toast.LENGTH_SHORT).show()
    }

    /** mobile.js 回報主影片開始／暫停。在背景時影片停了，就把背景播放的通知收掉。 */
    fun onVideoPlaying(playing: Boolean) {
        videoPlaying = playing
        if (!playing && !isResumedNow) stopService(Intent(this, PlaybackService::class.java))
    }

    fun bringToFront() {
        startActivity(
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        )
    }

    fun openUrl(url: String) {
        if (url.isEmpty()) return
        val uri = Uri.parse(url)
        when {
            isYoutube(uri) -> showYoutube(toMobileYoutube(uri).toString())
            uri.host == Scripts.APP_HOST -> showSettings()
            else -> openExternal(uri)
        }
    }

    /** 播放器齒輪 →「同步到電腦」：打開 Google 登入與同步的設定頁。 */
    fun showSettings() {
        if (customView != null) customViewCallback?.onCustomViewHidden()
        settingsVisible = true
        pauseVideos()
        settingsView.loadUrl(Scripts.SETTINGS_URL)
        settingsView.visibility = View.VISIBLE
        updateSentencePill()
    }

    // ---------- 版面 ----------

    private fun buildLayout() {
        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }

        youtube = FlowWebView(this)
        root.addView(youtube, FrameLayout.LayoutParams(MATCH, MATCH))

        sentencePill = sentenceControls()
        root.addView(sentencePill, pillLayoutParams(fullscreen = false))

        settingsView = WebView(this).apply {
            visibility = View.GONE
            setBackgroundColor(Color.WHITE)
        }
        root.addView(settingsView, FrameLayout.LayoutParams(MATCH, MATCH))

        // 背景頁：要掛在畫面上（只有 1×1、完全透明），WebView 才會被當成「可見」而正常執行
        backgroundView = WebView(this).apply { alpha = 0f }
        root.addView(backgroundView, FrameLayout.LayoutParams(1, 1))

        fullscreenHost = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            visibility = View.GONE
        }
        root.addView(fullscreenHost, FrameLayout.LayoutParams(MATCH, MATCH))

        setContentView(root)
        // 轉向、鍵盤升起時畫面高度會變，往上推的高度要重新算
        root.addOnLayoutChangeListener { _, _, top, _, bottom, _, oldTop, _, oldBottom ->
            if (bottom - top != oldBottom - oldTop && topCropPx > 0) root.post { applyTopCrop() }
        }
        updateSentencePill()
    }

    /** 右側那一排半透明的句子按鈕（◀ 上一句、↻ 重播、▶ 下一句）。 */
    private fun sentenceControls(): View {
        val pill = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                cornerRadius = dp(22).toFloat()
                setColor(Color.argb(110, 0, 0, 0))
            }
            alpha = 0.8f
        }
        for ((label, key) in listOf("◀" to "a", "↻" to "s", "▶" to "d")) {
            pill.addView(TextView(this).apply {
                text = label
                setTextColor(Color.WHITE)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
                gravity = Gravity.CENTER
                val outValue = TypedValue()
                context.theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, outValue, true)
                setBackgroundResource(outValue.resourceId)
                setOnClickListener { pressKey(key) }
            }, LinearLayout.LayoutParams(dp(46), dp(50)))
        }
        return pill
    }

    private fun pillLayoutParams(fullscreen: Boolean) = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.WRAP_CONTENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
        if (fullscreen) Gravity.END or Gravity.CENTER_VERTICAL else Gravity.END or Gravity.BOTTOM,
    ).apply {
        marginEnd = dp(6)
        if (!fullscreen) bottomMargin = dp(96)
    }

    /** 只在影片全螢幕、而且設定裡「句子按鈕」打開時出現（手機上少用，預設關閉）。 */
    fun updateSentencePill() {
        if (!::sentencePill.isInitialized) return
        val enabled = hub.local.get(JSONArray().put(SENTENCE_BUTTONS_KEY)).optBoolean(SENTENCE_BUTTONS_KEY, false)
        sentencePill.visibility = if (enabled && customView != null && !settingsVisible) View.VISIBLE else View.GONE
    }

    private fun moveSentencePill(toFullscreen: Boolean) {
        (sentencePill.parent as? ViewGroup)?.removeView(sentencePill)
        if (toFullscreen) fullscreenHost.addView(sentencePill, pillLayoutParams(fullscreen = true))
        else root.addView(sentencePill, 1, pillLayoutParams(fullscreen = false))
    }

    // ---------- 三個 WebView ----------

    private val assetLoader by lazy {
        WebViewAssetLoader.Builder()
            .setDomain(Scripts.APP_HOST)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun commonSettings(view: WebView) {
        with(view.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
        }
    }

    private fun setupBackground(installReason: String?) {
        commonSettings(backgroundView)
        WebViewCompat.addWebMessageListener(backgroundView, BRIDGE_NAME, setOf(Scripts.APP_ORIGIN), hub.listener)
        WebViewCompat.addDocumentStartJavaScript(backgroundView, Scripts.page(this, installReason), setOf(Scripts.APP_ORIGIN))
        backgroundView.webViewClient = object : AppPageClient() {
            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                hub.onBackgroundReloading()
            }
        }
        backgroundView.webChromeClient = LoggingChromeClient("background")
        backgroundView.loadUrl(Scripts.BACKGROUND_URL)
    }

    private fun setupSettings(installReason: String?) {
        commonSettings(settingsView)
        WebViewCompat.addWebMessageListener(settingsView, BRIDGE_NAME, setOf(Scripts.APP_ORIGIN), hub.listener)
        WebViewCompat.addDocumentStartJavaScript(settingsView, Scripts.page(this, installReason), setOf(Scripts.APP_ORIGIN))
        settingsView.webViewClient = AppPageClient()
        settingsView.webChromeClient = object : LoggingChromeClient("settings") {
            override fun onShowFileChooser(
                webView: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: WebChromeClient.FileChooserParams,
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback
                return try {
                    pickFile.launch(arrayOf("application/json", "text/plain", "*/*"))
                    true
                } catch (e: ActivityNotFoundException) {
                    filePathCallback = null
                    false
                }
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupYoutube(defaultUa: String) {
        commonSettings(youtube)
        with(youtube.settings) {
            // 一律用手機版 YouTube（平板也是），版面照網頁自己的 viewport，不能兩指縮放
            userAgentString = mobileUserAgent(chromeVersion(defaultUa))
            useWideViewPort = true
            loadWithOverviewMode = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
        }
        disguiseAsChrome(youtube.settings, chromeVersion(defaultUa))
        CookieManager.getInstance().setAcceptThirdPartyCookies(youtube, true)
        WebViewCompat.addWebMessageListener(youtube, BRIDGE_NAME, Scripts.YOUTUBE_ORIGINS, hub.listener)
        WebViewCompat.addDocumentStartJavaScript(youtube, Scripts.youtube(this), Scripts.YOUTUBE_ORIGINS)

        youtube.onLookupSelection = { mode ->
            youtube.evaluateJavascript(Scripts.pressKey("z")) { mode.finish() }
        }

        youtube.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                if (isShorts(uri)) {
                    blockedShorts()
                    return true
                }
                if (uri.host == "www.youtube.com" || uri.host == "youtube.com" || uri.host == "youtu.be") {
                    view.loadUrl(toMobileYoutube(uri).toString())
                    return true
                }
                if (isAllowedInYoutubeView(uri)) return false
                if (!request.isForMainFrame) return false
                openExternal(uri)
                return true
            }

            // 廣告：在網路層直接擋掉廣告與廣告追蹤的請求（影片裡的廣告另外由 adblock.js 處理）
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                if (!AdBlock.shouldBlock(request.url)) return null
                return WebResourceResponse("text/plain", "utf-8", 200, "OK", emptyMap(), ByteArrayInputStream(ByteArray(0)))
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                // YouTube 是單頁應用，換頁不會重新載入，只會走到這裡；點進 Shorts 也是在這裡才知道
                if (url != null && isShorts(Uri.parse(url))) {
                    if (view.canGoBack()) view.goBack() else view.loadUrl(HOME_URL)
                    blockedShorts()
                    return
                }
                updateSentencePill()
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                Log.e(TAG, "YouTube WebView 的渲染程序結束了，重新建立畫面")
                recreateAfterCrash()
                return true
            }
        }

        youtube.webChromeClient = object : LoggingChromeClient("youtube") {
            override fun onShowCustomView(view: View, callback: WebChromeClient.CustomViewCallback) {
                enterFullscreen(view, callback)
            }

            override fun onHideCustomView() {
                exitFullscreen()
            }

            // 影片載入前 WebView 預設會畫一個灰色的播放圖示，換成全透明
            override fun getDefaultVideoPoster(): Bitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
        }
    }

    private open inner class AppPageClient : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            assetLoader.shouldInterceptRequest(request.url)

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            if (uri.host == Scripts.APP_HOST) return false
            openUrl(uri.toString())
            return true
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            Log.e(TAG, "WebView 的渲染程序結束了，重新建立畫面")
            recreateAfterCrash()
            return true
        }
    }

    private open inner class LoggingChromeClient(private val name: String) : WebChromeClient() {
        override fun onConsoleMessage(message: ConsoleMessage): Boolean {
            val text = "[$name] ${message.message()} (${message.sourceId()}:${message.lineNumber()})"
            when (message.messageLevel()) {
                ConsoleMessage.MessageLevel.ERROR -> Log.e(TAG, text)
                ConsoleMessage.MessageLevel.WARNING -> Log.w(TAG, text)
                else -> Log.d(TAG, text)
            }
            return true
        }
    }

    private fun recreateAfterCrash() {
        if (isFinishing) return
        root.post { recreate() }
    }

    // ---------- 切換畫面 ----------

    private fun showYoutube(url: String?) {
        hideSettings()
        if (url != null) youtube.loadUrl(url)
    }

    private fun hideSettings() {
        if (!settingsVisible) return
        settingsVisible = false
        settingsView.visibility = View.GONE
        settingsView.loadUrl("about:blank")
        updateSentencePill()
    }

    private fun pauseVideos() {
        youtube.evaluateJavascript("document.querySelectorAll('video').forEach(function(v){ v.pause(); });", null)
    }

    private fun isShorts(uri: Uri): Boolean = isYoutube(uri) && (uri.path ?: "").startsWith("/shorts")

    private var lastShortsToastAt = 0L

    private fun blockedShorts() {
        val now = SystemClock.elapsedRealtime()
        if (now - lastShortsToastAt < 3000) return
        lastShortsToastAt = now
        Toast.makeText(this, "Shorts 已關閉", Toast.LENGTH_SHORT).show()
    }

    private fun pressKey(key: String) {
        youtube.evaluateJavascript(Scripts.pressKey(key), null)
    }

    private fun handleBack() {
        when {
            customView != null -> customViewCallback?.onCustomViewHidden()
            settingsVisible -> hideSettings()
            youtube.canGoBack() -> youtube.goBack()
            else -> moveTaskToBack(true) // 保留畫面狀態，下次打開回到原本那部影片
        }
    }

    // ---------- 全螢幕 ----------

    private fun enterFullscreen(view: View, callback: WebChromeClient.CustomViewCallback) {
        if (customView != null) {
            callback.onCustomViewHidden()
            return
        }
        customView = view
        customViewCallback = callback
        fullscreenHost.addView(view, FrameLayout.LayoutParams(MATCH, MATCH))
        moveSentencePill(toFullscreen = true)
        fullscreenHost.visibility = View.VISIBLE
        updateSentencePill()

        WindowCompat.getInsetsController(window, window.decorView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
        // 手機直拿看影片太小：全螢幕時轉橫向。平板維持使用者自己的方向
        if (resources.configuration.smallestScreenWidthDp < 600) {
            requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        }
    }

    private fun exitFullscreen() {
        if (customView == null) return
        moveSentencePill(toFullscreen = false)
        fullscreenHost.removeAllViews()
        fullscreenHost.visibility = View.GONE
        customView = null
        customViewCallback = null
        WindowCompat.getInsetsController(window, window.decorView).show(WindowInsetsCompat.Type.systemBars())
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        updateSentencePill()
    }

    // ---------- 外部開啟：分享進來的 YouTube 連結 ----------

    /** 回傳 true 表示已經從 intent 載入了要開的網址。 */
    private fun handleIntent(intent: Intent?): Boolean {
        if (intent == null) return false
        if (intent.data?.scheme == LoopbackAuth.RETURN_SCHEME) return false // 登入完成，回到 App 而已
        if (intent.action == Intent.ACTION_SEND) {
            val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: return false
            val link = Regex("https?://\\S+").find(text)?.value ?: return false
            val uri = Uri.parse(link)
            if (!isYoutube(uri)) return false
            if (isShorts(uri)) {
                blockedShorts()
                return false
            }
            showYoutube(toMobileYoutube(uri).toString())
            return true
        }
        return false
    }

    private fun openExternal(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (e: ActivityNotFoundException) {
            Log.w(TAG, "沒有 App 可以開啟 $uri")
        }
    }

    private fun isYoutube(uri: Uri): Boolean {
        val host = uri.host ?: return false
        return host == "youtu.be" || host == "youtube.com" || host.endsWith(".youtube.com")
    }

    private fun isAllowedInYoutubeView(uri: Uri): Boolean {
        val host = uri.host ?: return false
        if (isYoutube(uri)) return true
        // 同意 Cookie 的畫面、YouTube 帳號登入
        return host == "consent.google.com" || host == "accounts.google.com" || host.endsWith(".google.com") && uri.path?.startsWith("/sorry") == true
    }

    private fun toMobileYoutube(uri: Uri): Uri {
        if (uri.host == "youtu.be") {
            val id = uri.lastPathSegment ?: return Uri.parse(HOME_URL)
            val b = Uri.parse("https://m.youtube.com/watch").buildUpon().appendQueryParameter("v", id)
            uri.getQueryParameter("t")?.let { b.appendQueryParameter("t", it) }
            return b.build()
        }
        if (uri.host == "www.youtube.com" || uri.host == "youtube.com" || uri.host == "music.youtube.com") {
            return uri.buildUpon().scheme("https").authority("m.youtube.com").build()
        }
        return uri
    }

    // ---------- 雜項 ----------

    private fun computeInstallReason(): String? {
        val prefs = getSharedPreferences("flowstudy", MODE_PRIVATE)
        val last = prefs.getInt("lastVersionCode", -1)
        val current = BuildConfig.VERSION_CODE
        if (last == current) return null
        prefs.edit().putInt("lastVersionCode", current).apply()
        return if (last == -1) "install" else "update"
    }

    private fun chromeVersion(defaultUa: String): String =
        Regex("Chrome/([\\d.]+)").find(defaultUa)?.groupValues?.get(1) ?: "130.0.0.0"

    /** 跟手機版 Chrome 一字不差的 User-Agent（Chrome 現在固定寫 Android 10、型號 K、版本只留主版號）。平板也會拿到手機版 YouTube。 */
    private fun mobileUserAgent(chrome: String): String {
        val major = chrome.substringBefore('.')
        return "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$major.0.0.0 Mobile Safari/537.36"
    }

    /**
     * 除了 User-Agent，WebView 還有兩個地方會洩漏「我是 App 裡的 WebView」，YouTube 看到就給另一套版面
     * （進度條內縮、看影片時頂端的 YouTube 列不會收起來）：
     *   - 每個請求都帶 X-Requested-With: com.flowstudy.app
     *   - Sec-CH-UA 標頭的品牌寫的是 "Android WebView"
     * 兩個都改成跟 Chrome 一樣。舊版 WebView 不支援的話就算了。
     */
    private fun disguiseAsChrome(settings: WebSettings, chrome: String) {
        try {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST)) {
                WebSettingsCompat.setRequestedWithHeaderOriginAllowList(settings, emptySet())
            }
            if (WebViewFeature.isFeatureSupported(WebViewFeature.USER_AGENT_METADATA)) {
                val major = chrome.substringBefore('.')
                val brands = listOf(
                    "Chromium" to major,
                    "Google Chrome" to major,
                    "Not?A_Brand" to "99",
                ).map { (brand, version) ->
                    UserAgentMetadata.BrandVersion.Builder()
                        .setBrand(brand)
                        .setMajorVersion(version)
                        .setFullVersion(if (version == major) chrome else "$version.0.0.0")
                        .build()
                }
                WebSettingsCompat.setUserAgentMetadata(
                    settings,
                    UserAgentMetadata.Builder()
                        .setBrandVersionList(brands)
                        .setFullVersion(chrome)
                        .setPlatform("Android")
                        .setPlatformVersion("14.0.0")
                        .setModel("")
                        .setMobile(true)
                        .build(),
                )
            }
        } catch (e: Exception) {
            Log.w(TAG, "無法調整 WebView 的瀏覽器識別資訊", e)
        }
    }

    // ---------- 看影片時把頂端的 YouTube 列推到畫面外 ----------
    //
    // 手機版 Chrome 看影片時頂端只剩播放器；App 裡 YouTube 有時候還是把「YouTube 標誌、搜尋」那一列留著。
    // mobile.js 量出那一列的高度回報過來，這裡把整個 WebView 往上移那麼多、高度加那麼多，
    // 那一列就剛好落在畫面外，播放器貼齊頂端。離開觀看頁時回報 0，復原。
    private var topCropPx = 0

    fun setTopCrop(px: Int) {
        val value = px.coerceIn(0, dp(120))
        if (value == topCropPx) return
        topCropPx = value
        applyTopCrop()
    }

    private fun applyTopCrop() {
        val height = root.height
        if (topCropPx == 0 || height == 0) {
            youtube.translationY = 0f
            youtube.layoutParams = FrameLayout.LayoutParams(MATCH, MATCH)
        } else {
            youtube.translationY = -topCropPx.toFloat()
            youtube.layoutParams = FrameLayout.LayoutParams(MATCH, height + topCropPx)
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        private const val TAG = "FlowStudy"
        private const val BRIDGE_NAME = "FlowStudyNative"
        private const val HOME_URL = "https://m.youtube.com/"
        private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        private const val RESUME_SYNC_INTERVAL_MS = 20 * 60 * 1000L
        /** mobile.js 設定視窗裡「句子按鈕」開關存的 chrome.storage.local key */
        const val SENTENCE_BUTTONS_KEY = "flowstudyAndroidSentenceButtons"
    }
}
