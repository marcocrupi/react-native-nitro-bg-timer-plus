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

## Current validation status

- Core smoke iOS physical device: validated with `RESULT PASS`.
- Core smoke Android physical device foreground: validated with `RESULT PASS`.
- Core smoke Android physical device background: validated with `RESULT PASS`.
- UI smoke iOS simulator main flow: validated with `RESULT PASS`.
- Maestro on physical iPhone: best-effort because local driver setup and
  signing can fail outside the library runtime.
- Android real-device UI smoke: not yet validated.
- Real-device `fgs-optout` smoke: not yet validated.

## Automated smoke test

The example app exposes a smoke mode via:

```txt
nitrobgtimerexample://smoke?runId=<id>
```

It logs machine-readable markers to the JS console:

```txt
[NitroBgSmoke] DEEPLINK_RECEIVED runId=<id> url=<url>
[NitroBgSmoke] DEEPLINK_IGNORED runId=<id|none> reason=<reason>
[NitroBgSmoke] NATIVE_PENDING_URL_CHECK runId=none
[NitroBgSmoke] NATIVE_PENDING_URL_FOUND runId=<id> url=<url>
[NitroBgSmoke] NATIVE_PENDING_URL_EMPTY runId=none
[NitroBgSmoke] RUN_REQUESTED runId=<id>
[NitroBgSmoke] START runId=<id>
[NitroBgSmoke] STEP PASS runId=<id> name=<step>
[NitroBgSmoke] STEP FAIL runId=<id> name=<step> reason=<reason>
[NitroBgSmoke] BACKGROUND_READY runId=<id>
[NitroBgSmoke] RESULT PASS runId=<id>
[NitroBgSmoke] RESULT FAIL runId=<id> reason=<reason>
```

Smoke deep links with a malformed `runId` are ignored with
`DEEPLINK_IGNORED reason=invalid_run_id`.

Run Android smoke after installing the example app and starting Metro:

```sh
yarn smoke:android
```

Use the optional background window automation on Android:

```sh
yarn smoke:android --background
```

Run iOS simulator smoke after booting a simulator and starting Metro:

```sh
yarn smoke:ios
```

The iOS automated runner builds the Debug example app with `xcodebuild`,
installs the resulting `.app`, opens the smoke deep link, captures logs, and
waits for the matching `RESULT PASS/FAIL` marker. Build and install are on by
default so the smoke does not accidentally test an old app already installed
on the simulator or device.

On iOS, the example app duplicates JS `[NitroBgSmoke]` markers to native logs
through an example-only `NitroBgSmokeLog` module. This module is diagnostics
for the example app only and is not a public library API. Native
`[NitroBgSmokeNative] OPEN_URL` and `[NitroBgSmokeNative] LAUNCH_URL` markers
mean iOS received the smoke deep link before React Native Linking handles it.
The same example-only module also stores the last smoke URL received by
`AppDelegate` in memory so JS can consume it as a fallback when `Linking` does
not deliver the URL. `NATIVE_PENDING_URL_FOUND` means this fallback delivered
the URL to the JS smoke harness. `source=native_pending_url` identifies a JS
smoke run started from this example-only native pending URL fallback. It is
valid to see `NATIVE_PENDING_URL_FOUND` followed by
`DEEPLINK_IGNORED reason=duplicate` when the normal React Native Linking event
has already started the same run.

On physical devices, the default launch strategy is
`--launch-strategy launch-then-open-url`: the script launches the app with
`devicectl --console`, waits briefly for JS boot, then sends the smoke deep
link with a separate `devicectl --payload-url` command while continuing to read
the same console stream. Use `--launch-strategy payload-at-launch` to retry the
legacy single launch command that combines `--console` and `--payload-url`.

Run iOS physical device smoke with a connected, unlocked, trusted device:

```sh
bash scripts/smoke-ios.sh --device <udid>
bash scripts/smoke-ios.sh --device <udid> --run-id ios-device-1
```

On physical devices, `devicectl` and `xcodebuild` may expose different
identifiers. Use `--device` for `devicectl` and `--xcodebuild-device-id` for
the `xcodebuild` destination if automatic resolution fails.

Use these flags when reusing a previous build or a known DerivedData path:

```sh
bash scripts/smoke-ios.sh --skip-build --derived-data /tmp/nitro-bg-timer-xcodebuild
bash scripts/smoke-ios.sh --skip-build --skip-install
bash scripts/smoke-ios.sh --derived-data /tmp/nitro-bg-timer-xcodebuild
```

