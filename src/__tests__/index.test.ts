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
