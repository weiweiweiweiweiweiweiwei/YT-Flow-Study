package com.flowstudy.app

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
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
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * 整個 App 就這一個畫面：
 *
 *   ┌──────────────────────────────┐
 *   │  YouTube（桌面版網頁）         │ ← 注入 content.js 等，跟電腦上裝擴充功能一樣
 *   │  或 學習面板（review.html）    │
 *   ├──────────────────────────────┤
 *   │ YouTube 面板 ◀上句 ↻重播 下句▶ ⟳│ ← 手機沒有鍵盤，a/s/d 改成按鈕
 *   └──────────────────────────────┘
 *   另外還有一個 1×1、看不見的 WebView 跑 background.js。
 */
class MainActivity : ComponentActivity() {

    private lateinit var hub: NativeHub
    private lateinit var youtube: FlowWebView
    private lateinit var review: WebView
    private lateinit var backgroundView: WebView

    private lateinit var root: FrameLayout
    private lateinit var fullscreenHost: FrameLayout
    private lateinit var bottomBar: LinearLayout
    private lateinit var tabYoutube: TextView
    private lateinit var tabReview: TextView
    private val sentenceButtons = ArrayList<View>()

    private var reviewLoaded = false
    private var reviewVisible = false
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    private var isResumedNow = false
    private var firstResume = true
    private var lastResumeAt = 0L
    private var lastResumeSyncAt = 0L

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
        setupReview(installReason)
        setupYoutube(defaultUa)

        onBackPressedDispatcher.addCallback(this) { handleBack() }

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
        youtube.onResume()
        hub.auth.onActivityResumed()

