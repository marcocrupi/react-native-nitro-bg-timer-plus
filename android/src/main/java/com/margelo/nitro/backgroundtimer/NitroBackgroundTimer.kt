package com.margelo.nitro.backgroundtimer

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Handler
import android.os.HandlerThread
import android.os.PowerManager
import android.os.Process
import android.util.Log
import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.margelo.nitro.NitroModules
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

@DoNotStrip
class NitroBackgroundTimer : HybridNitroBackgroundTimerSpec() {
  // Bind to the context captured by Nitro, never to an Activity or to a later
  // value of NitroModules.applicationContext during teardown.
  private val reactContext: ReactApplicationContext = run {
    val ctx = NitroModules.applicationContext
    ctx as? ReactApplicationContext
      ?: throw IllegalStateException(
        "NitroBackgroundTimer requires NitroModules.applicationContext to be a ReactApplicationContext; " +
          "is Nitro installed and initialized before the first timer call?"
      )
  }

  // Resolve before allocating resources. This also instantiates the TurboModule
  // deterministically; it must not depend on JS requesting an unused module.
  private val runtimeOwner =
    (reactContext.getNativeModule(NitroBackgroundTimerRuntimeOwner.NAME) as? NitroBackgroundTimerRuntimeOwner)
      ?.takeIf { it.owns(reactContext) }
      ?: throw IllegalStateException("NitroBackgroundTimer requires its runtime owner on the captured ReactContext")

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
  private val clearPendingTimeoutIds = ConcurrentHashMap<Int, Boolean>()
  private val clearPendingIntervalIds = ConcurrentHashMap<Int, Boolean>()
  private val firedTimerQueueLock = Any()
  private val firedTimerQueue = mutableListOf<FiredTimerEvent>()
  private val pendingIntervalEventIds = mutableSetOf<Int>()
  private val nextFiredTimerSequence = AtomicLong(1)

  // AtomicBoolean (not `@Volatile Boolean`) because `dispose()` uses
  // `compareAndSet(false, true)` to ensure exactly one thread wins the
  // dispose race. Two concurrent callers — e.g. user JS calling
  // `BackgroundTimer.dispose()` while runtime invalidation fires from another
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

  // FGS physical state and process opt-out are shared by every runtime/owner.
  // Notification configuration remains per owner and is snapshotted per session.
  private val isExplicitBackgroundModeRequested = AtomicBoolean(false)
  private var notificationConfigRevision = 0L
  @Volatile
  private var notificationConfig: NotificationConfig? = null

  private data class NotificationConfig(
    val title: String?,
    val text: String?,
    val channelId: String?,
    val channelName: String?,
    val iconResourceName: String?
  )

