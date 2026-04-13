# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`BackgroundTimer.disableForegroundService()` API** — new opt-out method for consumers who don't need accurate background timers or already have their own foreground service (notifee, media playback, location tracking, etc.). Must be called before any timer is scheduled and before `startBackgroundMode()`; throws `IllegalStateException` (mapped to JS `Error`) if called late. Not reversible within the same process. Idempotent. Wake-lock path continues to run — timers still fire, just with ~10% drift in background instead of foreground-priority accuracy. No-op on iOS (iOS has no foreground service concept and achieves background accuracy natively via `beginBackgroundTask`). See the new "Disabling the foreground service" README section for full semantics, including how to pair the runtime opt-out with `tools:node="remove"` manifest entries in the consumer app to strip the `<service>` declaration and the `FOREGROUND_SERVICE_SPECIAL_USE` permission from the merged manifest and eliminate the Play Store `specialUse` review friction entirely.

### Changed

- **Android foreground service type changed from `shortService` to `specialUse`.** The 0.3.0 release used `shortService`, which Android terminates with an ANR after ~3 minutes (the actual platform contract — the "3 hour" claim in 0.3.0 docs was incorrect). `specialUse` has no platform-imposed timeout and is the correct semantic category for a user-initiated background timer of arbitrary duration. **Consumers inherit the `FOREGROUND_SERVICE_SPECIAL_USE` permission instead of `FOREGROUND_SERVICE_SHORT_SERVICE` via manifest merge.** During Play Store review, consumers must justify the `specialUse` declaration — see the "Play Store review notes" section in the README for a ready-to-paste justification paragraph.

### Fixed

- **Critical: example app no longer ANRs after ~3 minutes of background timer activity.** Caused by the `shortService` foreground service type timeout (see Changed above). Confirmed empirically on Pixel 9 Pro XL Android stock with the system logging `Short FGS ANR'ed` followed by `ANR in com.nitrobgtimerexample / Reason: A foreground service of FOREGROUND_SERVICE_TYPE_SHORT_SERVICE did not stop within a timeout`. Fix: switch to `specialUse` foreground service type, which has no platform-imposed timeout.
- **Documentation correction for 0.3.0**: README, CHANGELOG, KDoc, and TESTING.md previously stated a "3 hour cumulative cap" for the `shortService` foreground service type. The actual platform contract is approximately 3 minutes. The 3-hour claim was based on misreading the Android 14 documentation during B9 design. All references corrected in this release.

### Removed

### Security

## [0.3.0] - 2026-04-12

> **Correction (post-release)**: this release's claim that the `shortService` foreground service type has a "3 hour cumulative cap" is **incorrect**. The actual platform contract is approximately 3 minutes. Apps using 0.3.0 will hit an ANR after ~3 minutes of an active background timer. **Upgrade to the next release immediately.** The fix switches the foreground service type from `shortService` to `specialUse`, which has no platform-imposed timeout.

### Added

