jest.mock('react-native', () => {
  type Listener = (payload?: unknown) => void

  const listeners = new Map<string, Set<Listener>>()
  const DeviceEventEmitter = {
    addListener: jest.fn((eventName: string, listener: Listener) => {
      const eventListeners = listeners.get(eventName) ?? new Set<Listener>()
      eventListeners.add(listener)
      listeners.set(eventName, eventListeners)

      return {
        remove: jest.fn(() => {
          eventListeners.delete(listener)
        }),
      }
    }),
    emit: jest.fn((eventName: string, payload?: unknown) => {
      const eventListeners = listeners.get(eventName)
      if (!eventListeners) return

      for (const listener of Array.from(eventListeners)) {
        listener(payload)
      }
    }),
    removeAllListeners: jest.fn((eventName?: string) => {
      if (eventName) {
        listeners.delete(eventName)
      } else {
        listeners.clear()
      }
    }),
  }

  return {
    DeviceEventEmitter,
    NativeEventEmitter: jest.fn().mockImplementation(() => DeviceEventEmitter),
    NativeModules: {
      NitroBackgroundTimerEventEmitter: {
        addListener: jest.fn(),
        removeListeners: jest.fn(),
      },
    },
    Platform: {
      OS: 'android',
      select: jest.fn((options: Record<string, unknown>) => options.android),
    },
    __resetDeviceEventEmitter: () => {
      listeners.clear()
      DeviceEventEmitter.addListener.mockClear()
      DeviceEventEmitter.emit.mockClear()
      DeviceEventEmitter.removeAllListeners.mockClear()
    },
  }
})

jest.mock('react-native-nitro-modules', () =>
  require('../../__mocks__/react-native-nitro-modules')
)

beforeEach(() => {
  require('react-native').__resetDeviceEventEmitter()
  require('../../__mocks__/react-native-nitro-modules').__mockHelpers.reset()
})

describe('BackgroundTimer — ID management', () => {
  it('setTimeout returns a numeric id, and consecutive calls return distinct ids', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const id1 = BackgroundTimer.setTimeout(() => {}, 100)
      const id2 = BackgroundTimer.setTimeout(() => {}, 100)
      expect(typeof id1).toBe('number')
      expect(typeof id2).toBe('number')
      expect(id1).not.toBe(id2)
    })
  })

  it('setInterval returns ids distinct from setTimeout ids', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const timeoutId = BackgroundTimer.setTimeout(() => {}, 100)
      const intervalId = BackgroundTimer.setInterval(() => {}, 100)
      expect(intervalId).not.toBe(timeoutId)
    })
  })
})

