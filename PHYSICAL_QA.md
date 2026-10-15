# Physical QA suite

This guide describes the example-only Release QA infrastructure in current main.
It distinguishes the implemented runner from historical device results. For
manual checks and core/UI smoke, see [TESTING.md](TESTING.md).

## Current execution blocker

**The public runner currently refuses current main, including `--dry-run`.**
In [physical-qa.py](scripts/physical-qa.py), `protect()` requires HEAD
`741b0799b1be0c5f48466a2a3a2827b387e57a66`; this documentation audit starts at
`678284d9848eae7fb477ec3f957bc9d629f5626a`. Before checking HEAD, it compares
six SHA-256 entries in `FROZEN`:

| File | Frozen SHA-256 |
| --- | --- |
| `android/src/main/java/com/margelo/nitro/backgroundtimer/NitroBackgroundTimer.kt` | `2713a48123faff2ad9a0bbfe162972ebc3297f65b468e4d156aca8fbbe29439f` |
| `android/src/main/java/com/margelo/nitro/backgroundtimer/NitroBackgroundTimerPackage.kt` | `9ba54c0122f51d33dabbaaebfdefc0eefb72d2d9aa66c1c3c76459dfc854c5f7` |
| `android/src/main/java/com/margelo/nitro/backgroundtimer/NitroBackgroundTimerService.kt` | `1465b5a218236e6dd3777e39d558a7fe1f85c778ff53a0e5a747594ccdd01cd2` |
| `ios/NitroBackgroundTimer.swift` | `edce659f1f2ef00002d1f66f7b8b6d3dc0845e1d69e8161865d2c94d2ee1760a` |
| `README.md` | `5809e10f6369278d366941b938220058e7b035b12cc544d13d5cc2f1410c8277` |
| `TESTING.md` | `a7908d42a57fab04e24c7e90c310efdf97d460ff6a87a958858f823797f3b3ad` |

The four native hashes match the audit baseline. The two documentation hashes
match the pre-audit documents and intentionally stop matching after this overhaul.
Thus the first failure changes from `authorized_baseline_changed` to
`frozen_candidate_changed:README.md`. Preflight exits 2 before discovery/build,
and may produce no report directory. An absent report is not a successful run.

A separate tooling change must establish an authorized committed baseline for
future runs and reconcile the frozen documentation policy/hashes with that
candidate. The expected source hashes must come from the reviewed candidate;
they cannot be hardcoded here before the PO's documentation commit exists.
The runner also requires empty staging and no protected-source diff, and checks
protection again at completion. Do not bypass `protect()`, use internal execution
entry points directly, or change hashes merely to obtain PASS. No runner change
is included in this documentation-only revision.

**All campaign examples below describe supported CLI syntax and are blocked by
this gate until that maintenance is completed.**

## Requirements and device discovery

Run from the repository root with pinned JS dependencies installed, Python 3,
Node, shell tools and the appropriate native toolchain. Android needs `adb`, an
authorized USB target and the repository Gradle/JDK/SDK setup. The Android QA
build selects `arm64-v8a`; an explicitly allowed emulator must support that ABI.
iOS needs macOS, Xcode/`devicectl`, an unlocked, paired physical iPhone with
Developer Mode, and working development signing. Signing, dependencies,
capabilities and manifests are not patched by the runner.

The iOS Pods sandbox must match `example/ios/Podfile.lock`. If it is stale,
use the pinned Ruby environment and, from `example/ios`,
`bundle exec pod install --deployment`. Inspect generated deltas; do not accept
unrelated tracked changes. See [CONTRIBUTING.md](CONTRIBUTING.md).

Read-only discovery can be performed independently of the blocked runner:

```sh
adb devices -l
xcrun devicectl list devices
xcodebuild -workspace example/ios/NitroBgTimerExample.xcworkspace \
  -scheme NitroBgTimerExample -showdestinations
```

Use `--android-device` for the adb serial; `--ios-device` for the CoreDevice
identifier used by `devicectl`; `--xcodebuild-device-id` for the hardware UDID
used by Xcode. The iOS runner resolves these to the same physical device and
rejects a mismatched explicit Xcode UDID. Without an explicit identifier,
discovery requires exactly one eligible target. Missing/ambiguous/unauthorized
Android targets and unpaired/nonphysical/nondeveloper iOS targets fail preflight.

## Public CLI

```sh
bash scripts/physical-qa.sh --help
```

