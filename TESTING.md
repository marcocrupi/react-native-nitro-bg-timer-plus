# Testing and qualification

Use this guide for manual and semi-automated validation. Tests establish only the
contracts they observe. Keep host checks, core smoke, UI smoke and Release Physical
QA separate; record device/OS, build mode, source/artifact identity, runId, PID,
clocks, observations, raw exits and skipped checks. Never infer universal device
support from one successful run.

## Setup and evidence rules

Use the pinned toolchain in [CONTRIBUTING.md](CONTRIBUTING.md). From the root:

```sh
yarn install --immutable
yarn build
yarn tsc --project example/tsconfig.json --noEmit --incremental false
yarn example:start
# In another terminal:
yarn example:android
# Or, after Pods:
yarn example:ios
```

Bob declarations are needed for example typechecking, not for Metro's workspace
source resolution. Native/spec changes require a native rebuild. Use a fresh
example process for every one-shot smoke, QA, opt-out or dispose scenario.
Fast Refresh can preserve runtime state; it is not a clean process or proof of
runtime invalidation. Clear your timers after reversible UI checks.

All manual scenarios below require a known source/build, captured application
logs, and a target appropriate to the observation. Android notification checks
need permission/channel visibility; service state is checked separately.
Background checks on physical devices should use a Release build without a
debugger for qualification. Use dedicated virtual devices or host fixtures for
fault injection; do not deliberately provoke failed-promotion process crashes on
a personal phone. No global power/security workaround is required.

Record PASS only when preconditions and observations are established. Use FAIL
for a violated observed contract, BLOCKED for missing setup, NOT_RUN for omitted
checks and NOT_OBSERVED for an unproven natural event. Preserve unsuccessful
attempts. Current queue/resource snapshots carry more weight than old log lines.

## Test layers and current status

| Layer | Entry point | What it establishes |
| --- | --- | --- |
| Wrapper/unit | `yarn test --runInBand` | JS validation, callback ownership, registration rollback/error propagation with mocks. |
| Example/unit | `yarn --cwd example test --runInBand` | Example parsers, smoke and resource-ownership logic. |
| Host harness | Node/Python commands below | Controlled parser, supervision, stale-evidence and failure witnesses. |
| Core smoke | `smoke:android`, `smoke:ios` | Real wrapper/native delivery in the selected build/target. |
| UI smoke | `ui-smoke:android`, `ui-smoke:ios` | Maestro button handlers and bound core run; foreground UI flow. |
| Physical QA | `scripts/physical-qa.sh` | Release artifact/process-bound scenarios and external resource/provenance checks. |

```sh
yarn tsc --noEmit --composite false --incremental false
yarn lint-ci
node --test scripts/smoke-harness.test.cjs scripts/smoke-runner-fixture.test.cjs
python3 scripts/physical-qa.test.py
```