- `BackgroundTimer.startBackgroundMode()` and `BackgroundTimer.stopBackgroundMode()` — explicit opt-in APIs for Android foreground service control. While active, the library starts a `shortService` foreground service that keeps the host process at foreground scheduling priority, eliminating the ~10% residual `setInterval` drift observed in background after the B8 scheduling fixes. Recommended for known critical sessions (workouts, recordings, GPS tracking) where a stable notification is preferable to the implicit-fallback blink. iOS: no-op (iOS already achieves 100% background accuracy natively via `beginBackgroundTask` after the B8 step 1 fix in commit `06eaa066`).
- `BackgroundTimer.configure(config)` API with `BackgroundTimerConfig` / `BackgroundTimerNotificationConfig` TypeScript interfaces. Customises the Android foreground service notification (title, text, channel id, channel name, icon drawable resource name). All fields are optional; omitted fields fall back to sensible defaults. Must be called before a background-mode session is active — throws `IllegalStateException` if called while explicit mode is requested or any timer is currently holding the implicit fallback alive. iOS: no-op.
- **Implicit foreground service fallback** — if the consumer never calls `startBackgroundMode()`, the foreground service starts automatically on the first active timer and stops when the last timer completes. Existing `0.2.0` code continues to work unchanged; the only user-visible change is a persistent notification while timers are active in background.
- New permissions declared in the library's own `AndroidManifest.xml` so consumers do not have to add anything to their app manifest: `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SHORT_SERVICE` (API 34+), `POST_NOTIFICATIONS` (API 33+). `WAKE_LOCK` remains as in `0.2.0`.
- `NitroBackgroundTimerService.kt` — new internal `shortService` foreground service with `NotificationCompat.Builder` notification, `IMPORTANCE_LOW` channel, tap-to-return `PendingIntent`, and a three-tier icon resolution fallback (custom drawable → app launcher icon → system info icon). Handles `ForegroundServiceStartNotAllowedException` (API 31+) and `ForegroundServiceDidNotStartInTimeException` (API 34+) gracefully by stopping self cleanly and letting the wake-lock-only fallback stay in effect.
- New README section "Background Mode (Android)" covering the implicit/explicit activation modes, notification customisation, required permissions, the `POST_NOTIFICATIONS` runtime permission flow (with a ready-to-paste `PermissionsAndroid` snippet for RN 0.84+), and known limitations (3-hour `shortService` cumulative cap, iOS no-op).
- New manual test scenarios in `TESTING.md` (A10–A14) covering implicit activation, explicit mode stability across timers, notification customisation, the B9 accuracy regression gate, and the `POST_NOTIFICATIONS`-denied graceful fallback.
- New example app controls in Background Test 3 — "Start BG Mode" / "Stop BG Mode" / "Configure Notification" — mapped 1:1 to the A10–A14 scenarios.
- 10 new Jest tests (39 total, up from 29) in a new `BackgroundTimer — background mode lifecycle` describe block, locking in the forwarding contract, dispose interaction, the semantic `configure` gate, and the `configure`-after-fireTimer path.

### Changed

- **Background timer accuracy on Android: from ~10% drift down to effectively 0%** when the foreground service is active. Validated empirically on Pixel 9 Pro XL Android stock with Background Test 3 over 90 seconds in background with screen off: Native = Expected = 97, fire count = 97, effective interval = 1004.3 ms, thread priority = -2. The foreground service composes cleanly with the B8 step 3 `HandlerThread` FOREGROUND priority fix — the thread-level priority alone could not close the last 10% because the process-level `bg_non_interactive` cgroup capped total CPU quota.

### Removed

- Diagnostic telemetry introduced in B8 step 2 (commit `bc8e07a`): the `getDebugTelemetry()` method on the HybridObject spec, the `debugFireCount` / `debugFirstFireUptime` / `debugLastFireUptime` fields and the uptime-stamping block in the Android interval Runnable, the iOS placeholder stub, the JS wrapper, and the "Show Diagnostic" button in the example app. The instrumentation served its diagnostic purpose during B8 and B9 development and is no longer needed now that the fix is validated on device.

### Notes

- This release introduces new optional permissions declared in the library manifest. Consumers upgrading from `0.2.0` will see a persistent notification when timers are active in background unless they do not schedule any timers. Existing code continues to work without modification — the implicit fallback handles backward compatibility automatically.
- Consumer apps targeting Android 13+ (API 33) should request the `POST_NOTIFICATIONS` runtime permission as part of their onboarding flow. See the README "Background Mode (Android)" section for details. Without the permission the foreground service still starts but the notification does not appear, and on Android 14+ the system may terminate the service within ~10 seconds.
- The `shortService` foreground service type caps cumulative duration at 3 hours per the Android 14 platform contract. For timers that need to run longer than 3 hours, consumers should use `AlarmManager` or `WorkManager` at the application level instead.

## [0.2.0] - 2026-04-12

### Added

