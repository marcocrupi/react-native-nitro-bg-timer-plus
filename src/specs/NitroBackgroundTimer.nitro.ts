import type { HybridObject } from 'react-native-nitro-modules'

export interface NitroBackgroundTimer extends HybridObject<{
  ios: 'swift'
  android: 'kotlin'
}> {
  setTimeout(id: number, duration: number, callback: (id: number) => void): void
  clearTimeout(id: number): void
  setInterval(
    id: number,
    interval: number,
    callback: (id: number) => void
  ): void
  clearInterval(id: number): void
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
}