  init {
    registerForegroundServiceOwner(foregroundServiceOwnerId, this)
    if (BuildConfig.DEBUG) {
      Log.d(TAG, "HandlerThread started (${timerThread.name})")
    }
    if (!runtimeOwner.register(this)) {
      dispose()
      awaitRuntimeCleanup()
      throw IllegalStateException("NitroBackgroundTimer runtime is already invalidated")
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
   *  3. Runtime owner invalidate() → dispose() → cleanupAll()
   *  4. finalize() (best-effort GC fallback only)
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
    clearPendingTimeoutIds.clear()
    clearPendingIntervalIds.clear()
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
  private fun startForegroundServiceInternal(newSession: Boolean = false) {
    if (isDisposed.get() || ForegroundServiceCoordinator.isDisabled()) return
    val intent = Intent(reactContext, NitroBackgroundTimerService::class.java).apply {
      action = NitroBackgroundTimerService.ACTION_START
      putExtra(NitroBackgroundTimerService.EXTRA_OWNER_ID, foregroundServiceOwnerId)
      notificationConfig?.let { cfg ->
        putExtra(NitroBackgroundTimerService.EXTRA_CONFIG_TITLE, cfg.title)
        putExtra(NitroBackgroundTimerService.EXTRA_CONFIG_TEXT, cfg.text)
        putExtra(NitroBackgroundTimerService.EXTRA_CONFIG_CHANNEL_ID, cfg.channelId)
        putExtra(NitroBackgroundTimerService.EXTRA_CONFIG_CHANNEL_NAME, cfg.channelName)
        putExtra(NitroBackgroundTimerService.EXTRA_CONFIG_ICON_RESOURCE_NAME, cfg.iconResourceName)
      }
    }
    ForegroundServiceCoordinator.request(reactContext, foregroundServiceOwnerId, intent, newSession, notificationConfigRevision)
  }

  private fun stopForegroundServiceInternal() {
    ForegroundServiceCoordinator.release(reactContext, foregroundServiceOwnerId)
  }

  private fun ensureForegroundServiceForTimer() {
    startForegroundServiceInternal()
  }

  private fun <T> hasUnclearedTimerState(
    timerState: ConcurrentHashMap<Int, T>,
    clearPendingIds: ConcurrentHashMap<Int, Boolean>
  ): Boolean = timerState.keys.any { !clearPendingIds.containsKey(it) }

  private fun hasTimerState(): Boolean =
    hasUnclearedTimerState(acceptedTimeoutIds, clearPendingTimeoutIds) ||
      hasUnclearedTimerState(acceptedIntervalIds, clearPendingIntervalIds) ||
      hasUnclearedTimerState(timeoutRunnables, clearPendingTimeoutIds) ||
      hasUnclearedTimerState(intervalRunnables, clearPendingIntervalIds)

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
        ForegroundServiceCoordinator.markUsed()
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

  private fun markTimeoutClearPending(id: Int) {
    if (acceptedTimeoutIds.containsKey(id) || timeoutRunnables.containsKey(id)) {
      clearPendingTimeoutIds[id] = true
    }
  }

  private fun markIntervalClearPending(id: Int) {
    if (acceptedIntervalIds.containsKey(id) || intervalRunnables.containsKey(id)) {
      clearPendingIntervalIds[id] = true
    }
  }

  private fun cleanupTimeoutAfterClear(id: Int) {
    timeoutRunnables[id]?.let { handler.removeCallbacks(it) }
    timeoutRunnables.remove(id)
    acceptedTimeoutIds.remove(id)
    removeQueuedTimerEvents(id, FiredTimerType.TIMEOUT)
    clearPendingTimeoutIds.remove(id)
    releaseWakeLockIfNeeded()
    maybeStopForegroundServiceAfterClear()
  }

  private fun cleanupIntervalAfterClear(id: Int) {
    intervalRunnables[id]?.let { handler.removeCallbacks(it) }
    intervalRunnables.remove(id)
    acceptedIntervalIds.remove(id)
    removeQueuedTimerEvents(id, FiredTimerType.INTERVAL)
    clearPendingIntervalIds.remove(id)
    releaseWakeLockIfNeeded()
    maybeStopForegroundServiceAfterClear()
  }

  private fun enqueueFiredTimer(id: Int, type: FiredTimerType) {
    val queueSize = synchronized(firedTimerQueueLock) {
      if (type == FiredTimerType.INTERVAL && pendingIntervalEventIds.contains(id)) {
        return
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
  override fun startBackgroundMode() = synchronized(lifecycleLock) {
    if (isDisposed.get() || ForegroundServiceCoordinator.isDisabled()) return@synchronized
    ForegroundServiceCoordinator.markUsed()
    val newSession = !isExplicitBackgroundModeRequested.getAndSet(true)
    // A new logical session snapshots configuration even if its old physical
    // stop is still queued. A repeated request retries only when stopped.
    startForegroundServiceInternal(newSession)
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

  override fun disableForegroundService() = synchronized(lifecycleLock) {
    if (isDisposed.get()) return@synchronized
    ForegroundServiceCoordinator.disable()
  }

  override fun configure(configJson: String) {
    synchronized(lifecycleLock) {
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
          notificationConfigRevision += 1
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
        notificationConfigRevision += 1
        Log.i(TAG, "BackgroundTimer configured: $notificationConfig")
      } catch (e: Exception) {
        Log.w(TAG, "Failed to parse configuration JSON, ignoring", e)
      }
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
          clearPendingTimeoutIds.remove(intId)
          return@synchronized
        }
        if (clearPendingTimeoutIds.containsKey(intId)) {
          cleanupTimeoutAfterClear(intId)
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
          clearPendingTimeoutIds.remove(intId)
          return@synchronized
        }
        if (clearPendingTimeoutIds.containsKey(intId)) {
          cleanupTimeoutAfterClear(intId)
          return@synchronized
        }

        // inline-clear previous timer with same id (no re-post to avoid deadlock-free but wasteful double-hop)
        timeoutRunnables[intId]?.let { handler.removeCallbacks(it) }
        timeoutRunnables.remove(intId)

        val runnable = Runnable {
          if (isDisposed.get()) return@Runnable
          try {
            if (clearPendingTimeoutIds.containsKey(intId)) {
              removeQueuedTimerEvents(intId, FiredTimerType.TIMEOUT)
            } else {
              enqueueFiredTimer(intId, FiredTimerType.TIMEOUT)
            }
          } finally {
            timeoutRunnables.remove(intId)
            acceptedTimeoutIds.remove(intId)
            clearPendingTimeoutIds.remove(intId)
            releaseWakeLockIfNeeded()
            maybeStopForegroundServiceAfterClear()
          }
        }

        timeoutRunnables[intId] = runnable
        if (!postDelayedToWorker("setTimeout($id)", runnable, duration.toLong())) {
          timeoutRunnables.remove(intId, runnable)
          acceptedTimeoutIds.remove(intId)
          clearPendingTimeoutIds.remove(intId)
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
    val intId = id.toInt()
    markTimeoutClearPending(intId)
    handler.post {
      cleanupTimeoutAfterClear(intId)
    }
  }

  // --- Interval ---
  override fun setInterval(id: Double, interval: Double) {
    val intId = id.toInt()
    // Recurring posts must never collapse to zero after millisecond conversion.
    val intervalMillis = interval.toLong().coerceAtLeast(1L)
    var acceptedNewTimer = false
    if (!prepareTimerSchedule("setInterval") {
      acceptedNewTimer = acceptedIntervalIds.put(intId, true) == null
    }) return

    val posted = postToWorker("setInterval($id)") {
      synchronized(lifecycleLock) {
        if (isDisposed.get()) {
          Log.w(TAG, "setInterval($id) ignored after dispose")
          acceptedIntervalIds.remove(intId)
          clearPendingIntervalIds.remove(intId)
          return@synchronized
        }
        if (clearPendingIntervalIds.containsKey(intId)) {
          cleanupIntervalAfterClear(intId)
          return@synchronized
        }
        // Safety net: see equivalent comment in setTimeout above.
        ensureForegroundServiceForTimer()
        if (isDisposed.get()) {
          Log.w(TAG, "setInterval($id) ignored after dispose")
          acceptedIntervalIds.remove(intId)
          clearPendingIntervalIds.remove(intId)
          return@synchronized
        }
        if (clearPendingIntervalIds.containsKey(intId)) {
          cleanupIntervalAfterClear(intId)
          return@synchronized
        }

        intervalRunnables[intId]?.let { handler.removeCallbacks(it) }
        intervalRunnables.remove(intId)

        val runnable = object : Runnable {
          override fun run() {
            if (isDisposed.get()) return
            if (clearPendingIntervalIds.containsKey(intId)) {
              cleanupIntervalAfterClear(intId)
              return
            }
            enqueueFiredTimer(intId, FiredTimerType.INTERVAL)
            // Only reschedule if this interval is still registered and not disposed.
            // Wake lock stays held across ticks — no "renewal" needed (see acquireWakeLock() Kdoc).
            if (intervalRunnables.containsKey(intId) &&
              !clearPendingIntervalIds.containsKey(intId) &&
              !isDisposed.get()
            ) {
              val rescheduled = postDelayedToWorker("setInterval($id)", this, intervalMillis)
              if (!rescheduled) {
                intervalRunnables.remove(intId, this)
                acceptedIntervalIds.remove(intId)
                clearPendingIntervalIds.remove(intId)
                releaseWakeLockIfNeeded()
                maybeStopForegroundServiceAfterClear()
              }
            }
          }
        }

        intervalRunnables[intId] = runnable
        if (!postDelayedToWorker("setInterval($id)", runnable, intervalMillis)) {
          intervalRunnables.remove(intId, runnable)
          acceptedIntervalIds.remove(intId)
          clearPendingIntervalIds.remove(intId)
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
    val intId = id.toInt()
    markIntervalClearPending(intId)
    handler.post {
      cleanupIntervalAfterClear(intId)
    }
  }

  // --- Dispose (manual JS call or runtime-owner invalidation) ---
  @DoNotStrip
  override fun dispose() {
    // Atomic guard: exactly one caller wins the CAS; any racing caller (e.g.
    // user JS `dispose()` vs runtime-owner invalidation) takes the
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

    // Keep the runtime registration until worker cleanup completes, so
    // invalidate() can also wait for an overlapping manual dispose.
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
        runtimeOwner.unregister(this, timerThread)
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
      runtimeOwner.unregister(this, timerThread)
      try { timerThread.quitSafely() } catch (_: Throwable) { /* ignore */ }
    }
    super.dispose()
  }

  // Called by the runtime owner without registry/lifecycle locks. Worker tasks
  // never wait on the UI/ReactHost thread; do not join from the worker itself.
  internal fun awaitRuntimeCleanup() {
    if (Thread.currentThread() === timerThread) return
    var interrupted = false
    while (timerThread.isAlive) {
      try {
        timerThread.join()
      } catch (_: InterruptedException) {
        interrupted = true
      }
    }
    if (interrupted) Thread.currentThread().interrupt()
  }

  // --- Cleanup fallback via GC ---
  protected fun finalize() {
    if (!isDisposed.get()) {
      try {
        runtimeOwner.unregister(this, timerThread)
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

    private val nextForegroundServiceOwnerId = AtomicLong(1)
    private val foregroundServiceOwners = ConcurrentHashMap<Long, WeakReference<NitroBackgroundTimer>>()

    private fun registerForegroundServiceOwner(ownerId: Long, owner: NitroBackgroundTimer) {
      foregroundServiceOwners[ownerId] = WeakReference(owner)
    }

    private fun unregisterForegroundServiceOwner(ownerId: Long) {
      foregroundServiceOwners.remove(ownerId)
    }

  }
}
