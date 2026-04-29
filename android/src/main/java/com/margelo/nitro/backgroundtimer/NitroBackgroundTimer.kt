package com.margelo.nitro.backgroundtimer

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.PowerManager
import android.os.Process
import android.util.Log
import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.ReactApplicationContext
import com.margelo.nitro.NitroModules
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

@DoNotStrip
class NitroBackgroundTimer : HybridNitroBackgroundTimerSpec(), LifecycleEventListener {
  // Captured at construction time. Must be a non-null `ReactApplicationContext`
  // because the class registers itself as a `LifecycleEventListener`. Validated
  // via `as?` + throw so we fail fast if Nitro ever starts handing us a plain
  // `Context` — a programmer error we want to surface immediately.
  private val reactContext: ReactApplicationContext = run {
    val ctx = NitroModules.applicationContext
    ctx as? ReactApplicationContext
      ?: throw IllegalStateException(
        "NitroBackgroundTimer requires NitroModules.applicationContext to be a ReactApplicationContext; " +
          "is Nitro installed and initialized before the first timer call?"
      )
  }

  private val timerThread = HandlerThread(
    "NitroBgTimer-Worker",
    Process.THREAD_PRIORITY_FOREGROUND
  ).apply { start() }
  private val handler = Handler(timerThread.looper)

  private val powerManager = reactContext.getSystemService(android.content.Context.POWER_SERVICE) as PowerManager

