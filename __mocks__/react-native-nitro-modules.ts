type TimerCallback = (id: number) => void

interface CapturedTimer {
  id: number
  duration: number
  callback: TimerCallback
  type: 'timeout' | 'interval'
  cleared: boolean
}

const state = {
  timers: new Map<number, CapturedTimer>(),
}

const mockNativeTimer = {
  setTimeout: jest.fn(
    (id: number, duration: number, callback: TimerCallback) => {
      state.timers.set(id, {
        id,
        duration,
        callback,
        type: 'timeout',
        cleared: false,
      })
    }
  ),
  clearTimeout: jest.fn((id: number) => {
    const t = state.timers.get(id)
    if (t) t.cleared = true
  }),
  setInterval: jest.fn(
    (id: number, interval: number, callback: TimerCallback) => {
      state.timers.set(id, {
        id,
        duration: interval,
        callback,
        type: 'interval',
        cleared: false,
      })
    }
  ),
  clearInterval: jest.fn((id: number) => {
    const t = state.timers.get(id)
    if (t) t.cleared = true
  }),
}

export const NitroModules = {
  createHybridObject: jest.fn(() => mockNativeTimer),
}

export const __mockHelpers = {
  fireTimer(id: number) {
    const t = state.timers.get(id)
    if (!t) throw new Error(`No timer with id ${id}`)
    if (t.cleared) return
    t.callback(id)
  },
  getTimer(id: number) {
    return state.timers.get(id)
  },
  reset() {
    state.timers.clear()
    mockNativeTimer.setTimeout.mockClear()
    mockNativeTimer.clearTimeout.mockClear()
    mockNativeTimer.setInterval.mockClear()
    mockNativeTimer.clearInterval.mockClear()
  },
}
