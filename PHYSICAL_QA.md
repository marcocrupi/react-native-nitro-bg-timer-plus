# Physical device QA

The suite operates only on the example application. It builds Release artifacts from the
current sources, installs them on explicitly identified physical devices, and writes all
artifacts, receipts, logs, validation output and raw exits outside the repository.

```sh
bash scripts/physical-qa.sh --all \
  --android-device 49021FDAS003BC \
  --ios-device C274F5E5-B73D-556F-9589-E384F79EF805 \
  --xcodebuild-device-id 00008140-00195819267B801C \
  --artifacts /tmp/nitro-physical-qa-new-run
```

Use the connected devices' current identifiers. Discovery rejects absent, ambiguous,
unpaired, unauthorized or simulated targets. The CoreDevice ID and Xcode UDID are
resolved to the same iPhone. A dry run performs read-only discovery and preflight:

```sh
bash scripts/physical-qa.sh --all --dry-run \
  --android-device 49021FDAS003BC \
  --ios-device C274F5E5-B73D-556F-9589-E384F79EF805 \
  --xcodebuild-device-id 00008140-00195819267B801C \
  --artifacts /tmp/nitro-physical-preflight
```

Select `--platform android|ios|both` and repeat `--scenario NAME` for a subset.
Scenarios are `core`, `timers`, `backlog`, `short-intervals`, `recreate`, `reload`,
`fgs`, `notification`, `optout`, `multi-owner`, `background`, `long-run`,
`expiration`, `retry`, and `battery-saver`. Platform-specific scenarios report
`NOT_APPLICABLE` on the other platform. Battery Saver reports `NOT_RUN`: this
runner does not force global power settings. The Android long-run lasts five minutes.
A natural iOS expiration observation is bounded to 75 seconds before resume.

`--skip-build` requires a receipt in the same artifact directory with identical source
inventory and artifact hash. Changed sources or artifacts require a new build. Every
scenario receives a generated, single-use run ID and a fresh example process. Opt-out
and terminal dispose cannot contaminate another scenario. The existing target lock
also covers installation. An interrupted, unsettled lock is retained for investigation;
do not remove it without establishing that its recorded worker/process group stopped.

After an explicit switch to a disposable Android emulator, use its own serial and
`--allow-emulator`. The default remains physical-only. The report labels these runs
`deviceReality: emulated`; they do not replace or extend physical-device evidence.
For example:

```sh
bash scripts/physical-qa.sh --platform android --allow-emulator \
  --android-device emulator-5622 --scenario retry --scenario multi-owner \
  --artifacts /tmp/nitro-disposable-qa
```

Build requirements: installed pinned JavaScript dependencies, Android SDK/JDK, Xcode,
existing development signing, Python 3, Node and the usual shell tools. iOS requires
`Pods/Manifest.lock` to match `Podfile.lock`. If the generated Pods sandbox is stale,
restore it with the pinned Ruby/Bundler environment and `bundle exec pod install
--deployment`; inspect generated deltas and preserve all tracked project files.
Dependencies, signing, manifests, entitlements and library sources are never patched
by the QA runner. A fresh iOS DerivedData directory is used for every build. Metro and
Hermes resources are finalized by the Xcode bundle phase before CodeSign. Strict
signature verification precedes installation and is repeated after each custom run.

## Evidence and oracles

The explicit internal route is:

```
nitrobgtimerexample://smoke?runId=ID&mode=qa&scenario=NAME&deviceId=DEVICE
```

Normal example use and `mode=ui` retain their existing routes. QA requires all fields,
rejects malformed/duplicate query fields, and prevents incompatible core/UI/QA use.
QA hides the normal interactive timer controls while running. The Android example-only
bridge can recreate its Activity, reload its ReactHost, and observe public thread,
ReactContext, Activity and active-notification identities. It reads no private library
fields. The iOS observer records UIKit lifecycle changes without adding capabilities
or background tasks.

`[NitroBgPhysical]` publications carry run/scenario/platform/device, OS, PID, runtime
identity, source sequence, wall and monotonic timestamps, AppState, event and outcome.
Native iOS lifecycle publications use `[NitroBgPhysicalNative]`. The validator binds
publications to the actual process. Identical console/native mirrors share source
identities and count once; conflicting identities, sequence gaps, stale runs, missing
callbacks, duplicate timeout IDs, invalid clocks, JS errors and incomplete cleanup fail.
A RESULT marker alone never qualifies a run.

