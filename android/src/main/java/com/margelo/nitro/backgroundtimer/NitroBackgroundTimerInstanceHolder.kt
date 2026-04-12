package com.margelo.nitro.backgroundtimer

import android.util.Log
import java.lang.ref.WeakReference

/**
 * Singleton holder that tracks the currently live `NitroBackgroundTimer` instance so the
 * companion lifecycle TurboModule can dispose it deterministically on bundle reload
 * (`invalidate()`) or Activity destroy (`onHostDestroy`).
 *
 * The instance is held via `WeakReference` so this holder never prevents GC; it only
 * provides a deterministic cleanup path when RN tears down the bridge/host.
 */
internal object NitroBackgroundTimerInstanceHolder {
  private const val TAG = "NitroBgTimer"

  @Volatile
  private var instanceRef: WeakReference<NitroBackgroundTimer>? = null

  fun setInstance(timer: NitroBackgroundTimer) {
    instanceRef = WeakReference(timer)
  }

  fun disposeIfActive() {
    val timer = instanceRef?.get()
    instanceRef = null
    if (timer != null) {
      try {
        timer.dispose()
      } catch (e: Exception) {
        Log.w(TAG, "Error disposing NitroBackgroundTimer from lifecycle hook", e)
      }
    }
  }
}
