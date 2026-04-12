# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Example app with 7 test sections (SetTimeout, SetInterval, Background, Concurrent, Cleanup, Hook, Stress)
- `useBackgroundTimer` custom hook in example app
- `eslint`, `prettier`, `eslint-config-prettier` as direct devDependencies (were previously unresolved peer requirements)
- `engines.node >= 18` in root `package.json`

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

### Fixed

- Fixed iOS timer race condition (main-thread dispatch, same-ID timer overwrites)
- Fixed HookTest render error in example app
- Fixed native bugs surfaced during React Native 0.84.1 upgrade
- Fixed broken `yarn specs` script (was invoking `typescript` as a shell command; now uses `tsc && nitrogen`)
- Fixed all 8 `react-native/no-inline-styles` warnings in example sections (BackgroundTest, ConcurrentTimers, HookTest, StressTest)
- Removed invalid `UIBackgroundModes` entries from example app `Info.plist`

### Removed

- Stale `.eslintrc.js` (monorepo template artifact extending a non-existent `../../config/.eslintrc.js`)
- Unused `conventional-changelog-conventionalcommits` devDependency (legacy of removed `semantic-release`)
- Buy Me A Coffee button from README (kept attribution to original author elsewhere)

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

[Unreleased]: https://github.com/marcocrupi/react-native-nitro-bg-timer-plus/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/marcocrupi/react-native-nitro-bg-timer-plus/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/marcocrupi/react-native-nitro-bg-timer-plus/releases/tag/v0.0.1