`core` reuses the original smoke runners. `timers` and `short-intervals` exercise the
public wrapper's callbacks, cancellation and terminal dispose. The backlog uses an
explicit **example-only raw HybridObject dispatcher**, because the public wrapper
automatically drains its own object. It schedules 1,500 IDs, bounds JS blockage to
350 ms, makes no intermediate raw drain, and then requires the first raw drain to
contain all 1,500 expired timeout events. It dispatches registered application callbacks
and publishes all individual native IDs/types/sequences and callback IDs in small
batches. The parser expands and verifies those inventories; console line count is
never a callback count. This raw-adapter result does not independently qualify the
wrapper's 1,500-event automatic delivery path. Raw interval tests drain repeatedly
because pending interval events intentionally coalesce until drained.

Background qualification requires an initial active state, successful HOME/SpringBoard
activation, observed background, a qualifying callback **received live by the host
before issuing resume**, successful resume, final active state, unchanged PID and
artifact, and ordered clocks. iOS also requires the own-process UIKit background
publication. A callback received after resume does not qualify. Live receipt times
and byte offsets are retained independently of device timestamps. FGS tests include
current service/notification/power snapshots; the five-minute test samples the service
again before resume. Wake locks are attributed to the example UID. Current cleanup
snapshots must have no timer worker, owned wake lock or timer service remaining.

On iOS, provenance records the signed local bundle inventory, exact install receipt,
current app metadata and the process executable in the same installed container before
and after the run. **Remote installed bundle bytes cannot be read back through this
interface**; the suite does not claim that stronger guarantee. Library Release builds
also do not expose their private background-task identifiers or release timestamps.
The iOS cleanup callback test and natural expiration observation retain that diagnostic
gap. Expiration is reported `NOT_OBSERVED` for full I05 qualification rather than PASS
based only on a warning or a resumed callback.

Android `retry` attempts a real background request after the launch grace window,
then a legitimate foreground request. A bounded example-only native Handler pulse
drives this diagnostic request while ordinary JS timers may be suspended. It is not
counted as a product timer callback. The OS refusal must belong to the target PID
and fall between the request and settle pulses. If no OS refusal is observed, it reports
`NOT_OBSERVED`, not a reset/retry PASS. It never injects a failed initial promotion on
a physical phone. Survival of every initial FGS promotion failure remains unqualified.
Timing windows do not promise real-time 1 ms precision, unlimited background execution,
all OEM/OS compatibility, or store-distribution readiness.

## Host checks and exits

```sh
python3 scripts/physical-qa.test.py
node --test scripts/smoke-harness.test.cjs scripts/smoke-runner-fixture.test.cjs
```

The host tests use the real parser/entry point and controlled diagnostic responses.
They cover missing/ambiguous devices, identity, callback loss/duplicates, stale or
partial markers, invalid clocks/order, failed HOME/resume, post-resume callbacks,
interrupted capture, changed artifacts/PIDs, incomplete cleanup, and valid controls.
A real owned process-group timeout witness checks that descendants ignoring TERM are
settled before completion. Host tests do not replace physical results.

Exit 0 means the selected executable contracts passed; 1 indicates a contract failure;
2 indicates preflight/tooling failure or explicitly unqualified observation; 124 is a
bounded timeout. `summary.json` distinguishes `NOT_OBSERVED`, `NOT_RUN`,
`NOT_APPLICABLE` and `BLOCKED` from PASS. Failed attempts and their raw exits remain
in separate run directories. Capture cleanup exits (for example intentional host -9)
are recorded separately from scenario exits. Only the identified example process is
stopped, with current process/container authority rechecked before iOS termination.

The initial suite is gated to the PO-authorized commit
`741b0799b1be0c5f48466a2a3a2827b387e57a66` and SHA-256 values of the six frozen F2–F10
files. Updating that baseline is an explicit subsequent maintenance action. No commit,
push, tag, release, version bump or publication is performed.
