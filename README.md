# react-native-nitro-bg-timer-plus

A maintained, independent fork of [react-native-nitro-bg-timer](https://github.com/tconns/react-native-nitro-bg-timer)
by [Thành Công](https://github.com/tconns), maintained by [Marco Crupi](https://github.com/marcocrupi).

[![npm version](https://img.shields.io/npm/v/react-native-nitro-bg-timer-plus.svg)](https://www.npmjs.com/package/react-native-nitro-bg-timer-plus)
[![license](https://img.shields.io/npm/l/react-native-nitro-bg-timer-plus.svg)](LICENSE)

Native timeout and interval scheduling for Android and iOS, built with Nitro
Modules. Application callbacks run in JavaScript; background execution depends
on the time and resources the operating system grants your app.

This README describes **version 0.4.0**. See the [release notes](CHANGELOG.md#040---2026-10-15)
for changes since 0.3.3, including the required React Native/Nitro upgrade.
Use the documentation from the matching tag when consuming another version.

## Requirements

The current [manifest](package.json) declares:

| Dependency/tool | Requirement |
| --- | --- |
| React Native peer | `0.87.1` |
| Nitro Modules peer | `0.37.1` |
| React peer | `*` (development/example use `19.2.5`) |
| Node | `^22.13.0 \|\| ^24.3.0 \|\| >=26.0.0` |
| Repository package manager | Yarn `4.6.0` |

Use a native React Native application with the **New Architecture**. The current
RN 0.87.1 example is the integration target; other RN/Nitro versions and Old
Architecture are not declared supported by this revision. The Android library
has a default minimum SDK of 24; the host RN/toolchain can impose stricter
requirements. The iOS podspec uses React Native's `min_ios_version_supported`.
A podspec visionOS declaration is not visionOS runtime qualification.

Declared peers are distinct from tested configurations. Physical QA covers
specific Android/iPhone artifacts and scenarios, with gaps documented in
[PHYSICAL_QA.md](PHYSICAL_QA.md#qualification-boundaries). It does not establish
compatibility with every device, OS version, power mode or store distribution.

## Installation

Install the package and its pinned Nitro runtime peer in a React Native `0.87.1` app:

```sh
npm install react-native-nitro-bg-timer-plus@0.4.0 react-native-nitro-modules@0.37.1
# Or:
yarn add react-native-nitro-bg-timer-plus@0.4.0 react-native-nitro-modules@0.37.1
```

For a local package build, replace the package spec with the generated
`react-native-nitro-bg-timer-plus-0.4.0.tgz` path. See
[contributor package checks](CONTRIBUTING.md#checks-by-change-type).

Autolinking includes the native library and generated Nitro bindings. Consumers
do not run Nitrogen or manually register the package. Rebuild your native app
after installation; restarting Metro alone cannot load a new native module.
For iOS, install Pods using your application's Ruby/Bundler environment:

```sh
cd ios
bundle exec pod install
```

If your app does not use Bundler, use its established CocoaPods workflow. See
[Nitro installation](https://github.com/margelo/nitro/blob/main/docs/docs/resources/for-library-users.md).
The base iOS timer mechanism needs no `UIBackgroundModes` entry.

On Android, the library manifest merges `WAKE_LOCK`, `FOREGROUND_SERVICE`,
`FOREGROUND_SERVICE_SPECIAL_USE`, `POST_NOTIFICATIONS`, and a non-exported
`specialUse` service into the app. Review the merged manifest for your build.
Your app owns the Android 13+ notification permission request; the library
does not display that permission dialog itself. See [Android background mode](#android-background-mode).

## Quick start

```ts
import { BackgroundTimer } from 'react-native-nitro-bg-timer-plus'

const timeoutId = BackgroundTimer.setTimeout(() => {
  console.log('Timeout delivered')
}, 5000)

const intervalId = BackgroundTimer.setInterval(() => {
  console.log('Interval delivered')
}, 1000)

// Call when this feature finishes, before a pending callback is needed:
function cleanupTimers(): void {
  BackgroundTimer.clearTimeout(timeoutId)
  BackgroundTimer.clearInterval(intervalId)
}
```

In a React component, clear the timers created by that effect:

```ts
import { useEffect } from 'react'
import { BackgroundTimer } from 'react-native-nitro-bg-timer-plus'

export function useTimerLog(): void {
  useEffect(() => {
    const timeout = BackgroundTimer.setTimeout(() => console.log('Once'), 5000)
    const interval = BackgroundTimer.setInterval(() => console.log('Tick'), 1000)
    return () => {
      BackgroundTimer.clearTimeout(timeout)
      BackgroundTimer.clearInterval(interval)
    }
  }, [])
}
```

The exported `BackgroundTimer` is a shared wrapper, not a per-component instance.
Use clear methods for ordinary feature cleanup. `dispose()` permanently ends the
whole wrapper's lifetime and affects every feature using it.

## API reference

Import the named `BackgroundTimer` export. All durations are milliseconds.
All methods other than scheduling return `void`, not a Promise or a service
success receipt. Native setup/interop errors can propagate; a scheduling ID
acknowledges the wrapper call, not OS permission to execute in background.

### `setTimeout(callback: () => void, duration: number): number`

Registers a callback and returns its numeric ID. `callback` must be a function
(`TypeError` otherwise); `duration` must be a finite, nonnegative number
(`RangeError` otherwise). A disposed wrapper throws `Error` before validation.
If native registration throws synchronously, the callback registration is rolled
back and that error is rethrown (F9).

Android posts to its worker using `duration.toLong()` milliseconds, truncating
fractional values. iOS uses a main-run-loop `Timer` with `duration / 1000`
seconds. Zero is accepted; neither platform guarantees immediate delivery.
A delivered timeout is removed even if its callback throws.

### `clearTimeout(id: number): void`

Pass the ID returned by `setTimeout`. Removes its JS callback and requests native
cancellation/queued-event removal on Android or iOS. Repeating a clear or clearing
an unknown ID is harmless for normal numeric IDs. The wrapper does not validate
IDs; do not pass arbitrary values. After wrapper disposal this is a silent no-op.
Cancellation cannot interrupt a callback already executing.

### `setInterval(callback: () => void, interval: number): number`

Registers a recurring callback and returns its numeric ID. Validation, disposed
errors and synchronous registration rollback match `setTimeout`.

Both platforms apply a **1 ms native minimum** to interval values below 1 ms,
including zero (F10). For values at or above 1 ms, Android truncates to whole
milliseconds; iOS retains the fractional millisecond value. For example, `1.5`
uses 1 ms on Android and 1.5 ms on iOS. This is a scheduling floor, not a guarantee
of 1 ms precision. Timeout scheduling does not use this interval floor.
Intervals coalesce pending native events; missed ticks are not an elapsed-time
counter. Clear an interval explicitly, including after a callback error.

### `clearInterval(id: number): void`

Pass the ID returned by `setInterval`. Removes its JS callback and requests
native cancellation/queued-event removal on both platforms. Repeated or unknown
numeric IDs are harmless; IDs have no wrapper validation. Silent no-op after
disposal. Cannot preempt a running callback.

### `dispose(): void`

Idempotently marks the wrapper disposed, clears callback maps, removes its event
subscription and invokes native disposal. Android cleanup releases this owner's
FGS demand and wake lock, clears work and queues, and terminates its worker.
iOS dispatches cleanup to the main queue, invalidates timers, removes its observer
and ends its background task. Return from this method is not a synchronous
cross-platform resource-settlement receipt.

After disposal, `setTimeout`, `setInterval`, `configure` and
`startBackgroundMode` throw `Error`; clear methods, `stopBackgroundMode` and
repeated `dispose` are no-ops. There is no public reset/reinitialize method.
A fresh runtime/application can create a fresh wrapper. Android process-wide
FGS opt-out is a separate lifetime described below.

### `configure(config: BackgroundTimerConfig): void`

```ts
interface BackgroundTimerNotificationConfig {
  title?: string
  text?: string
  channelId?: string
  channelName?: string
  iconResourceName?: string
}
interface BackgroundTimerConfig {
  notification?: BackgroundTimerNotificationConfig
}
```

These types are exported. All notification fields are optional. Defaults are
`Background Timer Active`, `Tap to return to the app`, `nitro_bg_timer_channel`,
and `Background Timer` respectively. `iconResourceName` names an app drawable;
missing/unresolved icons fall back to the launcher icon, then a system icon.

Android rejects configuration while **that owner** has an explicit request or
uncleared accepted/pending/active timers. Clear all its timers and stop its
explicit request first. IDs marked pending-clear no longer block configuration,
so immediate clear → configure → schedule is supported. New sessions snapshot
the current config (F5). Empty/missing notification fields use defaults.
This is not a live-edit API for an active session.

On iOS the native operation is a no-op. The JS wrapper still serializes the
argument with `JSON.stringify(config ?? {})` on both platforms; non-serializable
input can throw. Both platforms throw `Error` if the wrapper is disposed.
Android native gating errors propagate to JS; malformed raw JSON is logged and
ignored by native code, not exposed as a supported input contract.

### `startBackgroundMode(): void`

Android requests an explicit service hold, including when there are no timers.
Repeated calls while pending/active do not add holds. A later request can retry
a recoverable failed start. When process opt-out has succeeded, native start is
a no-op. iOS: native no-op; it does not extend the background-task budget.
Both platforms throw `Error` if the wrapper is disposed.

### `stopBackgroundMode(): void`

Android releases this owner's explicit hold. Active timers retain implicit demand;
other owners can also retain the shared service. Repeated calls and calls after
wrapper disposal are no-ops. iOS: no-op. It does not cancel timers.

### `disableForegroundService(): void`

Android process-wide, irreversible opt-out (F6). The **first** successful call
must precede any timer acceptance or explicit background request across every
native owner in the process. A first call after such use throws, even when those
timers have finished. After successful opt-out, repeated calls are no-ops,
including with active wake-lock-only timers. It survives new HybridObjects and
RN runtime reloads; only a fresh process without opt-out can enable FGS again.

iOS: no-op. Unlike configure/start, the wrapper has no disposed guard for this
method: it always forwards to the native object. Android's native implementation
ignores it on a disposed object. Do not rely on raw Nitro access after disposal;
make opt-out decisions at process startup.

### Low-level export

`NitroBackgroundTimer` is also exported: the raw HybridObject backing the wrapper.
Its spec accepts numeric IDs plus durations, has the Android configuration method
`configure(configJson: string)`, the background-mode methods, and
`drainFiredTimers(): FiredTimerEvent[]`. Events contain `id`, `type` (timeout 0,
interval 1) and `sequence`; `dispose()` is inherited from Nitro's HybridObject.
It has no application callback registry or wrapper validation. The event types
are defined in [the spec](src/specs/NitroBackgroundTimer.nitro.ts), not re-exported
as named types from the package entry point. Prefer `BackgroundTimer` for apps.
Do not drain its raw object yourself: that can consume events before the wrapper.
Raw Nitro proxies must not be accessed after disposal, including for a second
method lookup. The wrapper's idempotent disposal guard is a separate contract.

## Native event delivery

Native Android runnables / iOS timers append fired events and send a
`NitroBackgroundTimerTimersAvailable` signal through React Native's event emitter.
The JS wrapper drains native events and invokes the callbacks held in its maps.
Nitro calls do not mean application callbacks execute off the JS thread.

F1 replaces the former 1,024-entry eviction behavior with a dynamic queue:
expired timeouts are not intentionally discarded at that old threshold. Memory
is proportional to pending events; this is not a constant-memory queue or a
persistent delivery mechanism. At most one event per interval ID remains pending
until drained. Clear removes callbacks and queued native events; dispose empties
the owner's queue. A blocked JS thread delays application callbacks; a suspended
app or terminated process cannot be promised delivery. The queue records actual
native fires, not every theoretical deadline missed while the OS suspended timers.

A drain continues processing its batch when a callback throws and rethrows the
first thrown value after processing. Timeout callbacks are removed in `finally`;
interval callbacks remain until cleared. Handle application errors inside your
callbacks; the timer is not a universal error boundary. Async callback results
are not awaited, so manage rejected promises and overlapping work yourself.

## Lifecycle and cleanup

| Event | Expected boundary |
| --- | --- |
| Home / Resume | Does not itself dispose timers; execution is subject to OS policy. |
| Android Activity recreation | Preserves timers when the same JS runtime/ReactContext remains alive (F2). |
| Android `ReactHost.reload()` | Replaces the runtime; its TurboModule owner invalidates and disposes registered timer objects (F3). |
| Android `ReactHost.destroy()` | Runtime invalidation uses the same cleanup path; this is distinct from Activity destruction. |
| Fast Refresh | Can retain the runtime; does not prove native teardown. Clear feature timers in effect/unmount cleanup. |
| Explicit `dispose()` | Terminal wrapper cleanup; use only when all users of the singleton are finished. |
| Process termination | OS reclaims process resources; Java/JS/Swift cleanup callbacks are not guaranteed to run. Timers are not persisted. |

The Android owner is tied to the captured ReactContext, not an Activity or a
later global context. Runtime invalidation disposes its objects and waits for old
workers, including manual disposal already in flight, before returning. Cleanup
releases per-owner wake locks and shared-service demand. Dropping a raw JS
reference alone does not terminate a runtime-owned Android worker. GC/finalizers
are fallback mechanisms, not deterministic feature cleanup.

On iOS, explicit disposal and `deinit` invalidate timers and end the background
task. Do not equate Android's runtime-owner barrier with an independently observed
iOS private-task teardown barrier.

## Android background mode

Timers request the FGS **when accepted**, including in foreground; it is not
started only after Home. Implicit demand ends when the owner's final timer
finishes/is cleared. Explicit mode holds demand across gaps between timers:

```ts
import { BackgroundTimer } from 'react-native-nitro-bg-timer-plus'

BackgroundTimer.configure({
  notification: {
    title: 'Timer session',
    text: 'A timer session is active',
    channelId: 'timer_sessions',
    channelName: 'Timer sessions',
  },
})
BackgroundTimer.startBackgroundMode()
const timer = BackgroundTimer.setInterval(() => console.log('Tick'), 1000)

function endSession(): void {
  BackgroundTimer.clearInterval(timer)
  BackgroundTimer.stopBackgroundMode()
}
```

Configure before starting and request from a legitimate user-visible context.
Multiple native owners share one service and notification (F8). The earliest
owner still holding demand supplies the notification snapshot. When it leaves,
the earliest remaining owner takes over; disposing one must not stop another's
demand. Wake locks are per owner and tied to timers, not an explicit hold alone.

The coordinator handles pending stop/start races and subsequent configuration
sessions. Notification title/text/icon/channel selection follow current demand;
creating an existing channel does not retroactively change immutable channel
settings or override user choices. See [Android notification channels](https://developer.android.com/develop/ui/compose/notifications/channels).

Recoverable `startForegroundService` refusals reset start state; a subsequent
explicit or timer request can retry (F7). There is no automatic retry loop.
While the process is alive, timers can use the wake-lock fallback. A failed
initial `startForeground` promotion or missed handshake can still cause Android
to terminate the process; catching an exception is not proof of survival.
[Background-start restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)
still apply. The service returns `START_NOT_STICKY`, not a persistence guarantee.

`WAKE_LOCK` is acquired non-reference-counted while timers remain and released
after completion, clear or cleanup. Missing permission/acquisition failures are
logged and timers continue without that protection. A wake lock does not grant
unlimited process or JS execution. FGS does not guarantee exact timing or survival
under every power, memory or OEM policy.

### Notifications and opt-out

On Android 13+, request notification permission through your app's existing flow:

```ts
import { PermissionsAndroid, Platform } from 'react-native'

export async function requestTimerNotificationPermission(): Promise<void> {
  if (Platform.OS === 'android' && Platform.Version >= 33) {
    await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
    )
  }
}
```

Permission denial/notification visibility and successful service promotion are
separate observations. Inspect service state rather than infer it from the shade.

To opt out, call `BackgroundTimer.disableForegroundService()` at startup before
any use, as specified in the API reference. Explicit start then has no effect;
timers continue using the wake-lock path where available. Runtime opt-out does
not remove manifest declarations. If your app intentionally excludes this FGS,
combine startup opt-out with manifest-merger removal of the service. Remove
shared permissions only if no other feature needs them:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools">
  <uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE"
      tools:node="remove" />
  <uses-permission android:name="android.permission.FOREGROUND_SERVICE"
      tools:node="remove" />
  <application>
    <service android:name="com.margelo.nitro.backgroundtimer.NitroBackgroundTimerService"
        tools:node="remove" />
  </application>
</manifest>
```

The bundled service declares `specialUse` with subtype
`continue_user_initiated_background_timer`. Assess your app's actual use case
and distribution requirements; this library and its QA do not establish store
approval. Runtime opt-out alone does not remove that declaration.

## iOS background execution

Native timers use the main run loop in common mode. Scheduling attempts to acquire
`UIApplication.beginBackgroundTask`; the OS may deny or expire it. Expiration
ends the matching identifier, preserves timer state and ignores stale identifiers.
When the app later enters background with active timers and no task, the observer
attempts reacquisition. It does not continuously renew an expired budget.

Suspension can stop both native timer firing and JS callback execution; resume
can allow delivery again. There is no guaranteed expiration duration, infinite
execution, or callback delivery while suspended. Clear/dispose release the task
when appropriate. See Apple's [background-task API](https://developer.apple.com/documentation/uikit/uiapplication/beginbackgroundtask%28withname%3Aexpirationhandler%3A%29).

## Performance and limitations

Choose intervals that match the work, keep callbacks short, and clear them when
finished. Frequent intervals, pending timeout backlogs and Android wake locks
consume CPU, memory and battery. Use monotonic elapsed time for duration logic
rather than equating interval callback counts with elapsed seconds.

No real-time precision, universal drift percentage, unlimited background window,
process-kill delivery, or multi-OEM guarantee is made. Physical QA results identify
specific artifacts and scenarios; a host/Jest PASS is not device qualification.
The 1,500-event backlog test uses a raw adapter, not the wrapper's full automatic
path. See [qualification boundaries](PHYSICAL_QA.md#qualification-boundaries).

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Native module / HybridObject unavailable | Match the installed RN/Nitro peers, install iOS Pods, verify autolinking and rebuild the native app. Use a native New Architecture build, not a JS-only runtime. |
| No callback | Check whether the ID was cleared or the shared wrapper disposed, whether JS is blocked, and whether the process/runtime changed. Use example smoke logs to separate URL delivery, event signals, drains and callbacks. |
| Android background delays | Inspect current timer service and UID-owned wake lock, start-refusal logs, opt-out state and OS power policy. A worker or wake lock alone does not prove JS delivery. |
| Android notification missing | Check app permission, channel/user settings and current service state separately. Confirm configure ran before active demand and the drawable exists. |
| Android start refusal | Follow permitted foreground-service start conditions; retry through a later legitimate request. Do not disable OS protections to force a PASS. |
| Configure throws | Clear all this owner's timers and release its explicit hold; other owners may still supply the shared notification. |
| Disposed error | Use clear for feature cleanup. Restart the app/runtime for a new wrapper; there is no reset API. FGS opt-out additionally requires a fresh process to reverse. |
| iOS timers pause | Check suspension, task denial/expiration, app lifecycle and process death. Test resume/re-entry; adding unrelated background modes does not grant unlimited execution. |
| Physical QA refuses preflight | Read the historical baseline/hash gate in PHYSICAL_QA.md before attempting device runs. |

Android native logs use tag `NitroBgTimer`; iOS logs use `[NitroBgTimer]`.
Debug builds include additional debug messages; there is no public debug-toggle
API. Example-only smoke/QA bridges are diagnostics, not library methods.

## Development and navigation

- [Testing and manual qualification](TESTING.md)
- [Physical QA runner, evidence and limits](PHYSICAL_QA.md)
- [Contributing](CONTRIBUTING.md)
- [Example app](example/README.md)
- [Changelog](CHANGELOG.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)

## Credits and acknowledgements

The original library is by [Thành Công](https://github.com/tconns):
[react-native-nitro-bg-timer](https://github.com/tconns/react-native-nitro-bg-timer).
This fork is an independent continuation, not an official upstream release.
Historical contributions and release records are retained.

Thanks to [Nitro Modules](https://github.com/margelo/nitro),
[react-native-background-timer](https://github.com/ocetnik/react-native-background-timer)
and [react-native-background-job](https://github.com/vikeri/react-native-background-job)
for the architecture, timer concepts and background-processing patterns.

## License

[MIT](LICENSE). Copyright 2025 Thành Công (original author) and 2026 Marco Crupi
(fork maintainer), as recorded in the unchanged license file.