describe('BackgroundTimer — callback invocation', () => {
  it('setTimeout stores the callback in JS and calls native without a callback argument', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        NitroModules,
      } = require('../../__mocks__/react-native-nitro-modules')
      const cb = jest.fn()
      const id = BackgroundTimer.setTimeout(cb, 100)
      const nativeInstance =
        NitroModules.createHybridObject.mock.results[0].value

      expect(nativeInstance.setTimeout).toHaveBeenCalledWith(id, 100)
      expect(nativeInstance.setTimeout.mock.calls[0]).toHaveLength(2)
      expect(cb).not.toHaveBeenCalled()
    })
  })

  it('invokes the user callback when the native timer fires', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      const cb = jest.fn()
      const id = BackgroundTimer.setTimeout(cb, 100)
      __mockHelpers.fireTimer(id)
      expect(cb).toHaveBeenCalledTimes(1)
      expect(__mockHelpers.drainFiredTimersCalls()).toBeGreaterThan(0)
    })
  })

  it('cleans up the timeout callback when the user callback throws', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      const error = new Error('boom')
      const cb = jest.fn(() => {
        throw error
      })
      const id = BackgroundTimer.setTimeout(cb, 100)

      expect(() => {
        __mockHelpers.fireTimer(id)
      }).toThrow(error)
      expect(cb).toHaveBeenCalledTimes(1)

      __mockHelpers.fireTimer(id)
      expect(cb).toHaveBeenCalledTimes(1)
    })
  })

  it('does not invoke the callback after clearTimeout', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      const cb = jest.fn()
      const id = BackgroundTimer.setTimeout(cb, 100)
      BackgroundTimer.clearTimeout(id)
      __mockHelpers.fireTimer(id)
      expect(cb).not.toHaveBeenCalled()
    })
  })

  it('ignores a queued timeout event when clearTimeout runs before drain', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      __mockHelpers.reset()
      const cb = jest.fn()
      const id = BackgroundTimer.setTimeout(cb, 100)

      __mockHelpers.queueTimer(id)
      BackgroundTimer.clearTimeout(id)
      __mockHelpers.emitTimersAvailable()

      expect(cb).not.toHaveBeenCalled()
      expect(__mockHelpers.queuedFiredTimers()).toHaveLength(0)
    })
  })

  it('setInterval stores the callback in JS and calls native without a callback argument', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        NitroModules,
      } = require('../../__mocks__/react-native-nitro-modules')
      const cb = jest.fn()
      const id = BackgroundTimer.setInterval(cb, 100)
      const nativeInstance =
        NitroModules.createHybridObject.mock.results[0].value

      expect(nativeInstance.setInterval).toHaveBeenCalledWith(id, 100)
      expect(nativeInstance.setInterval.mock.calls[0]).toHaveLength(2)
      expect(cb).not.toHaveBeenCalled()
    })
  })

  it('invokes the interval callback from event + drain while it is still registered', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      const cb = jest.fn()
      const id = BackgroundTimer.setInterval(cb, 100)

      __mockHelpers.fireTimer(id)

      expect(cb).toHaveBeenCalledTimes(1)
    })
  })

  it('does not invoke the interval callback after clearInterval', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      const cb = jest.fn()
      const id = BackgroundTimer.setInterval(cb, 100)
      BackgroundTimer.clearInterval(id)
      __mockHelpers.fireTimer(id)
      expect(cb).not.toHaveBeenCalled()
    })
  })

  it('ignores a queued interval event when clearInterval runs before drain', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      __mockHelpers.reset()
      const cb = jest.fn()
      const id = BackgroundTimer.setInterval(cb, 100)

      __mockHelpers.queueTimer(id)
      BackgroundTimer.clearInterval(id)
      __mockHelpers.emitTimersAvailable()

      expect(cb).not.toHaveBeenCalled()
      expect(__mockHelpers.queuedFiredTimers()).toHaveLength(0)
    })
  })

  it('processes a batch of fired timer events in FIFO order', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      __mockHelpers.reset()
      const calls: string[] = []
      const firstId = BackgroundTimer.setTimeout(() => calls.push('first'), 100)
      const secondId = BackgroundTimer.setInterval(
        () => calls.push('second'),
        100
      )

      __mockHelpers.queueTimer(firstId)
      __mockHelpers.queueTimer(secondId)
      __mockHelpers.emitTimersAvailable()

      expect(calls).toEqual(['first', 'second'])
    })
  })

  it('does not duplicate callbacks when a timersAvailable signal arrives during drain', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      __mockHelpers.reset()
      const first = jest.fn(() => {
        __mockHelpers.emitTimersAvailable()
      })
      const second = jest.fn()
      const firstId = BackgroundTimer.setTimeout(first, 100)
      const secondId = BackgroundTimer.setTimeout(second, 100)

      __mockHelpers.queueTimer(firstId)
      __mockHelpers.queueTimer(secondId)
      __mockHelpers.emitTimersAvailable()

      expect(first).toHaveBeenCalledTimes(1)
      expect(second).toHaveBeenCalledTimes(1)
      expect(__mockHelpers.drainFiredTimersCalls()).toBe(2)
    })
  })

  it('continues processing a drain batch after an interval callback throws', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      __mockHelpers.reset()
      const error = new Error('interval boom')
      const interval = jest.fn(() => {
        throw error
      })
      const timeout = jest.fn()
      const intervalId = BackgroundTimer.setInterval(interval, 100)
      const timeoutId = BackgroundTimer.setTimeout(timeout, 100)

      __mockHelpers.queueTimer(intervalId)
      __mockHelpers.queueTimer(timeoutId)

      expect(() => {
        __mockHelpers.emitTimersAvailable()
      }).toThrow(error)
      expect(interval).toHaveBeenCalledTimes(1)
      expect(timeout).toHaveBeenCalledTimes(1)
    })
  })
})

