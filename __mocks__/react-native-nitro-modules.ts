const TIMERS_AVAILABLE_EVENT = 'NitroBackgroundTimerTimersAvailable'

enum MockFiredTimerType {
  Timeout = 0,
  Interval = 1,
}

interface MockFiredTimerEvent {
  id: number
  type: MockFiredTimerType
  sequence: number
}

interface CapturedTimer {
  id: number
  duration: number
  type: 'timeout' | 'interval'
  cleared: boolean
}

const state = {
  timers: new Map<number, CapturedTimer>(),
  pendingTimers: new Map<number, CapturedTimer>(),
  acceptedTimers: new Map<number, CapturedTimer>(),
  clearPendingTimeoutIds: new Set<number>(),
  clearPendingIntervalIds: new Set<number>(),
  inactiveTimerIds: new Set<number>(),
  firedTimerQueue: [] as MockFiredTimerEvent[],
  pendingIntervalEventIds: new Set<number>(),
  nextSequence: 1,
  isForegroundServiceActive: false,
  isExplicitBackgroundModeRequested: false,
  lastConfigJson: null as string | null,
}

const hasAcceptedTimers = () =>
  Array.from(state.acceptedTimers.values()).some((timer) => !timer.cleared)

const updateImplicitForegroundService = () => {
  if (!state.isExplicitBackgroundModeRequested && !hasAcceptedTimers()) {
    state.isForegroundServiceActive = false
  }
}

const acceptTimer = (timer: CapturedTimer) => {
  if (timer.type === 'timeout') {
    state.clearPendingTimeoutIds.delete(timer.id)
  } else {
    state.clearPendingIntervalIds.delete(timer.id)
  }
  state.inactiveTimerIds.delete(timer.id)
  state.acceptedTimers.set(timer.id, timer)
  state.pendingTimers.set(timer.id, timer)
  state.isForegroundServiceActive = true
}

const markTimerClearPending = (id: number, type: 'timeout' | 'interval') => {
  const hasTimerState =
    state.acceptedTimers.has(id) ||
    state.pendingTimers.has(id) ||
    state.timers.has(id)

  if (!hasTimerState) return

  if (type === 'timeout') {
    state.clearPendingTimeoutIds.add(id)
  } else {
    state.clearPendingIntervalIds.add(id)
  }
}

const cleanupClearedTimer = (id: number, type: 'timeout' | 'interval') => {
  state.pendingTimers.delete(id)
  state.timers.delete(id)
  state.acceptedTimers.delete(id)
  state.inactiveTimerIds.add(id)
  if (type === 'timeout') {
    state.clearPendingTimeoutIds.delete(id)
  } else {
    state.clearPendingIntervalIds.delete(id)
  }
  updateImplicitForegroundService()
}

const clearAcceptedTimer = (id: number, type: 'timeout' | 'interval') => {
  markTimerClearPending(id, type)
  const timer = state.acceptedTimers.get(id)
  if (timer) {
    timer.cleared = true
    state.inactiveTimerIds.add(id)
  }
  removeQueuedTimerEvents(id)
  updateImplicitForegroundService()
}

const materializeTimer = (id: number) => {
  const activeTimer = state.timers.get(id)
  if (activeTimer) {
    if (activeTimer.cleared) {
      cleanupClearedTimer(id, activeTimer.type)
    }
    return activeTimer
  }

  const pendingTimer = state.pendingTimers.get(id)
  if (!pendingTimer) return undefined

  state.pendingTimers.delete(id)
  if (pendingTimer.cleared) {
    cleanupClearedTimer(id, pendingTimer.type)
  } else {
    state.timers.set(id, pendingTimer)
  }
  return pendingTimer
}

const removeQueuedTimerEvents = (id: number) => {
  state.firedTimerQueue = state.firedTimerQueue.filter(
    (event) => event.id !== id
  )
  state.pendingIntervalEventIds.delete(id)
}

const emitTimersAvailable = () => {
  const { DeviceEventEmitter } = require('react-native')
  DeviceEventEmitter.emit(TIMERS_AVAILABLE_EVENT, {
    count: state.firedTimerQueue.length,
  })
}