  @SuppressLint("InvalidWakeLockTag")
  private val wakeLock: PowerManager.WakeLock =
    powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG).apply {
      setReferenceCounted(false)
    }

  // ConcurrentHashMap kept as defence-in-depth even though all mutations are
  // serialized on the worker thread — no measurable overhead.
  private val timeoutRunnables = ConcurrentHashMap<Int, Runnable>()
  private val intervalRunnables = ConcurrentHashMap<Int, Runnable>()
  private val acceptedTimeoutIds = ConcurrentHashMap<Int, Boolean>()
  private val acceptedIntervalIds = ConcurrentHashMap<Int, Boolean>()
  private val firedTimerQueueLock = Any()
  private val firedTimerQueue = mutableListOf<FiredTimerEvent>()
  private val pendingIntervalEventIds = mutableSetOf<Int>()
  private val nextFiredTimerSequence = AtomicLong(1)

  // AtomicBoolean (not `@Volatile Boolean`) because `dispose()` uses
  // `compareAndSet(false, true)` to ensure exactly one thread wins the
  // dispose race. Two concurrent callers — e.g. user JS calling
  // `BackgroundTimer.dispose()` while `onHostDestroy` fires from the UI
  // thread — would otherwise both read false, both proceed past the guard,
  // and both reach the cleanup path.
  private val isDisposed = AtomicBoolean(false)

  // Serializes timer-scheduling side effects with the transition to disposed.
  // If dispose wins first, schedule blocks observe `isDisposed` before they
  // start services, acquire wake locks, or insert runnables. If a schedule
  // block is already running, dispose waits for that pre-dispose work to
  // finish before flipping the state and posting cleanup.
  private val lifecycleLock = Any()

  private val foregroundServiceOwnerId = nextForegroundServiceOwnerId.getAndIncrement()

  // Foreground service state. Protected by a small lock because state and
  // request id must move together: callbacks from the Android Service must not
  // be able to confirm or clear a newer request using an older Intent.
  private val foregroundServiceLock = Any()
  private var foregroundServiceState = ForegroundServiceState.STOPPED
  private var foregroundServiceRequestId = 0L
  private val isExplicitBackgroundModeRequested = AtomicBoolean(false)

  // Consumer opt-out flag. Set once via `disableForegroundService()` at app
  // startup and never reset — it is a process-lifetime declaration. The flag
  // lives on the HybridObject instance, which is recreated on next JS runtime
  // init, so the process-lifetime semantics are naturally enforced.
  private val isForegroundServiceDisabled = AtomicBoolean(false)

  // Written only from `configure()` on the JS thread. Read from
  // `startForegroundServiceInternal()`, which is invoked both from the JS
  // thread (explicit start path and the early-start path inside
  // setTimeout/setInterval) and from the worker thread (the safety-net
  // ensureForegroundServiceForTimer() call inside `handler.post`). The
  // @Volatile is therefore load-bearing, not belt-and-braces: it is what
  // makes configure()'s write visible to the worker thread without an
  // explicit happens-before relationship.
  //
  // `configure()` throws if the service is already active, which prevents
  // mid-session reconfiguration, so the only meaningful write-then-read
  // pattern is: configure → startForegroundServiceInternal (either thread)
  // → reads the stored reference. Any concurrent service start attempt
  // that loses the CAS returns without reading this field.
  @Volatile
  private var notificationConfig: NotificationConfig? = null

  private data class NotificationConfig(
    val title: String?,
    val text: String?,
    val channelId: String?,
    val channelName: String?,
    val iconResourceName: String?
  )

  private enum class ForegroundServiceState {
    STOPPED,
    STARTING,
    ACTIVE
  }

  init {
    registerForegroundServiceOwner(foregroundServiceOwnerId, this)
    if (BuildConfig.DEBUG) {
      Log.d(TAG, "HandlerThread started (${timerThread.name})")
    }
    // Register for Activity-destroy cleanup. Works in both Bridge and Bridgeless
    // modes because `addLifecycleEventListener` is on the base `ReactContext`
    // class, not on the TurboModule registry. `CopyOnWriteArraySet` under the
    // hood ([ReactContext.java:47]) makes registration thread-safe and tolerant
    // of removal-during-iteration from inside `onHostDestroy`.
    try {
      reactContext.addLifecycleEventListener(this)
      if (BuildConfig.DEBUG) {
        Log.d(TAG, "LifecycleEventListener registered on ReactContext")
      }
    } catch (e: Exception) {
      Log.w(TAG, "Failed to register LifecycleEventListener; Activity-destroy cleanup will not fire", e)
    }
  }

  // --- WakeLock helpers (must be called from the worker thread) ---
  /**
   * Acquires the partial wake lock without a timeout.
   *
   * **Why no timeout?** A timeout-based renewal pattern (calling
   * `acquire(interval + buffer)` at each tick) does NOT work with the Android
   * `WakeLock` API. The mechanics:
   *
   *  1. `WakeLock.acquire(timeout)` with `setReferenceCounted(false)` posts an
   *     internal `mReleaser` Runnable on the PowerManager's main-thread Handler
   *     with the given delay.
   *  2. Subsequent `acquire(timeout)` calls post **another** `mReleaser` without
   *     cancelling the previous ones.
   *  3. When the **first** `mReleaser` fires, `releaseLocked()` runs. Because
   *     `!mRefCounted` is true, the release branch executes
   *     `mHandler.removeCallbacks(mReleaser)` which wipes **all** pending
   *     `mReleaser` callbacks — including the ones scheduled by later
   *     `acquire()` calls — and releases the native wake lock.
   *
   * Net effect for a long-running `setInterval`: the lock is released at
   * `initial_acquire_time + (interval + buffer)` regardless of how many times
   * we re-acquired. After release the CPU can enter deep sleep, and since
   * `Handler.postDelayed` uses `SystemClock.uptimeMillis()` (which freezes in
   * deep sleep), subsequent ticks may be delayed indefinitely — exactly the
   * bug this library is meant to prevent.
   *
   * Instead, wake lock lifetime is managed **explicitly** via these cleanup paths:
   *
   *  1. `clearTimeout` / `clearInterval` / runnable natural completion
   *     → `releaseWakeLockIfNeeded()` (count-via-map plus accepted timer state)
   *  2. `dispose()` → `cleanupAll()` → explicit release
   *  3. `onHostDestroy()` (Activity destroy, via `LifecycleEventListener`)
   *     → `dispose()` → `cleanupAll()`
   *  4. `finalize()` (GC fallback) → `cleanupAll()`
   *
   * In dev mode, Fast Refresh (bundle reload without Activity destroy) still
   * relies on `finalize()` for native cleanup — non-deterministic, but
   * acceptable as a dev-only limitation.
   *
   * Must be called from the worker thread.
   */
  @SuppressLint("WakelockTimeout")
  private fun acquireWakeLock() {
    if (wakeLock.isHeld) return
    try {
      wakeLock.acquire()
      if (BuildConfig.DEBUG) {
        val active = timeoutRunnables.size + intervalRunnables.size
        Log.d(TAG, "Wake lock acquired (activeTimers=$active)")
      }
    } catch (e: SecurityException) {
      Log.w(TAG, "WAKE_LOCK permission missing or revoked, timer will run without wake lock", e)
    } catch (e: Exception) {
      Log.w(TAG, "Wake lock in unexpected state, timer will run without it", e)
    }
  }

  private fun releaseWakeLockIfNeeded() {
    if (!hasTimerState() && wakeLock.isHeld) {
      try {
        wakeLock.release()
        if (BuildConfig.DEBUG) {
          Log.d(TAG, "Wake lock released")
        }
      } catch (e: Exception) {
        Log.w(TAG, "Error releasing wake lock", e)
      }
    }
  }

  private fun cleanupAll() {
    timeoutRunnables.values.forEach { handler.removeCallbacks(it) }
    intervalRunnables.values.forEach { handler.removeCallbacks(it) }
    timeoutRunnables.clear()
    intervalRunnables.clear()
    acceptedTimeoutIds.clear()
    acceptedIntervalIds.clear()
    synchronized(firedTimerQueueLock) {
      firedTimerQueue.clear()
      pendingIntervalEventIds.clear()
    }
    if (wakeLock.isHeld) {
      try {
        wakeLock.release()
        if (BuildConfig.DEBUG) {
          Log.d(TAG, "Wake lock released during cleanup")
        }
      } catch (e: Exception) {
        Log.w(TAG, "Error releasing wake lock during cleanup", e)
      }
    }
    // Tear down the foreground service — both the explicit flag and any
    // implicit activation. Safe to call unconditionally; stopForegroundServiceInternal
    // early-returns if the service is neither starting nor active.
    isExplicitBackgroundModeRequested.set(false)
    stopForegroundServiceInternal()
  }

  // --- Foreground service control ---
  /**
   * Starts the foreground service, promoting the host process to foreground
   * scheduling priority so timer Runnables are not throttled by the
   * `bg_non_interactive` cgroup.
   *
   * Idempotent: returns immediately if the service is already starting or
   * active. Safe to call from any thread.
   *
   * On failure (e.g. Android 12+ background-start restriction), logs a
   * warning and leaves the foreground service state STOPPED, so timers
   * continue running with wake-lock-only precision (~10% drift).
   */
  private fun startForegroundServiceInternal() {
    if (isDisposed.get()) return
    if (isForegroundServiceDisabled.get()) return
    val requestId = synchronized(foregroundServiceLock) {
      if (isDisposed.get() ||
        isForegroundServiceDisabled.get() ||
        foregroundServiceState != ForegroundServiceState.STOPPED
      ) {
        null
      } else {
        foregroundServiceRequestId += 1
        foregroundServiceState = ForegroundServiceState.STARTING
        foregroundServiceRequestId
      }
    } ?: return
    val intent = Intent(reactContext, NitroBackgroundTimerService::class.java).apply {
      action = NitroBackgroundTimerService.ACTION_START
      putExtra(NitroBackgroundTimerService.EXTRA_OWNER_ID, foregroundServiceOwnerId)
      putExtra(NitroBackgroundTimerService.EXTRA_REQUEST_ID, requestId)
      notificationConfig?.let { cfg ->
        putExtra(NitroBackgroundTimerService.EXTRA_CONFIG_TITLE, cfg.title)
        putExtra(NitroBackgroundTimerService.EXTRA_CONFIG_TEXT, cfg.text)
        putExtra(NitroBackgroundTimerService.EXTRA_CONFIG_CHANNEL_ID, cfg.channelId)
        putExtra(NitroBackgroundTimerService.EXTRA_CONFIG_CHANNEL_NAME, cfg.channelName)
        putExtra(NitroBackgroundTimerService.EXTRA_CONFIG_ICON_RESOURCE_NAME, cfg.iconResourceName)
      }
    }
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        reactContext.startForegroundService(intent)
      } else {
        reactContext.startService(intent)
      }
      Log.i(TAG, "Foreground service start requested")
    } catch (e: Exception) {
      // On API 31+ this can throw ForegroundServiceStartNotAllowedException
      // if the app tries to start it from a background state without a
      // qualifying trigger. We roll back the flag and fall through — timers
      // will run with wake-lock-only precision.
      Log.w(TAG, "Failed to start foreground service, falling back to wake lock only", e)
      synchronized(foregroundServiceLock) {
        if (foregroundServiceRequestId == requestId &&
          foregroundServiceState == ForegroundServiceState.STARTING
        ) {
          foregroundServiceState = ForegroundServiceState.STOPPED
        }
      }
    }
  }

  private fun stopForegroundServiceInternal() {
    val shouldStop = synchronized(foregroundServiceLock) {
      if (foregroundServiceState == ForegroundServiceState.STOPPED) {
        false
      } else {
        foregroundServiceRequestId += 1
        foregroundServiceState = ForegroundServiceState.STOPPED
        true
      }
    }
    if (!shouldStop) return
    val intent = Intent(reactContext, NitroBackgroundTimerService::class.java)
    try {
      reactContext.stopService(intent)
      Log.i(TAG, "Foreground service stop requested")
    } catch (e: Exception) {
      Log.w(TAG, "Failed to stop foreground service", e)
    }
  }

  private fun isForegroundServiceStartingOrActive(): Boolean =
    synchronized(foregroundServiceLock) {
      foregroundServiceState != ForegroundServiceState.STOPPED
    }

  private fun handleForegroundServiceStarted(requestId: Long): Boolean {
    var didTransition = false
    val accepted = synchronized(foregroundServiceLock) {
      if (isDisposed.get() || foregroundServiceRequestId != requestId) {
        false
      } else {
        when (foregroundServiceState) {
          ForegroundServiceState.STARTING -> {
            foregroundServiceState = ForegroundServiceState.ACTIVE
            didTransition = true
            true
          }
          ForegroundServiceState.ACTIVE -> true
          ForegroundServiceState.STOPPED -> false
        }
      }
    }
    if (didTransition) {
      Log.i(TAG, "Foreground service active")
    }
    return accepted
  }

  private fun handleForegroundServiceStartFailed(requestId: Long) {
    val cleared = synchronized(foregroundServiceLock) {
      if (foregroundServiceRequestId == requestId &&
        foregroundServiceState != ForegroundServiceState.STOPPED
      ) {
        foregroundServiceState = ForegroundServiceState.STOPPED
        true
      } else {
        false
      }
    }
    if (cleared) {
      Log.w(TAG, "Foreground service failed to enter foreground, falling back to wake lock only")
    }
  }

  private fun handleForegroundServiceDestroyed(requestId: Long) {
    val cleared = synchronized(foregroundServiceLock) {
      if (foregroundServiceRequestId == requestId &&
        foregroundServiceState != ForegroundServiceState.STOPPED
      ) {
        foregroundServiceState = ForegroundServiceState.STOPPED
        true
      } else {
        false
      }
    }
    if (cleared) {
      Log.i(TAG, "Foreground service destroyed")
    }
  }

  /**
   * Ensures the foreground service is running before a timer is scheduled.
   *
   * Called from two places:
   *   1. **JS thread**, at the top of `setTimeout` / `setInterval`, before
   *      `handler.post {}`. Early-start path — we want the
   *      `startForegroundService()` call to race against any imminent
   *      app-background transition so Android 14's 10-second start window
   *      is still open.
   *   2. **Worker thread**, inside the `handler.post {}` block of
   *      `setTimeout` / `setInterval`. Safety-net path — closes the race
   *      where a previous Runnable's `maybeStopForegroundServiceAfterClear`
   *      stopped the service between the JS-thread check and the worker's
   *      processing of the post.
   *
   * Idempotent via the foreground service state lock inside
   * `startForegroundServiceInternal`: if the service is already up or a start
   * request is in flight, this is a no-op.
   *
   * Note on explicit vs implicit mode: this method intentionally does NOT
   * short-circuit on `isExplicitBackgroundModeRequested`. A previous design
   * did, but that path silently swallowed the failure-retry case where
   * `startBackgroundMode()` tried and failed (e.g. Android 12+ background
   * start restriction) — subsequent timers would then never retry the start.
   * Checking only the physical foreground service state is both simpler and
   * self-healing.
   */
  private fun ensureForegroundServiceForTimer() {
    if (isDisposed.get()) return
    // Consumer opt-out short-circuit: skip the FGS entirely. The wake-lock
    // path in setTimeout/setInterval continues to run, so timers still fire
    // — just with ~10% drift in background instead of foreground-priority
    // accuracy. See `disableForegroundService()` Kdoc.
    if (isForegroundServiceDisabled.get()) return
    if (isForegroundServiceStartingOrActive()) return
    startForegroundServiceInternal()
  }

  private fun hasTimerState(): Boolean =
    acceptedTimeoutIds.isNotEmpty() ||
      acceptedIntervalIds.isNotEmpty() ||
      timeoutRunnables.isNotEmpty() ||
      intervalRunnables.isNotEmpty()

  /**
   * Called after a timer is cleared or fires-and-completes. Stops the
   * foreground service only if both maps are empty AND the consumer has
   * not explicitly requested background mode. Must be called from the
   * worker thread (the maps are only safely-size-able after serialized
   * mutation).
   */
  private fun maybeStopForegroundServiceAfterClear() {
    if (isExplicitBackgroundModeRequested.get()) return
    if (hasTimerState()) return
    stopForegroundServiceInternal()
  }

  private fun postToWorker(operation: String, block: () -> Unit): Boolean {
    val posted = try {
      handler.post {
        block()
      }
    } catch (e: Exception) {
      Log.w(TAG, "$operation failed to post to worker", e)
      false
    }
    if (!posted) {
      Log.w(TAG, "$operation ignored because worker looper is not accepting messages")
    }
    return posted
  }

  private fun postDelayedToWorker(operation: String, runnable: Runnable, delayMillis: Long): Boolean {
    val posted = try {
      handler.postDelayed(runnable, delayMillis)
    } catch (e: Exception) {
      Log.w(TAG, "$operation failed to post delayed runnable", e)
      false
    }
    if (!posted) {
      Log.w(TAG, "$operation delayed runnable ignored because worker looper is not accepting messages")
    }
    return posted
  }

  private fun prepareTimerSchedule(operation: String, acceptTimer: () -> Unit): Boolean =
    synchronized(lifecycleLock) {
      if (isDisposed.get()) {
        Log.w(TAG, "$operation called on disposed instance, ignoring")
        false
      } else {
        acceptTimer()
        ensureForegroundServiceForTimer()
        true
      }
    }

  private fun rollbackRejectedSchedule() {
    if (!isExplicitBackgroundModeRequested.get() && !hasTimerState()) {
      stopForegroundServiceInternal()
    }
  }

  private fun emitTimersAvailable(queueSize: Int) {
    try {
      val payload = Arguments.createMap().apply {
        putInt("count", queueSize)
      }
      reactContext.emitDeviceEvent(TIMERS_AVAILABLE_EVENT, payload)
    } catch (e: Exception) {
      Log.w(TAG, "Failed to emit $TIMERS_AVAILABLE_EVENT", e)
    }
  }

  private fun removeQueuedTimerEvents(id: Int, type: FiredTimerType) {
    synchronized(firedTimerQueueLock) {
      firedTimerQueue.removeAll { event ->
        event.id.toInt() == id && event.type == type
      }
      if (type == FiredTimerType.INTERVAL) {
        pendingIntervalEventIds.remove(id)
      }
    }
  }

  private fun enqueueFiredTimer(id: Int, type: FiredTimerType) {
    val queueSize = synchronized(firedTimerQueueLock) {
      if (type == FiredTimerType.INTERVAL && pendingIntervalEventIds.contains(id)) {
        return
      }

      if (firedTimerQueue.size >= MAX_FIRED_TIMER_QUEUE_SIZE) {
        val dropIndex = firedTimerQueue.indexOfFirst { it.type == FiredTimerType.INTERVAL }
        if (dropIndex >= 0) {
          val dropped = firedTimerQueue.removeAt(dropIndex)
          pendingIntervalEventIds.remove(dropped.id.toInt())
          Log.w(TAG, "Fired timer queue reached cap; dropped a pending interval event")
        } else {
          Log.w(TAG, "Fired timer queue reached cap with only timeouts pending; dropping timer id=$id")
          return
        }
      }

      firedTimerQueue.add(
        FiredTimerEvent(
          id = id.toDouble(),
          type = type,
          sequence = nextFiredTimerSequence.getAndIncrement().toDouble()
        )
      )
      if (type == FiredTimerType.INTERVAL) {
        pendingIntervalEventIds.add(id)
      }
      firedTimerQueue.size
    }

    emitTimersAvailable(queueSize)
  }

  override fun drainFiredTimers(): Array<FiredTimerEvent> =
    synchronized(firedTimerQueueLock) {
      val events = firedTimerQueue.toTypedArray()
      firedTimerQueue.clear()
      pendingIntervalEventIds.clear()
      events
    }

  // --- Public background-mode API ---
  override fun startBackgroundMode() {
    if (isDisposed.get()) {
      Log.w(TAG, "startBackgroundMode called on disposed instance, ignoring")
      return
    }
    if (isForegroundServiceDisabled.get()) {
      Log.w(
        TAG,
        "startBackgroundMode() ignored: foreground service is disabled by consumer opt-out"
      )
      return
    }
    // CAS guarantees idempotency — second caller takes the false branch.
    if (isExplicitBackgroundModeRequested.compareAndSet(false, true)) {
      Log.i(TAG, "Background mode requested explicitly")
      startForegroundServiceInternal()
    } else if (BuildConfig.DEBUG) {
      Log.d(TAG, "Background mode already requested, no-op")
    }
  }

  override fun stopBackgroundMode() {
    if (isDisposed.get()) return
    if (isExplicitBackgroundModeRequested.compareAndSet(true, false)) {
      Log.i(TAG, "Background mode released explicitly")
      // Post the map-emptiness check onto the worker thread so it is
      // serialized against any setTimeout/setInterval posts already in the
      // handler queue. A naive JS-thread check can race against a worker-
      // pending postX that hasn't inserted X into the map yet — we'd see
      // an empty map, stop the service, then postX would run and schedule
      // a timer with no foreground service backing it.
      handler.post {
        maybeStopForegroundServiceAfterClear()
      }
    }
  }

  override fun disableForegroundService() {
    if (isDisposed.get()) {
      Log.w(TAG, "disableForegroundService called on disposed instance, ignoring")
      return
    }
    // Guard: can only opt out before anything has touched the foreground
    // service. If a timer is already active, an explicit mode is requested,
    // or the FGS flag is set, we refuse — otherwise we'd leave the library
    // in an inconsistent state where the FGS is running but new timers
    // bypass it.
    if (isForegroundServiceStartingOrActive() ||
      isExplicitBackgroundModeRequested.get() ||
      hasTimerState()
    ) {
      throw IllegalStateException(
        "disableForegroundService() must be called before any timer is scheduled " +
          "and before startBackgroundMode(). Call it once at app startup."
      )
    }
    // Idempotent: first caller wins the CAS, subsequent calls are silent no-ops.
    if (isForegroundServiceDisabled.compareAndSet(false, true)) {
      Log.i(TAG, "Foreground service disabled by consumer opt-out")
    }
  }

  override fun configure(configJson: String) {
    if (isDisposed.get()) {
      Log.w(TAG, "configure called on disposed instance, ignoring")
      return
    }
    // Gate on the semantic "is anyone still using the service" question.
    // The physical foreground service state is updated asynchronously by the
    // worker thread and by Service callbacks, so right after the user calls
    // stopBackgroundMode() it can still be STARTING/ACTIVE for a brief window,
    // even though the user has clearly signaled "I want this stopped".
    //
    // Semantic check: block configure if an explicit background mode is
    // requested OR any timer is holding the implicit fallback alive. This
    // covers every "the notification is currently visible and changing its
    // content would be confusing" case that Decision 2 of the B9 brief
    // meant to catch, while allowing the "stopBackgroundMode, then
    // immediately reconfigure for the next session" pattern to succeed.
    if (isExplicitBackgroundModeRequested.get() ||
        hasTimerState()) {
      throw IllegalStateException(
        "BackgroundTimer.configure() cannot be called while a background " +
          "mode session is active. Stop timers and call stopBackgroundMode() first."
      )
    }
    try {
      val root = JSONObject(configJson)
      val notification = root.optJSONObject("notification")
      if (notification == null) {
        notificationConfig = null
        Log.i(TAG, "BackgroundTimer configured with empty notification block")
        return
      }
      notificationConfig = NotificationConfig(
        title = notification.optString("title").takeIf { it.isNotEmpty() },
        text = notification.optString("text").takeIf { it.isNotEmpty() },
        channelId = notification.optString("channelId").takeIf { it.isNotEmpty() },
        channelName = notification.optString("channelName").takeIf { it.isNotEmpty() },
        iconResourceName = notification.optString("iconResourceName").takeIf { it.isNotEmpty() }
      )
      Log.i(TAG, "BackgroundTimer configured: $notificationConfig")
    } catch (e: Exception) {
      Log.w(TAG, "Failed to parse configuration JSON, ignoring", e)
    }
  }

  // --- Timeout ---
  override fun setTimeout(id: Double, duration: Double) {
    // Implicit foreground service activation: kicks in when the consumer
    // hasn't called startBackgroundMode() explicitly. Called from the JS
    // thread before posting so the service request beats the timer race
    // against a quick app-background transition.
    val intId = id.toInt()
    var acceptedNewTimer = false
    if (!prepareTimerSchedule("setTimeout") {
      acceptedNewTimer = acceptedTimeoutIds.put(intId, true) == null
    }) return

    val posted = postToWorker("setTimeout($id)") {
      synchronized(lifecycleLock) {
        if (isDisposed.get()) {
          Log.w(TAG, "setTimeout($id) ignored after dispose")
          acceptedTimeoutIds.remove(intId)
          return@synchronized
        }
        // Safety net: between the JS-thread check above and this worker-side
        // block, a previous Runnable may have completed and stopped the
        // service via maybeStopForegroundServiceAfterClear(). Re-assert the
        // service state here — idempotent via CAS, no-op if already active.
        ensureForegroundServiceForTimer()
        if (isDisposed.get()) {
          Log.w(TAG, "setTimeout($id) ignored after dispose")
          acceptedTimeoutIds.remove(intId)
          return@synchronized
        }

        // inline-clear previous timer with same id (no re-post to avoid deadlock-free but wasteful double-hop)
        timeoutRunnables[intId]?.let { handler.removeCallbacks(it) }
        timeoutRunnables.remove(intId)

        val runnable = Runnable {
          if (isDisposed.get()) return@Runnable
          try {
            enqueueFiredTimer(intId, FiredTimerType.TIMEOUT)
          } finally {
            timeoutRunnables.remove(intId)
            acceptedTimeoutIds.remove(intId)
            releaseWakeLockIfNeeded()
            maybeStopForegroundServiceAfterClear()
          }
        }

        timeoutRunnables[intId] = runnable
        if (!postDelayedToWorker("setTimeout($id)", runnable, duration.toLong())) {
          timeoutRunnables.remove(intId, runnable)
          acceptedTimeoutIds.remove(intId)
          releaseWakeLockIfNeeded()
          maybeStopForegroundServiceAfterClear()
          return@synchronized
        }
        acquireWakeLock()
      }
    }
    if (!posted) {
      if (acceptedNewTimer) {
        acceptedTimeoutIds.remove(intId)
      }
      rollbackRejectedSchedule()
    }
  }

  override fun clearTimeout(id: Double) {
    if (isDisposed.get()) return
    handler.post {
      val intId = id.toInt()
      timeoutRunnables[intId]?.let { handler.removeCallbacks(it) }
      timeoutRunnables.remove(intId)
      acceptedTimeoutIds.remove(intId)
      removeQueuedTimerEvents(intId, FiredTimerType.TIMEOUT)
      releaseWakeLockIfNeeded()
      maybeStopForegroundServiceAfterClear()
    }
  }

  // --- Interval ---
  override fun setInterval(id: Double, interval: Double) {
    val intId = id.toInt()
    var acceptedNewTimer = false
    if (!prepareTimerSchedule("setInterval") {
      acceptedNewTimer = acceptedIntervalIds.put(intId, true) == null
    }) return

    val posted = postToWorker("setInterval($id)") {
      synchronized(lifecycleLock) {
        if (isDisposed.get()) {
          Log.w(TAG, "setInterval($id) ignored after dispose")
          acceptedIntervalIds.remove(intId)
          return@synchronized
        }
        // Safety net: see equivalent comment in setTimeout above.
        ensureForegroundServiceForTimer()
        if (isDisposed.get()) {
          Log.w(TAG, "setInterval($id) ignored after dispose")
          acceptedIntervalIds.remove(intId)
          return@synchronized
        }

        intervalRunnables[intId]?.let { handler.removeCallbacks(it) }
        intervalRunnables.remove(intId)

        val runnable = object : Runnable {
          override fun run() {
            if (isDisposed.get()) return
            enqueueFiredTimer(intId, FiredTimerType.INTERVAL)
            // Only reschedule if this interval is still registered and not disposed.
            // Wake lock stays held across ticks — no "renewal" needed (see acquireWakeLock() Kdoc).
            if (intervalRunnables.containsKey(intId) && !isDisposed.get()) {
              val rescheduled = postDelayedToWorker("setInterval($id)", this, interval.toLong())
              if (!rescheduled) {
                intervalRunnables.remove(intId, this)
                acceptedIntervalIds.remove(intId)
                releaseWakeLockIfNeeded()
                maybeStopForegroundServiceAfterClear()
              }
            }
          }
        }

        intervalRunnables[intId] = runnable
        if (!postDelayedToWorker("setInterval($id)", runnable, interval.toLong())) {
          intervalRunnables.remove(intId, runnable)
          acceptedIntervalIds.remove(intId)
          releaseWakeLockIfNeeded()
          maybeStopForegroundServiceAfterClear()
          return@synchronized
        }
        acquireWakeLock()
      }
    }
    if (!posted) {
      if (acceptedNewTimer) {
        acceptedIntervalIds.remove(intId)
      }
      rollbackRejectedSchedule()
    }
  }

  override fun clearInterval(id: Double) {
    if (isDisposed.get()) return
    handler.post {
      val intId = id.toInt()
      intervalRunnables[intId]?.let { handler.removeCallbacks(it) }
      intervalRunnables.remove(intId)
      acceptedIntervalIds.remove(intId)
      removeQueuedTimerEvents(intId, FiredTimerType.INTERVAL)
      releaseWakeLockIfNeeded()
      maybeStopForegroundServiceAfterClear()
    }
  }

  // --- LifecycleEventListener ---
  override fun onHostResume() {
    // no-op
  }

  override fun onHostPause() {
    // no-op
  }

  override fun onHostDestroy() {
    Log.i(TAG, "onHostDestroy triggered cleanup")
    dispose()
  }

  // --- Dispose (manual, JS-triggered; also invoked by onHostDestroy above) ---
  @DoNotStrip
  override fun dispose() {
    // Atomic guard: exactly one caller wins the CAS; any racing caller (e.g.
    // user JS `dispose()` vs `onHostDestroy` from the UI thread) takes the
    // early-return path. Without this, the second caller would re-enter the
    // cleanup path and its `handler.post` could fall into the direct-cleanup
    // fallback on the caller thread, violating the worker-thread-only
    // invariant documented on `acquireWakeLock()`.
    val shouldDispose = synchronized(lifecycleLock) {
      isDisposed.compareAndSet(false, true)
    }
    if (!shouldDispose) {
      Log.w(TAG, "dispose() called on already-disposed instance, ignoring")
      super.dispose()
      return
    }

    // Unregister from ReactContext so we don't leak a strong reference through
    // mLifecycleEventListeners. Safe to call from inside onHostDestroy thanks
    // to CopyOnWriteArraySet — removal-during-iteration is allowed and does
    // not throw. Safe to call on a dead ReactContext (list.remove is just a
    // list operation).
    try {
      reactContext.removeLifecycleEventListener(this)
    } catch (e: Exception) {
      Log.w(TAG, "Failed to remove LifecycleEventListener", e)
    }
    unregisterForegroundServiceOwner(foregroundServiceOwnerId)

    // Post cleanup on the worker thread so any pending messages are drained in order,
    // then quit the looper from within. We cannot simply call quitSafely() from an
    // arbitrary thread and expect the last pending message to observe isDisposed.
    //
    // Handler.post() normally returns `false` if the looper is exiting; it is not
    // documented to throw under any circumstance, but we keep the try/catch as a
    // belt-and-braces guard against future API changes. The realistic "looper
    // dead" path is triggered by the boolean return check below.
    val posted: Boolean = try {
      handler.post {
        try {
          cleanupAll()
        } catch (e: Exception) {
          Log.w(TAG, "Error during dispose cleanup", e)
        }
        if (BuildConfig.DEBUG) {
          Log.d(TAG, "HandlerThread quitting")
        }
        timerThread.quitSafely()
      }
    } catch (e: Exception) {
      Log.w(TAG, "Handler post threw during dispose, falling back to direct cleanup", e)
      false
    }

    if (!posted) {
      Log.w(TAG, "Handler post returned false (looper dead?), falling back to direct cleanup")
      try {
        cleanupAll()
      } catch (inner: Exception) {
        Log.w(TAG, "Direct cleanup also failed during dispose", inner)
      }
      try { timerThread.quitSafely() } catch (_: Throwable) { /* ignore */ }
    }
    super.dispose()
  }

  // --- Cleanup fallback via GC ---
  protected fun finalize() {
    if (!isDisposed.get()) {
      // Best-effort remove from the ReactContext listener list. If the context
      // has already been torn down, this is a harmless list.remove no-op.
      try {
        reactContext.removeLifecycleEventListener(this)
      } catch (_: Throwable) {
        // finalize must never throw
      }
      try {
        unregisterForegroundServiceOwner(foregroundServiceOwnerId)
      } catch (_: Throwable) {
        // finalize must never throw
      }
      try {
        cleanupAll()
      } catch (_: Throwable) {
        // finalize must never throw
      }
      try { timerThread.quitSafely() } catch (_: Throwable) { /* ignore */ }
    }
  }

  companion object {
    private const val TAG = "NitroBgTimer"
    private const val WAKE_LOCK_TAG = "NitroBgTimer::WakeLock"
    private const val TIMERS_AVAILABLE_EVENT = "NitroBackgroundTimerTimersAvailable"
    private const val MAX_FIRED_TIMER_QUEUE_SIZE = 1024

    private val nextForegroundServiceOwnerId = AtomicLong(1)
    private val foregroundServiceOwners = ConcurrentHashMap<Long, WeakReference<NitroBackgroundTimer>>()

    private fun registerForegroundServiceOwner(ownerId: Long, owner: NitroBackgroundTimer) {
      foregroundServiceOwners[ownerId] = WeakReference(owner)
    }

    private fun unregisterForegroundServiceOwner(ownerId: Long) {
      foregroundServiceOwners.remove(ownerId)
    }

    private fun notifyForegroundServiceOwner(
      ownerId: Long,
      block: (NitroBackgroundTimer) -> Boolean
    ): Boolean {
      val ref = foregroundServiceOwners[ownerId] ?: return false
      val owner = ref.get()
      if (owner == null) {
        foregroundServiceOwners.remove(ownerId, ref)
        return false
      }
      return block(owner)
    }

    internal fun notifyForegroundServiceStarted(ownerId: Long, requestId: Long): Boolean =
      notifyForegroundServiceOwner(ownerId) { owner ->
        owner.handleForegroundServiceStarted(requestId)
      }

    internal fun notifyForegroundServiceStartFailed(ownerId: Long, requestId: Long) {
      notifyForegroundServiceOwner(ownerId) { owner ->
        owner.handleForegroundServiceStartFailed(requestId)
        true
      }
    }

    internal fun notifyForegroundServiceDestroyed(ownerId: Long, requestId: Long) {
      notifyForegroundServiceOwner(ownerId) { owner ->
        owner.handleForegroundServiceDestroyed(requestId)
        true
      }
    }
  }
}
