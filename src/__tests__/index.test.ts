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
