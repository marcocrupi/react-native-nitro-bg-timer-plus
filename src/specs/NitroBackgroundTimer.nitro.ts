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
   * DIAGNOSTIC ONLY (B8 step 2). Returns native fire count, first/last
   * uptime stamps, effective interval, and thread priority as a JSON
   * string. To be removed after Android scheduling fix is validated.
   */
  getDebugTelemetry(): string
}