| Flag | Meaning |
| --- | --- |
| `--artifacts PATH` | Required. Output directory outside the repository. |
| `--all` | Select core, all custom scenarios and Battery Saver. Overrides a supplied scenario subset. |
| `--platform android\|ios\|both` | Default `both`. |
| `--scenario NAME` | Repeat for a subset; names are listed below. Required unless `--all` or `--dry-run`. |
| `--android-device SERIAL` | Select the authorized adb target. |
| `--ios-device COREDEVICE_ID` | Select the physical iOS target. |
| `--xcodebuild-device-id UDID` | Explicit matching Xcode destination. |
| `--dry-run` | Runs protection/discovery/destination checks, writes `PREFLIGHT_ONLY`; does not build, install or launch. It still writes host discovery artifacts. |
| `--skip-build` | Reuse a build receipt and its artifact from the same output directory, subject to source/artifact checks. Does not skip installation. |
| `--allow-emulator` | Explicit disposable Android emulator mode. Rejects a physical Android target when enabled; results remain emulated. No iOS simulator option exists here. |

There are no public `--run-id`, `--skip-install`, `--configuration` or `--timeout`
flags in this runner. Shell `--locked` / `--locked-command` and Python internal
entry points implement supervision, not user-facing bypasses.

Set these shell variables to your current targets and an absolute output directory
outside the checkout. No historical private serial is a reusable target:

```sh
export ANDROID_DEVICE='YOUR_ADB_SERIAL'
export IOS_DEVICE='YOUR_COREDEVICE_ID'
export IOS_UDID='YOUR_XCODE_UDID'
export QA_ARTIFACTS="$HOME/nitro-qa-campaign"
```

Full campaign, Android only, iOS only and one scenario:

```sh
bash scripts/physical-qa.sh --all --android-device "$ANDROID_DEVICE" \
  --ios-device "$IOS_DEVICE" --xcodebuild-device-id "$IOS_UDID" \
  --artifacts "$QA_ARTIFACTS"

bash scripts/physical-qa.sh --platform android --all \
  --android-device "$ANDROID_DEVICE" --artifacts "$HOME/nitro-qa-android"

bash scripts/physical-qa.sh --platform ios --all \
  --ios-device "$IOS_DEVICE" --xcodebuild-device-id "$IOS_UDID" \
  --artifacts "$HOME/nitro-qa-ios"

bash scripts/physical-qa.sh --platform android --scenario notification \
  --android-device "$ANDROID_DEVICE" --artifacts "$HOME/nitro-qa-notification"
```

Dry run and explicit, already booted disposable ARM64 emulator:

```sh
bash scripts/physical-qa.sh --all --dry-run \
  --android-device "$ANDROID_DEVICE" --ios-device "$IOS_DEVICE" \
  --xcodebuild-device-id "$IOS_UDID" --artifacts "$HOME/nitro-qa-preflight"

bash scripts/physical-qa.sh --platform android --allow-emulator \
  --android-device emulator-5554 --scenario retry --scenario multi-owner \
  --artifacts "$HOME/nitro-qa-emulator"
```

Replace `emulator-5554` with the current dedicated emulator's serial. The runner
neither creates nor deletes an AVD. `deviceReality: emulated` never becomes
physical evidence. To reuse a build, repeat its command/output directory with
`--skip-build`: the platform build receipt must exist, the non-Markdown,
non-`scripts/` source inventory must match, and the artifact hash must match.
Runner/parser SHA values are recorded separately. Changed receipts/artifacts
require a new build; existing installation alone is insufficient provenance.

## Execution, locks and cleanup

Android builds `:app:assembleRelease` for ARM64, copies the APK into the artifact
dossier, then installs it. Gradle can use normal ignored build/cache directories
in the checkout; not every intermediate is external. iOS uses fresh external
DerivedData, completes Metro/Hermes bundling before signing and verifies the
signature before installation and after custom runs. No Metro server is needed
for these bundled Release artifacts.

Installation and individual scenarios acquire the shared target lock implemented
by the smoke harness. Run IDs are generated, single-use, and each scenario gets
a fresh example process. Process-wide opt-out and terminal disposal cannot be
reused as a clean next scenario. There is no automatic lock override. On
interruption, the supervisor settles its owned process group; unknown/unsettled
state retains the lock. Investigate the lock's recorded worker/group before any
manual recovery; a dead leader alone does not prove descendants stopped.

