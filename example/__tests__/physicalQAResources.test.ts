import { createOwnedRawTimers } from '../src/smoke/physicalQAResources'

function rawProxy() {
  let disposed = false
  let calls = 0
  const value = new Proxy({dispose() {}}, {
    get(_, property) {
      if (disposed) throw new Error('lookup_on_disposed_raw_proxy')
      if (property === 'dispose') return () => { disposed = true; calls++ }
      return undefined
    },
  })
  return {value, calls: () => calls}
}

test('retains the old invalid double-dispose cleanup as a causal RED witness', () => {
  const a = rawProxy(), b = rawProxy()
  const oldOwners = [a.value, b.value]
  a.value.dispose(); b.value.dispose()
  expect(() => oldOwners.forEach(timer => timer.dispose())).toThrow('lookup_on_disposed_raw_proxy')
})

test('releases raw owners once, before looking up dispose, including final cleanup', () => {
  const a = rawProxy(), b = rawProxy(), c = rawProxy()
  const owners = createOwnedRawTimers<{dispose(): void}>()
  owners.track(a.value); owners.track(b.value); owners.track(c.value)
  owners.release(a.value); owners.release(b.value)
  owners.disposeRemaining(); owners.release(a.value); owners.disposeRemaining()
  expect([a.calls(), b.calls(), c.calls()]).toEqual([1,1,1])
})

test('does not retry a failed dispose and still attempts the other owners', () => {
  const owners = createOwnedRawTimers<{dispose(): void}>()
  const broken = {dispose: jest.fn(() => {throw new Error('dispose_failed')})}
  const other = {dispose: jest.fn()}
  owners.track(broken); owners.track(other)
  expect(() => owners.disposeRemaining()).toThrow('dispose_failed')
  owners.disposeRemaining()
  expect(broken.dispose).toHaveBeenCalledTimes(1)
  expect(other.dispose).toHaveBeenCalledTimes(1)
})

for (const value of [0, false, '', null, undefined]) {
  test(`preserves falsy cleanup throw ${String(value)}`, () => {
    const owners = createOwnedRawTimers<{dispose(): void}>()
    const other = {dispose: jest.fn()}
    owners.track({dispose() { throw value }}); owners.track(other)
    let caught = false
    try { owners.disposeRemaining() } catch (error) { caught = true; expect(error).toBe(value) }
    expect(caught).toBe(true)
    expect(other.dispose).toHaveBeenCalledTimes(1)
    owners.disposeRemaining()
  })
}