const enqueueFiredTimer = (timer: CapturedTimer): boolean => {
  if (
    timer.type === 'interval' &&
    state.pendingIntervalEventIds.has(timer.id)
  ) {
    return false
  }

  state.firedTimerQueue.push({
    id: timer.id,
    type:
      timer.type === 'timeout'
        ? MockFiredTimerType.Timeout
        : MockFiredTimerType.Interval,
    sequence: state.nextSequence++,
  })

  if (timer.type === 'interval') {
    state.pendingIntervalEventIds.add(timer.id)
  }

  return true
}

const mockNativeTimer = {
  setTimeout: jest.fn((id: number, duration: number) => {
    acceptTimer({
      id,
      duration,
      type: 'timeout',
      cleared: false,
    })
  }),
  clearTimeout: jest.fn((id: number) => {
    clearAcceptedTimer(id, 'timeout')
  }),
  setInterval: jest.fn((id: number, interval: number) => {
    acceptTimer({
      id,
      duration: interval,
      type: 'interval',
      cleared: false,
    })
  }),
  clearInterval: jest.fn((id: number) => {
    clearAcceptedTimer(id, 'interval')
  }),
  drainFiredTimers: jest.fn(() => {
    const events = state.firedTimerQueue
    state.firedTimerQueue = []
    state.pendingIntervalEventIds.clear()
    return events
  }),
  dispose: jest.fn(() => {
    state.timers.clear()
    state.pendingTimers.clear()
    state.acceptedTimers.clear()
    state.clearPendingTimeoutIds.clear()
    state.clearPendingIntervalIds.clear()
    state.inactiveTimerIds.clear()
    state.firedTimerQueue = []
    state.pendingIntervalEventIds.clear()
    state.nextSequence = 1
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
    const didEnqueue = enqueueFiredTimer(t)
    try {
      if (didEnqueue) {
        emitTimersAvailable()
      }
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
        state.clearPendingTimeoutIds.delete(id)
        state.inactiveTimerIds.add(id)
        updateImplicitForegroundService()
      }
    }
  },
  queueTimer(id: number) {
    const t = materializeTimer(id)
    if (!t) {
      if (state.inactiveTimerIds.has(id)) return false
      throw new Error(`No timer with id ${id}`)
    }
    if (t.cleared) return false
    const didEnqueue = enqueueFiredTimer(t)
    if (t.type === 'timeout') {
      state.timers.delete(id)
      state.pendingTimers.delete(id)
      state.acceptedTimers.delete(id)
      state.inactiveTimerIds.add(id)
      updateImplicitForegroundService()
    }
    return didEnqueue
  },
  emitTimersAvailable,
  queuedFiredTimers(): MockFiredTimerEvent[] {
    return state.firedTimerQueue
  },
  getTimer(id: number) {
    return state.timers.get(id)
  },
  reset() {
    state.timers.clear()
    state.pendingTimers.clear()
    state.acceptedTimers.clear()
    state.clearPendingTimeoutIds.clear()
    state.clearPendingIntervalIds.clear()
    state.inactiveTimerIds.clear()
    state.firedTimerQueue = []
    state.pendingIntervalEventIds.clear()
    state.nextSequence = 1
    state.isForegroundServiceActive = false
    state.isExplicitBackgroundModeRequested = false
    state.lastConfigJson = null
    mockNativeTimer.setTimeout.mockClear()
    mockNativeTimer.clearTimeout.mockClear()
    mockNativeTimer.setInterval.mockClear()
    mockNativeTimer.clearInterval.mockClear()
    mockNativeTimer.drainFiredTimers.mockClear()
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
    const timer = state.acceptedTimers.get(id)
    return !!timer && !timer.cleared
  },
  isTimerPending(id: number): boolean {
    const timer = state.pendingTimers.get(id)
    return !!timer && !timer.cleared
  },
  isTimerActive(id: number): boolean {
    const timer = state.timers.get(id)
    return !!timer && !timer.cleared
  },
  isTimerClearPending(id: number): boolean {
    return (
      state.clearPendingTimeoutIds.has(id) ||
      state.clearPendingIntervalIds.has(id)
    )
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
  drainFiredTimersCalls(): number {
    return mockNativeTimer.drainFiredTimers.mock.calls.length
  },
}