- Example app with 7 test sections (SetTimeout, SetInterval, Background, Concurrent, Cleanup, Hook, Stress)
- `useBackgroundTimer` custom hook in example app
- `eslint`, `prettier`, `eslint-config-prettier` as direct devDependencies (were previously unresolved peer requirements)
- `engines.node >= 18` in root `package.json`
- `BackgroundTimer.dispose()` API to eagerly release native resources (wake lock, background task, pending runnables, worker thread). Calling `dispose()` is optional — see "Lifecycle and cleanup" in the README. After dispose, the instance is permanently unusable.
- Input validation on `setTimeout` / `setInterval`: `callback` must be a function, `duration` / `interval` must be a non-negative finite number. Invalid inputs throw `TypeError` / `RangeError` immediately, with no side effects on internal state.
- `android.permission.WAKE_LOCK` is now declared in the library's own `AndroidManifest.xml` and merged automatically into the consuming app — no manual setup required by the consumer.
- Three-layer cleanup defense on Android: explicit `dispose()`, automatic `LifecycleEventListener.onHostDestroy()` on Activity destroy (works in both Bridge and Bridgeless modes), and `finalize()` as a GC fallback.
- iOS dispose lifecycle: `dispose()` override on the Swift `HybridObject`, `deinit` aligned with the same cleanup path, hardened `beginBackgroundTask` expiration handler that completes within iOS's 1-second budget.
- Structured debug telemetry (`Log.w` / `Log.i` always-on, `Log.d` gated by `BuildConfig.DEBUG` on Android; `os.Logger` with `[NitroBgTimer]` prefix on iOS) for post-mortem analysis when integrated with Sentry / Crashlytics.
- Jest test infrastructure: `jest` + `ts-jest` scaffold, manual mock for `react-native-nitro-modules`, and 29 unit tests covering ID management, callback invocation, input validation, and dispose lifecycle.
- `TESTING.md` — manual release checklist for Android, iOS, and cross-platform regression scenarios. To be executed on physical devices before each release.

### Changed

