# NitroBgTimerExample

The workspace example exercises `react-native-nitro-bg-timer-plus` through its
public wrapper and dedicated example-only diagnostics. It is a development and
qualification app, not a background-execution guarantee or a store-ready product.
See the [library README](../README.md) for API and platform limits.

## Setup and run

Use the root Node engines, Yarn 4.6.0 and pinned native tools described in
[CONTRIBUTING.md](../CONTRIBUTING.md). Commands below start at the repository root:

```sh
yarn install --immutable
yarn build
yarn tsc --project example/tsconfig.json --noEmit --incremental false
yarn example:start
```

Bob builds the declarations required by example typechecking; Metro resolves
workspace sources. In a second terminal:

```sh
yarn example:android
# Or, after installing Pods:
yarn example:ios
```

For iOS dependencies, from the root:

```sh
cd example
bundle install
cd ios
bundle exec pod install --deployment
```

Open `example/android` in Android Studio or
`example/ios/NitroBgTimerExample.xcworkspace` in Xcode. A native change needs a
native rebuild. Android Release can be built from `example/android` with
`./gradlew :app:assembleRelease`; use the matching SDK/JDK/NDK and target ABI.
iOS Release builds use the workspace/scheme `NitroBgTimerExample`, Release
configuration and a selected destination/signing identity.

Debug normally loads JS from Metro and exposes development diagnostics. Release
bundles JS/Hermes resources and does not depend on Metro at runtime. Debug logging,
debugger attachment and simulator behavior can affect observations; do not treat
a Debug UI test as Release physical qualification.

## Interactive sections

The app provides timeout fire/cancel, interval start/stop/reset, Background Test
(including Android notification configuration and explicit mode), concurrent
timers, component cleanup, a timer hook, a bounded stress test and a core smoke
button. The log view shows application observations. Android 13+ notification
permission is requested by the example; iOS also has its own notification prompt.
Those prompts are app behavior, not a timer-library permission API.

Stop/clear feature timers after each check. `Disable FGS` is process-wide on
Android and cannot be undone by re-mounting the screen. `Run Smoke` ends with
terminal `BackgroundTimer.dispose()`; use it last. Restart the **process** before
another independent run, including after an opt-out test. Fast Refresh is not a
reliable reset of native/runtime/process state.

## Automated routes and logs

```text
nitrobgtimerexample://smoke?runId=example-core-001
nitrobgtimerexample://smoke?runId=example-ui-001&mode=ui
nitrobgtimerexample://smoke?runId=example-qa-001&mode=qa&scenario=timers&deviceId=DEVICE_ID
```

Use a fresh valid runId for each run. Core starts automatically; UI mode assigns
an identity and leaves buttons for Maestro to drive. QA validates its extra
fields, hides interactive controls, and excludes simultaneous core/UI runs.
Use the runner for device automation/provenance instead of treating a manually
opened QA URL as qualification. No source edits are required to activate tests.

From the root, after the required target/build setup:

```sh
yarn smoke:android
bash scripts/smoke-android.sh --device YOUR_ADB_SERIAL --background
bash scripts/smoke-ios.sh --simulator --terminate-existing
bash scripts/smoke-ios.sh --device YOUR_COREDEVICE_ID \
  --xcodebuild-device-id YOUR_XCODE_UDID --terminate-existing
yarn ui-smoke:android
yarn ui-smoke:ios
```

UI smoke requires Maestro. Physical iPhone Maestro setup/signing is best-effort;
its setup failure is distinct from a library assertion failure. See
[TESTING.md](../TESTING.md) for prerequisites, flags and manual diagnosis.

Core markers use `[NitroBgSmoke]`, UI actions `[NitroBgUiSmoke]`, custom QA
`[NitroBgPhysical]`, and iOS lifecycle `[NitroBgPhysicalNative]`. iOS mirrors core/QA
JS markers into native logs through `NitroBgSmokeLog` and retains a pending URL
fallback. Android's `NitroBgPhysicalQA` bridge can observe Activity/context/thread/
notification identities and request recreation/reload. These bridges are
example-only, not exported library APIs. Inspect matching runId, PID, steps and
raw exits; an isolated PASS line or visible UI counter is insufficient evidence.

The Release [Physical QA suite](../PHYSICAL_QA.md) covers device discovery, build
receipts, locks, scenarios, independent validation and cleanup. **Its historical
baseline/hash gate currently blocks current main**, including dry-run. Complete
the documented tooling maintenance before starting a campaign. Backlog/multi-owner
raw adapters have a different contract from wrapper tests; raw Nitro objects must
never be accessed after disposal.

## Host checks

```sh
yarn --cwd example test --runInBand
node --test scripts/smoke-harness.test.cjs scripts/smoke-runner-fixture.test.cjs
python3 scripts/physical-qa.test.py
```

These commands run from the root and do not qualify physical behavior. Keep
runtime logs/artifacts outside the repository, redact private device identifiers
before sharing, and retain failed attempts alongside selected successes.

For API changes and package work, follow [CONTRIBUTING.md](../CONTRIBUTING.md).
For release history, see [CHANGELOG.md](../CHANGELOG.md).
