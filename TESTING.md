# Manual testing checklist

This checklist must be executed on a real device before publishing a new
version of the library. The unit tests cover the JS layer in isolation; the
native lifecycle, wake lock behaviour, threading, and Activity-destroy
cleanup all require manual verification on each platform.

## Setup

1. `yarn install`
2. `yarn example:android` or `yarn example:ios`
3. Open the example app on a physical device (Android: USB debugging on;
   iOS: trusted developer profile)

## Android tests

> **Note on Fast Refresh / dev bundle reload**: automatic cleanup on
> Fast Refresh (bundle reload without Activity destroy) is **not**
> provided. In dev mode, call `BackgroundTimer.dispose()` manually before
> reloading, or rely on Kotlin `finalize()` which is non-deterministic.
> Activity destroy (the production teardown path) is fully covered via
> the `LifecycleEventListener` hook.

### A1 — Basic timer functionality

- [ ] `setTimeout` fires once after the specified delay
- [ ] `setInterval` fires repeatedly at the specified interval
- [ ] `clearTimeout` cancels a pending timeout
- [ ] `clearInterval` cancels a running interval

### A2 — Background execution

- [ ] Start a 30-second `setTimeout`, immediately background the app
- [ ] After 30s, verify the callback fired
- [ ] Repeat with `setInterval` (5s interval, 60s total) — verify all 12
      ticks fired while backgrounded
- [ ] Lock the screen during a running interval — verify ticks continue

### A3 — Dispose lifecycle

- [ ] Call `BackgroundTimer.dispose()` from a button — verify no errors
- [ ] After dispose, calling `setTimeout` throws an `Error` with a message
      containing `disposed`
- [ ] After dispose, calling `clearTimeout` is silent (no throw)
- [ ] Calling `dispose()` twice is silent

### A4 — Activity destroy cleanup (production teardown path)

This is the primary automatic cleanup path on Android. It fires when the
host Activity is destroyed, which covers user-initiated quit, system kill
under memory pressure, and process termination.

- [ ] Start a `setInterval` (e.g. 30s)
- [ ] Swipe the app away from the recents screen (or force-stop from
      Android system settings)
- [ ] Reopen the app, inspect logcat for
      `NitroBgTimer: onHostDestroy triggered cleanup` (logged during the
      previous destroy cycle)
- [ ] Run `adb shell dumpsys power | grep -i nitrobgtimer` — verify no
      wake lock held

### A5 — Explicit dispose() cleans up on Fast Refresh

Because automatic Fast Refresh cleanup is not provided (see note at top),
verify that manually calling `dispose()` before reload works as expected.

- [ ] Start a `setInterval` (60s)
- [ ] Call `BackgroundTimer.dispose()` from a dev button
- [ ] Trigger Fast Refresh (R+R in emulator or "Reload" from dev menu)
- [ ] Run `adb shell dumpsys power | grep -i nitrobgtimer` — verify no
      wake lock held

### A6 — SecurityException graceful fallback

- [ ] Create a consumer manifest override that strips `WAKE_LOCK` via
      `<uses-permission android:name="android.permission.WAKE_LOCK" tools:node="remove" />`
- [ ] Build and run — verify no crash
- [ ] Verify timer still fires
- [ ] Verify warning log: `NitroBgTimer: WAKE_LOCK permission missing or revoked`

### A7 — Wake lock release on natural completion

- [ ] Start a 10-second `setTimeout`
- [ ] After it fires, run `adb shell dumpsys power | grep -i nitrobgtimer`
- [ ] Verify no wake lock held

### A8 — Thread safety stress test

- [ ] Start 50 concurrent `setTimeout` with random delays (100–5000 ms)
- [ ] Verify all callbacks fire
- [ ] Verify no errors in logcat
- [ ] Verify wake lock released after the last one fires (via `dumpsys power`)

### A9 — Cross-thread callback verification

This closes the loop on the JSI `AsyncJSCallback` dispatcher guarantee: the
worker `HandlerThread` invokes the callback on a non-main thread, Nitro
marshals it back to JS via `CallInvoker`.

- [ ] Start a single `BackgroundTimer.setTimeout(() => console.log('fired'), 1000)`
- [ ] Verify the log appears in Metro and no JSI errors are printed
- [ ] Verify no `Tried to access JS runtime from non-JS thread` error

## iOS tests

### I1 — Basic timer functionality

- [ ] Same as A1

### I2 — Background execution

- [ ] Start a 25-second `setTimeout`, immediately background the app
- [ ] After 25s, verify the callback fired
- [ ] Note: iOS grants ~30s of background execution without explicit
      background modes

### I3 — Dispose lifecycle

- [ ] Same as A3

### I4 — Bundle reload cleanup

- [ ] Start a `setInterval`, trigger Fast Refresh
- [ ] Verify `[NitroBgTimer] debug: deinit triggered` appears in Xcode
      console (debug builds only)

### I5 — Background task expiration

- [ ] Start a 60-second `setInterval` and background the app
- [ ] After ~30s iOS fires the expiration handler
- [ ] Verify no `0x8badf00d` watchdog crash
- [ ] Verify `[NitroBgTimer] warn: Background task expiration handler fired`
      appears in Xcode console

### I6 — Stress test

- [ ] Same as A8 (adapted for iOS)

## Cross-platform regression tests

### X1 — Long-running interval drift

- [ ] Start `setInterval` with 1000 ms
- [ ] Let it run 10 minutes
- [ ] Verify no drift > 100 ms per tick
- [ ] Android: verify wake lock held throughout (via `dumpsys power`)
- [ ] Call `clearInterval`, verify wake lock / background task released

### X2 — clearTimeout race

- [ ] Start `setTimeout`, immediately call `clearTimeout` with same id
- [ ] Verify callback never fires
- [ ] Verify no wake lock / background task leak

### X3 — Reuse after dispose

- [ ] Call `BackgroundTimer.dispose()`
- [ ] Full app reload (kill + relaunch) — verify the new instance works
      normally (dispose is per-instance, not per-process)

## Release sign-off

Before tagging a release, the maintainer must:

- [ ] Execute the full Android checklist on a physical device
- [ ] Execute the full iOS checklist on a physical device
- [ ] Verify all JS unit tests pass (`yarn test`)
- [ ] Verify `yarn typecheck` and `yarn lint` are clean
- [ ] Document any skipped tests with reason in the release notes