Automated iOS mode must launch a fresh example app process so
`devicectl --console` or `simctl log stream` can observe the run. If the app
is already running, the script fails by default. To let the script terminate
only the example app and continue, pass:

```sh
bash scripts/smoke-ios.sh --device <udid> --terminate-existing
bash scripts/smoke-ios.sh --simulator --terminate-existing
```

Use manual open-url mode only when the app is already launched from Xcode or
another harness and you want to observe Metro or Xcode yourself:

```sh
bash scripts/smoke-ios.sh --device <udid> --open-url-only
bash scripts/smoke-ios.sh --device <udid> --run-id manual-ios-1 --open-url-only
```

`--open-url-only` only sends `nitrobgtimerexample://smoke?runId=<id>`; it does
not build, install, terminate the app, capture logs, or wait for
`RESULT PASS/FAIL`. The `[NitroBgSmoke]` markers are JS `console.log` markers,
so in manual mode they may appear in Metro or Xcode rather than the script.

The smoke covers public `BackgroundTimer` API behavior for `setTimeout`,
`clearTimeout`, `setInterval`, `clearInterval`, callback-free timer delivery
through the native fired-event queue and JS drain, batch ordering, reentrant
scheduling, a short background-ready interval, and final `dispose()`. The
scripts exit with:

```txt
0   RESULT PASS
1   RESULT FAIL, crash, RedBox, or runtime error marker
2   preflight, configuration, build, install, or launch setup failure
124 timeout waiting for a matching RESULT marker
```

The smoke is one-shot per app process because it calls
`BackgroundTimer.dispose()` at the end. Reload or restart the app before
running the smoke again in the same process, including after a manual
`--open-url-only` run.

Use the last marker reported by the iOS script to classify failures:

- No marker: URL delivery or JS console log capture issue. Verify Metro is
  running with `yarn example:start`, the target simulator is booted or the
  device is connected/unlocked/trusted, the example app was not already
  running, and the full log path printed by the script.
- `native_url_received`: the URL reached iOS, but the JS smoke handler has not
  logged `DEEPLINK_RECEIVED` yet. This points to React Native Linking, JS
  console capture, or app JS initialization.
- `native_pending_url_found`: JS consumed the pending URL stored by
  `AppDelegate`, but did not log `DEEPLINK_RECEIVED`.
- `DEEPLINK_RECEIVED` but no `START`: the deep link reached JS, but the app
  smoke handler did not start the smoke.
- `START` but no `RESULT`: the smoke started, but the timer/event bridge did
  not complete or the app stopped before result logging.
- `RESULT FAIL`: smoke assertion failure; inspect the failing step and reason.

If the app was launched from Xcode, use `--open-url-only` instead of automated
mode. If `--skip-install` was used, rerun without it to avoid testing a stale
installed app.

Physical iOS backgrounding still requires manual validation or a future
XCUITest that presses Home.

## UI button smoke

The UI button smoke is separate from the automated core smoke above.

- Core smoke opens `nitrobgtimerexample://smoke?runId=<id>` and executes the
  timer API harness automatically.
- UI button smoke opens
  `nitrobgtimerexample://smoke?runId=<id>&mode=ui`, keeps the app
  interactive, then uses Maestro to press the example app buttons.

`mode=ui` only activates the UI smoke run id. It must not start the core smoke
until Maestro presses the "Run Smoke" button, which is intentionally last
because the core smoke calls `BackgroundTimer.dispose()`.

Outside `mode=ui`, the example app behaves like the normal manual demo: button
taps do not emit `[NitroBgUiSmoke]` markers and do not apply UI-smoke-only
shortcuts such as reduced timer durations or suppressed alerts.

UI button smoke markers are machine-readable:

```txt
[NitroBgUiSmoke] START runId=<id> section=<section> action=<action>
[NitroBgUiSmoke] PASS runId=<id> section=<section> action=<action>
[NitroBgUiSmoke] FAIL runId=<id> section=<section> action=<action> reason=<reason>
```

Maestro is required and is not installed automatically:

```sh
maestro --version
yarn ui-smoke:android
yarn ui-smoke:ios
```

Android UI smoke with Maestro requires Maestro installed and available in
`PATH`. Runtime Android smoke is validated separately by
`scripts/smoke-android.sh`; a missing Maestro binary is an environment
prerequisite failure for UI smoke, not a runtime failure.

Install Maestro from <https://maestro.mobile.dev/> if the scripts exit with:

```txt
Maestro is required for UI smoke. Install it from https://maestro.mobile.dev/ ...
```

The main UI smoke flow is foreground-only. It presses stable `testID`
selectors, not coordinates, and validates PASS/FAIL per section/action from
captured logs. It covers:

