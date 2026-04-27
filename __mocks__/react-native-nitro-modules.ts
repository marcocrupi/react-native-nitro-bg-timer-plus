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
  pendingTimers: new Map<number, CapturedTimer>(),
  acceptedTimers: new Map<number, CapturedTimer>(),
  inactiveTimerIds: new Set<number>(),
  isForegroundServiceActive: false,
  isExplicitBackgroundModeRequested: false,
  lastConfigJson: null as string | null,
}

const hasAcceptedTimers = () => state.acceptedTimers.size > 0

const updateImplicitForegroundService = () => {
  if (!state.isExplicitBackgroundModeRequested && !hasAcceptedTimers()) {
    state.isForegroundServiceActive = false
  }
}

const acceptTimer = (timer: CapturedTimer) => {
  state.inactiveTimerIds.delete(timer.id)
  state.acceptedTimers.set(timer.id, timer)
  state.pendingTimers.set(timer.id, timer)
  state.isForegroundServiceActive = true
}

const clearAcceptedTimer = (id: number) => {
  const timer = state.acceptedTimers.get(id)
  if (timer) {
    timer.cleared = true
    state.inactiveTimerIds.add(id)
  }
  state.pendingTimers.delete(id)
  state.timers.delete(id)
  state.acceptedTimers.delete(id)
  updateImplicitForegroundService()
}

const materializeTimer = (id: number) => {
  const activeTimer = state.timers.get(id)
  if (activeTimer) return activeTimer

  const pendingTimer = state.pendingTimers.get(id)
  if (!pendingTimer) return undefined

  state.pendingTimers.delete(id)
  if (!pendingTimer.cleared) {
    state.timers.set(id, pendingTimer)
  }
  return pendingTimer
}

const mockNativeTimer = {
  setTimeout: jest.fn(
    (id: number, duration: number, callback: TimerCallback) => {
      acceptTimer({
        id,
        duration,
        callback,
        type: 'timeout',
        cleared: false,
      })
    }
  ),
  clearTimeout: jest.fn((id: number) => {
    clearAcceptedTimer(id)
  }),
  setInterval: jest.fn(
    (id: number, interval: number, callback: TimerCallback) => {
      acceptTimer({
        id,
        duration: interval,
        callback,
        type: 'interval',
        cleared: false,
      })
    }
  ),
  clearInterval: jest.fn((id: number) => {
    clearAcceptedTimer(id)
  }),
  dispose: jest.fn(() => {
    state.timers.clear()
    state.pendingTimers.clear()
    state.acceptedTimers.clear()
    state.inactiveTimerIds.clear()
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
    if (!hasAcceptedTimers()) {
      state.isForegroundServiceActive = false
    }
  }),
  disableForegroundService: jest.fn(() => {
    // Mirror the native guard: refuse if a session is already in flight.
    const hasActiveTimers = Array.from(state.acceptedTimers.values()).some(
      (t) => !t.cleared
    )
    if (
      state.isForegroundServiceActive ||
      state.isExplicitBackgroundModeRequested ||
      hasActiveTimers
    ) {
      throw new Error(
        'disableForegroundService() must be called before any timer is scheduled ' +
          'and before startBackgroundMode().'
      )
    }
  }),
  configure: jest.fn((configJson: string) => {
    // Mirror the native IllegalStateException path so test code can verify
    // it. Matches the native semantic check: block if explicit mode is
    // requested OR any timer is scheduled (holding the implicit fallback
    // alive). Intentionally does NOT check state.isForegroundServiceActive
    // on its own — the physical flag is a lagging indicator that would
    // spuriously block configure right after stopBackgroundMode.
    const hasActiveTimers = Array.from(state.acceptedTimers.values()).some(
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
    const t = materializeTimer(id)
    if (!t) {
      if (state.inactiveTimerIds.has(id)) return
      throw new Error(`No timer with id ${id}`)
    }
    if (t.cleared) return
    try {
      t.callback(id)
    } finally {
      // Mirror native setTimeout semantics: after the Runnable fires, the
      // native side removes the entry from `timeoutRunnables`. Intervals
      // stay in the map because they reschedule themselves. Without this,
      // `hasActiveTimers` in the `configure` mock would stay true forever
      // after a setTimeout fires, diverging from native.
      if (t.type === 'timeout') {
        state.timers.delete(id)
        state.pendingTimers.delete(id)
        state.acceptedTimers.delete(id)
        state.inactiveTimerIds.add(id)
        updateImplicitForegroundService()
      }
    }
  },
  getTimer(id: number) {
    return state.timers.get(id)
  },
  reset() {
    state.timers.clear()
    state.pendingTimers.clear()
    state.acceptedTimers.clear()
    state.inactiveTimerIds.clear()
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
    mockNativeTimer.disableForegroundService.mockClear()
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
  isTimerAccepted(id: number): boolean {
    return state.acceptedTimers.has(id)
  },
  isTimerPending(id: number): boolean {
    return state.pendingTimers.has(id)
  },
  isTimerActive(id: number): boolean {
    return state.timers.has(id)
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
  disableForegroundServiceCalls(): number {
    return mockNativeTimer.disableForegroundService.mock.calls.length
  },
}