The custom harness cancels probes, removes listeners, disposes wrapper/raw owners
and observes cleanup before host termination. Raw owners are released once;
accessing a disposed raw proxy is invalid. The host resumes the authorized app
on failure when needed, then stops only the example. iOS termination rechecks
PID/executable/container authority. Host log-capture cleanup exits are separate
from scenario exits. No global power/security setting is changed by the suite.

## Scenario matrix

`core` uses the existing core smoke runner. Other executable scenarios use the
QA route and validator. `--all` includes cases that cannot currently become PASS.

| Scenario | Android | iOS | Contract / boundary |
| --- | --- | --- | --- |
| `core` | Yes | Yes | Wrapper scheduling, cancellation, drain, reentrancy and terminal dispose; separate core logs/oracles. |
| `timers` | Yes | Yes | Timeout, three interval ticks, cancellation, ordered callbacks, reentrancy, post-dispose rejection. |
| `backlog` | Yes | Yes | 1,500 raw timeouts; 350 ms JS block, no intermediate drain, first drain and adapter callback inventory exactly 1,500 unique IDs. |
| `short-intervals` | Yes | Yes | 0, 0.1, 0.5, 0.999, 1, 1.5, 2, 10 ms; bounded progress, clear and dispose; not precision measurement. |
| `recreate` | Yes | N/A | Activity identity changes; PID/context/runtime/worker remain; subsequent callbacks work. Does not itself keep a pending timer across recreation. |
| `reload` | Yes | N/A | Real ReactHost reload, old worker termination, resource-free boundary before new timer request, new runtime callbacks. |
| `fgs` | Yes | N/A | Explicit service, qualifying live background callback, current foreground specialUse service/wake lock, cleanup. |
| `notification` | Yes | N/A | Explicit A/B, implicit C/D, pending-stop E; current notification title/text. |
| `optout` | Yes | N/A | Repeated process opt-out and second raw owner; callbacks with wake lock and no service. |
| `multi-owner` | Yes | N/A | Two raw owners; B continues after A release/dispose, notification takeover and final cleanup. |
| `background` | Yes | Yes | Home/SpringBoard, own lifecycle, live callback before resume, same PID/artifact. |
| `long-run` | Yes | N/A | Five-minute Android session; current service/wake lock sampled again before resume. |
| `expiration` | N/A | Partial | Natural observation up to 75 seconds before resume; timer progress after resume. Full private-task contract stays `NOT_OBSERVED`. |
| `retry` | Conditional | N/A | Real OS background start refusal, then legitimate foreground retry. Without refusal: `NOT_OBSERVED`. |
| `battery-saver` | `NOT_RUN` | N/A | Runner does not enable/restore global Battery Saver settings. |

The retry scenario uses a bounded example-native Handler pulse to issue the
request when ordinary JS timers may be paused. That pulse is a control adapter,
not a product timer callback. It requires a target-PID OS refusal between request
and settle pulses; it does not inject failed initial FGS promotion.

## Evidence and independent validation

The example-only route is:

```text
nitrobgtimerexample://smoke?runId=ID&mode=qa&scenario=NAME&deviceId=DEVICE
```

The parser requires valid run/scenario/device fields and rejects duplicate query
fields. QA hides interactive controls and prevents incompatible core/UI/QA use.
The Android bridge observes public Activity/ReactContext identities, named worker
threads and active notifications, and invokes recreation/reload. It does not read
private library fields. iOS adds lifecycle observation, not extra background time.

`[NitroBgPhysical]` records carry runId, scenario, device/platform/OS, actual PID,
runtime identity, source sequence, wall/monotonic timestamps, AppState and events.
Callback IDs and native event IDs/types/sequences are separate inventories. Backlog
batch lines are expanded by the parser; line count is not callback count.
Identical native/console mirrors count once. Conflicting identities, sequence gaps,
stale runs, missing/duplicate callbacks, invalid clocks, JS errors and incomplete
cleanup fail validation. A RESULT marker alone is insufficient.

Background checks require successful Home and resume, active → background → active
observations and a qualifying callback **received live by the host before resume**.
Host UTC/monotonic receipt times and byte offsets are retained separately from
device clocks. Do not assume host/device wall clocks are synchronized. iOS also
requires the own-process UIKit background publication. A post-resume callback
with stale JS AppState is not background proof.

Android snapshots inspect current ServiceRecord/foreground type, NotificationRecord
and UID-attributed wake lock, not historical ACQ/REL lines. Cleanup requires no
named timer worker, timer service or owned wake lock. These are observable
resources; absence of a notification alone does not establish service teardown.

