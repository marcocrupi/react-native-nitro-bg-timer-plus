import { NitroModules } from 'react-native-nitro-modules'
import type { NitroBackgroundTimer as NitroBackgroundTimerSpec } from './specs/NitroBackgroundTimer.nitro'

export const NitroBackgroundTimer =
  NitroModules.createHybridObject<NitroBackgroundTimerSpec>(
    'NitroBackgroundTimer'
  )
let nextId = 1
const timeoutCallbacks = new Map<number, () => void>()
const intervalCallbacks = new Map<number, () => void>()

let isDisposed = false

export const BackgroundTimer = {
  setTimeout(callback: () => void, duration: number): number {
    if (isDisposed) {
      throw new Error(
        'BackgroundTimer.setTimeout: cannot schedule timers on a disposed BackgroundTimer instance'
      )
    }
    if (typeof callback !== 'function') {
      throw new TypeError(
        'BackgroundTimer.setTimeout: callback must be a function'
      )
    }
    if (
      typeof duration !== 'number' ||
      !Number.isFinite(duration) ||
      duration < 0
    ) {
      throw new RangeError(
        'BackgroundTimer.setTimeout: duration must be a non-negative finite number'
      )
    }
    const id = nextId++
    timeoutCallbacks.set(id, callback)
    NitroBackgroundTimer.setTimeout(id, duration, () => {
      timeoutCallbacks.get(id)?.()
      timeoutCallbacks.delete(id)
    })
    return id
  },

  clearTimeout(id: number) {
    if (isDisposed) return
    timeoutCallbacks.delete(id)
    NitroBackgroundTimer.clearTimeout(id)
  },

  setInterval(callback: () => void, interval: number): number {
    if (isDisposed) {
      throw new Error(
        'BackgroundTimer.setInterval: cannot schedule timers on a disposed BackgroundTimer instance'
      )
    }
    if (typeof callback !== 'function') {
      throw new TypeError(
        'BackgroundTimer.setInterval: callback must be a function'
      )
    }
    if (
      typeof interval !== 'number' ||
      !Number.isFinite(interval) ||
      interval < 0
    ) {
      throw new RangeError(
        'BackgroundTimer.setInterval: interval must be a non-negative finite number'
      )
    }
    const id = nextId++
    intervalCallbacks.set(id, callback)
    NitroBackgroundTimer.setInterval(id, interval, () => {
      intervalCallbacks.get(id)?.()
    })
    return id
  },

  clearInterval(id: number) {
    if (isDisposed) return
    intervalCallbacks.delete(id)
    NitroBackgroundTimer.clearInterval(id)
  },

  /**
   * Eagerly disposes all native resources held by the background timer
   * (wake lock / background task, pending runnables, worker thread).
   *
   * After calling `dispose()`, this `BackgroundTimer` instance is permanently
   * unusable: subsequent calls to `setTimeout` or `setInterval` will throw,
   * while `clearTimeout` and `clearInterval` are silently no-op. Calling
   * `dispose()` twice is safe and idempotent.
   *
   * Calling `dispose()` is **not** required for correct cleanup in normal
   * usage — the library registers native lifecycle hooks that release
   * resources on bundle reload and app destroy, and falls back to GC
   * finalizers otherwise. Call it explicitly when you want deterministic
   * teardown, e.g. before tearing down an isolated feature module.
   */
  dispose(): void {
    if (isDisposed) return
    isDisposed = true
    timeoutCallbacks.clear()
    intervalCallbacks.clear()
    NitroBackgroundTimer.dispose()
  },
}
