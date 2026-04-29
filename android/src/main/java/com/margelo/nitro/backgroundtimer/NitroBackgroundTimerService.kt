package com.margelo.nitro.backgroundtimer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Foreground service that keeps the host process at foreground scheduling
 * priority so background timers avoid the `bg_non_interactive` cgroup CPU
 * throttling that otherwise causes ~10% drift on modern Android devices.
 *
 * The service is controlled from [NitroBackgroundTimer] — started either
 * explicitly via `startBackgroundMode()` or implicitly when the first timer
 * is scheduled, and stopped when both the explicit flag is cleared and no
 * timers remain active.
 *
 * Declared as `foregroundServiceType="specialUse"` (API 34+) with the
 * `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` manifest property set to
 * `continue_user_initiated_background_timer`. `specialUse` is the documented
 * catch-all for valid foreground service use cases not covered by typed
 * categories (`mediaPlayback`, `location`, `dataSync`, `health`, etc.), and
 * has no platform-imposed cumulative timeout — the correct semantic category
 * for a user-initiated background timer of arbitrary duration. Consumers
 * must justify the declaration in the Play Console FGS section during
 * review; a ready-to-paste paragraph is in the README.
 */
class NitroBackgroundTimerService : Service() {
  private var currentOwnerId = NO_OWNER_ID
  private var currentRequestId = NO_REQUEST_ID

  override fun onCreate() {
    super.onCreate()
    Log.i(TAG, "Service onCreate")
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    Log.i(TAG, "Service onStartCommand (action=${intent?.action})")

    val ownerId = intent?.getLongExtra(EXTRA_OWNER_ID, NO_OWNER_ID) ?: NO_OWNER_ID
    val requestId = intent?.getLongExtra(EXTRA_REQUEST_ID, NO_REQUEST_ID) ?: NO_REQUEST_ID

    val config = NotificationConfig(
      title = intent?.getStringExtra(EXTRA_CONFIG_TITLE),
      text = intent?.getStringExtra(EXTRA_CONFIG_TEXT),
      channelId = intent?.getStringExtra(EXTRA_CONFIG_CHANNEL_ID),
      channelName = intent?.getStringExtra(EXTRA_CONFIG_CHANNEL_NAME),
      iconResourceName = intent?.getStringExtra(EXTRA_CONFIG_ICON_RESOURCE_NAME)
    )

    try {
      val notification = buildNotification(config)
      // API 34+ (UPSIDE_DOWN_CAKE) requires passing the foreground service
      // type explicitly for the new API-34 typed services. On older APIs
      // the 2-arg form remains valid and uses the manifest-declared type.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        startForeground(
          NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        )
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (e: Exception) {
      // On API 31+ the system can refuse the start with
      // ForegroundServiceStartNotAllowedException (e.g. background-start
      // restriction, missing POST_NOTIFICATIONS on API 34+). We log and
      // bail — the wake-lock-only fallback remains in effect for timers.
      Log.w(TAG, "startForeground failed, service will stop", e)
      if (ownerId != NO_OWNER_ID && requestId != NO_REQUEST_ID) {
        NitroBackgroundTimer.notifyForegroundServiceStartFailed(ownerId, requestId)
      }
      stopSelf(startId)
      return START_NOT_STICKY
    }

    if (ownerId == NO_OWNER_ID || requestId == NO_REQUEST_ID) {
      Log.w(TAG, "Service promoted without owner/request id, stopping")
      stopSelf(startId)
      return START_NOT_STICKY
    }

    currentOwnerId = ownerId
    currentRequestId = requestId

    when (NitroBackgroundTimer.notifyForegroundServiceStarted(ownerId, requestId)) {
      ForegroundServiceStartResult.ACTIVE -> {
        Log.i(TAG, "Service running in foreground")
      }
      ForegroundServiceStartResult.STOP_AFTER_START -> {
        Log.i(TAG, "Service promoted then stopping due to pending stop")
        stopSelf(startId)
      }
      ForegroundServiceStartResult.REJECTED -> {
        Log.w(TAG, "Foreground service request is stale or owner is gone, stopping")
        stopSelf(startId)
      }
    }

    // Do not auto-restart — NitroBackgroundTimer owns the lifecycle and will
    // re-issue startForegroundService() on the next timer if needed.
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    Log.i(TAG, "Service onDestroy")
    if (currentOwnerId != NO_OWNER_ID && currentRequestId != NO_REQUEST_ID) {
      NitroBackgroundTimer.notifyForegroundServiceDestroyed(currentOwnerId, currentRequestId)
      currentOwnerId = NO_OWNER_ID
      currentRequestId = NO_REQUEST_ID
    }
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun buildNotification(config: NotificationConfig): Notification {
    val channelId = config.channelId?.takeIf { it.isNotEmpty() } ?: DEFAULT_CHANNEL_ID
    val channelName = config.channelName?.takeIf { it.isNotEmpty() } ?: DEFAULT_CHANNEL_NAME
    val title = config.title?.takeIf { it.isNotEmpty() } ?: DEFAULT_TITLE
    val text = config.text?.takeIf { it.isNotEmpty() } ?: DEFAULT_TEXT

    // NotificationChannel is API 26+. On earlier versions the channel id is
    // simply ignored by NotificationCompat.Builder.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        channelId,
        channelName,
        NotificationManager.IMPORTANCE_LOW
      ).apply {
        setShowBadge(false)
        description = "Keeps background timers running accurately"
      }
      val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      nm.createNotificationChannel(channel)
    }