describe('BackgroundTimer — input validation', () => {
  describe('setTimeout', () => {
    it('throws TypeError when callback is not a function (string)', () => {
      jest.isolateModules(() => {
        const { BackgroundTimer } = require('../index')
        expect(() =>
          BackgroundTimer.setTimeout('not a function' as any, 100)
        ).toThrow(TypeError)
      })
    })

    it('throws TypeError when callback is undefined', () => {
      jest.isolateModules(() => {
        const { BackgroundTimer } = require('../index')
        expect(() => BackgroundTimer.setTimeout(undefined as any, 100)).toThrow(
          TypeError
        )
      })
    })

    it('throws RangeError when duration is NaN', () => {
      jest.isolateModules(() => {
        const { BackgroundTimer } = require('../index')
        expect(() => BackgroundTimer.setTimeout(() => {}, NaN)).toThrow(
          RangeError
        )
      })
    })

    it('throws RangeError when duration is Infinity', () => {
      jest.isolateModules(() => {
        const { BackgroundTimer } = require('../index')
        expect(() => BackgroundTimer.setTimeout(() => {}, Infinity)).toThrow(
          RangeError
        )
      })
    })

    it('throws RangeError when duration is negative', () => {
      jest.isolateModules(() => {
        const { BackgroundTimer } = require('../index')
        expect(() => BackgroundTimer.setTimeout(() => {}, -1)).toThrow(
          RangeError
        )
      })
    })

    it('throws RangeError when duration is not a number (string)', () => {
      jest.isolateModules(() => {
        const { BackgroundTimer } = require('../index')
        expect(() =>
          BackgroundTimer.setTimeout(() => {}, '100' as any)
        ).toThrow(RangeError)
      })
    })

    it('accepts duration === 0', () => {
      jest.isolateModules(() => {
        const { BackgroundTimer } = require('../index')
        expect(() => BackgroundTimer.setTimeout(() => {}, 0)).not.toThrow()
      })
    })
  })

  describe('setInterval', () => {
    it('throws TypeError when callback is not a function (string)', () => {
      jest.isolateModules(() => {
        const { BackgroundTimer } = require('../index')
        expect(() =>
          BackgroundTimer.setInterval('not a function' as any, 100)
        ).toThrow(TypeError)
      })
    })

    it('throws TypeError when callback is undefined', () => {
      jest.isolateModules(() => {
        const { BackgroundTimer } = require('../index')
        expect(() =>
          BackgroundTimer.setInterval(undefined as any, 100)
        ).toThrow(TypeError)
      })
    })

    it('throws RangeError when interval is NaN', () => {
      jest.isolateModules(() => {
        const { BackgroundTimer } = require('../index')
        expect(() => BackgroundTimer.setInterval(() => {}, NaN)).toThrow(
          RangeError
        )
      })
    })

    it('throws RangeError when interval is Infinity', () => {
      jest.isolateModules(() => {
        const { BackgroundTimer } = require('../index')
        expect(() => BackgroundTimer.setInterval(() => {}, Infinity)).toThrow(
          RangeError
        )
      })
    })

    it('throws RangeError when interval is negative', () => {
      jest.isolateModules(() => {
        const { BackgroundTimer } = require('../index')
        expect(() => BackgroundTimer.setInterval(() => {}, -1)).toThrow(
          RangeError
        )
      })
    })

    it('throws RangeError when interval is not a number (string)', () => {
      jest.isolateModules(() => {
        const { BackgroundTimer } = require('../index')
        expect(() =>
          BackgroundTimer.setInterval(() => {}, '100' as any)
        ).toThrow(RangeError)
      })
    })

    it('accepts interval === 0', () => {
      jest.isolateModules(() => {
        const { BackgroundTimer } = require('../index')
        expect(() => BackgroundTimer.setInterval(() => {}, 0)).not.toThrow()
      })
    })
  })

  describe('state invariants', () => {
    it('does not increment internal id when setTimeout validation fails', () => {
      jest.isolateModules(() => {
        const { BackgroundTimer } = require('../index')
        const id1 = BackgroundTimer.setTimeout(() => {}, 100)
        expect(() => BackgroundTimer.setTimeout(null as any, 100)).toThrow()
        const id2 = BackgroundTimer.setTimeout(() => {}, 100)
        expect(id2 - id1).toBe(1)
      })
    })

    it('does not increment internal id when setInterval validation fails', () => {
      jest.isolateModules(() => {
        const { BackgroundTimer } = require('../index')
        const id1 = BackgroundTimer.setInterval(() => {}, 100)
        expect(() => BackgroundTimer.setInterval(() => {}, NaN)).toThrow()
        const id2 = BackgroundTimer.setInterval(() => {}, 100)
        expect(id2 - id1).toBe(1)
      })
    })
  })
})

