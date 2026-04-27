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

/**
 * Configuration for the Android foreground service notification used when
 * background mode is active. All fields are optional; omitted fields fall
 * back to sensible defaults (generic title, app launcher icon, library
 * channel id). On iOS this configuration is ignored — iOS does not use a
 * foreground service for background scheduling.
 */
export interface BackgroundTimerNotificationConfig {
  /** Notification title. Default: `"Background Timer Active"`. */
  title?: string
  /** Notification body text. Default: `"Tap to return to the app"`. */
  text?: string
  /**
   * Android notification channel id. Default: `"nitro_bg_timer_channel"`.
   * Channels are created on first use (API 26+).
   */
  channelId?: string
  /** Android notification channel name. Default: `"Background Timer"`. */
  channelName?: string
  /**
   * Name of a drawable resource in the consumer app (e.g. `"ic_workout"`)
   * to use as the notification small icon. If omitted or not found at
   * runtime, the library falls back to the app's launcher icon, and then
   * to a generic system icon.
   */
  iconResourceName?: string
}

export interface BackgroundTimerConfig {
  notification?: BackgroundTimerNotificationConfig
}

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
      try {
        timeoutCallbacks.get(id)?.()
      } finally {
        timeoutCallbacks.delete(id)
      }
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

  /**
   * Configures the Android foreground service notification used when
   * background mode is active. Must be called before any timer is
   * scheduled and before `startBackgroundMode()` — calling it while the
   * service is already running throws on the native side.
   *
   * On iOS this is a no-op: iOS does not use a foreground service for
   * background scheduling (the main run loop + `beginBackgroundTask`
   * handle it natively).
   *
   * @throws if called on a disposed `BackgroundTimer` instance.
   */
  configure(config: BackgroundTimerConfig): void {
    if (isDisposed) {
      throw new Error(
        'BackgroundTimer.configure: cannot configure a disposed BackgroundTimer instance'
      )
    }
    NitroBackgroundTimer.configure(JSON.stringify(config ?? {}))
  },

  /**
   * Requests background mode explicitly. On Android, this starts a
   * foreground service that keeps the host process at foreground
   * scheduling priority for the entire session, so `setInterval` /
   * `setTimeout` fire with zero drift even in background / screen-off.
   * The accompanying persistent notification stays stable until
   * `stopBackgroundMode()` or `dispose()` is called.
   *
   * Use this when you have a known critical session (workout, recording,
   * tracking) and want one stable notification for its duration, instead
   * of the implicit-fallback behaviour that starts/stops the service
   * around each individual timer.
   *
   * Idempotent: multiple calls have no additional effect. On iOS this is
   * a no-op — iOS handles background timer accuracy natively.
   *
   * @throws if called on a disposed `BackgroundTimer` instance.
   */
  startBackgroundMode(): void {
    if (isDisposed) {
      throw new Error(
        'BackgroundTimer.startBackgroundMode: cannot start background mode on a disposed BackgroundTimer instance'
      )
    }
    NitroBackgroundTimer.startBackgroundMode()
  },

  /**
   * Releases the explicit background mode requested via
   * `startBackgroundMode()`. If timers are still active and the implicit
   * fallback is enabled, the foreground service continues running until
   * the last timer completes — only the explicit hold is released.
   *
   * On a disposed instance this is a silent no-op (for symmetry with
   * `clearTimeout` / `clearInterval`). iOS: no-op.
   */
  stopBackgroundMode(): void {
    if (isDisposed) return
    NitroBackgroundTimer.stopBackgroundMode()
  },

  /**
   * Disables the automatic Android foreground service fallback for the
   * lifetime of the process. Must be called before any timer is scheduled
   * and before `startBackgroundMode()` — calling it later throws. Not
   * reversible within the same process. Idempotent: second and subsequent
   * calls are silent no-ops. iOS: no-op.
   *
   * Use this when your app does not need accurate background scheduling,
   * or when you already have your own foreground service (e.g. media
   * playback, location tracking) and don't want a second one. Timers
   * keep working via the wake-lock fallback with ~10% drift in background.
   *
   * See the "Disabling the foreground service" section of the README for
   * full semantics, including how to pair the runtime opt-out with
   * `tools:node="remove"` manifest entries to eliminate the Play Store
   * `specialUse` review friction entirely.
   */
  disableForegroundService(): void {
    NitroBackgroundTimer.disableForegroundService()
  },
}