- setTimeout schedule/fire and cancel
- setInterval start, stop, reset
- Background Test reversible foreground actions
- Concurrent Timers start all and stop all
- Cleanup mount, tick observation, and unmount cleanup window
- `useBackgroundTimer` hook start, restart, and stop
- Stress Test 100 timers
- Automated Smoke Test "Run Smoke" last

Android:

```sh
yarn ui-smoke:android
bash scripts/ui-smoke-android.sh --device <serial>
bash scripts/ui-smoke-android.sh --flow fgs-optout --device <serial>
```

Current status: Android physical-device UI smoke has not yet been validated.

iOS simulator:

```sh
yarn ui-smoke:ios
bash scripts/ui-smoke-ios.sh --simulator <udid>
```

iOS UI smoke with Maestro is simulator-first. The flow is foreground-only and
presses app UI controls, so a booted simulator is the recommended target for
the automated UI button smoke. The simulator main flow has been validated
with `RESULT PASS`.

iOS physical device:

```sh
bash scripts/ui-smoke-ios.sh --device <devicectl-id>
bash scripts/ui-smoke-ios.sh --device <devicectl-id> --xcodebuild-device-id <xcodebuild-id>
bash scripts/ui-smoke-ios.sh \
  --device C274F5E5-B73D-556F-9589-E384F79EF805 \
  --xcodebuild-device-id 00008140-00195819267B801C \
  --maestro-device-id 00008140-00195819267B801C \
  --run-id ios-ui-device-001 \
  --flow main
```

Maestro on a physical iPhone is best-effort and experimental because it
requires Maestro's iOS driver setup and local signing. Physical device runs may
need three separate ids:

- `--device` for `devicectl`
- `--xcodebuild-device-id` for `xcodebuild`
- `--maestro-device-id` for Maestro

If Maestro physical-device execution fails during driver setup, do not treat
that alone as a library failure. XCUITest is the recommended follow-up for
robust iOS physical-device automation.

`Disable FGS` is intentionally outside the main flow because it is not
reversible in the same app process. Use the `fgs-optout` flow as a fresh,
one-shot process check. The Android script refuses to run that flow when the
example app process is already running unless `--install` is used:

```sh
bash scripts/ui-smoke-android.sh --flow fgs-optout
bash scripts/ui-smoke-ios.sh --flow fgs-optout
```

Current status: real-device `fgs-optout` smoke has not yet been validated.

The UI button smoke does not validate true background/Home behavior, iOS
background execution, lock-screen behavior, or OEM Android background policy.
Those remain manual checks or future native UI automation.

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
- [ ] Remove the app from the recents screen, or close it from Android
      system settings
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

### A9 — Callback-free fired-event delivery verification

This closes the loop on the callback-free timer fire path: the worker
`HandlerThread` records a fired timer event, native emits the timers-available
signal, and JS drains the queue before invoking the callback stored in the
public `BackgroundTimer` wrapper.

- [ ] Start a single `BackgroundTimer.setTimeout(() => console.log('fired'), 1000)`
- [ ] Verify the log appears in Metro and no JSI errors are printed
- [ ] Verify no `Tried to access JS runtime from non-JS thread` error
- [ ] Verify no generated Nitro callback-wrapper error is printed for timer
      fire delivery

### A10 — Implicit foreground service activation

Default path: the consumer never calls `startBackgroundMode()`, and the
library starts/stops the service automatically around active timers.

- [ ] Grant `POST_NOTIFICATIONS` to the example app
- [ ] Press "Start" in the Background Test section (no "Start BG Mode" press)
- [ ] Verify the "Background Timer Active" notification appears in the shade
- [ ] Verify `NitroBgTimer: Foreground service started` appears in logcat
- [ ] Press "Stop" — verify the notification disappears and
      `Foreground service stopped` appears in logcat

### A11 — Explicit background mode stays stable across timers

- [ ] Press "Configure Notification" (sets a custom title/text)
- [ ] Press "Start BG Mode" — verify the notification appears immediately
      even without any active timer
- [ ] Press "Start" to begin the Background Test — notification must stay
      the same (no blink, no channel recreation)
- [ ] Press "Stop" on the Background Test — notification must stay alive
      (explicit mode still held)
- [ ] Press "Stop BG Mode" — verify the notification disappears
- [ ] Verify `Background mode requested explicitly` and `Background mode
      released explicitly` lines appear in logcat in the right order

### A12 — Notification customization via `configure`

