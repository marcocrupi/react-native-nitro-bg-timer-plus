# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

### Fixed

### Removed

### Security

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

[Unreleased]: https://github.com/marcocrupi/react-native-nitro-bg-timer-plus/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/marcocrupi/react-native-nitro-bg-timer-plus/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/marcocrupi/react-native-nitro-bg-timer-plus/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/marcocrupi/react-native-nitro-bg-timer-plus/releases/tag/v0.0.1
