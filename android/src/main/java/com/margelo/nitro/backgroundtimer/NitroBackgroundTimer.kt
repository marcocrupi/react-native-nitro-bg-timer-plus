package com.margelo.nitro.backgroundtimer

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.PowerManager
import android.os.Process
import android.os.SystemClock
import android.util.Log
import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.ReactApplicationContext
import com.margelo.nitro.NitroModules
import org.json.JSONObject
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

  // AtomicBoolean (not `@Volatile Boolean`) because `dispose()` uses
  // `compareAndSet(false, true)` to ensure exactly one thread wins the
  // dispose race. Two concurrent callers — e.g. user JS calling
  // `BackgroundTimer.dispose()` while `onHostDestroy` fires from the UI
  // thread — would otherwise both read false, both proceed past the guard,
  // and both reach the cleanup path.
  private val isDisposed = AtomicBoolean(false)

  // Foreground service state. AtomicBoolean (not volatile) because these
  // are mutated from both the JS thread (startBackgroundMode / stopBackgroundMode
  // / configure / setTimeout / setInterval entry points) and the worker thread
  // (cleanupAll). compareAndSet semantics give us the same race-free start/stop
  // idempotency we rely on for `isDisposed`.
  private val isForegroundServiceActive = AtomicBoolean(false)
  private val isExplicitBackgroundModeRequested = AtomicBoolean(false)

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

  // === DIAGNOSTIC TELEMETRY (B8 step 2) ===
  // To be removed after Android scheduling fix is validated.
  // Counts how many times the interval Runnable actually executes natively,
  // independent of whether the JS callback is delivered. Distinguishes A2
  // (native Runnable slowed down by background cgroup + default thread
  // priority) from A3 (callback dispatcher drops under pressure).
  private val debugFireCount = AtomicLong(0)
  private val debugFirstFireUptime = AtomicLong(0)
  private val debugLastFireUptime = AtomicLong(0)
  // === END DIAGNOSTIC TELEMETRY ===

  init {
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
   *     → `releaseWakeLockIfNeeded()` (count-via-map)
   *  2. `dispose()` → `cleanupAll()` → explicit release
   *  3. `onHostDestroy()` (Activity destroy, via `LifecycleEventListener`)
   *     → `dispose()` → `cleanupAll()`
   *  4. `finalize()` (GC fallback) → `cleanupAll()`
   *
   * The only residual gap is "user callback that never returns" (e.g. a JS
   * deadlock holding a timer entry in the map). That is a consumer bug we
   * cannot protect against at the library level. In dev mode, Fast Refresh
   * (bundle reload without Activity destroy) also relies on `finalize()` —
   * non-deterministic, but acceptable as a dev-only limitation.
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
    if (timeoutRunnables.isEmpty() && intervalRunnables.isEmpty() && wakeLock.isHeld) {
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
    // early-returns if the service is not active.
    isExplicitBackgroundModeRequested.set(false)
    stopForegroundServiceInternal()
  }

  // --- Foreground service control ---
  /**
   * Starts the foreground service, promoting the host process to foreground
   * scheduling priority so timer Runnables are not throttled by the
   * `bg_non_interactive` cgroup.
   *
   * Idempotent: returns immediately if the service is already active. Safe
   * to call from any thread.
   *
   * On failure (e.g. Android 12+ background-start restriction), logs a
   * warning and leaves `isForegroundServiceActive = false`, so timers
   * continue running with wake-lock-only precision (~10% drift).
   */
  private fun startForegroundServiceInternal() {
    if (!isForegroundServiceActive.compareAndSet(false, true)) return
    val intent = Intent(reactContext, NitroBackgroundTimerService::class.java).apply {
      action = NitroBackgroundTimerService.ACTION_START
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
      Log.i(TAG, "Foreground service started")
    } catch (e: Exception) {
      // On API 31+ this can throw ForegroundServiceStartNotAllowedException
      // if the app tries to start it from a background state without a
      // qualifying trigger. We roll back the flag and fall through — timers
      // will run with wake-lock-only precision.
      Log.w(TAG, "Failed to start foreground service, falling back to wake lock only", e)
      isForegroundServiceActive.set(false)
    }
  }

  private fun stopForegroundServiceInternal() {
    if (!isForegroundServiceActive.compareAndSet(true, false)) return
    val intent = Intent(reactContext, NitroBackgroundTimerService::class.java)
    try {
      reactContext.stopService(intent)
      Log.i(TAG, "Foreground service stopped")
    } catch (e: Exception) {
      Log.w(TAG, "Failed to stop foreground service", e)
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
   * Idempotent via `isForegroundServiceActive` CAS inside
   * `startForegroundServiceInternal`: if the service is already up, this is
   * a no-op; if a concurrent start is in flight, the CAS loser returns
   * without side-effects.
   *
   * Note on explicit vs implicit mode: this method intentionally does NOT
   * short-circuit on `isExplicitBackgroundModeRequested`. A previous design
   * did, but that path silently swallowed the failure-retry case where
   * `startBackgroundMode()` tried and failed (e.g. Android 12+ background
   * start restriction) — subsequent timers would then never retry the
   * start. Checking only `isForegroundServiceActive` is both simpler and
   * self-healing.
   */
  private fun ensureForegroundServiceForTimer() {
    if (isForegroundServiceActive.get()) return
    startForegroundServiceInternal()
  }

  /**
   * Called after a timer is cleared or fires-and-completes. Stops the
   * foreground service only if both maps are empty AND the consumer has
   * not explicitly requested background mode. Must be called from the
   * worker thread (the maps are only safely-size-able after serialized
   * mutation).
   */
  private fun maybeStopForegroundServiceAfterClear() {
    if (isExplicitBackgroundModeRequested.get()) return
    if (timeoutRunnables.isNotEmpty() || intervalRunnables.isNotEmpty()) return
    stopForegroundServiceInternal()
  }

  // --- Public background-mode API ---
  override fun startBackgroundMode() {
    if (isDisposed.get()) {
      Log.w(TAG, "startBackgroundMode called on disposed instance, ignoring")
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

  override fun configure(configJson: String) {
    if (isDisposed.get()) {
      Log.w(TAG, "configure called on disposed instance, ignoring")
      return
    }
    // Gate on the semantic "is anyone still using the service" question,
    // not on the physical `isForegroundServiceActive` flag. The physical
    // flag is updated asynchronously by the worker thread inside
    // maybeStopForegroundServiceAfterClear(), so right after the user
    // calls stopBackgroundMode() it still reads `true` for a brief window,
    // even though the user has clearly signaled "I want this stopped".
    //
    // Semantic check: block configure if an explicit background mode is
    // requested OR any timer is holding the implicit fallback alive. This
    // covers every "the notification is currently visible and changing its
    // content would be confusing" case that Decision 2 of the B9 brief
    // meant to catch, while allowing the "stopBackgroundMode, then
    // immediately reconfigure for the next session" pattern to succeed.
    if (isExplicitBackgroundModeRequested.get() ||
        timeoutRunnables.isNotEmpty() ||
        intervalRunnables.isNotEmpty()) {
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
  override fun setTimeout(id: Double, duration: Double, callback: (Double) -> Unit) {
    if (isDisposed.get()) {
      Log.w(TAG, "setTimeout called on disposed instance, ignoring")
      return
    }
    // Implicit foreground service activation: kicks in when the consumer
    // hasn't called startBackgroundMode() explicitly. Called from the JS
    // thread before posting so the service request beats the timer race
    // against a quick app-background transition.
    ensureForegroundServiceForTimer()
    handler.post {
      // Safety net: between the JS-thread check above and this worker-side
      // block, a previous Runnable may have completed and stopped the
      // service via maybeStopForegroundServiceAfterClear(). Re-assert the
      // service state here — idempotent via CAS, no-op if already active.
      ensureForegroundServiceForTimer()

      val intId = id.toInt()
      // inline-clear previous timer with same id (no re-post to avoid deadlock-free but wasteful double-hop)
      timeoutRunnables[intId]?.let { handler.removeCallbacks(it) }
      timeoutRunnables.remove(intId)

      acquireWakeLock()
      val runnable = Runnable {
        try {
          callback(id)
        } catch (e: Exception) {
          Log.e(TAG, "Callback error in setTimeout($id): ${e.message}", e)
        }
        timeoutRunnables.remove(intId)
        releaseWakeLockIfNeeded()
        maybeStopForegroundServiceAfterClear()
      }

      timeoutRunnables[intId] = runnable
      handler.postDelayed(runnable, duration.toLong())
    }
  }

  override fun clearTimeout(id: Double) {
    if (isDisposed.get()) return
    handler.post {
      val intId = id.toInt()
      timeoutRunnables[intId]?.let { handler.removeCallbacks(it) }
      timeoutRunnables.remove(intId)
      releaseWakeLockIfNeeded()
      maybeStopForegroundServiceAfterClear()
    }
  }

  // --- Interval ---
  override fun setInterval(id: Double, interval: Double, callback: (Double) -> Unit) {
    if (isDisposed.get()) {
      Log.w(TAG, "setInterval called on disposed instance, ignoring")
      return
    }
    ensureForegroundServiceForTimer()
    handler.post {
      // Safety net: see equivalent comment in setTimeout above.
      ensureForegroundServiceForTimer()

      val intId = id.toInt()
      intervalRunnables[intId]?.let { handler.removeCallbacks(it) }
      intervalRunnables.remove(intId)

      acquireWakeLock()
      val runnable = object : Runnable {
        override fun run() {
          // === DIAGNOSTIC TELEMETRY (B8 step 2) ===
          val now = SystemClock.uptimeMillis()
          if (debugFireCount.get() == 0L) {
            debugFirstFireUptime.set(now)
          }
          debugLastFireUptime.set(now)
          debugFireCount.incrementAndGet()
          // === END DIAGNOSTIC TELEMETRY ===

          try {
            callback(id)
          } catch (e: Exception) {
            Log.e(TAG, "Callback error in setInterval($id): ${e.message}", e)
          }
          // Only reschedule if this interval is still registered and not disposed.
          // Wake lock stays held across ticks — no "renewal" needed (see acquireWakeLock() Kdoc).
          if (intervalRunnables.containsKey(intId) && !isDisposed.get()) {
            handler.postDelayed(this, interval.toLong())
          }
        }
      }

      intervalRunnables[intId] = runnable
      handler.postDelayed(runnable, interval.toLong())
    }
  }

  override fun clearInterval(id: Double) {
    if (isDisposed.get()) return
    handler.post {
      val intId = id.toInt()
      intervalRunnables[intId]?.let { handler.removeCallbacks(it) }
      intervalRunnables.remove(intId)
      releaseWakeLockIfNeeded()
      maybeStopForegroundServiceAfterClear()
    }
  }

  // === DIAGNOSTIC TELEMETRY (B8 step 2) ===
  // To be removed after Android scheduling fix is validated.
  override fun getDebugTelemetry(): String {
    val count = debugFireCount.get()
    val first = debugFirstFireUptime.get()
    val last = debugLastFireUptime.get()
    val effectiveIntervalMs = if (count > 1L) {
      (last - first).toDouble() / (count - 1).toDouble()
    } else {
      0.0
    }
    val threadPriority = try {
      Process.getThreadPriority(timerThread.threadId)
    } catch (e: Exception) {
      -999
    }
    return """{"fireCount":$count,"firstFireUptime":$first,"lastFireUptime":$last,"effectiveIntervalMs":$effectiveIntervalMs,"threadPriority":$threadPriority}"""
  }
  // === END DIAGNOSTIC TELEMETRY ===

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
    if (!isDisposed.compareAndSet(false, true)) {
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
  }
}
