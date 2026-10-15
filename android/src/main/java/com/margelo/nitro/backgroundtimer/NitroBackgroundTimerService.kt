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

  override fun onCreate() {
    super.onCreate()
    Log.i(TAG, "Service onCreate")
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    ForegroundServiceCoordinator.onStart(this, intent, startId)
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    ForegroundServiceCoordinator.onDestroy(this)
    super.onDestroy()
  }

  internal fun promote(intent: Intent?) {
    val config = NotificationConfig(
      title = intent?.getStringExtra(EXTRA_CONFIG_TITLE),
      text = intent?.getStringExtra(EXTRA_CONFIG_TEXT),
      channelId = intent?.getStringExtra(EXTRA_CONFIG_CHANNEL_ID),
      channelName = intent?.getStringExtra(EXTRA_CONFIG_CHANNEL_NAME),
      iconResourceName = intent?.getStringExtra(EXTRA_CONFIG_ICON_RESOURCE_NAME)
    )
    val notification = buildNotification(config)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
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
  }
}

/** Process-wide service arbitration. Entries contain notification snapshots, not
 * timers or ReactContexts; release/dispose removes them. Only the two opt-out
 * scalars intentionally survive runtime teardown until process termination. */
internal object ForegroundServiceCoordinator {
  enum class State { STOPPED, STARTING, STARTING_PENDING_STOP, ACTIVE }
  private val lock = Any()
  private data class Request(val intent: Intent, val revision: Long)
  private val requests = linkedMapOf<Long, Request>()
  private var state = State.STOPPED
  private var requestId = 0L
  private var service: NitroBackgroundTimerService? = null
  private var serviceRequestId = -1L
  private var disabled = false
  private var used = false

  fun markUsed() = synchronized(lock) { used = true }
  fun isDisabled(): Boolean = synchronized(lock) { disabled }

  fun disable() = synchronized(lock) {
    if (disabled) return@synchronized
    check(!used) {
      "disableForegroundService() must be called before any timer is scheduled " +
        "and before startBackgroundMode(). Call it once at app startup."
    }
    disabled = true
  }

  fun stateFor(ownerId: Long): State = synchronized(lock) {
    if (requests.containsKey(ownerId)) state else State.STOPPED
  }

  fun request(context: Context, ownerId: Long, config: Intent, newSession: Boolean, revision: Long) = synchronized(lock) {
    if (disabled) return@synchronized
    val representative = requests.keys.firstOrNull()
    val changed = requests[ownerId]?.revision != revision
    if (changed || newSession) requests[ownerId] = Request(config, revision)
    val refresh = (changed || newSession) && representative == ownerId
    if ((state == State.ACTIVE || state == State.STARTING) && !refresh) return@synchronized
    start(context)
  }

  // Called only under lock; serialize Android effects with owner admission.
  private fun start(context: Context) {
    val representative = requests.values.firstOrNull() ?: return
    requestId += 1
    state = State.STARTING
    val intent = Intent(representative.intent).apply {
      putExtra(NitroBackgroundTimerService.EXTRA_REQUEST_ID, requestId)
    }
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
      else context.startService(intent)
    } catch (e: Exception) {
      state = State.STOPPED
      Log.w("NitroBgTimer", "Failed to start foreground service; retry on next explicit or timer request", e)
    }
  }

  fun release(context: Context, ownerId: Long) = synchronized(lock) {
    val representative = requests.keys.firstOrNull()
    if (requests.remove(ownerId) == null) return@synchronized
    if (requests.isNotEmpty()) {
      // The earliest remaining owner supplies the single shared notification.
      if (representative == ownerId) start(context)
    } else when (state) {
      State.STARTING, State.STARTING_PENDING_STOP -> state = State.STARTING_PENDING_STOP
      State.ACTIVE, State.STOPPED -> {
        requestId += 1
        state = State.STOPPED
        try {
          context.stopService(Intent(context, NitroBackgroundTimerService::class.java))
        } catch (e: Exception) {
          Log.w("NitroBgTimer", "Failed to stop foreground service", e)
        }
      }
    }
  }

  fun onStart(instance: NitroBackgroundTimerService, intent: Intent?, startId: Int) = synchronized(lock) {
    // Even a cancelled startForegroundService Intent must be promoted before
    // stopping. A stale Intent can only publish CURRENT demand's snapshot.
    val config = requests.values.firstOrNull()?.intent ?: intent
    val wasPromoted = service === instance
    try {
      instance.promote(config)
    } catch (e: Exception) {
      state = State.STOPPED
      Log.w("NitroBgTimer", "startForeground failed; wake-lock fallback, retry on next request", e)
      if (!wasPromoted) instance.stopSelf(startId)
      return@synchronized
    }
    service = instance
    serviceRequestId = requestId
    if (requests.isEmpty()) {
      state = State.STOPPED
      instance.stopSelf(startId)
    } else {
      state = State.ACTIVE
    }
  }

  fun onDestroy(instance: NitroBackgroundTimerService) = synchronized(lock) {
    if (service === instance) {
      service = null
      // A stop of the old session must not erase a newer pending request.
      if (serviceRequestId == requestId) state = State.STOPPED
      serviceRequestId = -1L
    }
  }
}
