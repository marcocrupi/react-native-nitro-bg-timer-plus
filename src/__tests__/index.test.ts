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

describe.each(['setTimeout', 'setInterval'] as const)(
  'BackgroundTimer — transactional registration via %s',
  (method) => {
    it.each([
      { label: 'Error', value: new Error('native registration failed') },
      { label: 'undefined', value: undefined },
    ])(
      'removes only the failed callback when native throws $label',
      ({ value }) => {
        jest.isolateModules(() => {
          const { BackgroundTimer, NitroBackgroundTimer } = require('../index')
          const {
            FiredTimerType,
          } = require('../specs/NitroBackgroundTimer.nitro')
          const {
            __mockHelpers,
          } = require('../../__mocks__/react-native-nitro-modules')
          const calls: string[] = []
          const existingTimeout = jest.fn(() => calls.push('timeout'))
          const existingInterval = jest.fn(() => calls.push('interval'))
          const timeoutId = BackgroundTimer.setTimeout(existingTimeout, 100)
          const intervalId = BackgroundTimer.setInterval(existingInterval, 100)
          const failedCallback = jest.fn()
          const nativeRegister = NitroBackgroundTimer[method]
          const originalImplementation = nativeRegister.getMockImplementation()
          let attemptedId: number | undefined

          nativeRegister.mockImplementationOnce((id: number) => {
            attemptedId = id
            throw value
          })

          let didThrow = false
          let caughtValue: unknown
          let returnedId: number | undefined
          try {
            returnedId = BackgroundTimer[method](failedCallback, 100)
          } catch (error) {
            didThrow = true
            caughtValue = error
          }

          expect(didThrow).toBe(true)
          expect(caughtValue).toBe(value)
          expect(returnedId).toBeUndefined()
          expect(typeof attemptedId).toBe('number')
          if (attemptedId === undefined) {
            throw new Error('Native registration did not capture an ID')
          }
          expect(nativeRegister).toHaveBeenLastCalledWith(attemptedId, 100)
          expect(__mockHelpers.isTimerAccepted(attemptedId)).toBe(false)
          expect(nativeRegister.getMockImplementation()).toBe(
            originalImplementation
          )

          const successfulCallback = jest.fn(() => calls.push('success'))
          const successfulId = BackgroundTimer[method](successfulCallback, 100)
          expect(successfulId).toBe(attemptedId + 1)
          expect(__mockHelpers.isTimerAccepted(successfulId)).toBe(true)

          // Inject a stale event even though native never accepted the timer.
          // fireTimer(attemptedId) would reject it before reaching the JS map.
          const staleEvent = {
            id: attemptedId,
            type:
              method === 'setTimeout'
                ? FiredTimerType.Timeout
                : FiredTimerType.Interval,
            sequence: 0,
          }
          const drainsBefore = __mockHelpers.drainFiredTimersCalls()
          __mockHelpers.queuedFiredTimers().push(staleEvent)
          __mockHelpers.emitTimersAvailable()

          expect(__mockHelpers.drainFiredTimersCalls()).toBe(drainsBefore + 1)
          expect(__mockHelpers.queuedFiredTimers()).toHaveLength(0)
          expect(failedCallback).not.toHaveBeenCalled()

          __mockHelpers.queueTimer(timeoutId)
          __mockHelpers.queueTimer(intervalId)
          __mockHelpers.queueTimer(successfulId)
          __mockHelpers.emitTimersAvailable()
          expect(calls).toEqual(['timeout', 'interval', 'success'])

          __mockHelpers.queuedFiredTimers().push(staleEvent)
          __mockHelpers.fireTimer(successfulId)
          __mockHelpers.emitTimersAvailable()
          expect(failedCallback).not.toHaveBeenCalled()
          expect(existingTimeout).toHaveBeenCalledTimes(1)
          expect(existingInterval).toHaveBeenCalledTimes(1)
          expect(successfulCallback).toHaveBeenCalledTimes(
            method === 'setTimeout' ? 1 : 2
          )
        })
      }
    )

    it('preserves reentrant registrations and batch order when native throws during drain', () => {
      jest.isolateModules(() => {
        const { BackgroundTimer, NitroBackgroundTimer } = require('../index')
        const {
          FiredTimerType,
        } = require('../specs/NitroBackgroundTimer.nitro')
        const {
          __mockHelpers,
        } = require('../../__mocks__/react-native-nitro-modules')
        const error = new Error('reentrant registration failed')
        const calls: string[] = []
        const failedCallback = jest.fn()
        const nestedCallback = jest.fn(() => calls.push('nested'))
        let didThrow = false
        let caughtValue: unknown
        let attemptedId: number | undefined
        let nestedId: number | undefined
        const triggerId = BackgroundTimer.setTimeout(() => {
          calls.push('trigger')
          try {
            BackgroundTimer[method](failedCallback, 100)
          } catch (caught) {
            didThrow = true
            caughtValue = caught
            calls.push('caught')
          }
        }, 100)
        const tailId = BackgroundTimer.setTimeout(() => calls.push('tail'), 100)
        const nativeRegister = NitroBackgroundTimer[method]
        const originalImplementation = nativeRegister.getMockImplementation()
        nativeRegister.mockImplementationOnce((id: number) => {
          attemptedId = id
          nestedId = BackgroundTimer[method](nestedCallback, 100)
          __mockHelpers.queuedFiredTimers().push({
            id,
            type:
              method === 'setTimeout'
                ? FiredTimerType.Timeout
                : FiredTimerType.Interval,
            sequence: 3,
          })
          __mockHelpers.queueTimer(nestedId)
          __mockHelpers.emitTimersAvailable()
          throw error
        })

        __mockHelpers.queueTimer(triggerId)
        __mockHelpers.queueTimer(tailId)
        const drainsBefore = __mockHelpers.drainFiredTimersCalls()
        __mockHelpers.emitTimersAvailable()

        expect(didThrow).toBe(true)
        expect(caughtValue).toBe(error)
        expect(typeof attemptedId).toBe('number')
        expect(typeof nestedId).toBe('number')
        expect(nestedId).not.toBe(attemptedId)
        expect(failedCallback).not.toHaveBeenCalled()
        expect(nestedCallback).toHaveBeenCalledTimes(1)
        expect(calls).toEqual(['trigger', 'caught', 'tail', 'nested'])
        expect(__mockHelpers.drainFiredTimersCalls()).toBe(drainsBefore + 2)
        expect(__mockHelpers.queuedFiredTimers()).toHaveLength(0)
        expect(nativeRegister.getMockImplementation()).toBe(
          originalImplementation
        )
      })
    })

    it('registers the callback before a synchronous native fire and preserves success', () => {
      jest.isolateModules(() => {
        const { BackgroundTimer, NitroBackgroundTimer } = require('../index')
        const {
          __mockHelpers,
        } = require('../../__mocks__/react-native-nitro-modules')
        const callback = jest.fn()
        const nativeRegister = NitroBackgroundTimer[method]
        const originalImplementation = nativeRegister.getMockImplementation()
        nativeRegister.mockImplementationOnce((id: number, delay: number) => {
          originalImplementation(id, delay)
          __mockHelpers.fireTimer(id)
          expect(callback).toHaveBeenCalledTimes(1)
        })

        const id = BackgroundTimer[method](callback, 100)
        expect(nativeRegister).toHaveBeenCalledWith(id, 100)
        expect(nativeRegister.getMockImplementation()).toBe(
          originalImplementation
        )
        expect(callback).toHaveBeenCalledTimes(1)
        __mockHelpers.fireTimer(id)
        expect(callback).toHaveBeenCalledTimes(method === 'setTimeout' ? 1 : 2)
      })
    })
  }
)

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