`lint-ci` does not fix files; `lint` does. These checks do not qualify device
background behavior. Physical QA **currently refuses main** due to its historical
HEAD/documentation hashes. Read [the blocker](PHYSICAL_QA.md#current-execution-blocker)
before any campaign, including dry-run. Its two entry-point discovery fixtures
can pass at that earlier gate and do not prove discovery is exercised.

Historical selected physical results and gaps are summarized in
[qualification boundaries](PHYSICAL_QA.md#qualification-boundaries). They are not
new executions of the current documentation candidate. Battery Saver, some
lock/unlock checks, full iOS private-task release timing and arbitrary failed
initial FGS promotion remain unqualified. Do not describe these as PASS.

## Core smoke

Core deep link:

```text
nitrobgtimerexample://smoke?runId=UNIQUE_ID
```

Use 1–80 characters from letters, digits, `.`, `_`, `-`. Malformed IDs are ignored.
The harness covers timeout/interval delivery, cancellation, native event drain,
batch ordering, reentrant scheduling and terminal disposal. Native timer callbacks
do not directly retain application JS functions. The final dispose makes core
one-shot for the wrapper's lifetime.

### Android runner

Start Metro for Debug and build/install the current example. The runner expects
the selected APK for installed-artifact verification; provide `--apk` when using
a different output path. For Release `--apk`, install that matching artifact first
through your normal build/install workflow. `--install` runs
`yarn example:android --deviceId` to build/install the example; it does not install the file passed to `--apk`:

```sh
yarn smoke:android
bash scripts/smoke-android.sh --device YOUR_ADB_SERIAL --install
bash scripts/smoke-android.sh --device YOUR_ADB_SERIAL --background
bash scripts/smoke-android.sh --device YOUR_ADB_SERIAL \
  --apk /path/to/app-release.apk --run-id android-core-001
```

`--background` automates a bounded Home/resume window. It does not qualify screen
lock, all power modes or every OEM. Target locks/run-ID admission, process identity,
artifact checks and crash checks are part of the runner contract; preserve its
printed log paths and raw exits.

### iOS runner

A booted simulator or a paired, trusted, unlocked physical device is required.
Build/install are on by default; Debug requires Metro. Device CoreDevice and
Xcode UDID may differ:

```sh
bash scripts/smoke-ios.sh --simulator --terminate-existing
bash scripts/smoke-ios.sh --device YOUR_COREDEVICE_ID \
  --xcodebuild-device-id YOUR_XCODE_UDID --terminate-existing
bash scripts/smoke-ios.sh --device YOUR_COREDEVICE_ID \
  --xcodebuild-device-id YOUR_XCODE_UDID --configuration Release \
  --terminate-existing --run-id ios-core-001
```

Automated capture starts a fresh process by default, terminating an existing
example process. `--terminate-existing` is retained as a compatibility flag;
termination is already enabled. The default physical-device launch strategy is `launch-then-open-url`; `--launch-strategy
payload-at-launch` selects the alternative. The example mirrors JS markers through
`NitroBgSmokeLog` and can consume the pending URL stored by AppDelegate when
React Native Linking does not deliver it.

`--derived-data PATH` selects build output. `--skip-build` requires matching
build output (supply its DerivedData path). Automated physical-device runs reject
`--skip-install` because installation is required for provenance. Simulator
`--skip-install` still requires comparison against the matching local app. These
flags are not necessary for an ordinary fresh run. Manual mode only sends the URL:

```sh
bash scripts/smoke-ios.sh --device YOUR_COREDEVICE_ID --open-url-only
```

`--open-url-only` does not build, install, terminate, capture or wait for a result.
Observe Metro/Xcode yourself. It is not an automated PASS. Core alone does not
press Home on a physical iPhone; Physical QA has the separate background route.

### Markers and failure diagnosis

Core uses `[NitroBgSmoke]` with `runId`, `START`, `STEP PASS/FAIL`, and final
`RESULT PASS/FAIL`; URL diagnostics include `DEEPLINK_RECEIVED`, ignored reasons
and native pending-URL markers. iOS native `OPEN_URL`/`LAUNCH_URL` proves URL
receipt by iOS, not JS callback delivery. Event-module/signal/drain diagnostics
are supporting observations, not substitutes for callback assertions.

| Last observation | Next investigation |
| --- | --- |
| No native or JS URL marker | Target/process launch, URL registration, capture, pairing, Metro in Debug. |
| Native URL only | JS boot, Linking/pending URL fallback, native console mirror. |
| `DEEPLINK_RECEIVED` without START | ID/mode validation, duplicate admission or another active run. |
| START without RESULT | Last step, signal/drain/callback path, suspension, capture interruption or process death. |
| RESULT FAIL / JS error | Preserve failing step/error and identities; classify setup versus product evidence. |

Core runner exits: 0 matching validated PASS; 1 assertion/crash/runtime failure;
2 setup/preflight/build/install/launch failure; 124 bounded timeout. A stale PASS,
wrong process, incomplete steps or later FAIL must not be accepted.

## UI smoke

UI mode sets a run identity and leaves controls interactive:

```text
nitrobgtimerexample://smoke?runId=UNIQUE_ID&mode=ui
```

Maestro must already be available. The scripts own launch/context; Maestro drives
stable testIDs and runs core smoke last because it disposes the wrapper.
`[NitroBgUiSmoke]` action START/PASS/FAIL markers and the bound core result qualify
the flow, not Maestro exit 0 alone. Normal manual mode has no UI-smoke shortcuts.

```sh
maestro --version
yarn ui-smoke:android
bash scripts/ui-smoke-android.sh --device YOUR_ADB_SERIAL --flow main
bash scripts/ui-smoke-android.sh --device YOUR_ADB_SERIAL --flow fgs-optout
bash scripts/ui-smoke-android.sh --device YOUR_ADB_SERIAL --flow fgs-optout-deep
bash scripts/ui-smoke-ios.sh --simulator YOUR_SIMULATOR_UDID --flow main
bash scripts/ui-smoke-ios.sh --device YOUR_COREDEVICE_ID \
  --xcodebuild-device-id YOUR_XCODE_UDID --maestro-device-id YOUR_MAESTRO_ID
```

The main flow checks timeout fire/cancel, interval controls, reversible Background
Test controls, concurrent timers, mount/unmount cleanup, hook restart/stop, bounded
100-timer stress and core smoke. Opt-out flows are separate fresh-process lanes;
the Android script force-stops the example before every UI flow. `--install`
optionally builds/installs via `yarn example:android`, independently of `--apk`.
Android `fgs-optout-deep` adds its own background/resource checks.
Main UI success does not qualify background, lock-screen or long-run execution.

Physical iPhone Maestro is best-effort because driver/signing setup may fail.
Keep that infrastructure result separate from core iOS/native qualification.
Consult each script's `--help`; flags are not interchangeable across core, UI
and Physical QA runners.

## Android manual and semi-automated scenarios

For each scenario, preserve current PID/runtime/context and observation times.
The Physical QA scenario names below are references to implemented contracts,
subject to the documented execution blocker, not claims of new runs.

### A1 — Standard callbacks, cancellation and disposal

**Precondition:** Fresh app; use timeout/interval, concurrent, cleanup and smoke
sections. **Procedure:** Observe one timeout, several interval callbacks and
multiple IDs; cancel pending timeout and running interval before their next
needed delivery. Run terminal core smoke last. **Expected/observe:** One delivery
per delivered timeout, distinct IDs, no callback after a proven clear, repeated
dispose harmless; scheduling/configure/start after disposal reject. An executing
callback cannot be preempted. **Automation/limit:** `core`/`timers` and UI main;
UI counts alone do not prove native resource release.

### A2 — Home/resume and long-run

**Precondition:** Known Release build, notification visibility and captured live
logs; record initial active state. **Procedure:** Use Physical QA `background`
(25-second qualifying timeout) or `long-run` (five minutes), with Home then resume.
For manual Background Test, record monotonic elapsed time and each callback
receipt before returning. **Expected/observe:** Successful Home/resume, active →
background → active, same PID/artifact, live qualifying callback before resume,
current FGS/wake lock and final cleanup. Long-run samples current service again
at five minutes. **Limit:** No universal drift/count threshold; coalesced interval
counts are not elapsed time. Lock/unlock is separate, opt-in manual evidence and
not filled by Home. Battery Saver is NOT_RUN in the runner. Do not change global
power policy to force a result.

### A3 — Activity recreation versus runtime teardown (F2/F3)

**Precondition:** Instrumented example identities; runtime retained for recreation.
**Procedure:** Physical QA `recreate` invokes actual Activity recreation and
checks identities plus subsequent timers. To establish pending-timer preservation
separately, a bounded integration harness must keep a timeout/interval pending
across recreation. **Expected/observe:** Changed nonzero Activity identity,
unchanged PID/context/runtime/worker and continuing timer usability. **Limit:**
The current automated `recreate` scenario does not keep its tested timer pending
through the recreation; subsequent success is narrower evidence.

For runtime replacement, use `reload`: start old timers/explicit hold, invoke real
`ReactHost.reload`, observe new runtime/context and termination of old workers.
Require a resource-free interval (old service/wake lock absent) **before** new
timer demand, then verify new callbacks. Manual `ReactHost.destroy` coverage
requires a dedicated integration harness and is a separate result. Fast Refresh,
Activity destruction and process kill do not prove this invalidation barrier.
Do not expect Java callbacks to run during force-kill. Runtime invalidation also
waits for manual disposal already in flight.

### A4 — Implicit/explicit FGS and wake locks

**Precondition:** Fresh app without opt-out; permission/channel visibility recorded.
**Procedure:** Start a timer without explicit mode; inspect current service and
UID-owned `NitroBgTimer::WakeLock`. Clear it and wait for cleanup. Then start
explicit mode without timers, add/clear timers, and release explicit mode.
**Expected/observe:** Implicit request begins at timer acceptance, even in
foreground; final timer completion releases implicit demand. Explicit mode keeps
service demand across timer gaps; it alone need not hold a timer wake lock.
Stopping explicit mode does not cancel active timers. **Automation/limit:**
`fgs`, `background`, `long-run`, notification and cleanup snapshots. A notification
or old acquire/release log is insufficient proof of current service/lock state.

Example read-only snapshots, with your current target serial:

```sh
adb -s YOUR_ADB_SERIAL shell dumpsys activity services com.nitrobgtimerexample
adb -s YOUR_ADB_SERIAL shell dumpsys power
adb -s YOUR_ADB_SERIAL shell dumpsys notification --noredact --package com.nitrobgtimerexample
```

Restrict collected evidence to the example; inspect/redact before sharing.
Missing WAKE_LOCK permission/acquisition failures are logged; native scheduling
continues without that protection. Verify that branch with host/dedicated consumer
evidence when relevant, not by modifying this example's manifest for routine QA.

### A5 — Notification sessions and configure gating (F5)

**Precondition:** No timers or explicit hold for the owner being configured.
**Procedure:** Configure A → explicit start/stop → configure B → start; repeat with
implicit timers C/D, then immediate pending-start/stop/reconfigure E.
**Expected/observe:** Current notification title/text match each current session,
including takeover after pending stop. `notification` automates these cases.
Channel identity/user policy is separate; immutable existing channel properties
are not expected to reset. Icon/channel selection requires its own observation.

Use focused wrapper/native tests for accepted timer → configure rejection,
immediate clear → configure success, and explicit hold gating. These assertions
are not all proven by notification title checks alone. Configure is owner-scoped;
another raw owner can still hold the shared service.

### A6 — Multi-owner service coordination (F8)

**Precondition:** Dedicated `multi-owner` adapter creates two distinct raw owners.
**Procedure:** Observe both owners' events, release A while B has demand, then
dispose A and finally release B. **Expected/observe:** Earliest demanded owner A
supplies the one notification; B takes over and continues callbacks after A leaves;
last release cleans up workers, service and locks. **Limit:** Raw adapter evidence
is distinct from wrapper callbacks. Never look up/call a method on a raw proxy
after disposal. Delayed stale-start/destruction races need bounded host/integration
witnesses; UI alone does not expose coordinator state.

### A7 — Process opt-out (F6)

**Precondition:** Fresh process, before every owner's first timer/start request.
**Procedure:** Use `optout` or separate UI opt-out flows. Disable, schedule timers,
repeat disable and create a second owner. **Expected/observe:** Callbacks and
wake-lock-only scheduling with no timer service; repeated opt-out does not throw.
**Limit:** First opt-out after earlier use must throw, even after timers finish;
prove that in separate fresh-process tests. Process scalars survive RN reload and
new raw owners; a runtime reload cannot re-enable FGS. Those persistence branches
are implemented but not all exercised by the `optout` scenario itself.

### A8 — Start refusal/retry and pending-stop (F7)

**Precondition:** Dedicated emulator or safe naturally restricted OS request,
separate from ordinary phone testing. **Procedure:** `retry` attempts background
start after the grace window, then retries from foreground. **Expected/observe:**
Target-PID `ForegroundServiceStartNotAllowedException` between native control
pulses, followed by current foreground notification/service request recovery.
Without refusal the result is NOT_OBSERVED. The pulse is not a product callback.
**Limit:** No synthetic failed-initial-promotion crash is required. Reset state or
caught exceptions do not guarantee survival of Android's promotion deadline.
Pending-stop sequencing is exercised by notification E and bounded host/native
checks; absence of a crash alone does not prove every race was reached.

### A9 — Queue backlog, callback errors and registration rollback

**Precondition:** Fresh process and bounded test. **Procedure:** Physical QA
`backlog` schedules 1,500 raw timeouts, blocks JS for 350 ms and validates the first
drain's complete native/callback inventories. **Expected/observe:** All unique IDs,
types/sequences and adapter callbacks; no intermediate drain or duplicate timeout.
**Limit:** Dynamic memory scales with pending timeout events; this does not qualify
the wrapper's automatic 1,500-event path. Intervals coalesce until drain.

Use host Jest tests for F9 synchronous registration rollback and thrown-value
propagation: failed registration leaves no callback entry; batch drain continues,
then rethrows the first value, including falsy values. Timeout cleanup uses
`finally`; an interval remains registered until clear. Do not deliberately throw
uncaught callbacks on a personal phone as a required manual check.

### A10 — Short intervals and bounded concurrency (F10)

**Precondition:** Fresh process; finite durations. **Procedure:** `short-intervals`
uses 0, 0.1, 0.5, 0.999, 1, 1.5, 2 and 10 ms, then clear/dispose. UI stress covers
100 timers; core tests ordering/reentrancy. **Expected/observe:** Progress without
freeze, bounded delivery and no post-clear/dispose callbacks. Inspect source or
native-focused tests for exact conversions: Android truncates then floors at 1 ms;
iOS floors at 1 ms while retaining larger fractions. **Limit:** Runtime callback
counts do not directly measure effective native scheduling or real-time accuracy;
timeout conversion is unchanged. Avoid long physical short-interval stress runs.

## iOS manual and semi-automated scenarios

### I1 — Standard timers, event delivery and cleanup

**Precondition:** Fresh process, current native build and captured logs.
**Procedure:** Run core, `timers`, UI main, or timeout/interval/cleanup sections.
Clear before expiry, stop intervals, then run terminal dispose last.
**Expected/observe:** Real JS callbacks, cancellation, reentrancy and no forbidden
callbacks after clear/dispose; native signal → JS drain → wrapper delivery.
**Limit:** Release private background-task IDs are not exposed; callback absence
alone does not prove exact private task release timing. Debug `deinit` logging is
supporting evidence, not the Android runtime-owner barrier.

### I2 — Background delivery and suspension

**Precondition:** Physical Release target, no debugger, initial active state and
live host capture. **Procedure:** Use `background`; Home/SpringBoard, wait for the
qualifying 25-second callback, then resume. **Expected/observe:** Own-process UIKit
background event, JS AppState changes, callback received by host before resume,
unchanged PID/artifact/container chain and successful return to active.
**Limit:** A task grant is best-effort. Suspension/denial can prevent observation;
a callback delivered only after resume does not prove background execution.
Simulator/Debug success does not establish this physical contract.

### I3 — Natural expiration and reacquire

**Precondition:** Physical target, active long-running interval, finite observation
window. **Procedure:** `expiration` waits for a natural expiration warning or up to
75 seconds before resume, then checks timer progress. Do not assume expiration at
30 seconds. For manual re-entry, after observed expiration/resume, background again
with timers still active; observe the debug reacquire message where available.
**Expected/observe:** Expiration ends only its matching identifier and preserves
timer state; future background entry may request a new task. Clear/dispose ends
remaining work. Record absence/presence of expiration and watchdog errors.
**Limit:** No guaranteed time grant or continuous renewal. The automated scenario
does not prove a second background reacquire cycle or full private task-ID/end
timing. Full I05 qualification stays NOT_OBSERVED even when warning/resume progress
is observed. Do not turn a partial natural observation into PASS.

### I4 — Pending timeout clear and runtime disposal

**Precondition:** Fresh app, callback IDs logged, pending timeout long enough to
cancel. **Procedure:** Clear before fire, allow execution/resume and observe no
callback; repeat in a fresh process with dispose. For full runtime reload, record
old/new runtime identities and observe old callback absence/new usability.
**Expected/observe:** Native main-queue invalidation, queued-event removal and task
release when no timers remain; wrapper terminal guard prevents reuse.
**Limit:** Calls return before all iOS native cleanup has necessarily executed.
Do not use reload alone to claim direct observation of private task identifiers.

### I5 — Backlog and short intervals

**Precondition:** Fresh process, finite test budgets. **Procedure:** Use `backlog`
and `short-intervals` separately. **Expected/observe:** First raw drain 1,500 unique
timeouts with adapter callbacks; short values make progress and stop after clear.
**Limit:** Raw adapter versus wrapper automatic delivery remains distinct. iOS
uses the main run loop, so native execution depends on its availability; JS blockage
does not imply arbitrary OS suspension can retain/fill all events. The interval
floor is 1 ms, not an accuracy guarantee; fractional values >=1 ms are preserved.

## Qualification record and release preparation

For every selected lane, retain source/build receipts, artifact hashes, PID/runtime
identity, callback IDs, wall/monotonic clocks, AppState/native lifecycle, command
exits and cleanup observations. Use [PHYSICAL_QA.md](PHYSICAL_QA.md) for report
layout, lock ownership, independent parser behavior and provenance limits.
Historical selected runs must retain their failed predecessors and artifact deltas.

Before a future release, maintainers should review relevant host/unit checks,
package/consumer validation, physical scenarios and explicit gaps. Full checklist
completion is not implied by this guide or a single exit 0. Report NOT_RUN and
NOT_OBSERVED honestly; do not require every unobservable private contract to be
claimed PASS. Version/tag/publication decisions are separate maintainer actions.
