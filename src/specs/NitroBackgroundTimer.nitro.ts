import type { HybridObject } from 'react-native-nitro-modules'

export enum FiredTimerType {
  Timeout = 0,
  Interval = 1,
}

export interface FiredTimerEvent {
  id: number
  type: FiredTimerType
  sequence: number
}

export interface NitroBackgroundTimer extends HybridObject<{
  ios: 'swift'
  android: 'kotlin'
}> {
  setTimeout(id: number, duration: number): void
  clearTimeout(id: number): void
  setInterval(id: number, interval: number): void
  clearInterval(id: number): void
  drainFiredTimers(): FiredTimerEvent[]
  /**
   * Explicitly request background mode. On Android, starts a foreground
   * service that keeps the process at foreground scheduling priority for
   * accurate timer delivery. Idempotent. iOS: no-op (iOS handles
   * background scheduling natively).
   */
  startBackgroundMode(): void
  /**
   * Release explicit background mode. If timers are still active and the
   * implicit fallback is in effect, the foreground service remains alive
   * until the last timer completes. iOS: no-op.
   */
  stopBackgroundMode(): void
  /**
   * Configure the foreground service notification. Accepts a JSON-
   * serialized `BackgroundTimerConfig`. Must be called before the service
   * is active; throws otherwise. iOS: no-op.
   */
  configure(configJson: string): void
  /**
   * Disable the automatic Android foreground service fallback for the
   * lifetime of the process. Must be called before any timer is
   * scheduled and before `startBackgroundMode()`. Throws on Android
   * (`IllegalStateException` → JS `Error`) if called after a timer
   * has already activated the foreground service. Not reversible
   * within the same process — call once at app startup. Idempotent:
   * second and subsequent calls are silent no-ops. iOS: no-op (iOS
   * has no foreground service concept).
   */
  disableForegroundService(): void
}
