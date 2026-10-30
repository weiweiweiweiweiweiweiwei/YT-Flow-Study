# FlowStudy Android 版（自用）

把電腦上的 FlowStudy 擴充功能原封不動搬進 Android App：App 裡用 WebView 開**桌面版 YouTube**，
再把 `content.js`、`yt-player-bridge.js`、`web-lookup.js` 注入進去，背景的 `background.js` 跑在一個看不見的 WebView 裡。
擴充功能的程式碼只有一份（repo 根目錄），打包時直接複製進 APK，改擴充功能就等於同時改了 App。

## 安裝

1. 每次推上 GitHub，Actions 會自動編譯（`.github/workflows/android.yml`）。
2. 用手機打開 repo 的 **Releases → Android 最新版（android-latest）**，下載 `FlowStudy.apk`。
3. 第一次安裝時手機會問「是否允許安裝不明來源的應用程式」→ 允許瀏覽器安裝。
4. 之後有新版，一樣下載安裝就會覆蓋舊版，**資料保留**（APK 都用 `app/flowstudy-debug.keystore` 這把固定金鑰簽章）。

> ⚠️ 不要「解除安裝再重裝」——App 裡的單字資料會被一起刪掉。真的要重裝，先到「學習面板 → 設定 → 立即備份」，
> 備份檔在手機的 `下載/FlowStudy Backups/`，重裝後用「從備份還原」補回來。

需要 Android 10 以上，以及較新的 Android System WebView（Play 商店更新即可）。

## 用法

| 電腦 | 手機／平板 |
|---|---|
| 滑鼠移到字幕上自動暫停 | 手指碰到字幕就暫停 |
| 點單字查翻譯 | 點單字 |
| 拖曳選取片語 | 手指在字幕上**滑過**幾個字 |
| 雙擊翻譯框收藏 | **連點兩下**翻譯框 |
| 拖曳字幕左邊的 ⠿ 移動位置 | 按住 ⠿ 拖曳 |
| `a` / `s` / `d` 上一句、重播、下一句 | 底部的「◀ 上句」「↻ 重播」「下句 ▶」，全螢幕時在右側 |
| 任何網頁反白英文按 `Z` | 反白後在系統選單點「FlowStudy 翻譯」 |
| 工具列圖示 → 首頁 | 底部的「學習面板」 |

- 在 YouTube App 看到想學的影片：**分享 → FlowStudy**，就會在 FlowStudy 裡打開。
- 平板接藍牙鍵盤時，`a/s/d`、空白鍵、`Z` 都跟電腦一樣能用。
- 全螢幕時手機會自動轉橫向。

## Google 雲端同步（選用）

要跟電腦共用同一份單字，需要在 Google Cloud Console 的 OAuth 用戶端（`core/cloud/config.js` 裡那個 `GOOGLE_CLIENT_ID`）
的「已授權的重新導向 URI」**再加一條**：

```text
http://localhost:47391/
```

加好之後到「學習面板 → 設定 → 使用 Google 登入」。登入畫面會用手機的瀏覽器開（Google 不允許在 App 內嵌的網頁登入）。

Google 給的登入憑證一小時過期。換新憑證時也得開一下瀏覽器分頁，畫面會閃一下，
所以 App 只在**剛打開、回到 App 時**或**正在看學習面板**時才換，看影片途中不會突然跳出來。

## 已知限制

- **YouTube 帳號可能登不進去**：Google 常常擋 App 內嵌網頁的登入。不登入也能看影片、用所有學習功能，
  只是沒有你的訂閱和推薦。
- 用的是桌面版 YouTube，手機直拿畫面會比較小，可以兩指放大，或直接全螢幕看。
- YouTube 改版時，跟電腦版擴充功能一樣可能需要修 `content.js`。

## 架構

```
YouTube WebView ──┐                                   ┌── 背景 WebView（background.js）
學習面板 WebView ─┼── FlowStudyNative ── NativeHub ──┤
                  └   (WebMessageListener)            └── chrome.storage、fetch、備份、登入
```

| 檔案 | 作用 |
|---|---|
| `assets/shell/chrome-shim.js` | `chrome.storage / runtime / alarms / identity / downloads` 的替身，全部轉給原生端 |
| `assets/shell/youtube-prelude.js` | 建立 Trusted Types 預設政策（content.js 原本在隔離世界，不受 YouTube 的 CSP 限制） |
| `assets/shell/touch.js` | 把觸控手勢翻譯成 content.js 本來就認得的滑鼠事件 |
| `assets/shell/background.html` | 載入 `background.js` 的空頁面 |
| `Scripts.kt` | 照 `manifest.json` 的規則把擴充功能檔案串成要注入的腳本 |
| `NativeHub.kt` | 三個 WebView 之間的總機。YouTube 頁面能做的事刻意限縮（看不到登入憑證與 Gemini 金鑰） |
| `LoopbackAuth.kt` | Google 登入：瀏覽器分頁 + 手機本機的小伺服器接收結果 |
| `BackupWriter.kt` | 自動備份寫進「下載」資料夾 |

除錯：手機接上電腦、開 USB 偵錯，在電腦的 Chrome 打開 `chrome://inspect` 就能看到三個 WebView 的 Console。

自己編譯：裝好 Android Studio 後打開 `android/` 資料夾，或在命令列執行 `./gradlew assembleDebug`。