describe.each(['setTimeout', 'setInterval'] as const)(
  'BackgroundTimer — J1 undefined witness via %s',
  (method) => {
    it('propagates throw undefined after invoking the callback', () => {
      jest.isolateModules(() => {
        const { BackgroundTimer } = require('../index')
        const {
          __mockHelpers,
        } = require('../../__mocks__/react-native-nitro-modules')
        const callback = jest.fn(() => {
          throw undefined
        })
        const id = BackgroundTimer[method](callback, 100)
        const drainsBefore = __mockHelpers.drainFiredTimersCalls()
        expect(__mockHelpers.queueTimer(id)).toBe(true)

        let didThrow = false
        let caughtValue: unknown
        try {
          __mockHelpers.emitTimersAvailable()
        } catch (error) {
          didThrow = true
          caughtValue = error
        }

        expect(callback).toHaveBeenCalledTimes(1)
        expect(__mockHelpers.drainFiredTimersCalls()).toBe(drainsBefore + 1)
        expect(__mockHelpers.queuedFiredTimers()).toHaveLength(0)
        expect(didThrow).toBe(true)
        expect(caughtValue).toBe(undefined)
      })
    })
  }
)

describe('BackgroundTimer — J1 callback error propagation', () => {
  function captureThrow(action: () => void) {
    let didThrow = false
    let caughtValue: unknown
    try {
      action()
    } catch (error) {
      didThrow = true
      caughtValue = error
    }
    return { didThrow, caughtValue }
  }

  const throwableCases = [
    { label: 'undefined', value: undefined },
    { label: 'null', value: null },
    { label: 'false', value: false },
    { label: 'true', value: true },
    { label: 'zero', value: 0 },
    { label: 'negative zero', value: -0 },
    { label: 'NaN', value: NaN },
    { label: 'number', value: 42 },
    { label: 'empty string', value: '' },
    { label: 'string', value: 'callback failure' },
    { label: 'Error', value: new Error('callback failure') },
    { label: 'object', value: { message: 'callback failure' } },
    { label: 'Symbol', value: Symbol('callback failure') },
    { label: 'bigint', value: 1n },
  ]
  const errorOrders = [
    {
      label: 'undefined then Error',
      firstValue: undefined,
      secondValue: new Error('second callback failure'),
    },
    {
      label: 'Error then undefined',
      firstValue: new Error('first callback failure'),
      secondValue: undefined,
    },
  ]

  describe.each(['setTimeout', 'setInterval'] as const)('%s', (method) => {
    it.each(throwableCases)(
      'propagates $label by identity after completing a mixed batch',
      ({ value }) => {
        jest.isolateModules(() => {
          const { BackgroundTimer } = require('../index')
          const {
            __mockHelpers,
          } = require('../../__mocks__/react-native-nitro-modules')
          const calls: string[] = []
          const before = jest.fn(() => calls.push('before'))
          const failing = jest.fn(() => {
            calls.push('failing')
            throw value
          })
          const after = jest.fn(() => calls.push('after'))
          const ids = [
            BackgroundTimer.setTimeout(before, 100),
            BackgroundTimer[method](failing, 100),
            BackgroundTimer.setInterval(after, 100),
          ]
          for (const id of ids) {
            expect(__mockHelpers.queueTimer(id)).toBe(true)
          }
          expect(failing).not.toHaveBeenCalled()
          const drainsBefore = __mockHelpers.drainFiredTimersCalls()

          const outcome = captureThrow(__mockHelpers.emitTimersAvailable)

          expect(calls).toEqual(['before', 'failing', 'after'])
          for (const callback of [before, failing, after]) {
            expect(callback).toHaveBeenCalledTimes(1)
          }
          expect(__mockHelpers.drainFiredTimersCalls()).toBe(drainsBefore + 1)
          expect(__mockHelpers.queuedFiredTimers()).toHaveLength(0)
          expect(outcome.didThrow).toBe(true)
          expect(outcome.caughtValue).toBe(value)
        })
      }
    )

    it.each(errorOrders)(
      'keeps the first error across reentrant batches: $label',
      ({ firstValue, secondValue }) => {
        jest.isolateModules(() => {
          const { BackgroundTimer } = require('../index')
          const {
            __mockHelpers,
          } = require('../../__mocks__/react-native-nitro-modules')
          const calls: string[] = []
          const reentrantOutcomes: ReturnType<typeof captureThrow>[] = []
          const nestedFailure = jest.fn(() => {
            calls.push('nested failure')
            throw secondValue
          })
          const nestedSuccess = jest.fn(() => calls.push('nested success'))
          const first = jest.fn(() => {
            calls.push('first')
            const nestedTimeoutId = BackgroundTimer.setTimeout(
              nestedFailure,
              100
            )
            const nestedIntervalId = BackgroundTimer.setInterval(
              nestedSuccess,
              100
            )
            __mockHelpers.queueTimer(nestedTimeoutId)
            __mockHelpers.queueTimer(nestedIntervalId)
            reentrantOutcomes.push(
              captureThrow(__mockHelpers.emitTimersAvailable),
              captureThrow(__mockHelpers.emitTimersAvailable)
            )
            throw firstValue
          })
          const tail = jest.fn(() => calls.push('tail'))
          const firstId = BackgroundTimer[method](first, 100)
          const tailId = BackgroundTimer.setTimeout(tail, 100)
          __mockHelpers.queueTimer(firstId)
          __mockHelpers.queueTimer(tailId)
          const drainsBefore = __mockHelpers.drainFiredTimersCalls()

          const outcome = captureThrow(__mockHelpers.emitTimersAvailable)

          expect(calls).toEqual([
            'first',
            'tail',
            'nested failure',
            'nested success',
          ])
          for (const callback of [first, tail, nestedFailure, nestedSuccess]) {
            expect(callback).toHaveBeenCalledTimes(1)
          }
          expect(reentrantOutcomes).toEqual([
            { didThrow: false, caughtValue: undefined },
            { didThrow: false, caughtValue: undefined },
          ])
          expect(__mockHelpers.drainFiredTimersCalls()).toBe(drainsBefore + 2)
          expect(__mockHelpers.queuedFiredTimers()).toHaveLength(0)
          expect(outcome.didThrow).toBe(true)
          expect(outcome.caughtValue).toBe(firstValue)

          const recovery = jest.fn()
          const recoveryId = BackgroundTimer.setTimeout(recovery, 100)
          __mockHelpers.queueTimer(recoveryId)
          const recovered = captureThrow(__mockHelpers.emitTimersAvailable)
          expect(recovery).toHaveBeenCalledTimes(1)
          expect(recovered.didThrow).toBe(false)
          expect(__mockHelpers.drainFiredTimersCalls()).toBe(drainsBefore + 3)
          expect(__mockHelpers.queuedFiredTimers()).toHaveLength(0)
        })
      }
    )

    it('preserves dispose during a throwing callback and skips the batch tail', () => {
      jest.isolateModules(() => {
        const { BackgroundTimer, NitroBackgroundTimer } = require('../index')
        const {
          __mockHelpers,
        } = require('../../__mocks__/react-native-nitro-modules')
        const first = jest.fn(() => {
          BackgroundTimer.dispose()
          throw undefined
        })
        const timeoutTail = jest.fn()
        const intervalTail = jest.fn()
        const ids = [
          BackgroundTimer[method](first, 100),
          BackgroundTimer.setTimeout(timeoutTail, 100),
          BackgroundTimer.setInterval(intervalTail, 100),
        ]
        for (const id of ids) __mockHelpers.queueTimer(id)
        const staleEvents = [...__mockHelpers.queuedFiredTimers()]
        const drainsBefore = __mockHelpers.drainFiredTimersCalls()

        const outcome = captureThrow(__mockHelpers.emitTimersAvailable)

        expect(first).toHaveBeenCalledTimes(1)
        expect(timeoutTail).not.toHaveBeenCalled()
        expect(intervalTail).not.toHaveBeenCalled()
        expect(__mockHelpers.disposeCalls()).toBe(1)
        expect(__mockHelpers.drainFiredTimersCalls()).toBe(drainsBefore + 1)
        expect(__mockHelpers.queuedFiredTimers()).toHaveLength(0)
        expect(outcome.didThrow).toBe(true)
        expect(outcome.caughtValue).toBe(undefined)

        __mockHelpers.queuedFiredTimers().push(...staleEvents)
        const late = captureThrow(__mockHelpers.emitTimersAvailable)
        expect(late.didThrow).toBe(false)
        expect(__mockHelpers.drainFiredTimersCalls()).toBe(drainsBefore + 1)
        expect(first).toHaveBeenCalledTimes(1)
        expect(timeoutTail).not.toHaveBeenCalled()
        expect(intervalTail).not.toHaveBeenCalled()
        BackgroundTimer.dispose()
        expect(__mockHelpers.disposeCalls()).toBe(1)
        expect(() => BackgroundTimer[method](jest.fn(), 100)).toThrow(
          /disposed/
        )
        BackgroundTimer.clearTimeout(ids[1])
        BackgroundTimer.clearInterval(ids[2])
        expect(NitroBackgroundTimer.clearTimeout).not.toHaveBeenCalled()
        expect(NitroBackgroundTimer.clearInterval).not.toHaveBeenCalled()
      })
    })
  })

  describe.each([
    { firstMethod: 'setTimeout', secondMethod: 'setInterval' },
    { firstMethod: 'setInterval', secondMethod: 'setTimeout' },
  ] as const)(
    '$firstMethod then $secondMethod',
    ({ firstMethod, secondMethod }) => {
      it.each(errorOrders)(
        'keeps the first error within a mixed batch: $label',
        ({ firstValue, secondValue }) => {
          jest.isolateModules(() => {
            const { BackgroundTimer } = require('../index')
            const {
              __mockHelpers,
            } = require('../../__mocks__/react-native-nitro-modules')
            const calls: string[] = []
            const before = jest.fn(() => calls.push('before'))
            const first = jest.fn(() => {
              calls.push('first')
              throw firstValue
            })
            const between = jest.fn(() => calls.push('between'))
            const second = jest.fn(() => {
              calls.push('second')
              throw secondValue
            })
            const after = jest.fn(() => calls.push('after'))
            const ids = [
              BackgroundTimer.setTimeout(before, 100),
              BackgroundTimer[firstMethod](first, 100),
              BackgroundTimer.setInterval(between, 100),
              BackgroundTimer[secondMethod](second, 100),
              BackgroundTimer.setTimeout(after, 100),
            ]
            for (const id of ids) __mockHelpers.queueTimer(id)
            const drainsBefore = __mockHelpers.drainFiredTimersCalls()

            const outcome = captureThrow(__mockHelpers.emitTimersAvailable)

            expect(calls).toEqual([
              'before',
              'first',
              'between',
              'second',
              'after',
            ])
            for (const callback of [before, first, between, second, after]) {
              expect(callback).toHaveBeenCalledTimes(1)
            }
            expect(__mockHelpers.drainFiredTimersCalls()).toBe(drainsBefore + 1)
            expect(__mockHelpers.queuedFiredTimers()).toHaveLength(0)
            expect(outcome.didThrow).toBe(true)
            expect(outcome.caughtValue).toBe(firstValue)
          })
        }
      )
    }
  )

  it('cleans up a throwing timeout before duplicate and late stale events', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      const callback = jest.fn(() => {
        throw undefined
      })
      const id = BackgroundTimer.setTimeout(callback, 100)
      __mockHelpers.queueTimer(id)
      const staleEvent = { ...__mockHelpers.queuedFiredTimers()[0] }
      __mockHelpers.queuedFiredTimers().push(staleEvent)
      const drainsBefore = __mockHelpers.drainFiredTimersCalls()

      const outcome = captureThrow(__mockHelpers.emitTimersAvailable)

      expect(callback).toHaveBeenCalledTimes(1)
      expect(__mockHelpers.drainFiredTimersCalls()).toBe(drainsBefore + 1)
      expect(__mockHelpers.queuedFiredTimers()).toHaveLength(0)
      expect(outcome.didThrow).toBe(true)
      expect(outcome.caughtValue).toBe(undefined)

      // Bypass native inactivity so a stale event actually reaches the JS map.
      __mockHelpers.queuedFiredTimers().push(staleEvent)
      const late = captureThrow(__mockHelpers.emitTimersAvailable)
      expect(callback).toHaveBeenCalledTimes(1)
      expect(late.didThrow).toBe(false)
      expect(__mockHelpers.drainFiredTimersCalls()).toBe(drainsBefore + 2)
      expect(__mockHelpers.queuedFiredTimers()).toHaveLength(0)
    })
  })

  it('keeps a throwing interval callable until clear and ignores late events', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      const callback = jest.fn(() => {
        throw undefined
      })
      const id = BackgroundTimer.setInterval(callback, 100)
      const drainsBefore = __mockHelpers.drainFiredTimersCalls()
      __mockHelpers.queueTimer(id)
      const staleEvent = { ...__mockHelpers.queuedFiredTimers()[0] }

      for (let invocation = 1; invocation <= 2; invocation++) {
        if (invocation === 2) {
          expect(__mockHelpers.queueTimer(id)).toBe(true)
        }
        const outcome = captureThrow(__mockHelpers.emitTimersAvailable)
        expect(callback).toHaveBeenCalledTimes(invocation)
        expect(__mockHelpers.isTimerAccepted(id)).toBe(true)
        expect(__mockHelpers.queuedFiredTimers()).toHaveLength(0)
        expect(outcome.didThrow).toBe(true)
        expect(outcome.caughtValue).toBe(undefined)
      }

      BackgroundTimer.clearInterval(id)
      __mockHelpers.queuedFiredTimers().push(staleEvent)
      const late = captureThrow(__mockHelpers.emitTimersAvailable)
      expect(callback).toHaveBeenCalledTimes(2)
      expect(late.didThrow).toBe(false)
      expect(__mockHelpers.isTimerAccepted(id)).toBe(false)
      expect(__mockHelpers.drainFiredTimersCalls()).toBe(drainsBefore + 3)
      expect(__mockHelpers.queuedFiredTimers()).toHaveLength(0)
    })
  })

  it('preserves clear, self-clear and new registration during a throwing callback', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      const calls: string[] = []
      const canceledTimeout = jest.fn()
      const canceledInterval = jest.fn()
      const nested = jest.fn(() => calls.push('nested'))
      const first = jest.fn(() => {
        calls.push('first')
        BackgroundTimer.clearInterval(firstId)
        BackgroundTimer.clearTimeout(timeoutId)
        BackgroundTimer.clearInterval(intervalId)
        const nestedId = BackgroundTimer.setTimeout(nested, 100)
        __mockHelpers.queueTimer(nestedId)
        __mockHelpers.emitTimersAvailable()
        throw undefined
      })
      const tail = jest.fn(() => calls.push('tail'))
      const firstId = BackgroundTimer.setInterval(first, 100)
      const timeoutId = BackgroundTimer.setTimeout(canceledTimeout, 100)
      const intervalId = BackgroundTimer.setInterval(canceledInterval, 100)
      const tailId = BackgroundTimer.setTimeout(tail, 100)
      for (const id of [firstId, timeoutId, intervalId, tailId]) {
        __mockHelpers.queueTimer(id)
      }
      const staleEvents = __mockHelpers.queuedFiredTimers().slice(0, 3)
      const drainsBefore = __mockHelpers.drainFiredTimersCalls()

      const outcome = captureThrow(__mockHelpers.emitTimersAvailable)

      expect(calls).toEqual(['first', 'tail', 'nested'])
      for (const callback of [first, tail, nested]) {
        expect(callback).toHaveBeenCalledTimes(1)
      }
      expect(canceledTimeout).not.toHaveBeenCalled()
      expect(canceledInterval).not.toHaveBeenCalled()
      expect(__mockHelpers.drainFiredTimersCalls()).toBe(drainsBefore + 2)
      expect(__mockHelpers.queuedFiredTimers()).toHaveLength(0)
      expect(outcome.didThrow).toBe(true)
      expect(outcome.caughtValue).toBe(undefined)

      __mockHelpers.queuedFiredTimers().push(...staleEvents)
      const late = captureThrow(__mockHelpers.emitTimersAvailable)
      expect(late.didThrow).toBe(false)
      expect(first).toHaveBeenCalledTimes(1)
      expect(canceledTimeout).not.toHaveBeenCalled()
      expect(canceledInterval).not.toHaveBeenCalled()
      expect(__mockHelpers.drainFiredTimersCalls()).toBe(drainsBefore + 3)
      expect(__mockHelpers.queuedFiredTimers()).toHaveLength(0)
    })
  })

  it('performs an empty reentrant drain after a callback throws', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      const first = jest.fn(() => {
        __mockHelpers.emitTimersAvailable()
        throw undefined
      })
      const tail = jest.fn()
      const firstId = BackgroundTimer.setTimeout(first, 100)
      const tailId = BackgroundTimer.setInterval(tail, 100)
      __mockHelpers.queueTimer(firstId)
      __mockHelpers.queueTimer(tailId)
      const drainsBefore = __mockHelpers.drainFiredTimersCalls()

      const outcome = captureThrow(__mockHelpers.emitTimersAvailable)

      expect(first).toHaveBeenCalledTimes(1)
      expect(tail).toHaveBeenCalledTimes(1)
      expect(__mockHelpers.drainFiredTimersCalls()).toBe(drainsBefore + 2)
      expect(__mockHelpers.queuedFiredTimers()).toHaveLength(0)
      expect(outcome.didThrow).toBe(true)
      expect(outcome.caughtValue).toBe(undefined)
    })
  })

  it('ignores unknown and cleared events without reporting a callback error', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const { FiredTimerType } = require('../specs/NitroBackgroundTimer.nitro')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      const canceled = jest.fn()
      const canceledId = BackgroundTimer.setTimeout(canceled, 100)
      BackgroundTimer.clearTimeout(canceledId)
      const successful = jest.fn()
      const successfulId = BackgroundTimer.setInterval(successful, 100)
      __mockHelpers
        .queuedFiredTimers()
        .push(
          { id: canceledId, type: FiredTimerType.Timeout, sequence: 0 },
          { id: -1, type: FiredTimerType.Timeout, sequence: 0 },
          { id: -2, type: FiredTimerType.Interval, sequence: 0 }
        )
      __mockHelpers.queueTimer(successfulId)
      const drainsBefore = __mockHelpers.drainFiredTimersCalls()

      const outcome = captureThrow(__mockHelpers.emitTimersAvailable)

      expect(canceled).not.toHaveBeenCalled()
      expect(successful).toHaveBeenCalledTimes(1)
      expect(outcome.didThrow).toBe(false)
      expect(__mockHelpers.drainFiredTimersCalls()).toBe(drainsBefore + 1)
      expect(__mockHelpers.queuedFiredTimers()).toHaveLength(0)
    })
  })

  describe('native drain boundary', () => {
    it.each([
      { label: 'Error', value: new Error('native drain failed') },
      { label: 'undefined', value: undefined },
    ])('preserves a direct native throw of $label', ({ value }) => {
      jest.isolateModules(() => {
        const { BackgroundTimer, NitroBackgroundTimer } = require('../index')
        const {
          __mockHelpers,
        } = require('../../__mocks__/react-native-nitro-modules')
        const callback = jest.fn()
        const id = BackgroundTimer.setTimeout(callback, 100)
        __mockHelpers.queueTimer(id)
        const nativeDrain = NitroBackgroundTimer.drainFiredTimers
        const originalImplementation = nativeDrain.getMockImplementation()
        nativeDrain.mockImplementationOnce(() => {
          throw value
        })
        const drainsBefore = __mockHelpers.drainFiredTimersCalls()

        const outcome = captureThrow(__mockHelpers.emitTimersAvailable)

        expect(callback).not.toHaveBeenCalled()
        expect(outcome.didThrow).toBe(true)
        expect(outcome.caughtValue).toBe(value)
        expect(__mockHelpers.drainFiredTimersCalls()).toBe(drainsBefore + 1)
        expect(__mockHelpers.queuedFiredTimers()).toHaveLength(1)
        expect(nativeDrain.getMockImplementation()).toBe(originalImplementation)

        const recovered = captureThrow(__mockHelpers.emitTimersAvailable)
        expect(callback).toHaveBeenCalledTimes(1)
        expect(recovered.didThrow).toBe(false)
        expect(__mockHelpers.drainFiredTimersCalls()).toBe(drainsBefore + 2)
        expect(__mockHelpers.queuedFiredTimers()).toHaveLength(0)
      })
    })

    it.each([
      {
        label: 'callback undefined, native Error',
        callbackValue: undefined,
        nativeValue: new Error('native drain failed'),
      },
      {
        label: 'callback Error, native undefined',
        callbackValue: new Error('callback failed'),
        nativeValue: undefined,
      },
      {
        label: 'callback Error, native Error',
        callbackValue: new Error('callback failed'),
        nativeValue: new Error('native drain failed'),
      },
    ])(
      'preserves native failure precedence after $label',
      ({ callbackValue, nativeValue }) => {
        jest.isolateModules(() => {
          const { BackgroundTimer, NitroBackgroundTimer } = require('../index')
          const {
            __mockHelpers,
          } = require('../../__mocks__/react-native-nitro-modules')
          const pending = jest.fn()
          const pendingId = BackgroundTimer.setTimeout(pending, 100)
          const first = jest.fn(() => {
            __mockHelpers.queueTimer(pendingId)
            __mockHelpers.emitTimersAvailable()
            NitroBackgroundTimer.drainFiredTimers.mockImplementationOnce(() => {
              throw nativeValue
            })
            throw callbackValue
          })
          const tail = jest.fn()
          const firstId = BackgroundTimer.setTimeout(first, 100)
          const tailId = BackgroundTimer.setInterval(tail, 100)
          __mockHelpers.queueTimer(firstId)
          __mockHelpers.queueTimer(tailId)
          const nativeDrain = NitroBackgroundTimer.drainFiredTimers
          const originalImplementation = nativeDrain.getMockImplementation()
          const drainsBefore = __mockHelpers.drainFiredTimersCalls()

          const outcome = captureThrow(__mockHelpers.emitTimersAvailable)

          expect(first).toHaveBeenCalledTimes(1)
          expect(tail).toHaveBeenCalledTimes(1)
          expect(pending).not.toHaveBeenCalled()
          expect(outcome.didThrow).toBe(true)
          expect(outcome.caughtValue).toBe(nativeValue)
          expect(__mockHelpers.drainFiredTimersCalls()).toBe(drainsBefore + 2)
          expect(__mockHelpers.queuedFiredTimers()).toHaveLength(1)
          expect(nativeDrain.getMockImplementation()).toBe(
            originalImplementation
          )

          const recovered = captureThrow(__mockHelpers.emitTimersAvailable)
          expect(pending).toHaveBeenCalledTimes(1)
          expect(recovered.didThrow).toBe(false)
          expect(__mockHelpers.drainFiredTimersCalls()).toBe(drainsBefore + 3)
          expect(__mockHelpers.queuedFiredTimers()).toHaveLength(0)
        })
      }
    )
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

  it('configure succeeds immediately after clearTimeout of an accepted timer', () => {
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
      expect(__mockHelpers.isTimerClearPending(id)).toBe(true)
      expect(() =>
        BackgroundTimer.configure({ notification: { title: 'After clear' } })
      ).not.toThrow()
      expect(__mockHelpers.configureCalls()).toBe(1)
    })
  })

  it('configure succeeds immediately after clearInterval of an accepted timer', () => {
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
      expect(__mockHelpers.isTimerClearPending(id)).toBe(true)
      expect(() =>
        BackgroundTimer.configure({ notification: { title: 'After clear' } })
      ).not.toThrow()
      expect(__mockHelpers.configureCalls()).toBe(1)
    })
  })

  it('clear-pending timeout does not become active when native processes it later', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      __mockHelpers.reset()
      const cb = jest.fn()
      const id = BackgroundTimer.setTimeout(cb, 1000)
      BackgroundTimer.clearTimeout(id)

      expect(__mockHelpers.isTimerClearPending(id)).toBe(true)
      __mockHelpers.fireTimer(id)

      expect(cb).not.toHaveBeenCalled()
      expect(__mockHelpers.isTimerClearPending(id)).toBe(false)
      expect(__mockHelpers.isTimerAccepted(id)).toBe(false)
      expect(__mockHelpers.isTimerPending(id)).toBe(false)
      expect(__mockHelpers.isTimerActive(id)).toBe(false)
      expect(() =>
        BackgroundTimer.configure({ notification: { title: 'After worker' } })
      ).not.toThrow()
    })
  })

  it('clear-pending interval does not become active when native processes it later', () => {
    jest.isolateModules(() => {
      const { BackgroundTimer } = require('../index')
      const {
        __mockHelpers,
      } = require('../../__mocks__/react-native-nitro-modules')
      __mockHelpers.reset()
      const cb = jest.fn()
      const id = BackgroundTimer.setInterval(cb, 1000)
      BackgroundTimer.clearInterval(id)

      expect(__mockHelpers.isTimerClearPending(id)).toBe(true)
      __mockHelpers.fireTimer(id)

      expect(cb).not.toHaveBeenCalled()
      expect(__mockHelpers.isTimerClearPending(id)).toBe(false)
      expect(__mockHelpers.isTimerAccepted(id)).toBe(false)
      expect(__mockHelpers.isTimerPending(id)).toBe(false)
      expect(__mockHelpers.isTimerActive(id)).toBe(false)
      expect(() =>
        BackgroundTimer.configure({ notification: { title: 'After worker' } })
      ).not.toThrow()
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