        // 回到 App 時跟雲端對一次帳（剛啟動時 background.js 自己會做，不用重複）
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
        // 跟關掉分頁一樣：影片停下、沉浸計時暫停（content.js 看的是 visibilitychange）。
        // 背景頁不暫停，備份與同步照常。
        youtube.onPause()
        hub.flush()
    }

    override fun onDestroy() {
        if (::hub.isInitialized) {
            hub.flush()
            listOf(youtube, review, backgroundView).forEach { it.destroy() }
        }
        super.onDestroy()
    }

    // ---------- 給 NativeHub / LoopbackAuth 用 ----------

    /** 背景換 Google token 會閃一下瀏覽器分頁，只在「剛打開 App」或「正在看學習面板」時允許。 */
    fun allowSilentAuth(): Boolean =
        isResumedNow && (reviewVisible || SystemClock.elapsedRealtime() - lastResumeAt < 20_000)

    fun bringToFront() {
        startActivity(
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        )
    }

    fun openUrl(url: String) {
        if (url.isEmpty()) return
        val uri = Uri.parse(url)
        when {
            isYoutube(uri) -> showYoutube(toDesktopYoutube(uri).toString())
            uri.host == Scripts.APP_HOST -> showReview(url)
            else -> openExternal(uri)
        }
    }

    // ---------- 版面 ----------

    private fun buildLayout() {
        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }

        val column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val pages = FrameLayout(this)

        youtube = FlowWebView(this)
        review = WebView(this).apply { visibility = View.GONE }
        pages.addView(youtube, FrameLayout.LayoutParams(MATCH, MATCH))
        pages.addView(review, FrameLayout.LayoutParams(MATCH, MATCH))
        column.addView(pages, LinearLayout.LayoutParams(MATCH, 0, 1f))

        bottomBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(Color.parseColor("#111827"))
            gravity = Gravity.CENTER_VERTICAL
        }
        tabYoutube = barButton("YouTube") { showYoutube(null) }
        tabReview = barButton("學習面板") { showReview(null) }
        bottomBar.addView(tabYoutube, LinearLayout.LayoutParams(0, dp(48), 1.1f))
        bottomBar.addView(tabReview, LinearLayout.LayoutParams(0, dp(48), 1.1f))
        for ((label, key) in listOf("◀ 上句" to "a", "↻ 重播" to "s", "下句 ▶" to "d")) {
            val b = barButton(label) { pressKey(key) }
            sentenceButtons.add(b)
            bottomBar.addView(b, LinearLayout.LayoutParams(0, dp(48), 1f))
        }
        bottomBar.addView(barButton("⟳") { reloadCurrent() }, LinearLayout.LayoutParams(dp(44), dp(48)))
        column.addView(bottomBar, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT))

        root.addView(column, FrameLayout.LayoutParams(MATCH, MATCH))

        // 背景頁：要掛在畫面上（只有 1×1、完全透明），WebView 才會被當成「可見」而正常執行
        backgroundView = WebView(this).apply { alpha = 0f }
        root.addView(backgroundView, FrameLayout.LayoutParams(1, 1))

        fullscreenHost = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            visibility = View.GONE
        }
        root.addView(fullscreenHost, FrameLayout.LayoutParams(MATCH, MATCH))

        setContentView(root)
        updateTabs()
    }

    private fun barButton(label: String, onClick: () -> Unit): TextView = TextView(this).apply {
        text = label
        setTextColor(Color.parseColor("#E5E7EB"))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        gravity = Gravity.CENTER
        maxLines = 1
        val outValue = TypedValue()
        context.theme.resolveAttribute(android.R.attr.selectableItemBackground, outValue, true)
        setBackgroundResource(outValue.resourceId)
        setOnClickListener { onClick() }
    }

    /** 全螢幕時右側那一排半透明的句子按鈕。 */
    private fun fullscreenControls(): View {
        val pill = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                cornerRadius = dp(22).toFloat()
                setColor(Color.argb(90, 0, 0, 0))
            }
            alpha = 0.75f
        }
        for ((label, key) in listOf("◀" to "a", "↻" to "s", "▶" to "d")) {
            pill.addView(barButton(label) { pressKey(key) }.apply {
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
                setTextColor(Color.WHITE)
            }, LinearLayout.LayoutParams(dp(48), dp(52)))
        }
        return pill
    }

    private fun updateTabs() {
        val active = Color.parseColor("#60A5FA")
        val idle = Color.parseColor("#E5E7EB")
        tabYoutube.setTextColor(if (reviewVisible) idle else active)
        tabReview.setTextColor(if (reviewVisible) active else idle)
        val onWatchPage = !reviewVisible && (youtube.url ?: "").contains("/watch")
        sentenceButtons.forEach { it.visibility = if (onWatchPage) View.VISIBLE else View.GONE }
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

    private fun setupReview(installReason: String?) {
        commonSettings(review)
        WebViewCompat.addWebMessageListener(review, BRIDGE_NAME, setOf(Scripts.APP_ORIGIN), hub.listener)
        WebViewCompat.addDocumentStartJavaScript(review, Scripts.page(this, installReason), setOf(Scripts.APP_ORIGIN))
        review.webViewClient = AppPageClient()
        review.webChromeClient = object : LoggingChromeClient("review") {
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
            // 用桌面版 YouTube：content.js 是照桌面版的播放器（#movie_player、.ytp-*）寫的，
            // 手機版網頁（m.youtube.com）的結構完全不同。
            userAgentString = desktopUserAgent(defaultUa)
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(youtube, true)
        WebViewCompat.addWebMessageListener(youtube, BRIDGE_NAME, Scripts.YOUTUBE_ORIGINS, hub.listener)
        WebViewCompat.addDocumentStartJavaScript(youtube, Scripts.youtube(this), setOf("https://www.youtube.com"))

        youtube.onLookupSelection = { mode ->
            youtube.evaluateJavascript(Scripts.pressKey("z")) { mode.finish() }
        }

        youtube.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                if (uri.host == "m.youtube.com" || uri.host == "youtu.be") {
                    view.loadUrl(toDesktopYoutube(uri).toString())
                    return true
                }
                if (isAllowedInYoutubeView(uri)) return false
                if (!request.isForMainFrame) return false
                openExternal(uri)
                return true
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                updateTabs() // YouTube 是單頁應用，換影片不會重新載入頁面，只會走到這裡
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
            openUrl(uri.toString()) // 學習面板裡的影片連結 → 切到 YouTube 分頁播放
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
        reviewVisible = false
        review.visibility = View.GONE
        youtube.visibility = View.VISIBLE
        if (url != null) youtube.loadUrl(url)
        updateTabs()
    }

    private fun showReview(url: String?) {
        reviewVisible = true
        youtube.visibility = View.GONE
        review.visibility = View.VISIBLE
        // 學習面板每次切過來都重新整理一次，才看得到剛剛在影片裡收藏的單字
        if (url != null) review.loadUrl(url)
        else if (!reviewLoaded) review.loadUrl(Scripts.REVIEW_URL)
        else review.reload()
        reviewLoaded = true
        // 切走時影片先停下來，不然學習面板開著還在背景播
        youtube.evaluateJavascript("document.querySelectorAll('video').forEach(function(v){ v.pause(); });", null)
        updateTabs()
    }

    private fun reloadCurrent() {
        if (reviewVisible) review.reload() else youtube.reload()
    }

    private fun pressKey(key: String) {
        youtube.evaluateJavascript(Scripts.pressKey(key), null)
    }

    private fun handleBack() {
        when {
            customView != null -> customViewCallback?.onCustomViewHidden()
            reviewVisible && review.canGoBack() -> review.goBack()
            reviewVisible -> showYoutube(null)
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
        fullscreenHost.addView(fullscreenControls(), FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.END or Gravity.CENTER_VERTICAL,
        ).apply { marginEnd = dp(8) })
        fullscreenHost.visibility = View.VISIBLE

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
        fullscreenHost.removeAllViews()
        fullscreenHost.visibility = View.GONE
        customView = null
        customViewCallback = null
        WindowCompat.getInsetsController(window, window.decorView).show(WindowInsetsCompat.Type.systemBars())
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
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
            showYoutube(toDesktopYoutube(uri).toString())
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

    private fun toDesktopYoutube(uri: Uri): Uri {
        if (uri.host == "youtu.be") {
            val id = uri.lastPathSegment ?: return Uri.parse(HOME_URL)
            val b = Uri.parse("https://www.youtube.com/watch").buildUpon().appendQueryParameter("v", id)
            uri.getQueryParameter("t")?.let { b.appendQueryParameter("t", it) }
            return b.build()
        }
        if (uri.host == "m.youtube.com" || uri.host == "youtube.com" || uri.host == "music.youtube.com") {
            return uri.buildUpon().scheme("https").authority("www.youtube.com").build()
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

    private fun desktopUserAgent(defaultUa: String): String {
        val chrome = Regex("Chrome/([\\d.]+)").find(defaultUa)?.groupValues?.get(1) ?: "130.0.0.0"
        return "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$chrome Safari/537.36"
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        private const val TAG = "FlowStudy"
        private const val BRIDGE_NAME = "FlowStudyNative"
        private const val HOME_URL = "https://www.youtube.com/"
        private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        private const val RESUME_SYNC_INTERVAL_MS = 20 * 60 * 1000L
    }
}
