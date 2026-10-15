/** Ownership applies to raw Nitro proxies: after disposal even looking up a method is invalid. */
export function createOwnedRawTimers<T extends { dispose(): void }>() {
  const owned = new Set<T>()
  const release = (timer: T) => {
    if (!owned.delete(timer)) return
    timer.dispose()
  }
  return {
    track(timer: T): T { owned.add(timer); return timer },
    release,
    disposeRemaining() {
      let failure: unknown
      let hasFailure = false
      for (const timer of Array.from(owned)) {
        try { release(timer) } catch (error) { if (!hasFailure) failure = error; hasFailure = true }
      }
      if (hasFailure) throw failure
    },
  }
}
