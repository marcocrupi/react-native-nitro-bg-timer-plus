package com.margelo.nitro.backgroundtimer

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.facebook.react.turbomodule.core.interfaces.TurboModule
import java.lang.ref.WeakReference

/** Loads the Nitro bindings and supplies a context-scoped runtime cleanup owner. */
class NitroBackgroundTimerPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
    if (name == NitroBackgroundTimerRuntimeOwner.NAME) NitroBackgroundTimerRuntimeOwner(reactContext) else null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider =
    ReactModuleInfoProvider {
      mapOf(NitroBackgroundTimerRuntimeOwner.NAME to ReactModuleInfo(
        NitroBackgroundTimerRuntimeOwner.NAME,
        NitroBackgroundTimerRuntimeOwner::class.java.name,
        false, false, false, true
      ))
    }

  companion object {
    init {
      NitroBackgroundTimerOnLoad.initializeNative()
    }
  }
}

/**
 * Instantiated through getNativeModule before a timer starts its worker. RN 0.87
 * retains this TurboModule and invokes invalidate() on ReactInstance destruction,
 * including reload; Activity destruction does not invalidate it. No JS methods
 * or generated binding are needed for this internal native lifecycle owner.
 */
internal class NitroBackgroundTimerRuntimeOwner(private val context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context), TurboModule {
  private val lock = Any()
  private var invalidated = false
  // Runtime-scoped ownership, released on explicit cleanup or invalidation.
  // A weak registry could lose an idle worker before its finalizer runs, leaving
  // invalidate() unable to clean it deterministically. This is not a global root.
  private val timers = mutableSetOf<NitroBackgroundTimer>()
  // A disposed timer unregisters on its worker just before that worker exits.
  // Preserve that termination boundary without retaining disposed timers or
  // terminated threads for the rest of the runtime.
  private val retiringWorkers = mutableListOf<WeakReference<Thread>>()

  override fun getName(): String = NAME

  fun owns(candidate: ReactApplicationContext): Boolean = context === candidate

  fun register(timer: NitroBackgroundTimer): Boolean = synchronized(lock) {
    retiringWorkers.removeAll { it.get()?.isAlive != true }
    if (invalidated) return@synchronized false
    timers.add(timer)
    true
  }

  fun unregister(timer: NitroBackgroundTimer, worker: Thread) = synchronized(lock) {
    timers.remove(timer)
    retiringWorkers.removeAll { it.get()?.isAlive != true }
    // If invalidate already took its snapshot, it owns this timer and joins
    // its worker. Otherwise it must also see workers finishing manual dispose.
    if (!invalidated && worker.isAlive) retiringWorkers.add(WeakReference(worker))
    Unit
  }

  override fun invalidate() {
    val (retiring, workers) = synchronized(lock) {
      invalidated = true
      val retiring = timers.toList().also { timers.clear() }
      val workers = retiringWorkers.mapNotNull { it.get()?.takeIf { worker -> worker.isAlive } }
      retiringWorkers.clear()
      retiring to workers
    }
    // Never hold the registry lock while disposing or waiting on a worker.
    retiring.forEach { it.dispose() }
    // RN creates the next runtime after invalidate returns. Finish old worker
    // cleanup (including stopService) first, so it cannot stop the new owner's
    // service. A manual dispose still in flight remains registered until cleanup.
    retiring.forEach { it.awaitRuntimeCleanup() }
    var interrupted = false
    workers.forEach { worker ->
      if (worker !== Thread.currentThread()) {
        while (worker.isAlive) {
          try {
            worker.join()
          } catch (_: InterruptedException) {
            interrupted = true
          }
        }
      }
    }
    if (interrupted) Thread.currentThread().interrupt()
    super.invalidate()
  }

  companion object {
    const val NAME = "NitroBackgroundTimerRuntimeOwner"
  }
}