Android provenance compares installed APK identity/hash before/after. iOS binds
the signed local bundle inventory, install receipt, current app metadata and
executable/container chain before/after. **The interface cannot read back all
remote installed iOS bundle bytes.** iOS private task identifiers/end timestamps
are not fully exposed in Release; a cleanup callback test or expiration warning
is supporting evidence, not direct proof of every private task transition.

[physical-qa-validate.py](scripts/physical-qa-validate.py) validates captured records
independently of scenario self-checks; runner-side resource/provenance checks also
matter. It is an importable oracle, not a standalone CLI with validation flags.
Raw backlog callbacks come from the explicit example adapter, not the public
wrapper's automatic drain. Distinguish direct observations, adapter observations
and inferences when writing a report.

## Artifacts, reports and exits

A completed campaign writes `summary.json` (an array of platform/scenario rows),
platform build receipts, source inventories, copied APK or iOS bundle inventory,
installation/discovery logs, and `evidence-sha256.json`. Custom runs live under
`PLATFORM/pqa-SCENARIO-ID/` with `context.json`, `device.log`,
`live-receipts.jsonl`, `validated-events.json`, command logs/`commands.jsonl`,
raw `.exit` files and `result.exit`. Core uses its own runner logs. Preflight
failure before directory creation need not produce this layout. No final prose
report is automatically generated; maintainers reconcile attempts and gaps.

| Exit | Meaning |
| --- | --- |
| `0` | No selected row is FAIL/BLOCKED/NOT_OBSERVED; can still include NOT_RUN/N/A or PREFLIGHT_ONLY. Inspect summary. |
| `1` | Contract failure (including a custom scenario timeout recorded as FAIL in the campaign). |
| `2` | Preflight/tooling block or unqualified observation; BLOCKED/NOT_OBSERVED takes precedence over FAIL in campaign aggregation. |
| `124` | Bounded child/scenario timeout in raw evidence; not necessarily the top-level campaign exit. |

`NOT_APPLICABLE`, `NOT_RUN`, `NOT_OBSERVED`, `BLOCKED` and PASS are different
states. Retain failed attempts and capture-cleanup exits (including intentional
host capture termination) without rewriting them after a later success.

## Qualification boundaries

The 2026-10-15 retained qualification dossier reports selected Release runs on a
Pixel 9 Pro XL (Android 17/API 37) and iPhone 16e (iOS 26.5), RN 0.87.1/Nitro
0.37.1. Selected physical results cover Android core/timers/backlog/short intervals,
recreation/reload, FGS/notification/opt-out/multi-owner, background and five-minute
long-run; iOS core/timers/backlog/short intervals and live background delivery.
These are historical artifact-specific results, not fresh runs of this HEAD.
The physical artifacts precede some final example diagnostic changes; current
parser replay of recordings is host validation, not new physical execution.
The dossier is not distributed with this repository; preserve its receipts/logs
with any release qualification record instead of relying on this summary alone.

Explicit remaining limits:

- F7 refusal/retry was qualified on a disposable Android emulator; the physical
  attempt was interrupted and remains `NOT_RUN`, not PASS. Survival of every
  failed initial promotion/missed handshake remains unqualified everywhere.
- Natural iOS expiration and post-resume progress were observed, but full private
  task-ID release/end-timing qualification remains `NOT_OBSERVED`.
- Backlog 1,500 uses a raw HybridObject adapter; the wrapper's 1,500-event automatic
  delivery path is a separate unqualified contract.
- Battery Saver and some lock/unlock checks were not run. Background Home evidence
  does not fill those gaps.
- There is no universal OEM/OS/power-mode guarantee, unlimited iOS background
  guarantee, or App Store/Play Store distribution qualification.

## Host regression checks

```sh
python3 scripts/physical-qa.test.py
node --test scripts/smoke-harness.test.cjs scripts/smoke-runner-fixture.test.cjs
```

These are host fixture/supervision checks, not device campaigns. Negative fixtures
exercise identities, callback loss/duplicates, stale/partial publications, clocks,
Home/resume boundaries, process/artifact changes, cleanup and owned descendants
that ignore TERM. The two entry-point discovery tests assert only exit 2: on the
current baseline they can pass because protection rejects before discovery.
Do not cite those two tests as independent live discovery coverage until the
historical gate and fixture assertions are maintained.