- [ ] Press "Configure Notification" before starting any timer
- [ ] Press "Start BG Mode"
- [ ] Verify the notification shows "Workout in progress" as title and
      "Background timers running" as text (values from the example app
      configure call)
- [ ] Press "Stop BG Mode", then "Start BG Mode" again — same custom
      text should reappear (config persists across service stop/start
      within the same process)

### A13 — Background accuracy with foreground service (regression gate)

This is the primary acceptance criterion for B9. Before B9, Background
Test 3 on a Pixel 9 Pro XL stock Android showed Native ~78, Expected 100
after 90s backgrounded with screen off (~10% drift). After B9, with the
foreground service active, the drift must be near zero.

- [ ] Press "Start BG Mode" (explicit mode, stable notification)
- [ ] Press "Start" on Background Test 3
- [ ] Background the app and lock the screen within 2 seconds
- [ ] Wait 90 seconds on the lock screen (optionally: repeat the phone
      while locked to ensure it doesn't dim off into Doze on first run)
- [ ] Unlock, return to the app, press "Stop"
- [ ] Verify `Native ≈ Expected` within 1-2 units (target: Native 89-91
      when Expected is 90)
- [ ] Repeat with "Stop BG Mode" pressed before backgrounding to confirm
      the drift regresses to ~10% without the foreground service

### A14 — POST_NOTIFICATIONS denied graceful fallback

- [ ] Long-press the example app icon → App Info → Notifications →
      disable all notifications, or revoke `POST_NOTIFICATIONS` via
      `adb shell pm revoke com.nitrobgtimerexample android.permission.POST_NOTIFICATIONS`
- [ ] Relaunch the example app, press "Start" on Background Test
- [ ] Verify the app does not crash
- [ ] Verify either the foreground service starts with the notification hidden
      or `startForeground()` fails and the library logs a wake-lock-only
      fallback
- [ ] On API 34+, if the service cannot stay promoted, expect a
      `Foreground service stopped`, service death, or fallback log line — this
      is documented as a known limitation, not a bug

### A15 — Long background run does not ANR (B11 regression gate)

Purpose: verify that the foreground service does not crash with an ANR
after 3 minutes (regression gate for the B11 fix that switched from
`shortService` to `specialUse`).

- [ ] Kill the example app, reinstall, reopen
- [ ] Grant `POST_NOTIFICATIONS` permission if prompted
- [ ] Tap **Start BG Mode** in the Background Test section
- [ ] Verify the persistent notification appears
- [ ] Tap **Start** on Background Test 3 to start a 1-second interval
- [ ] Press the home button to background the app
- [ ] Lock the screen
- [ ] **Wait 5 minutes** (timed)
- [ ] Unlock the screen and return to the app
- [ ] Wait 5 seconds for JS counters to settle
- [ ] Verify the timer is still running and accurate (Native ≈ Expected)
- [ ] Check `adb logcat | grep -E "ANR|Short FGS"` — should show **no**
      ANR or `Short FGS` messages for `com.nitrobgtimerexample`

Expected: timer fires continuously for 5+ minutes without ANR,
notification stays visible, Native and Expected counters remain aligned
within 1-2 units.

Failure mode if regressed: the app would crash with `Short FGS ANR'ed`
followed by `ANR in com.nitrobgtimerexample` in logcat, and the example
app would disappear from the recents.

### A16 — Foreground service failure falls back cleanly

This is partly a technical/instrumented scenario because Android does not
offer a stable manual switch for every foreground-service failure mode.

- [ ] Build a temporary consumer/app variant that removes
      `NitroBackgroundTimerService` from the merged manifest but does **not**
      call `BackgroundTimer.disableForegroundService()`
- [ ] Start a timer — verify the app does not crash
- [ ] Verify logcat contains a foreground-service start failure and
      wake-lock-only fallback message
- [ ] Verify the timer still fires, with the expected wake-lock-only timing
      caveat
- [ ] Clear the timer, then start another timer — verify the previous failed
      start state does not suppress a future foreground-service start attempt
- [ ] In a normal manifest build, start explicit background mode, then stop the
      service from adb or an instrumented hook; verify `Service onDestroy` /
      `Foreground service destroyed` is logged and a later timer can request
      the service again

### A17 — `configure()` is blocked immediately after timer acceptance

Use a temporary dev button/test harness or an instrumented test if the example
app does not expose direct calls in this order.

- [ ] Call `BackgroundTimer.setTimeout(() => {}, 30000)`
- [ ] Immediately call `BackgroundTimer.configure({ notification: { title: 'Late' } })`
- [ ] Verify `configure()` throws an `Error` before the native timer has fired
- [ ] Repeat with `BackgroundTimer.setInterval(() => {}, 30000)`
- [ ] Clear the timer and call `configure()` again — verify it succeeds after
      no timer is accepted, pending, or active

### A18 — JS callback failure policy after callback-free native delivery

Use a temporary dev button/test harness or a focused unit/integration test; a
throwing callback can intentionally surface a JS error/RedBox.

- [ ] Schedule a timeout whose callback throws a normal JS `Error`
- [ ] Verify native timer delivery does not crash in a generated Nitro callback
      wrapper; the error is surfaced from the JS drain path
- [ ] Verify the timeout callback is removed after the throw and does not fire
      again
- [ ] Schedule an interval whose callback throws a normal JS `Error`
- [ ] Verify the interval callback remains registered until explicitly cleared
      by `BackgroundTimer.clearInterval(id)`

### A19 — Foreground service STARTING pending-stop race (API 36 regression gate)

Purpose: verify the Android foreground-service lifecycle fix for the race
where a stop arrived while a foreground-service request was still `STARTING`.
The fix avoids invalidating that request before `Service.onStartCommand()` can
call `startForeground()`.

- [ ] Use an Android API 36 physical device or emulator with the example app
      installed and Metro running
- [ ] Start a timer or explicit background mode, then clear/stop it quickly so
      a stop can arrive while the service start is still in flight
- [ ] Verify logcat contains
      `Foreground service stop requested while starting; deferring until service start`
      when the race is hit
- [ ] Verify the service is allowed to call `startForeground()` and then stops
      cleanly if there is no remaining demand
- [ ] Verify no `ForegroundServiceDidNotStartInTimeException` appears in
      logcat
- [ ] Verify a later timer or explicit `startBackgroundMode()` call can start
      the foreground service again

## iOS tests

### I1 — Basic timer functionality

- [ ] Same as A1

### I2 — Background execution

- [ ] Start a 25-second `setTimeout`, immediately background the app
- [ ] After 25s, verify the callback fired
- [ ] Note: iOS typically grants only limited background execution time
      without explicit background modes; this is not an infinite background
      guarantee

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

### I6 — Expiration, foreground, second background reacquire

- [ ] Start a long-running `setInterval`
- [ ] Background the app and wait for the background task expiration log
- [ ] Return the app to foreground
- [ ] Background the app again while the interval is still active
- [ ] Verify the app does not crash or hit a watchdog termination
- [ ] In a debug build, verify the reacquire path logs that the app entered
      background with active timers and no background task
      (`didEnterBackground` observer path)
- [ ] Call `clearInterval` or `dispose()` and verify the background task is
      released / no further interval callbacks fire

### I7 — Timeout cleanup after clear/dispose

- [ ] Start a `setTimeout` long enough to clear manually
- [ ] Immediately background the app, then call `clearTimeout` before it fires
- [ ] Verify the callback never fires
- [ ] Verify the background task is released if no timers remain
- [ ] Repeat with `BackgroundTimer.dispose()` instead of `clearTimeout`
- [ ] Verify dispose prevents late callback delivery and releases the
      background task

### I8 — Callback-free delivery on iOS

The iOS timer fire path should not use generated Nitro callback wrappers for
timer delivery. Native records fired timer events, emits the timers-available
signal, and JS drains the queue through the public `BackgroundTimer` wrapper.

- [ ] Run the automated core smoke on a physical iOS device and verify
      `RESULT PASS`
- [ ] Start a manual timeout and interval; verify callbacks run in JS
- [ ] Verify no generated Nitro callback-wrapper error is printed for timer
      fire delivery
- [ ] Verify timeout cleanup behavior with normal clear/dispose paths instead
      of relying on thrown JS errors as a guaranteed recoverable path

### I9 — Stress test

- [ ] Same as A8 (adapted for iOS)

## Cross-platform regression tests

### X1 — Long-running interval drift / platform limits

- [ ] Android: start explicit background mode, start `setInterval` with
      1000 ms, background the app for 10 minutes, and verify near-zero drift
      while the foreground service notification remains active
- [ ] Android: verify wake lock held throughout (via `dumpsys power`) and
      released after `clearInterval`
- [ ] iOS: do **not** treat 10 minutes of continuous background execution as a
      required pass condition. Use I5/I6 to validate the limited
      `beginBackgroundTask` window, expiration handling, best-effort reacquire,
      and cleanup behavior

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
- [ ] Verify `yarn typecheck` and `yarn lint-ci` are clean
- [ ] Document any skipped tests with reason in the release notes