    val contentIntent = buildContentIntent()
    val iconRes = resolveIconResource(this, config.iconResourceName)

    val builder = NotificationCompat.Builder(this, channelId)
      .setContentTitle(title)
      .setContentText(text)
      .setSmallIcon(iconRes)
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setShowWhen(false)

    if (contentIntent != null) {
      builder.setContentIntent(contentIntent)
    }

    return builder.build()
  }

  private fun buildContentIntent(): PendingIntent? {
    return try {
      val launchIntent = packageManager.getLaunchIntentForPackage(packageName) ?: return null
      launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      // FLAG_IMMUTABLE is required on API 31+ for PendingIntents that won't
      // be modified later, and is available since API 23. Our minSdk is 23,
      // so it's safe to unconditionally OR it in.
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      PendingIntent.getActivity(this, 0, launchIntent, flags)
    } catch (e: Exception) {
      Log.w(TAG, "Failed to build content intent, notification will not be tappable", e)
      null
    }
  }

  /**
   * Three-tier icon resolution:
   *   1. Custom drawable name specified via configure()
   *   2. App launcher icon via PackageManager
   *   3. System info dialog icon as final fallback
   *
   * `getIdentifier` returns 0 on miss — we check for that and fall through.
   */
  private fun resolveIconResource(context: Context, requestedName: String?): Int {
    if (!requestedName.isNullOrEmpty()) {
      @Suppress("DiscouragedApi")
      val customId = context.resources.getIdentifier(
        requestedName, "drawable", context.packageName
      )
      if (customId != 0) return customId
      Log.w(TAG, "Custom icon '$requestedName' not found, falling back to app icon")
    }

    try {
      val appInfo = context.packageManager.getApplicationInfo(context.packageName, 0)
      val launcherIcon = appInfo.icon
      if (launcherIcon != 0) return launcherIcon
    } catch (e: Exception) {
      Log.w(TAG, "Could not resolve app launcher icon", e)
    }

    return android.R.drawable.ic_dialog_info
  }

  private data class NotificationConfig(
    val title: String?,
    val text: String?,
    val channelId: String?,
    val channelName: String?,
    val iconResourceName: String?
  )

  companion object {
    private const val TAG = "NitroBgTimer"

    const val NOTIFICATION_ID = 1
    const val ACTION_START = "com.margelo.nitro.backgroundtimer.action.START"
    const val EXTRA_OWNER_ID = "owner_id"
    const val EXTRA_REQUEST_ID = "request_id"
    const val EXTRA_CONFIG_TITLE = "config_title"
    const val EXTRA_CONFIG_TEXT = "config_text"
    const val EXTRA_CONFIG_CHANNEL_ID = "config_channel_id"
    const val EXTRA_CONFIG_CHANNEL_NAME = "config_channel_name"
    const val EXTRA_CONFIG_ICON_RESOURCE_NAME = "config_icon_resource_name"

    private const val DEFAULT_CHANNEL_ID = "nitro_bg_timer_channel"
    private const val DEFAULT_CHANNEL_NAME = "Background Timer"
    private const val DEFAULT_TITLE = "Background Timer Active"
    private const val DEFAULT_TEXT = "Tap to return to the app"
    private const val NO_OWNER_ID = -1L
    private const val NO_REQUEST_ID = -1L
  }
}
