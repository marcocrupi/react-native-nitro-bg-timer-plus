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
   * Request this owner's explicit Android foreground-service hold. Starts
   * are subject to OS restrictions; timing and promotion are not guaranteed.
   * Repeated pending/active requests add no holds. A later request can retry
   * a recoverable refusal. iOS: no-op; does not extend the background budget.
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
   * serialized `BackgroundTimerConfig`. This owner must have no explicit
   * hold or uncleared accepted/pending/active timers; throws otherwise.
   * Other owners may remain active. iOS: no-op.
   */
  configure(configJson: string): void
  /**
   * Disable the automatic Android foreground service fallback for the
   * lifetime of the process. The first successful call must precede any
   * timer acceptance or explicit request across all owners, including
   * already-finished timers. A late first call throws on Android
   * (`IllegalStateException` → JS `Error`). After successful opt-out,
   * repeated calls are no-ops. Only a fresh process can enable FGS again.
   * iOS: no-op. Android ignores calls on disposed owners.
   */
  disableForegroundService(): void
}
