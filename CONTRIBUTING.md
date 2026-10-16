# Contributing

Thank you for contributing to this independent fork. Read the [README](README.md)
for current API/OS limits and the [Code of Conduct](CODE_OF_CONDUCT.md) for community
standards. Keep changes focused and retain original-author credits and the MIT license.

## Toolchain and setup

The development/example stack uses React Native `0.87.1`, React `19.2.5`, Nitro
Modules and Nitrogen `0.37.1`, TypeScript `5.9.3` and Bob `0.41.0`. Peers admit
RN `>=0.78.0` with Nitro `^0.37.1`. The tested range is RN 0.78.3–0.88.0;
iOS RN 0.78–0.83 requires exactly Nitro 0.37.1 with the
[app-side compatibility patch](compat/README.md). See the
[results](README.md#compatibility-matrix) and [checks](#compatibility-matrix).
Node engines are exactly
`^22.13.0 || ^24.3.0 || >=26.0.0`; use Yarn `4.6.0` from `packageManager`.
This repository uses Yarn workspaces with the node-modules linker.

Before editing, establish the branch/HEAD, inspect staged/unstaged/untracked
files, and preserve unrelated work. From the root, with Yarn 4.6.0 available:

```sh
yarn install --immutable
```

Do not update lockfiles just to make installation pass. Diagnose toolchain or
lock drift first. No Nitrogen run is required on first install: the files under
`nitrogen/generated/` **are tracked**, included in the package, and used by native
autolinking. Documentation changes do not require regeneration or native builds.

For Android, install the SDK/NDK/build tools required by the example and use its
Gradle wrapper. Current settings use compile SDK 37, target SDK 36, minimum SDK 24,
build tools 37.0.0, NDK 27.1.12297006, Kotlin 2.2.0, AGP 9.2.1 and Gradle 9.4.1.
Use a JDK supported by that Gradle/AGP toolchain; the library's Java source/target
compatibility of 17 is not itself the Gradle runtime requirement. Configure
Android SDK discovery through your normal local environment. Do not commit
machine-specific SDK paths.

For iOS, use macOS/Xcode with the selected simulator/device runtime, Ruby `>=3.1`
and Bundler. Resolve gems against `example/Gemfile.lock`:

```sh
cd example
bundle install
cd ios
bundle exec pod install --deployment
```

Run these in the pinned Ruby environment. `--deployment` preserves the dependency
lock; intentional dependency work may require a separately reviewed lock update.
The root `example:pods` script invokes plain `pod install`, so it does not enforce
the same Bundler/deployment constraints. Use the workspace, not the `.xcodeproj`.
Device builds also require your own development signing. Do not commit signing
changes or credentials as incidental setup fixes.

## Development workflow

The example consumes workspace sources through Metro. Use the New Architecture
configuration already present; an obsolete architecture log example is not a
compatibility test. Run from the repository root:

```sh
yarn example:start
# In another terminal:
yarn example:android
# Or, after Pods:
yarn example:ios
```

Open `example/android` in Android Studio or
`example/ios/NitroBgTimerExample.xcworkspace` in Xcode for native development.
TypeScript-only changes can be served by Metro; native/generated changes need a
native rebuild. Fast Refresh can retain runtime state and is not proof of cleanup.
Use a fresh process for terminal disposal, opt-out and one-shot harness scenarios.
See [example/README.md](example/README.md).

### Generated bindings

After an intentional API change to `src/specs/*.nitro.ts`, use the pinned generator:

```sh
yarn nitrogen
```

Inspect all generated diffs and run it again to establish idempotence. Commit
reviewed generated output with the spec change. Do not hand-edit bindings to hide
a generator defect. The `specs` script is `tsc && nitrogen --logLevel="debug"`;
it also runs TypeScript emission and is not a read-only check. Neither command
belongs in a documentation-only workflow.

### Checks by change type

| Change | Appropriate checks |
| --- | --- |
| Markdown only | Read against source, validate links/anchors/commands, `git diff --check`, scope audit. No generator or device build required. |
| TypeScript wrapper | Root typecheck, Jest, non-fixing lint; build declarations before example typecheck; relevant smoke for native integration. |
| Nitro spec | Above, pinned regeneration and idempotence, both native builds and affected device behavior. |
| Android/iOS implementation | Relevant regressions, platform build, native lifecycle/resource checks; distinguish host checks from device qualification. |
| Smoke/QA harness | Harness fixtures and adversarial negative controls; real target run for the behavior being claimed. |
| Package/build metadata | Bob build and `test:package`, inspect extracted artifact and isolated consumer; pack success alone is insufficient. |
| Peer range, native build config, Nitro upgrade | Above, plus the [compatibility matrix](#compatibility-matrix) across the declared RN range. |

Useful scripts/commands from the root:

```sh
yarn typecheck
yarn test --runInBand
yarn lint-ci
yarn build
yarn tsc --project example/tsconfig.json --noEmit --incremental false
yarn --cwd example test --runInBand
# After packing, replace this path with the actual archive:
yarn test:package /path/to/package.tgz
node scripts/check-package.test.cjs /path/to/package.tgz
yarn test:compat
node --test scripts/smoke-harness.test.cjs scripts/smoke-runner-fixture.test.cjs
python3 scripts/physical-qa.test.py
```

`yarn build` uses Bob and produces CommonJS/ESM builds plus
`lib/typescript/index.d.ts`. Build before the first example typecheck, after
removing `lib`, or after changing library source/types/specs. Installation and
plain `tsc` do not produce Bob's declaration layout. `yarn typecheck` runs
`tsc --noEmit`; for a scratch check without incremental cache writes, use
`yarn tsc --noEmit --composite false --incremental false`.

`yarn lint-ci` does not fix files. **`yarn lint` includes `--fix`** and mutates
source; use it only when those edits belong to your change. Do not run code
formatters for a documentation-only change.

`yarn test:package` checks a built/packed artifact; `prepack` invokes the Bob
build. These may create ignored outputs and are not read-only documentation
checks. No release command is implied by package validation.

### Compatibility matrix

`scripts/compat-matrix.sh` packs the library, creates a fresh app per RN version
with `@react-native-community/cli`, installs the tarball with strict peer
resolution (`--strict-peer-deps --legacy-peer-deps=false --force=false`) and
builds Android/iOS Release. The host's `@react-native/virtualized-lists` version
is explicitly pinned to the
requested RN version so npm resolves its wildcard RN peer without selecting a
newer RN/React stack. This adds no version overrides or peer exceptions. With
`--run`, it launches the app on a booted emulator/simulator and waits for an
in-app timer check (interval ticks, cleared timeout, final timeout) to report
PASS. Each app embeds a fresh run ID. The runner checks that ID, RN version,
platform and timer observations; Android also pins the selected device and app
PID. It rejects failed commands, duplicate/contradictory reports and an exited
log collector, with a 500 ms settlement window after a valid PASS. The iOS
listener must bind successfully before launch and exactly one simulator must
be booted. The runtime helper defaults to 90 seconds for result collection and
for each synchronous device command (`COMPAT_TIMEOUT_MS` can set 1000–600000 ms).
This is not an overall installation, build or run deadline. Raw captures record
command exits and monotonic durations. Timer observation, identity and conflict
checks remain mandatory.

Generated app directories are removed after build/runtime rows unless `--keep`
is given; a failed installation can leave a partial app directory. Installed
apps are not uninstalled from the selected device/simulator. The work directory
(under the system temporary directory by default, or `--work-dir`) retains
the packed archive, step logs, raw runtime captures and summary for inspection.
Use a new work directory for each campaign: repeated runs replace the archive,
per-version app directories, logs and summary.

```sh
export RN_CLI_VERSION=20.2.0
scripts/compat-matrix.sh --platform android 0.78.3 0.88.0
ANDROID_SERIAL=emulator-5554 scripts/compat-matrix.sh --platform android --run 0.78.3
scripts/compat-matrix.sh --platform ios --run 0.88.0
scripts/compat-matrix.sh --platform ios --run --nitro-ios-compat 0.78.3 0.83.10
yarn test:compat
```

Pick an emulator with `ANDROID_SERIAL` when physical devices are attached. The
iOS runtime check reports over `http://localhost:8765` (`COMPAT_REPORT_PORT`),
because Release builds drop JS console output. When it detects Xcode 26+ and
RN's `fmt` 11 pod, the script sets that pod to C++17. This covers the Xcode 26.4+
compiler issue documented in the [iOS build notes](README.md#ios-build-notes).
Apps built with the iOS 27
SDK from RN templates before 0.88 do not adopt the UIScene life cycle and fail to
launch on an iOS 27 runtime; run their runtime check on an iOS 26 simulator.

`yarn test:compat` exercises the full script with fake native commands and
adversarial reports, without using devices or building native apps. iOS fixture
cases run on macOS. The `Compatibility` workflow runs these regressions and the
build matrix in CI; it does not run the apps. When a new RN minor is
released, add its latest patch there and run the script locally before release.
The six iOS RN 0.78–0.83 lanes explicitly pass `--nitro-ios-compat`; newer
lanes use stock Nitro. The flag requires exactly Nitro 0.37.1 and applies the
patch from the installed library tarball using patch-package 8.0.1 before Pods.
It preserves strict peer resolution and timer checks. Without the flag those
older iOS builds retain the documented upstream `glog` failure. The patch is
not installed automatically for consumers: use the [app guide](compat/README.md).
Set `RN_CLI_VERSION=20.2.0` to reproduce the qualified CLI stack; the script's
default tracks the latest CLI.

## Runtime qualification

Use [TESTING.md](TESTING.md) for core smoke, UI smoke and manual scenarios, and
[PHYSICAL_QA.md](PHYSICAL_QA.md) for Release artifact/device evidence. The Physical
QA runner currently has a historical HEAD/documentation-hash gate that blocks
current main, including dry-run. Resolve that in a separate reviewed tooling
change before claiming a new campaign can run.

A Jest/host PASS does not qualify native timing, installed artifacts or physical
cleanup. Record source/artifact identity, configuration, device/OS, raw exit,
observed behavior and gaps. Preserve failed attempts and distinguish PASS,
FAIL, BLOCKED, NOT_RUN and NOT_OBSERVED. Avoid deliberate promotion-crash tests
on a contributor's personal phone; use bounded host/virtual-device evidence.

## Pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/en/), such as
`fix(timer): ...`, `test(qa): ...` or `docs: ...`. Describe the concrete problem,
resulting behavior, affected platforms and validation. Include causal negative
controls for fixes where appropriate, and report checks not run with reasons.

Keep runtime, dependency, generated and documentation changes within the agreed
scope. Inspect the full diff and Git status before submission, including ignored
build side effects that might affect later checks. Update `CHANGELOG.md` under
Unreleased for user-visible work; leave historical release records intact and
do not describe main changes as published. API/compatibility changes should be
discussed with maintainers before implementation. Follow any repository PR
template when present. Maintainers control versioning, commits and publication
according to the task's authorization; testing never authorizes a release.