- **Project renamed to `react-native-nitro-bg-timer-plus`** — this project is now an independent fork of [tconns/react-native-nitro-bg-timer](https://github.com/tconns/react-native-nitro-bg-timer), maintained by Marco Crupi. Previous history is preserved.
- `LICENSE`: dual copyright preserving original author (Thành Công) and adding new maintainer (Marco Crupi)
- Upgraded Nitro Modules from 0.29.3 to 0.35.4
- Upgraded Nitrogen from 0.35.0 to 0.35.4
- Upgraded React Native to 0.84.1
- Upgraded `react-native-builder-bob` from 0.37.0 to 0.41.0
- Upgraded `@types/react` from 19.1.1 to 19.2.14
- Upgraded `eventemitter3` from 5.0.1 to 5.0.4
- Upgraded `prettier` from 2.8.8 to 3.3.3 (root + example)
- Upgraded `eslint-plugin-prettier` from 4.2.1 to 5.2.1
- Migrated `nitro.json` to modern autolinking syntax (`ios`/`android` with `language` + `implementationClassName`)
- Tightened `react-native` peer dependency from `*` to `>=0.76.0`
- Updated `moduleResolution` to `Bundler` in `tsconfig.json`
- Upgraded Yarn to modern version with `nodeLinker: node-modules`
- Updated Podfile.lock with `react-native-safe-area-context`
- README: rewritten iOS/Android platform configuration sections to reflect actual requirements (no `UIBackgroundModes` needed; only `WAKE_LOCK` for Android)
- CONTRIBUTING.md: removed outdated references to `yarn test`, `release-it`, and pre-commit hooks that did not exist in the project
- CODE_OF_CONDUCT.md: fixed corrupted Contributor Covenant text
- **Android wake lock rewritten following Google's 2024–2026 best practices**: switched to `setReferenceCounted(false)` to eliminate the "WakeLock under-locked" `RuntimeException` risk; tag updated to `"NitroBgTimer::WakeLock"` (compliant with the `Library::Description` format); `SecurityException` from `acquire()` is now caught with a graceful fallback (timer continues running via `Handler` without the wake lock instead of crashing the app).
- **All Android timer state is now serialized on a dedicated `HandlerThread`** (`"NitroBgTimer-Worker"`) to eliminate race conditions between concurrent `setTimeout` / `clearTimeout` callers. Previously, the race window was theoretical because calls arrive serialized from the JS thread, but the threading model is now explicit and self-defending.
- **`isDisposed` flag uses `AtomicBoolean.compareAndSet` instead of a `@Volatile var`** to guarantee that exactly one thread wins the dispose race when `BackgroundTimer.dispose()` and `onHostDestroy()` fire concurrently.
- The Nitro spec `setTimeout` / `setInterval` return type was changed from `number` to `void`. The native side never generated IDs (the JS-side `nextId` is the single source of truth), so the return value was a pure echo of the input parameter and was already discarded by the JS wrapper. The change has no impact on the public JS API in `src/index.ts`.
- `NitroBackgroundTimerPackage.java` was rewritten in Kotlin (`NitroBackgroundTimerPackage.kt`) using `BaseReactPackage` (the non-deprecated successor of `TurboReactPackage` in RN 0.84+). The static C++ bootstrap (`NitroBackgroundTimerOnLoad.initializeNative()`) is preserved.
- README "Platform Configuration → Android" section rewritten: no more manual `WAKE_LOCK` permission setup, no more references to `FOREGROUND_SERVICE` (which was never used by the library).
- README gained a new "Lifecycle and cleanup" section documenting the three-layer defense, the `dispose()` API, and the dev-mode Fast Refresh caveat.
- README "Android Implementation Details" and "iOS Implementation Details" sections updated to reflect the new architecture (HandlerThread serialization, LifecycleEventListener integration, expiration handler hardening).

### Fixed

- Fixed critical iOS bug where `setInterval` and `setTimeout` would not fire on
  physical devices. The previous `serialQueue` + nested `DispatchQueue.main.async`
  double-dispatch caused the unconditional `clearTimeout`/`clearInterval` call to
  race against timer creation, invalidating timers immediately after scheduling.
  All timer operations now dispatch directly to the main queue with inline,
  conditional cleanup. Addresses upstream issues
  [tconns/react-native-nitro-bg-timer#2](https://github.com/tconns/react-native-nitro-bg-timer/issues/2)
  and [#5](https://github.com/tconns/react-native-nitro-bg-timer/issues/5).
- Fixed HookTest render error in example app
- Fixed native bugs surfaced during React Native 0.84.1 upgrade
- Fixed broken `yarn specs` script (was invoking `typescript` as a shell command; now uses `tsc && nitrogen`)
- Fixed all 8 `react-native/no-inline-styles` warnings in example sections (BackgroundTest, ConcurrentTimers, HookTest, StressTest)
- Removed invalid `UIBackgroundModes` entries from example app `Info.plist`
- `eventemitter3` was declared as a runtime dependency but never imported anywhere in the source. Removed.
- README incorrectly instructed consumers to add `android.permission.FOREGROUND_SERVICE` to their manifest. The library does not start any foreground service. Reference removed; the only permission actually needed (`WAKE_LOCK`) is now declared by the library itself.
- `tsconfig.tsbuildinfo` was tracked in git despite being a build artifact that mutates on every `tsc` run. Added to `.gitignore` and untracked.

### Removed

- Stale `.eslintrc.js` (monorepo template artifact extending a non-existent `../../config/.eslintrc.js`)
- Unused `conventional-changelog-conventionalcommits` devDependency (legacy of removed `semantic-release`)
- Buy Me A Coffee button from README (kept attribution to original author elsewhere)
- Unused `eventemitter3` runtime dependency.
- `NitroBackgroundTimerPackage.java` (replaced by the Kotlin equivalent).

### Security

- Bumped `lodash` dependency
- Bumped `lodash-es` dependency
- Bumped `handlebars` dependency

## [0.1.0] - 2025-09-07

### Changed

- Updated Nitro Modules to 0.29.3

### Docs

- Added support button to README

### Fixed

- Fixed iOS native implementation

## [0.0.1] - 2025-09-02

### Added

- Initial implementation of react-native-nitro-bg-timer
- Background `setTimeout` / `clearTimeout` support
- Background `setInterval` / `clearInterval` support
- iOS native implementation (Swift) using `UIApplication.beginBackgroundTask`
- Android native implementation (Kotlin) using `PowerManager.PARTIAL_WAKE_LOCK`
- Nitro Modules JSI bridge integration for zero-overhead native calls
- TypeScript API wrapper with callback management
- Full API documentation and usage examples in README

[Unreleased]: https://github.com/marcocrupi/react-native-nitro-bg-timer-plus/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/marcocrupi/react-native-nitro-bg-timer-plus/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/marcocrupi/react-native-nitro-bg-timer-plus/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/marcocrupi/react-native-nitro-bg-timer-plus/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/marcocrupi/react-native-nitro-bg-timer-plus/releases/tag/v0.0.1
