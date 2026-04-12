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
  isForegroundServiceActive: false,
  isExplicitBackgroundModeRequested: false,
  lastConfigJson: null as string | null,
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
  dispose: jest.fn(() => {
    state.timers.clear()
    state.isForegroundServiceActive = false
    state.isExplicitBackgroundModeRequested = false
    state.lastConfigJson = null
  }),
  startBackgroundMode: jest.fn(() => {
    state.isExplicitBackgroundModeRequested = true
    state.isForegroundServiceActive = true
  }),
  stopBackgroundMode: jest.fn(() => {
    state.isExplicitBackgroundModeRequested = false
    // Only stop the service if no timers hold it up via the implicit fallback.
    if (state.timers.size === 0) {
      state.isForegroundServiceActive = false
    }
  }),
  configure: jest.fn((configJson: string) => {
    // Mirror the native IllegalStateException path so test code can verify
    // it. Matches the native semantic check: block if explicit mode is
    // requested OR any timer is scheduled (holding the implicit fallback
    // alive). Intentionally does NOT check state.isForegroundServiceActive
    // on its own — the physical flag is a lagging indicator that would
    // spuriously block configure right after stopBackgroundMode.
    const hasActiveTimers = Array.from(state.timers.values()).some(
      (t) => !t.cleared
    )
    if (state.isExplicitBackgroundModeRequested || hasActiveTimers) {
      throw new Error(
        'BackgroundTimer.configure() cannot be called while a background mode session is active.'
      )
    }
    state.lastConfigJson = configJson
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
    // Mirror native setTimeout semantics: after the Runnable fires, the
    // native side removes the entry from `timeoutRunnables`. Intervals
    // stay in the map because they reschedule themselves. Without this,
    // `hasActiveTimers` in the `configure` mock would stay true forever
    // after a setTimeout fires, diverging from native.
    if (t.type === 'timeout') {
      state.timers.delete(id)
    }
  },
  getTimer(id: number) {
    return state.timers.get(id)
  },
  reset() {
    state.timers.clear()
    state.isForegroundServiceActive = false
    state.isExplicitBackgroundModeRequested = false
    state.lastConfigJson = null
    mockNativeTimer.setTimeout.mockClear()
    mockNativeTimer.clearTimeout.mockClear()
    mockNativeTimer.setInterval.mockClear()
    mockNativeTimer.clearInterval.mockClear()
    mockNativeTimer.dispose.mockClear()
    mockNativeTimer.startBackgroundMode.mockClear()
    mockNativeTimer.stopBackgroundMode.mockClear()
    mockNativeTimer.configure.mockClear()
  },
  disposeCalls(): number {
    return mockNativeTimer.dispose.mock.calls.length
  },
  isForegroundServiceActive(): boolean {
    return state.isForegroundServiceActive
  },
  isExplicitBackgroundModeRequested(): boolean {
    return state.isExplicitBackgroundModeRequested
  },
  lastConfigJson(): string | null {
    return state.lastConfigJson
  },
  startBackgroundModeCalls(): number {
    return mockNativeTimer.startBackgroundMode.mock.calls.length
  },
  stopBackgroundModeCalls(): number {
    return mockNativeTimer.stopBackgroundMode.mock.calls.length
  },
  configureCalls(): number {
    return mockNativeTimer.configure.mock.calls.length
  },
}
