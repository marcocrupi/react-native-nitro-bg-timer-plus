# react-native-nitro-bg-timer-plus

> A maintained fork of [react-native-nitro-bg-timer](https://github.com/tconns/react-native-nitro-bg-timer) by [Thành Công](https://github.com/tconns), continued as an independent project.

[![npm version](https://img.shields.io/npm/v/react-native-nitro-bg-timer-plus.svg)](https://www.npmjs.com/package/react-native-nitro-bg-timer-plus)
[![npm downloads](https://img.shields.io/npm/dm/react-native-nitro-bg-timer-plus.svg)](https://www.npmjs.com/package/react-native-nitro-bg-timer-plus)
[![license](https://img.shields.io/npm/l/react-native-nitro-bg-timer-plus.svg)](https://github.com/marcocrupi/react-native-nitro-bg-timer-plus/blob/main/LICENSE)
[![platforms](https://img.shields.io/badge/platforms-iOS%20%7C%20Android-blue.svg)](https://github.com/marcocrupi/react-native-nitro-bg-timer-plus)

Native background timer for React Native built with Nitro Modules.

## Overview

This module provides high-performance timer functionality for React Native
applications that need background-aware `setTimeout` / `setInterval`
behavior. Background execution is implemented with platform-specific native
mechanisms and remains subject to Android and iOS operating-system limits.

## Features

- ⚡ High-performance native implementation using Nitro Modules
- 🎯 Background-safe timers (`setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`)
- 🔄 Background-aware scheduling with platform-specific limits
- 📱 Cross-platform support (iOS & Android)
- 🚀 Zero-bridge overhead with direct native calls
- 🛡️ Three-layer cleanup defense: explicit `dispose()`, automatic Activity lifecycle hooks, GC fallback
- 🎯 Near-zero drift on Android while the foreground service is active (implicit fallback, or explicit `startBackgroundMode` / `stopBackgroundMode` for long sessions)
- 🔔 Customizable persistent notification via `configure()` (title, text, icon, channel)
- 🔒 Thread-safe by design — all native state serialized on a dedicated worker thread (Android) or main queue (iOS)
- 🛡️ Graceful fallback if `WAKE_LOCK` permission is missing — no crash, just a warning
- ✅ 42 unit tests + manual release checklist

## Requirements

- React Native >= 0.76
- Node >= 18
- `react-native-nitro-modules` must be installed (Nitro runtime)

## Installation

```bash
npm install react-native-nitro-bg-timer-plus react-native-nitro-modules
# or
yarn add react-native-nitro-bg-timer-plus react-native-nitro-modules
```

## Upgrading from 0.2.0

If you are upgrading an existing project from `0.2.0`, your code
continues to work without modification — no breaking API changes. You
will, however, notice two new runtime behaviors:

1. **A persistent notification appears while timers are active in
   background.** This is the foreground service used for near-zero
   drift while Android allows it to run. See
   [Background Mode (Android)](#background-mode-android).

2. **On Android 13+, you must request the `POST_NOTIFICATIONS`
   runtime permission** for the persistent notification to appear.
   Without it, the notification may be hidden. On newer Android
   versions, `startForeground()` can also fail if the service cannot
   be promoted; in that case the library falls back to wake-lock-only
   mode with less precise background timing. Add a permission request
   to your app's onboarding flow — a ready-to-paste snippet is in the
   [Required permissions](#required-permissions) section.

If you prefer the 0.2.0 behavior (no foreground service, wake-lock-only
background timers with higher drift), call
`BackgroundTimer.disableForegroundService()` once at app startup. For
apps that also want to remove the foreground service declaration from
the merged manifest, pair that runtime opt-out with the manifest removal
documented in [Disabling the foreground service](#disabling-the-foreground-service).

## Platform Configuration

### iOS

No special configuration is required for the library's base iOS behavior.
The module uses `UIApplication.beginBackgroundTask` as a best-effort
mechanism when timers are active. iOS grants only limited background
runtime, and it may expire that task; when expiration fires, the library
ends the expired background task but preserves its internal timer state.
If the app later enters background again with active timers, the library
attempts to acquire a new background task.

This does **not** guarantee infinite background execution on iOS. Actual
timer delivery depends on the runtime iOS allows for the app. No entries
in `UIBackgroundModes` are needed for the base timer behavior described
here.

### Android

The library's manifest declares all the permissions it needs, and they
are merged automatically into your app at build time. You do not need
to add anything to your own `AndroidManifest.xml`:

- `android.permission.WAKE_LOCK`
- `android.permission.FOREGROUND_SERVICE`
- `android.permission.FOREGROUND_SERVICE_SPECIAL_USE` (Android 14+)
- `android.permission.POST_NOTIFICATIONS` (Android 13+)

There is, however, **one thing you should do yourself** if your app
targets Android 13 or later: request the `POST_NOTIFICATIONS` runtime
permission from the user as part of your onboarding flow. Without it,
the persistent notification may be hidden, and on newer Android versions
foreground-service promotion can fail. If that happens, timers continue
through the wake-lock-only fallback, but background drift can be higher
than with an active foreground service.

See the [Background Mode (Android)](#background-mode-android) section
below for the full picture of what the foreground service does, when
it activates, and how to customize it. If you are upgrading from
`0.2.0`, also read the [Upgrading from 0.2.0](#upgrading-from-020)
section.

If `WAKE_LOCK` has been explicitly removed from the merged manifest
(for example via `tools:node="remove"`), the module logs a warning and
runs timers via the handler thread without a wake lock — no crash.

## Quick Usage

```ts
import { BackgroundTimer } from 'react-native-nitro-bg-timer-plus'

// setTimeout - runs once after delay
const timeoutId = BackgroundTimer.setTimeout(() => {
  console.log('This runs after 5 seconds when background execution is allowed!')
}, 5000)

// Clear timeout if needed
BackgroundTimer.clearTimeout(timeoutId)

// setInterval - runs repeatedly
const intervalId = BackgroundTimer.setInterval(() => {
  console.log('This runs every 2 seconds while background execution is allowed!')
}, 2000)

// Clear interval when done
BackgroundTimer.clearInterval(intervalId)
```

### Important — Android background behavior

When a timer is active and your app moves to background, this library
automatically starts a foreground service that keeps your host
process at foreground scheduling priority. While that foreground service
is active, Android background timer drift is near zero on validated stock
devices. Without the service, the library falls back to wake-lock-only
execution and `setInterval` can drift by roughly 10% in background.

The side effect is that your users will see a **persistent notification**
in the notification shade for as long as a timer is running. The
notification appears automatically on the first active timer and
disappears when the last timer completes. You can customize its title,
text, and icon via `BackgroundTimer.configure()`, and you can control
its lifecycle explicitly with `startBackgroundMode()` /
`stopBackgroundMode()` to avoid "blinking" if your app creates many
short consecutive timers.

This behavior is **Android-only**. On iOS, the library uses
`beginBackgroundTask` as a limited, best-effort background execution
mechanism and does not need a foreground service.

See the [Background Mode (Android)](#background-mode-android) section
for details, including how to request the required
`POST_NOTIFICATIONS` runtime permission.

## API Reference

### BackgroundTimer

The main API object providing background-safe timer functionality.

The public `BackgroundTimer` API is unchanged: application code still passes
callbacks to `BackgroundTimer.setTimeout()` and
`BackgroundTimer.setInterval()`, and receives numeric timer IDs for clearing.
Internally, those callbacks stay in the JS wrapper. Native code records fired
timer events in a small queue and emits a signal; the JS wrapper drains that
queue and invokes the matching JS callbacks. The low-level Nitro object and
its `drainFiredTimers()` method are implementation details and are not the
recommended app-facing API.

#### `setTimeout(callback: () => void, duration: number): number`

Creates a timer that calls the callback function after the specified duration.

- **callback**: Function to execute after the timer expires
- **duration**: Time in milliseconds to wait before executing the callback
- **Returns**: Timer ID that can be used with `clearTimeout`

```ts
const id = BackgroundTimer.setTimeout(() => {
  console.log('Timer executed!')
}, 3000)
```

#### `clearTimeout(id: number): void`

Cancels a timeout timer created with `setTimeout`.

- **id**: Timer ID returned from `setTimeout`

```ts
const id = BackgroundTimer.setTimeout(() => {
  console.log('This will not run')
}, 5000)

BackgroundTimer.clearTimeout(id) // Cancel the timer
```

#### `setInterval(callback: () => void, interval: number): number`

Creates a timer that repeatedly calls the callback function at specified intervals.

- **callback**: Function to execute on each interval
- **interval**: Time in milliseconds between each execution
- **Returns**: Timer ID that can be used with `clearInterval`

```ts
const id = BackgroundTimer.setInterval(() => {
  console.log('Repeating timer!')
}, 1000) // Runs every second
```

#### `clearInterval(id: number): void`

Cancels an interval timer created with `setInterval`.

- **id**: Timer ID returned from `setInterval`

```ts
const id = BackgroundTimer.setInterval(() => {
  console.log('This will stop after 10 seconds')
}, 1000)

// Stop the interval after 10 seconds
BackgroundTimer.setTimeout(() => {
  BackgroundTimer.clearInterval(id)
}, 10000)
```

#### `dispose(): void`

Eagerly disposes all native resources held by the background timer (wake
lock / background task, pending runnables, worker thread). Calling `dispose()`
is **not** required for correct cleanup in normal usage — see
[Lifecycle and cleanup](#lifecycle-and-cleanup) below for the full picture.

After calling `dispose()`, the `BackgroundTimer` instance is **permanently
unusable**:

- `setTimeout` / `setInterval` throw an `Error`.
- `clearTimeout` / `clearInterval` are silent no-ops.
- `dispose()` itself is idempotent — calling it twice is safe.

```ts
BackgroundTimer.dispose()
```

## Lifecycle and cleanup

The library handles native resource cleanup through a three-layer defense:

1. **Automatic native lifecycle hooks.**
   - On **Android**, the `HybridObject` registers itself as a
     `LifecycleEventListener` on the active `ReactApplicationContext`. When
     the host Activity is destroyed, `onHostDestroy` fires and the timer
     disposes itself deterministically, releasing the wake lock and
     tearing down the worker thread.
   - On **iOS**, JSI runtime teardown releases the `HybridObject`, whose
     `deinit` invalidates all pending `Timer`s and ends the background task.
2. **Explicit `dispose()`.** Call `BackgroundTimer.dispose()` when you want
   deterministic teardown earlier than the lifecycle hooks — for example,
   inside a feature module's shutdown path, or before navigating away from
   a long-lived screen that owns the timer.
3. **GC fallback.** If neither of the above runs, Kotlin `finalize()` and
   Swift `deinit` act as a safety net and release the wake lock / background
   task when the garbage collector reclaims the instance.

In normal production usage, **you do not need to call `dispose()`
manually** — Activity destroy covers app shutdown. Call it only when you
have a concrete reason to force early release.

`dispose()`, lifecycle cleanup, `clearTimeout`, and `clearInterval`
prevent future callbacks and release native resources, but they cannot
preempt a callback that is already executing or blocked in user code.

### Dev-mode caveat: Fast Refresh / bundle reload

In development, Fast Refresh tears down the JS runtime but keeps the host
Activity alive, so `onHostDestroy` does **not** fire. In that case the old
timer instance relies on Kotlin `finalize()` / Swift `deinit` to release
its wake lock, which is non-deterministic and may leave the lock held
briefly across a reload. If you are debugging long-running background
timers during Fast Refresh cycles and notice a leaked wake lock, call
`BackgroundTimer.dispose()` explicitly from your code before triggering
the reload — or just rely on process restart to reset state. This
limitation does not affect production builds.

## Background Mode (Android)

On Android, background processes are throttled by the `bg_non_interactive`
cgroup, which limits CPU quota and causes `setInterval` / `setTimeout`
ticks to drift by roughly 10% even with a partial wake lock and a
foreground-priority worker thread. To reduce that drift, this library can
run a **foreground service** that keeps the host process at foreground
scheduling priority while timers are active.

The foreground service activates in two modes:

**Implicit (default)** — when the consumer does not call any background
mode API, the service is started automatically on the first active timer
and stopped when the last timer completes. The consumer sees a persistent
notification in the notification shade only while a timer is running.
Existing code written for older versions of this library continues to
work unchanged.

**Explicit (recommended for long sessions)** — for known critical
sessions like a workout, a recording, or a GPS tracking session, call
`startBackgroundMode()` at the start and `stopBackgroundMode()` at the
end. The notification stays stable for the entire session instead of
appearing and disappearing around individual timers.

```ts
import { BackgroundTimer } from 'react-native-nitro-bg-timer-plus'

// At the start of a workout session
BackgroundTimer.startBackgroundMode()

// Schedule timers normally during the session
const restTimerId = BackgroundTimer.setTimeout(() => {
  // rest period over
}, 90_000)

// At the end of the session
BackgroundTimer.stopBackgroundMode()
```

Both methods are idempotent and are **no-ops on iOS**. iOS uses
`beginBackgroundTask` for limited best-effort background runtime; timers
are preserved internally, but continued background execution depends on
the time the system grants. You can write cross-platform code that calls
these methods on both platforms without a platform branch.

### Customizing the notification

Call `configure()` **before** the first timer is accepted/scheduled and
before `startBackgroundMode()` to customize the notification appearance.
All fields are optional — omitted fields fall back to sensible generic
defaults.

```ts
BackgroundTimer.configure({
  notification: {
    title: 'Workout in progress',
    text: 'Tracking your rest timers',
    channelId: 'my_app_workout_channel',
    channelName: 'Workout Tracking',
    iconResourceName: 'ic_workout',
  },
})
```

`configure()` throws if called while explicit background mode is requested
or while any timer is accepted, pending, or active. Call it early in your
app lifecycle (e.g. at startup or right before the user enters the
critical screen), never mid-session.

### Required permissions

The library's own manifest declares everything the foreground service
needs — you do not have to add permissions to your app's manifest for
this to work:

- `android.permission.WAKE_LOCK`
- `android.permission.FOREGROUND_SERVICE`
- `android.permission.FOREGROUND_SERVICE_SPECIAL_USE` (API 34+)
- `android.permission.POST_NOTIFICATIONS` (API 33+)

`POST_NOTIFICATIONS` is a **runtime permission** starting on Android 13,
and your app must request it from the user before the foreground service
notification can appear. The library intentionally does not request this
permission for you — most apps already have a notification permission
flow as part of their onboarding, and silently triggering the system
dialog from a timer library would be surprising.

If the permission is denied, the foreground service notification may be
hidden. On newer Android versions, the service may also fail to enter
foreground; when that happens the library logs the failure and falls back
to wake-lock-only mode. Timers still run, but background drift can be
higher than with an active foreground service. Request the permission
yourself so users can see that a timer is active and Android can promote
the service normally:

```ts
import { PermissionsAndroid, Platform } from 'react-native'

async function ensureNotificationPermission() {
  if (Platform.OS !== 'android') return
  if (typeof Platform.Version === 'number' && Platform.Version >= 33) {
    await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
    )
  }
}
```

### Limitations

- The foreground service uses Android 14's `specialUse` foreground
  service type. There is **no platform-imposed time limit** on how
  long the service can run, but on Android 14+ your app must declare
  the `specialUse` subtype in the Play Console during review (see
  "Play Store review notes" below).
- Aggressive OEM battery savers (Xiaomi, Huawei, Oppo, Samsung with
  restrictive power management profiles, etc.) may still kill
  background services regardless of foreground service type. Ask
  users to whitelist your app in the device battery optimization
  settings.
- If Android refuses `startForegroundService()` / `startForeground()`, or
  if the service is removed from the merged manifest without the runtime
  opt-out, the library logs the failure and continues with wake-lock-only
  timing. There is no automatic retry loop or backoff; the next timer or
  explicit background-mode request can attempt to start the service again.
- iOS is unaffected: `startBackgroundMode`, `stopBackgroundMode`, and
  `configure` are no-ops on iOS. iOS uses `beginBackgroundTask` as a
  limited best-effort mechanism, not as an unlimited background mode.

### Play Store review notes

Android 14 (API 34) introduced stricter declarations for foreground
service types. Apps that declare `specialUse` must justify it in the
Play Console during the review process, in the "Foreground service"
section of the app content declaration.

The library's foreground service is declared with the subtype
`continue_user_initiated_background_timer`. When submitting your app
to Play Store, paste the following justification in the FGS
declaration form (or adapt it to your app's specific use case):

> This app uses a foreground service of type `specialUse` to keep a
> user-initiated background timer running with accurate scheduling
> while the app is in the background. The service is started only
> after the user explicitly initiates a timer (e.g. starting a
> workout, a recording, or a tracking session). The service is
> stopped automatically when the timer completes or when the user
> cancels it. The use case does not fit other FGS types:
>
> - `mediaPlayback`: not playing media
> - `location`: not tracking location
> - `dataSync`: not synchronizing data with a server or device
> - `health`: not specifically a health/fitness measurement
> - `shortService`: timer duration is variable and may exceed the
>   ~3 minute shortService limit
>
> Therefore `specialUse` is the appropriate type per Android's
> documentation, which defines it as the catch-all for legitimate
> FGS use cases that don't fit other typed categories.

If your app does not need lower-drift background timer scheduling, you
can opt out of the foreground service entirely — see the
[Disabling the foreground service](#disabling-the-foreground-service)
section below.

### Disabling the foreground service

If your app does not need lower-drift background timer scheduling, or
if you already have your own foreground service (for media playback,
location tracking, or another purpose) and don't want a second one
from this library, you can opt out of the foreground service
entirely.

There are **two levels of opt-out**, and which one you need depends
on whether you want to avoid the Play Store review friction.

#### Level 1 — Runtime opt-out (simple, keeps Play Store friction)

Call `BackgroundTimer.disableForegroundService()` once at app startup,
before any timer is accepted/scheduled and before `startBackgroundMode()`:

```ts
import { BackgroundTimer } from 'react-native-nitro-bg-timer-plus'

// At the top of your app's entry point, BEFORE any timer is scheduled
BackgroundTimer.disableForegroundService()
```

What this does:

- The foreground service is never started, implicitly or explicitly
- `startBackgroundMode()` becomes a no-op (with a warning log)
- Timers still run, using only the `PARTIAL_WAKE_LOCK` — background
  timing can drift more than with the foreground service active (similar
  to pre-`0.3.0` behavior)
- No persistent notification appears
- **The `<service>` and `FOREGROUND_SERVICE_SPECIAL_USE` permission
  remain in the merged manifest**, so Play Store review still asks
  for the `specialUse` justification

This is the easy path — one line of code, no manifest surgery. Use
it if you're OK with Play Store friction but just want to disable
the FGS at runtime.

**Important**: `disableForegroundService()` is startup-only. It must be
called before any timer is accepted, pending, or active, and before
`startBackgroundMode()` is called. Calling it later throws an `Error`.
Call it once at app startup, typically in your root component or in your
`index.js` / `App.tsx`.

The call is not reversible within the same process. To re-enable
the foreground service, kill and restart the app without the call.

#### Level 2 — Manifest removal (zero Play Store friction)

If you also want to remove the `<service>` declaration and the
`FOREGROUND_SERVICE_SPECIAL_USE` permission from your final APK
so that Play Store review does not ask you to justify a foreground
service you're not using, add the following to your app's
`android/app/src/main/AndroidManifest.xml`:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools">

    <!-- Opt out of react-native-nitro-bg-timer-plus foreground service -->
    <uses-permission
        android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE"
        tools:node="remove" />
    <uses-permission
        android:name="android.permission.FOREGROUND_SERVICE"
        tools:node="remove" />

    <application>
        <service
            android:name="com.margelo.nitro.backgroundtimer.NitroBackgroundTimerService"
            tools:node="remove" />

        <!-- rest of your application element -->
    </application>
</manifest>
```

Note the `xmlns:tools` namespace declaration on the root `<manifest>`
element — it's required for `tools:node="remove"` to work.

What this does:

- The `<service>` and both `FOREGROUND_SERVICE*` permissions are
  stripped from the merged manifest at build time
- The final APK contains neither the service class declaration nor
  the permissions
- Play Store review does not see the `specialUse` foreground service
  and does not ask you to justify it
- The `POST_NOTIFICATIONS` and `WAKE_LOCK` permissions remain, since
  they're still used by the library for the wake-lock-only fallback

**Important**: if you do manifest removal (Level 2), you should
also do runtime opt-out (Level 1). Without runtime opt-out, the
library will still attempt to call `startForegroundService()`
at runtime, Android will throw because the service class isn't
declared, the library's exception handler will catch it and fall
back to wake-lock-only mode, but you'll see one exception per
timer activation in the logs. Combining both levels gives you a
clean, silent wake-lock-only mode.

Recommended combined setup:

```ts
// src/index.tsx or App.tsx, before any timer
import { BackgroundTimer } from 'react-native-nitro-bg-timer-plus'
BackgroundTimer.disableForegroundService()
```

```xml
<!-- android/app/src/main/AndroidManifest.xml -->
<uses-permission
    android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE"
    tools:node="remove" />
<uses-permission
    android:name="android.permission.FOREGROUND_SERVICE"
    tools:node="remove" />
<service
    android:name="com.margelo.nitro.backgroundtimer.NitroBackgroundTimerService"
    tools:node="remove" />
```

#### Decision matrix

| Scenario | Level 1 (runtime) | Level 2 (manifest) | Play Store review asks about FGS |
| --- | --- | --- | --- |
| Keep FGS as default (near-zero drift while active) | no | no | Yes, must justify `specialUse` |
| Disable FGS in one specific build variant | yes | no | Yes (manifest still has it) |
| App already has its own FGS (notifee, etc.) | yes | yes | No |
| Accept ~10% drift, want zero friction | yes | yes | No |
| Foreground-only app (never backgrounds) | yes | yes | No |

## Real-world Examples

### Basic Timer Usage

```ts
import React, { useEffect, useState } from 'react'
import { View, Text, Button } from 'react-native'
import { BackgroundTimer } from 'react-native-nitro-bg-timer-plus'

const TimerExample = () => {
  const [seconds, setSeconds] = useState(0)
  const [intervalId, setIntervalId] = useState<number | null>(null)

  const startTimer = () => {
    const id = BackgroundTimer.setInterval(() => {
      setSeconds(prev => prev + 1)
    }, 1000)
    setIntervalId(id)
  }

  const stopTimer = () => {
    if (intervalId) {
      BackgroundTimer.clearInterval(intervalId)
      setIntervalId(null)
    }
  }

  const resetTimer = () => {
    stopTimer()
    setSeconds(0)
  }

  useEffect(() => {
    return () => {
      if (intervalId) {
        BackgroundTimer.clearInterval(intervalId)
      }
    }
  }, [intervalId])

  return (
    <View style={{ padding: 20 }}>
      <Text style={{ fontSize: 24, textAlign: 'center' }}>
        Timer: {seconds}s
      </Text>
      <Button title="Start" onPress={startTimer} disabled={!!intervalId} />
      <Button title="Stop" onPress={stopTimer} disabled={!intervalId} />
      <Button title="Reset" onPress={resetTimer} />
    </View>
  )
}
```

### Background Task Simulation

```ts
import { BackgroundTimer } from 'react-native-nitro-bg-timer-plus'

class BackgroundTaskManager {
  private taskId: number | null = null

  startPeriodicSync(interval: number = 30000) { // 30 seconds
    this.taskId = BackgroundTimer.setInterval(() => {
      this.performBackgroundSync()
    }, interval)
  }

  stopPeriodicSync() {
    if (this.taskId) {
      BackgroundTimer.clearInterval(this.taskId)
      this.taskId = null
    }
  }

  private async performBackgroundSync() {
    try {
      // Simulate API call or data processing
      console.log('Performing background sync...', new Date().toISOString())
      
      // Your background logic here
      // await syncDataWithServer()
      // await processLocalData()
      
    } catch (error) {
      console.error('Background sync failed:', error)
    }
  }

  scheduleDelayedTask(delay: number, task: () => void) {
    return BackgroundTimer.setTimeout(task, delay)
  }
}

// Usage
const taskManager = new BackgroundTaskManager()

// Start periodic background sync
taskManager.startPeriodicSync(60000) // Every minute

// Schedule a one-time delayed task
taskManager.scheduleDelayedTask(5000, () => {
  console.log('Delayed task executed!')
})
```

### React Hook for Background Timers

```ts
import { useEffect, useRef, useCallback } from 'react'
import { BackgroundTimer } from 'react-native-nitro-bg-timer-plus'

export const useBackgroundTimer = (
  callback: () => void,
  interval: number,
  immediate: boolean = false
) => {
  const intervalRef = useRef<number | null>(null)
  const savedCallback = useRef(callback)

  // Remember the latest callback
  useEffect(() => {
    savedCallback.current = callback
  }, [callback])

  const start = useCallback(() => {
    if (intervalRef.current) return // Already running

    if (immediate) {
      savedCallback.current()
    }

    intervalRef.current = BackgroundTimer.setInterval(() => {
      savedCallback.current()
    }, interval)
  }, [interval, immediate])

  const stop = useCallback(() => {
    if (intervalRef.current) {
      BackgroundTimer.clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  const restart = useCallback(() => {
    stop()
    start()
  }, [stop, start])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stop()
    }
  }, [stop])

  return { start, stop, restart, isRunning: !!intervalRef.current }
}

// Usage in component
const MyComponent = () => {
  const { start, stop, isRunning } = useBackgroundTimer(
    () => console.log('Background task executed!'),
    5000, // 5 seconds
    true  // Run immediately
  )

  return (
    <View>
      <Button 
        title={isRunning ? "Stop Timer" : "Start Timer"} 
        onPress={isRunning ? stop : start} 
      />
    </View>
  )
}
```

## Best Practices

### Memory Management

Always clean up timers to prevent memory leaks:

```ts
useEffect(() => {
  const timers: number[] = []

  // Store timer IDs
  timers.push(BackgroundTimer.setInterval(() => {
    // Your logic
  }, 1000))

  timers.push(BackgroundTimer.setTimeout(() => {
    // Your logic
  }, 5000))

  // Cleanup function
  return () => {
    timers.forEach(id => {
      BackgroundTimer.clearInterval(id)
      BackgroundTimer.clearTimeout(id)
    })
  }
}, [])
```

### Performance Considerations

- Use appropriate intervals - avoid too frequent executions
- Consider batching operations in timer callbacks
- Be mindful of battery usage on mobile devices

```ts
// Good: Batch multiple operations
BackgroundTimer.setInterval(() => {
  performDataSync()
  updateLocalCache()
  checkNotifications()
}, 30000) // Every 30 seconds

// Avoid: Multiple frequent timers
// BackgroundTimer.setInterval(performDataSync, 5000)
// BackgroundTimer.setInterval(updateLocalCache, 3000)
// BackgroundTimer.setInterval(checkNotifications, 7000)
```

### Error Handling

Timer callbacks should handle their own errors. Native timer delivery does
not retain or invoke JS callback functions directly; native code only records
fired timer events and signals JS to drain them. User callbacks then run from
the JS `BackgroundTimer` wrapper. A thrown timeout callback is removed from
the JS callback map in a cleanup path before the error is rethrown; interval
callbacks remain registered until you clear them. Treat the library as a
timer delivery mechanism, not as a universal error boundary for application
callback failures.

```ts
BackgroundTimer.setInterval(() => {
  try {
    performRiskyOperation()
  } catch (error) {
    console.error('Timer callback failed:', error)
    // Handle error appropriately
  }
}, 10000)
```

## Platform Support

### Android Implementation Details

- Background execution via `PowerManager.PARTIAL_WAKE_LOCK`
  (non-reference-counted, held explicitly for the lifetime of all active
  timers).
- All state mutations serialized on a dedicated `HandlerThread` to eliminate
  race conditions between `setTimeout`/`clearTimeout` concurrent callers.
- Timer fire delivery is callback-free at the native spec boundary: the
  worker thread records fired timer IDs in a native queue and emits a React
  Native event so the JS wrapper can drain and execute callbacks.
- The `HybridObject` registers itself as a `LifecycleEventListener` on the
  `ReactApplicationContext`, so Activity destroy triggers deterministic
  cleanup in both Bridge and Bridgeless modes.
- Graceful fallback: if `WAKE_LOCK` permission is missing or revoked, the
  module logs a warning and runs timers without the wake lock instead of
  crashing.
- Foreground-service failures are logged and fall back to wake-lock-only
  timing instead of crashing the app.
- Foreground-service stop requests that arrive while a start is still
  `STARTING` are deferred until the service has called `startForeground()`,
  avoiding Android's foreground-service start timeout race.

### iOS Implementation Details

- Background execution via `UIApplication.beginBackgroundTask` as a
  best-effort, time-limited mechanism. The expiration handler bounces to
  the main queue, releases the expired task identifier, and preserves timer
  state for future best-effort reacquire on background re-entry.
- Main-thread serialization of all timer state via `DispatchQueue.main.async`
  eliminates cross-thread races.
- Timer fire delivery records native fired events and signals the JS wrapper
  to drain them, avoiding generated callback wrappers for timer fire delivery.
- `deinit` acts as a GC fallback when JS never calls `dispose()`.

## Troubleshooting

### Common Issues

### Issue Resolution

#### Timers stop working in background (Android)

- The `WAKE_LOCK`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`,
  and `POST_NOTIFICATIONS` permissions are all declared by the library
  manifest and merged automatically — no action needed unless you have
  explicitly removed them.
- On Android 13+, verify that your app has requested the
  `POST_NOTIFICATIONS` runtime permission. If the permission is denied,
  the notification may be hidden, and on newer Android versions
  foreground-service promotion can fail. In that fallback path, timers
  continue with wake-lock-only timing and may drift more in background.
- Aggressive OEM battery savers (Xiaomi, Huawei, Oppo, etc.) may still
  kill foreground services regardless of the above. Ask the user to
  whitelist your app in the device battery optimization settings.
- The library uses Android 14's `specialUse` foreground service type,
  which has no platform-imposed time limit. If your timer still gets
  killed, the cause is almost always an aggressive OEM battery saver
  (see above) — Android itself will not terminate a `specialUse`
  foreground service based on duration alone.

#### Timers not firing on iOS

- Test on a physical device; simulator and device behavior can differ.
- Remember that `beginBackgroundTask` grants limited runtime only. If the
  background task expires, the library preserves timer state but iOS may
  suspend further execution until the app is foregrounded or allowed to
  run again.
- Check Xcode logs for
  `[NitroBgTimer] warn: Background task expiration handler fired`.
- Verify the app was not terminated by the system watchdog or by memory
  pressure.

#### Memory leaks

- Always clear timers when components unmount
- Use cleanup functions in useEffect hooks
- Monitor timer IDs and clean them appropriately

### Debug Mode

You can enable debug logging to troubleshoot timer issues:

```ts
// Enable debug mode (if supported by the native implementation)
if (__DEV__) {
  console.log('Timer created with ID:', timerId)
}
```

## Migration Guide

### From JavaScript timers

```ts
// Before (standard JavaScript timers)
const timeoutId = setTimeout(() => {
  console.log('This might not work in background')
}, 5000)

const intervalId = setInterval(() => {
  console.log('This will pause in background')
}, 1000)

// After (BackgroundTimer)
const timeoutId = BackgroundTimer.setTimeout(() => {
  console.log('This runs when background execution is allowed!')
}, 5000)

const intervalId = BackgroundTimer.setInterval(() => {
  console.log('This continues while background execution is allowed!')
}, 1000)
```

### From other background timer libraries

The API is designed to be a drop-in replacement for most background timer libraries:

```ts
// Just replace the import
import { BackgroundTimer } from 'react-native-nitro-bg-timer-plus'
// The rest of your code should work the same
```

## Example App

Clone the repo and run:

```bash
yarn install
yarn example:ios    # or yarn example:android
```

The example app exercises all library use cases including background timer validation, concurrent timers, cleanup verification, and stress testing.

## Contributing

See `CONTRIBUTING.md` for contribution workflow.

When updating spec files in `src/specs/*.nitro.ts`, regenerate Nitro artifacts:

```bash
yarn nitrogen
```

## Project Structure

- `android/` — Native Android implementation (Kotlin/Java)
- `ios/` — Native iOS implementation (Swift/Objective-C)
- `src/` — TypeScript source code and exports
- `nitrogen/` — Generated Nitro artifacts (auto-generated)
- `lib/` — Compiled JavaScript output

## Acknowledgements

Special thanks to the following projects that inspired this library:

- [mrousavy/nitro](https://github.com/mrousavy/nitro) – Nitro Modules architecture
- [react-native-background-timer](https://github.com/ocetnik/react-native-background-timer) – Background timer concepts
- [react-native-background-job](https://github.com/vikeri/react-native-background-job) – Background processing patterns

## License

MIT © 2026 [Marco Crupi](https://github.com/marcocrupi) — react-native-nitro-bg-timer-plus fork
MIT © 2025 [Thành Công](https://github.com/tconns) — original react-native-nitro-bg-timer

This project is a fork of [react-native-nitro-bg-timer](https://github.com/tconns/react-native-nitro-bg-timer) and continues under the same MIT license.
