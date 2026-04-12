package com.margelo.nitro.backgroundtimer

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * React Native package for `react-native-nitro-bg-timer-plus`.
 *
 * Responsibilities:
 *  1. **C++ bootstrap** — the static initializer loads the `NitroBackgroundTimer`
 *     native library via `NitroBackgroundTimerOnLoad.initializeNative()` so the
 *     Nitro `HybridObject` can be constructed on first JS access.
 *  2. **Lifecycle companion registration** — exposes [NitroBackgroundTimerLifecycleModule]
 *     so React Native can invoke its `invalidate()` and `LifecycleEventListener`
 *     hooks, which dispose the live `NitroBackgroundTimer` instance on bundle
 *     reload and Activity destroy. The timer itself is a Nitro HybridObject
 *     and is **not** registered as a TurboModule — only the lifecycle companion is.
 */
class NitroBackgroundTimerPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
    return if (name == NitroBackgroundTimerLifecycleModule.NAME) {
      NitroBackgroundTimerLifecycleModule(reactContext)
    } else {
      null
    }
  }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
    return ReactModuleInfoProvider {
      mapOf(
        NitroBackgroundTimerLifecycleModule.NAME to ReactModuleInfo(
          NitroBackgroundTimerLifecycleModule.NAME,
          NitroBackgroundTimerLifecycleModule::class.java.name,
          false, // canOverrideExistingModule
          // needsEagerInit MUST be true: the lifecycle module is never called from
          // JS, so without eager init React Native would never instantiate it and
          // neither its `LifecycleEventListener.onHostDestroy()` nor its
          // `invalidate()` override would ever fire — defeating the entire purpose
          // of the companion module. See ModuleHolder.kt:49-51 and 100-102 in RN
          // for the lazy-vs-eager creation paths.
          true, // needsEagerInit
          false, // isCxxModule
          false, // isTurboModule — this is a classic NativeModule for lifecycle only
        )
      )
    }
  }

  companion object {
    init {
      NitroBackgroundTimerOnLoad.initializeNative()
    }
  }
}
