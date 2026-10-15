# Contributing

Thank you for contributing to this independent fork. Read the [README](README.md)
for current API/OS limits and the [Code of Conduct](CODE_OF_CONDUCT.md) for community
standards. Keep changes focused and retain original-author credits and the MIT license.

## Toolchain and setup

Current main targets React Native `0.87.1`, React `19.2.5`, Nitro Modules and
Nitrogen `0.37.1`, TypeScript `5.9.3` and Bob `0.41.0`. Node engines are exactly
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

After an intentional change to `src/specs/*.nitro.ts`, use the pinned generator:

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

Useful scripts/commands from the root:

```sh
yarn typecheck
yarn test --runInBand
yarn lint-ci
yarn build
yarn tsc --project example/tsconfig.json --noEmit --incremental false
yarn --cwd example test --runInBand
node --test scripts/check-package.test.cjs
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
