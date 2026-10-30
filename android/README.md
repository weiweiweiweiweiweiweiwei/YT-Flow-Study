# FlowStudy Android 版（自用）

把電腦上的 FlowStudy 擴充功能原封不動搬進 Android App：App 裡用 WebView 開**手機版 YouTube**（m.youtube.com，平板也是），
再把 `content.js`、`yt-player-bridge.js`、`web-lookup.js` 注入進去，背景的 `background.js` 跑在一個看不見的 WebView 裡。
擴充功能的程式碼只有一份（repo 根目錄），打包時直接複製進 APK，改擴充功能就等於同時改了 App。

## 安裝

1. 每次推上 GitHub，Actions 會自動編譯（`.github/workflows/android.yml`）。
2. 用手機打開 repo 的 **Releases → Android 最新版（android-latest）**，下載 `FlowStudy.apk`。
3. 第一次安裝時手機會問「是否允許安裝不明來源的應用程式」→ 允許瀏覽器安裝。
4. 之後有新版，一樣下載安裝就會覆蓋舊版，**資料保留**（APK 都用 `app/flowstudy-debug.keystore` 這把固定金鑰簽章）。

> ⚠️ 不要「解除安裝再重裝」——App 裡的單字資料會被一起刪掉。真的要重裝，先到「齒輪 → 同步到電腦 → 設定 → 立即備份」，
> 備份檔在手機的 `下載/FlowStudy Backups/`，重裝後用「從備份還原」補回來。

需要 Android 10 以上，以及較新的 Android System WebView（Play 商店更新即可）。

## 用法

打開就是手機版 YouTube，整個畫面都是 YouTube，沒有額外的按鈕列。看影片時：

1. 點播放器左上角的「關閉」膠囊，切成「沉浸模式」，學習用的字幕條就會出現。
2. 旁邊的齒輪是字幕設定（大小、雙字幕、短句、懸停暫停…）。

| 電腦 | 手機／平板 |
|---|---|
| 滑鼠移到字幕上自動暫停 | 手指碰到字幕就暫停 |
| 點單字查翻譯 | 點單字 |
| 拖曳選取片語 | 手指在字幕上**滑過**幾個字 |
| 雙擊翻譯框收藏 | **連點兩下**翻譯框 |
| 拖曳字幕左邊的 ⠿ 移動位置 | 按住 ⠿ 拖曳 |
| `a` / `s` / `d` 上一句、重播、下一句 | 右側半透明的「◀ ↻ ▶」 |
| 任何網頁反白英文按 `Z` | 反白後在系統選單點「FlowStudy 翻譯」 |

- 在 YouTube App 看到想學的影片：**分享 → FlowStudy**，就會在 FlowStudy 裡打開。
- 平板接藍牙鍵盤時，`a/s/d`、空白鍵、`Z` 都跟電腦一樣能用。
- 全螢幕時手機會自動轉橫向。
- 畫面固定是手機版面，不能兩指縮放。
- **背景播放**：影片播放中切到別的 App 或關掉螢幕，聲音會繼續；通知列會出現「FlowStudy 背景播放中」，點它回到影片、按「停止」就暫停。
- **Shorts 全部關掉**：首頁、搜尋結果、底部選單都看不到 Shorts，點到 Shorts 的連結也不會打開。
- 播放器上的進度條、全螢幕下方的按讚／收藏那一排、「更多影片」都藏起來了。
- 手機上不做複習：單字一樣會收藏起來，到電腦版的學習面板複習（要先設定下面的同步）。

## 擋廣告

App 內建擋廣告，不用另外裝東西：

- 影片廣告：在播放器拿到資料之前，就把資料裡的廣告刪掉；萬一漏網，偵測到廣告就靜音、直接跳到結尾、按「略過」。
- 首頁、搜尋結果、影片下方的廣告卡片藏起來；廣告伺服器與廣告追蹤的請求直接擋掉。

YouTube 偶爾會改廣告的格式，那時候可能又看得到廣告，或跳出「不允許使用廣告攔截器」的提示，需要更新 `assets/shell/adblock.js`。

## Google 雲端同步（選用）

要跟電腦共用同一份單字，需要在 Google Cloud Console 的 OAuth 用戶端（`core/cloud/config.js` 裡那個 `GOOGLE_CLIENT_ID`）
的「已授權的重新導向 URI」**再加一條**：

```text
http://localhost:47391/
```

加好之後在播放器的齒輪裡點「同步到電腦 → 設定」，按「使用 Google 登入」。登入畫面會用手機的瀏覽器開（Google 不允許在 App 內嵌的網頁登入）。

Google 給的登入憑證一小時過期。換新憑證時也得開一下瀏覽器分頁，畫面會閃一下，
所以 App 只在**剛打開、回到 App 時**或**正在看同步設定**時才換，看影片途中不會突然跳出來。

## 已知限制

- **YouTube 帳號可能登不進去**：Google 常常擋 App 內嵌網頁的登入。不登入也能看影片、用所有學習功能，
  只是沒有你的訂閱和推薦。
- YouTube 改版時，跟電腦版擴充功能一樣可能需要修 `content.js`。

## 架構

```
YouTube WebView ──┐                                   ┌── 背景 WebView（background.js）
同步設定 WebView ─┼── FlowStudyNative ── NativeHub ──┤
                  └   (WebMessageListener)            └── chrome.storage、fetch、備份、登入
```

| 檔案 | 作用 |
|---|---|
| `assets/shell/chrome-shim.js` | `chrome.storage / runtime / alarms / identity / downloads` 的替身，全部轉給原生端 |
| `assets/shell/youtube-prelude.js` | 建立 Trusted Types 預設政策（content.js 原本在隔離世界，不受 YouTube 的 CSP 限制） |
| `assets/shell/touch.js` | 把觸控手勢翻譯成 content.js 本來就認得的滑鼠事件 |
| `assets/shell/mobile.js` | 手機版 YouTube 的轉接：在 YouTube 的觸控層上方疊一層放字幕條與沉浸模式按鈕、藏起進度條／按讚列／更多影片／Shorts、回報播放狀態給背景播放 |
| `PlaybackService.kt` | 背景播放用的前景服務與通知 |
| `assets/shell/adblock.js`、`AdBlock.kt` | 擋廣告（播放器資料、頁面廣告欄位、廣告網路請求） |
| `assets/shell/background.html` | 載入 `background.js` 的空頁面 |
| `Scripts.kt` | 照 `manifest.json` 的規則把擴充功能檔案串成要注入的腳本 |
| `NativeHub.kt` | 三個 WebView 之間的總機。YouTube 頁面能做的事刻意限縮（看不到登入憑證與 Gemini 金鑰） |
| `LoopbackAuth.kt` | Google 登入：瀏覽器分頁 + 手機本機的小伺服器接收結果 |
| `BackupWriter.kt` | 自動備份寫進「下載」資料夾 |

除錯：手機接上電腦、開 USB 偵錯，在電腦的 Chrome 打開 `chrome://inspect` 就能看到三個 WebView 的 Console。

自己編譯：裝好 Android Studio 後打開 `android/` 資料夾，或在命令列執行 `./gradlew assembleDebug`。