describe('BackgroundTimer — dispose lifecycle', () => {
  it('dispose() can be called and is idempotent', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      expect(() => BackgroundTimer.dispose()).not.toThrow()
      expect(() => BackgroundTimer.dispose()).not.toThrow()
    })
  })

  it('dispose() forwards exactly one call to the native hybrid object', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      expect(__mockHelpers.disposeCalls()).toBe(0)
      BackgroundTimer.dispose()
      expect(__mockHelpers.disposeCalls()).toBe(1)
      BackgroundTimer.dispose()
      expect(__mockHelpers.disposeCalls()).toBe(1)
    })
  })

  it('throws when setTimeout is called after dispose', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      BackgroundTimer.dispose()
      expect(() => BackgroundTimer.setTimeout(() => {}, 100)).toThrow(
        /disposed/
      )
    })
  })

  it('throws when setInterval is called after dispose', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      BackgroundTimer.dispose()
      expect(() => BackgroundTimer.setInterval(() => {}, 100)).toThrow(
        /disposed/
      )
    })
  })

  it('clearTimeout after dispose is silent (no throw)', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const id = BackgroundTimer.setTimeout(() => {}, 100)
      BackgroundTimer.dispose()
      expect(() => BackgroundTimer.clearTimeout(id)).not.toThrow()
    })
  })

  it('clearInterval after dispose is silent (no throw)', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const id = BackgroundTimer.setInterval(() => {}, 100)
      BackgroundTimer.dispose()
      expect(() => BackgroundTimer.clearInterval(id)).not.toThrow()
    })
  })

  it('dispose() clears the JS-side callback map so GC can reclaim user closures', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      const cb = jest.fn()
      const id = BackgroundTimer.setTimeout(cb, 100)
      BackgroundTimer.dispose()
      // Even if a late-arriving native fire is replayed, the user callback
      // must not be invoked because the JS-side map was cleared on dispose.
      expect(() => __mockHelpers.fireTimer(id)).toThrow() // timer was cleared from mock state
      expect(cb).not.toHaveBeenCalled()
    })
  })

  it('does not call native clearTimeout after dispose', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        NitroModules,
      } = require('../../__mocks__/react-native-nitro-modules')
      const id = BackgroundTimer.setTimeout(() => {}, 100)
      BackgroundTimer.dispose()
      const nativeInstance =
        NitroModules.createHybridObject.mock.results[0].value
      const clearCallsBefore = nativeInstance.clearTimeout.mock.calls.length
      BackgroundTimer.clearTimeout(id)
      const clearCallsAfter = nativeInstance.clearTimeout.mock.calls.length
      expect(clearCallsAfter).toBe(clearCallsBefore)
    })
  })
})

