jest.mock('react-native-nitro-modules', () =>
  require('../../__mocks__/react-native-nitro-modules')
)

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
