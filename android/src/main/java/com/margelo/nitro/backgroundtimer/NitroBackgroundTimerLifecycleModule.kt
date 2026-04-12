package com.margelo.nitro.backgroundtimer

import android.util.Log
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.module.annotations.ReactModule

/**
 * Companion TurboModule whose sole purpose is to dispose the live
 * `NitroBackgroundTimer` instance deterministically when React Native tears
 * down. It listens to two independent cleanup triggers:
 *
 *  - `onHostDestroy()` — fired when the host Activity is destroyed (user
 *    closes the app, system kills the task). Covers foreground cleanup.
 *  - `invalidate()` — fired on bundle reload (Fast Refresh in dev) and on
 *    bridge teardown in both Bridge and Bridgeless modes. Covers dev reload
 *    and most prod destroy paths.
 *
 * Both paths funnel through [NitroBackgroundTimerInstanceHolder.disposeIfActive],
 * which is idempotent.
 */
@ReactModule(name = NitroBackgroundTimerLifecycleModule.NAME)
class NitroBackgroundTimerLifecycleModule(
  reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext), LifecycleEventListener {

  init {
    reactContext.addLifecycleEventListener(this)
  }

  override fun getName(): String = NAME

  override fun onHostResume() {
    // no-op
  }

  override fun onHostPause() {
    // no-op
  }

  override fun onHostDestroy() {
    Log.i(TAG, "onHostDestroy triggered cleanup")
    NitroBackgroundTimerInstanceHolder.disposeIfActive()
  }

  override fun invalidate() {
    Log.i(TAG, "Companion module invalidate() triggered cleanup")
    NitroBackgroundTimerInstanceHolder.disposeIfActive()
    super.invalidate()
  }

  companion object {
    const val NAME = "NitroBackgroundTimerLifecycle"
    private const val TAG = "NitroBgTimer"
  }
}
