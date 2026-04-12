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
}
