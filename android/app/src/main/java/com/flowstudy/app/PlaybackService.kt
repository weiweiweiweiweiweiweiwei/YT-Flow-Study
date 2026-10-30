package com.flowstudy.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.os.IBinder

/**
 * 背景播放：App 切到背景、或關掉螢幕時，讓影片的聲音繼續。
 *
 * 網頁那邊（youtube-prelude.js）讓 YouTube 以為頁面一直看得見，所以它不會自己停；
 * 但 Android 會把背景的 App 凍結。開一個「正在播放媒體」的前景服務，系統就會讓 App 繼續跑，
 * 通知列會出現一則「背景播放中」，點它回到影片，按「停止」就暫停。
 */
class PlaybackService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            onStopRequested?.invoke()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "背景播放", NotificationManager.IMPORTANCE_LOW).apply {
                description = "App 在背景播放影片時顯示"
                setShowBadge(false)
            }
        )

        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stop = PendingIntent.getService(
            this, 1,
            Intent(this, PlaybackService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle("FlowStudy 背景播放中")
            .setContentText("點這裡回到影片")
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(
                Notification.Action.Builder(Icon.createWithResource(this, android.R.drawable.ic_media_pause), "停止", stop).build()
            )
            .build()

        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        return START_NOT_STICKY
    }

    companion object {
        private const val CHANNEL_ID = "playback"
        private const val NOTIFICATION_ID = 1
        private const val ACTION_STOP = "com.flowstudy.app.STOP_PLAYBACK"

        /** 通知列按「停止」時呼叫（MainActivity 設定：把影片暫停）。 */
        var onStopRequested: (() -> Unit)? = null
    }
}
