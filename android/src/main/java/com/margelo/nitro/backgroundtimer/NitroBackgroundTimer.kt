package com.margelo.nitro.backgroundtimer

import android.annotation.SuppressLint
import android.os.Handler
import android.os.HandlerThread
import android.os.PowerManager
import android.util.Log
import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.ReactApplicationContext
import com.margelo.nitro.NitroModules
import java.util.concurrent.ConcurrentHashMap

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

  private val timerThread = HandlerThread("NitroBgTimer-Worker").apply { start() }
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

  @Volatile
  private var isDisposed: Boolean = false

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
  }

  // --- Timeout ---
  override fun setTimeout(id: Double, duration: Double, callback: (Double) -> Unit) {
    if (isDisposed) {
      Log.w(TAG, "setTimeout called on disposed instance, ignoring")
      return
    }
    handler.post {
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
      }

      timeoutRunnables[intId] = runnable
      handler.postDelayed(runnable, duration.toLong())
    }
  }

  override fun clearTimeout(id: Double) {
    if (isDisposed) return
    handler.post {
      val intId = id.toInt()
      timeoutRunnables[intId]?.let { handler.removeCallbacks(it) }
      timeoutRunnables.remove(intId)
      releaseWakeLockIfNeeded()
    }
  }

  // --- Interval ---
  override fun setInterval(id: Double, interval: Double, callback: (Double) -> Unit) {
    if (isDisposed) {
      Log.w(TAG, "setInterval called on disposed instance, ignoring")
      return
    }
    handler.post {
      val intId = id.toInt()
      intervalRunnables[intId]?.let { handler.removeCallbacks(it) }
      intervalRunnables.remove(intId)

      acquireWakeLock()
      val runnable = object : Runnable {
        override fun run() {
          try {
            callback(id)
          } catch (e: Exception) {
            Log.e(TAG, "Callback error in setInterval($id): ${e.message}", e)
          }
          // Only reschedule if this interval is still registered and not disposed.
          // Wake lock stays held across ticks — no "renewal" needed (see acquireWakeLock() Kdoc).
          if (intervalRunnables.containsKey(intId) && !isDisposed) {
            handler.postDelayed(this, interval.toLong())
          }
        }
      }

      intervalRunnables[intId] = runnable
      handler.postDelayed(runnable, interval.toLong())
    }
  }

  override fun clearInterval(id: Double) {
    if (isDisposed) return
    handler.post {
      val intId = id.toInt()
      intervalRunnables[intId]?.let { handler.removeCallbacks(it) }
      intervalRunnables.remove(intId)
      releaseWakeLockIfNeeded()
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
    if (isDisposed) {
      Log.w(TAG, "dispose() called on already-disposed instance, ignoring")
      super.dispose()
      return
    }
    isDisposed = true

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
    if (!isDisposed) {
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
