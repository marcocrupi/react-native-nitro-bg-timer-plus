import {
  DeviceEventEmitter,
  NativeEventEmitter,
  NativeModules,
  Platform,
} from 'react-native'
import { NitroModules } from 'react-native-nitro-modules'
import {
  FiredTimerType,
  type FiredTimerEvent,
  type NitroBackgroundTimer as NitroBackgroundTimerSpec,
} from './specs/NitroBackgroundTimer.nitro'

export const NitroBackgroundTimer =
  NitroModules.createHybridObject<NitroBackgroundTimerSpec>(
    'NitroBackgroundTimer'
  )

const TIMERS_AVAILABLE_EVENT = 'NitroBackgroundTimerTimersAvailable'

type TimerEventSubscription = {
  remove(): void
}

type CallbackOutcome = { threw: false } | { threw: true; value: unknown }

let nextId = 1
const timeoutCallbacks = new Map<number, () => void>()
const intervalCallbacks = new Map<number, () => void>()

let isDisposed = false
let isDraining = false
let shouldDrainAgain = false

const onTimersAvailable = () => {
  drainFiredTimers()
}

let timerEventSubscription: TimerEventSubscription | undefined =
  Platform.OS === 'ios' && NativeModules.NitroBackgroundTimerEventEmitter
    ? new NativeEventEmitter(
        NativeModules.NitroBackgroundTimerEventEmitter
      ).addListener(TIMERS_AVAILABLE_EVENT, onTimersAvailable)
    : DeviceEventEmitter.addListener(TIMERS_AVAILABLE_EVENT, onTimersAvailable)

function handleFiredTimer(event: FiredTimerEvent): CallbackOutcome {
  if (event.type === FiredTimerType.Timeout) {
    const callback = timeoutCallbacks.get(event.id)
    try {
      callback?.()
    } catch (error) {
      return { threw: true, value: error }
    } finally {
      timeoutCallbacks.delete(event.id)
    }
    return { threw: false }
  }

  if (event.type === FiredTimerType.Interval) {
    const callback = intervalCallbacks.get(event.id)
    if (!callback) return { threw: false }

    try {
      callback()
    } catch (error) {
      return { threw: true, value: error }
    }
  }

  return { threw: false }
}

function drainFiredTimers(): void {
  if (isDisposed) return
  if (isDraining) {
    shouldDrainAgain = true
    return
  }

  isDraining = true
  let hasError = false
  let firstError: unknown

  try {
    do {
      shouldDrainAgain = false
      const events = NitroBackgroundTimer.drainFiredTimers()

      for (const event of events) {
        const outcome = handleFiredTimer(event)
        if (!hasError && outcome.threw) {
          hasError = true
          firstError = outcome.value
        }
      }
    } while (shouldDrainAgain)
  } finally {
    isDraining = false
  }

  if (hasError) {
    throw firstError
  }
}

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
    try {
      NitroBackgroundTimer.setTimeout(id, duration)
    } catch (error) {
      timeoutCallbacks.delete(id)
      throw error
    }
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
    try {
      NitroBackgroundTimer.setInterval(id, interval)
    } catch (error) {
      intervalCallbacks.delete(id)
      throw error
    }
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
   * This wrapper is shared by all consumers. Use clearTimeout/clearInterval
   * for ordinary feature cleanup; dispose only when every consumer is done.
   * Return is not a synchronous cross-platform resource-settlement receipt:
   * iOS cleanup is dispatched to the main queue. Process termination does
   * not guarantee that cleanup callbacks run.
   */
  dispose(): void {
    if (isDisposed) return
    isDisposed = true
    timeoutCallbacks.clear()
    intervalCallbacks.clear()
    timerEventSubscription?.remove()
    timerEventSubscription = undefined
    NitroBackgroundTimer.dispose()
  },

  /**
   * Configures the Android foreground service notification used when
   * background mode is active. This owner must have no explicit hold or
   * uncleared accepted/pending/active timers. Clear its timers and stop
   * its explicit hold before reconfiguration; other owners may remain active.
   * New sessions snapshot the configuration; this does not edit a live session.
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
   * Requests an explicit Android foreground-service hold, including when
   * there are no timers. Starts remain subject to OS restrictions and can
   * fail. Neither service promotion nor timer precision is guaranteed.
   *
   * Use it to retain this owner's service demand across gaps between timers.
   * The service and notification are shared: another owner can retain demand
   * or supply the notification after this owner releases its hold.
   *
   * Repeated pending/active requests add no holds. A later request can retry
   * a recoverable refusal. After process-wide FGS opt-out, native start is a
   * no-op. On iOS this is a no-op and does not extend its background budget.
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
   * lifetime of the process. The first successful call must precede any
   * timer acceptance or explicit background request across all native owners;
   * a first call after such use throws even if the timers have finished.
   * After successful opt-out, repeated calls are no-ops, including with active
   * timers. Only a fresh process can enable FGS again. iOS: no-op.
   *
   * Timers can use the wake-lock fallback while the process remains alive.
   * There is no guaranteed drift percentage, background execution window
   * or process survival. The wrapper always forwards this method, including
   * after disposal; Android's native implementation ignores disposed owners.
   *
   * See the README's "Notifications and opt-out" section for app-side
   * manifest-merger removal. Runtime opt-out does not remove service or
   * permission declarations and does not establish store approval.
   */
  disableForegroundService(): void {
    NitroBackgroundTimer.disableForegroundService()
  },
}

drainFiredTimers()