describe('BackgroundTimer — background mode lifecycle', () => {
  it('startBackgroundMode forwards exactly one call to the native hybrid object', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      __mockHelpers.reset()
      BackgroundTimer.startBackgroundMode()
      expect(__mockHelpers.startBackgroundModeCalls()).toBe(1)
      expect(__mockHelpers.isExplicitBackgroundModeRequested()).toBe(true)
    })
  })

  it('stopBackgroundMode forwards exactly one call to the native hybrid object', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      __mockHelpers.reset()
      BackgroundTimer.startBackgroundMode()
      BackgroundTimer.stopBackgroundMode()
      expect(__mockHelpers.stopBackgroundModeCalls()).toBe(1)
      expect(__mockHelpers.isExplicitBackgroundModeRequested()).toBe(false)
    })
  })

  it('configure forwards the stringified notification config to native', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      __mockHelpers.reset()
      BackgroundTimer.configure({
        notification: {
          title: 'Custom Title',
          text: 'Custom Text',
          channelId: 'my_channel',
          channelName: 'My Channel',
          iconResourceName: 'ic_custom',
        },
      })
      expect(__mockHelpers.configureCalls()).toBe(1)
      const received = JSON.parse(__mockHelpers.lastConfigJson())
      expect(received).toEqual({
        notification: {
          title: 'Custom Title',
          text: 'Custom Text',
          channelId: 'my_channel',
          channelName: 'My Channel',
          iconResourceName: 'ic_custom',
        },
      })
    })
  })

  it('configure with an empty config forwards "{}" to native without throwing', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      __mockHelpers.reset()
      expect(() => BackgroundTimer.configure({})).not.toThrow()
      expect(__mockHelpers.configureCalls()).toBe(1)
      expect(__mockHelpers.lastConfigJson()).toBe('{}')
    })
  })

  it('startBackgroundMode after dispose throws and does not forward to native', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      __mockHelpers.reset()
      BackgroundTimer.dispose()
      expect(() => BackgroundTimer.startBackgroundMode()).toThrow(/disposed/)
      expect(__mockHelpers.startBackgroundModeCalls()).toBe(0)
    })
  })

  it('stopBackgroundMode after dispose is silent (matches clearTimeout idiom)', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      __mockHelpers.reset()
      BackgroundTimer.dispose()
      expect(() => BackgroundTimer.stopBackgroundMode()).not.toThrow()
      expect(__mockHelpers.stopBackgroundModeCalls()).toBe(0)
    })
  })

  it('configure after dispose throws and does not forward to native', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      __mockHelpers.reset()
      BackgroundTimer.dispose()
      expect(() =>
        BackgroundTimer.configure({ notification: { title: 'X' } })
      ).toThrow(/disposed/)
      expect(__mockHelpers.configureCalls()).toBe(0)
    })
  })

  it('configure succeeds immediately after stopBackgroundMode (semantic check fix, round 4)', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      __mockHelpers.reset()
      BackgroundTimer.startBackgroundMode()
      BackgroundTimer.stopBackgroundMode()
      // After stopBackgroundMode the user should be able to reconfigure
      // for the next session without waiting for a worker-thread tick.
      // This exercises the round-4 fix where configure gates on the
      // semantic "explicit || maps non-empty" signal rather than the
      // lagging physical `isForegroundServiceActive` flag.
      expect(() =>
        BackgroundTimer.configure({ notification: { title: 'Next' } })
      ).not.toThrow()
      expect(__mockHelpers.configureCalls()).toBe(1)
    })
  })

  it('configure succeeds after a setTimeout has fired and completed', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      __mockHelpers.reset()
      const cb = jest.fn()
      const id = BackgroundTimer.setTimeout(cb, 100)
      __mockHelpers.fireTimer(id)
      expect(__mockHelpers.isTimerAccepted(id)).toBe(false)
      expect(__mockHelpers.isTimerPending(id)).toBe(false)
      expect(__mockHelpers.isTimerActive(id)).toBe(false)
      // After the timeout fires, both native and mock remove it from the
      // active map. configure should then allow — no live session is
      // holding the service open.
      expect(() =>
        BackgroundTimer.configure({ notification: { title: 'After' } })
      ).not.toThrow()
      expect(__mockHelpers.configureCalls()).toBe(1)
    })
  })

  it('configure is blocked immediately after setTimeout is accepted', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      __mockHelpers.reset()
      const id = BackgroundTimer.setTimeout(() => {}, 1000)
      expect(__mockHelpers.isTimerAccepted(id)).toBe(true)
      expect(__mockHelpers.isTimerPending(id)).toBe(true)
      expect(__mockHelpers.isTimerActive(id)).toBe(false)
      // The implicit fallback keeps the service alive while the timer is
      // accepted/pending, before the Android worker materializes the active map.
      // configure() must throw to prevent mid-visible reconfiguration.
      expect(() =>
        BackgroundTimer.configure({ notification: { title: 'Mid' } })
      ).toThrow(/background mode session is active/)
      // The native mock was called (jest.fn counts invocations that
      // throw), but no config was stored because the throw happened
      // before the assignment.
      expect(__mockHelpers.lastConfigJson()).toBeNull()
    })
  })

  it('configure is blocked immediately after setInterval is accepted', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      __mockHelpers.reset()
      const id = BackgroundTimer.setInterval(() => {}, 1000)
      expect(__mockHelpers.isTimerAccepted(id)).toBe(true)
      expect(__mockHelpers.isTimerPending(id)).toBe(true)
      expect(__mockHelpers.isTimerActive(id)).toBe(false)
      expect(() =>
        BackgroundTimer.configure({ notification: { title: 'Mid' } })
      ).toThrow(/background mode session is active/)
      expect(__mockHelpers.lastConfigJson()).toBeNull()
    })
  })

  it('configure succeeds after clearTimeout removes an accepted timer', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      __mockHelpers.reset()
      const id = BackgroundTimer.setTimeout(() => {}, 1000)
      BackgroundTimer.clearTimeout(id)
      expect(__mockHelpers.isTimerAccepted(id)).toBe(false)
      expect(__mockHelpers.isTimerPending(id)).toBe(false)
      expect(__mockHelpers.isTimerActive(id)).toBe(false)
      expect(() =>
        BackgroundTimer.configure({ notification: { title: 'After clear' } })
      ).not.toThrow()
      expect(__mockHelpers.configureCalls()).toBe(1)
    })
  })

  it('configure succeeds after clearInterval removes an accepted timer', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      __mockHelpers.reset()
      const id = BackgroundTimer.setInterval(() => {}, 1000)
      BackgroundTimer.clearInterval(id)
      expect(__mockHelpers.isTimerAccepted(id)).toBe(false)
      expect(__mockHelpers.isTimerPending(id)).toBe(false)
      expect(__mockHelpers.isTimerActive(id)).toBe(false)
      expect(() =>
        BackgroundTimer.configure({ notification: { title: 'After clear' } })
      ).not.toThrow()
      expect(__mockHelpers.configureCalls()).toBe(1)
    })
  })
})

describe('BackgroundTimer — disableForegroundService opt-out', () => {
  it('forwards exactly one call to the native hybrid object', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      __mockHelpers.reset()
      BackgroundTimer.disableForegroundService()
      expect(__mockHelpers.disableForegroundServiceCalls()).toBe(1)
    })
  })

  it('forwards every call (idempotency is enforced natively, not in JS)', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      __mockHelpers.reset()
      expect(() => BackgroundTimer.disableForegroundService()).not.toThrow()
      expect(() => BackgroundTimer.disableForegroundService()).not.toThrow()
      expect(__mockHelpers.disableForegroundServiceCalls()).toBe(2)
    })
  })

  it('after dispose the JS wrapper still forwards without throwing', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      __mockHelpers.reset()
      BackgroundTimer.dispose()
      // The JS wrapper intentionally adds no dispose guard — the native
      // side owns the late-call semantics. The mock's dispose() resets
      // timers and explicit-mode state, so the guard inside the native
      // stub passes and the call returns cleanly.
      expect(() => BackgroundTimer.disableForegroundService()).not.toThrow()
      expect(__mockHelpers.disableForegroundServiceCalls()).toBe(1)
    })
  })
})
