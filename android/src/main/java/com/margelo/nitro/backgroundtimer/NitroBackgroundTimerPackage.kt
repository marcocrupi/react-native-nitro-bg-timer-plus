package com.margelo.nitro.backgroundtimer

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * React Native package for `react-native-nitro-bg-timer-plus`.
 *
 * Sole responsibility: load the Nitro C++ library at class-load time via
 * `NitroBackgroundTimerOnLoad.initializeNative()` so the `HybridObject` can
 * be constructed on first JS access.
 *
 * The package deliberately exposes **no** `NativeModule` or `TurboModule`.
 * Lifecycle cleanup lives inside [NitroBackgroundTimer] itself, which
 * registers as a `LifecycleEventListener` on the `ReactApplicationContext`
 * via `NitroModules.applicationContext`. This approach works identically in
 * Bridge and Bridgeless modes, whereas a companion `NativeModule` would be
 * unreachable in Bridgeless without `useTurboModuleInterop()` (see the
 * commit message of this file's rewrite for details).
 *
 * **Manual linking note**: autolinking (RN 0.60+) registers this package
 * automatically. If you use manual linking, you MUST add
 * `NitroBackgroundTimerPackage` to your host app's `getPackages()` —
 * otherwise the `companion object` static `initializeNative()` block is
 * never executed and the Nitro C++ library is never loaded, causing the
 * `HybridObject` to crash on first access with `UnsatisfiedLinkError`.
 */
class NitroBackgroundTimerPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? = null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider =
    ReactModuleInfoProvider { emptyMap() }

  companion object {
    init {
      NitroBackgroundTimerOnLoad.initializeNative()
    }
  }
}
