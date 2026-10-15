#!/usr/bin/env bash
set -euo pipefail

# Shared runner functions live here so the authorized runners use one validator.
# Sourcing this file does not start an Android run.
harness_validate() {
  node - "$@" <<'JS'
const fs = require('node:fs')
const [file, runId, platform, pid, flow = 'core', mode = 'poll', processName = 'NitroBgTimerExample'] = process.argv.slice(2)
const [backgroundPhase = 'none', homeBoundary = '-1', resumeBoundary = '-1'] = process.argv.slice(9)
const fail = (reason) => { console.log(`FAIL runId=${runId} pid=${pid} harness=${reason}`); process.exit(1) }
if (!/^[A-Za-z0-9._-]{1,80}$/.test(runId) || !/^\d+$/.test(pid) || !['android', 'ios'].includes(platform) || !['core', 'main', 'fgs-optout', 'fgs-optout-deep'].includes(flow) || !['poll', 'final'].includes(mode)) process.exit(2)
const records = []
const seen = new Set()
const foreignRunIds = new Set()
let offset = 0
for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
  const line = rawLine.replace(/\r$/, '')
  const startOffset = offset
  offset += Buffer.byteLength(rawLine + '\n')
  // log stream prints its predicate as an informational header.
  if (line.startsWith('Filtering the log data using')) continue
  const android = line.match(/^\d\d-\d\d\s+\S+\s+(\d+)\s+\d+\s+([VDIWEF])\s+([^:]+):\s?(.*)$/)
    || line.match(/^\d\d-\d\d\s+\S+\s+([VDIWEF])\/([^ (]+)\(\s*(\d+)\):\s?(.*)$/)?.map((x, i, a) => i === 1 ? a[3] : i === 2 ? a[1] : i === 3 ? a[2] : x)
  const ios = line.match(/\s([^\s\[]+)\[(\d+):[^\]]+\]\s+(.*)$/)
  const sourcePid = platform === 'android' ? android?.[1] : ios?.[2]
  const message = platform === 'android' ? android?.[4] : ios?.[3]
  const own = sourcePid === pid && (platform === 'android' || ios?.[1] === processName)
  // Recognize publications at the message boundary. Accessibility diagnostics
  // can quote the entire on-screen log inside a different process's message.
  const payload = (platform === 'ios'
    ? message?.replace(/^(?:\([^)]*\)|\[[^\]]+:[^\]]+\])\s+/, '')
    : message)?.replace(/^\[\d\d:\d\d:\d\d\.\d+\]\s+/, '')
    .replace(/^\[NitroBgSmoke\]\s+(?=\[NitroBgUiSmoke\])/, '')
  const marker = payload?.match(/^\[(NitroBg(?:Ui)?Smoke)\]\s+([A-Z_]+)(?:\s+(PASS|FAIL))?\s+(.*)$/)
  const rawMarker = /\[NitroBg(?:Ui)?Smoke\]\s+(?:START|STEP|RESULT|CONTEXT|PASS|FAIL)\b/.test(line)
  if (!sourcePid && rawMarker) fail('marker_pid_unavailable')
  const entries = [...(marker?.[4] ?? '').matchAll(/(?:^|\s)([A-Za-z][A-Za-z0-9]*)=([^\s]+)/g)].map(m => [m[1], m[2]])
  if (own && new Set(entries.map(([key]) => key)).size !== entries.length) fail('ambiguous_marker_fields')
  const fields = Object.fromEntries(entries)
  if (marker && !own) foreignRunIds.add(fields.runId)
  if (marker && fields.runId === runId && !own) fail('marker_process_mismatch')
  // RN can report primitive throwables without an Error/Exception name.
  const jsErrorPriority = platform === 'android'
    ? ['E', 'F'].includes(android?.[2]) && android?.[3].trim() === 'ReactNativeJS'
    : /^\d{4}-\d\d-\d\d\s+\S+\s+[EF]\s/.test(line) && /^\[com\.facebook\.react\.log:javascript\]/.test(message ?? '')
  // Errors must be actual error records, not module names or the log predicate.
  if ((own || !sourcePid) && (message || line) && (
    jsErrorPriority || /FATAL EXCEPTION|Fatal signal|SIGABRT|std::terminate|\bRCTFatal\b|Terminating app due to|uncaught exception|\bFatal error:|\bInvariant Violation:|\bRedBox\b|Unhandled JS Exception:|Exception in HostFunction:/.test(message ?? line)
    || (platform === 'android' && android?.[2] === 'E' && /(?:^|\s)(?:Error|[A-Za-z]+Exception):/.test(message))
    || /(?:^|[\s\[])(?:Error|TypeError|ReferenceError|SyntaxError|RangeError):/.test(message ?? line)
  )) fail('runtime_crash_or_js_error')
  if (!own || !marker) continue
  const kind = marker[2]
  const status = marker[3]
  const qualification = ['START', 'STEP', 'RESULT', 'CONTEXT', 'PASS', 'FAIL', 'TIMER_CALLBACK', 'CLEAR_TIMEOUT_CAUSALITY'].includes(kind)
  if (qualification && fields.runId !== runId && flow === 'core') fail('stale_execution')
  if (flow !== 'core' && marker[1] === 'NitroBgSmoke' && kind === 'START') {
    const action = records.find(r => r.family === 'NitroBgUiSmoke' && r.kind === 'START' && r.fields.runId === runId && r.fields.section === 'core-smoke' && r.fields.action === 'run')
    const binding = records.find(r => r.family === 'NitroBgSmoke' && r.kind === 'UI_CORE_BINDING' && r.fields.runId === runId && r.fields.coreRunId === fields.runId)
    if (!action || !binding || binding.position <= action.position) fail('stale_core_disposed_before_UI')
  }
  if (kind === 'FAIL' || status === 'FAIL') fail('failure_marker:' + (fields.reason ?? 'unspecified'))
  // Console, native mirror and UI log copies carry identical payloads.
  // PID mismatches and FAILs were checked BEFORE this diagnostic de-duplication.
  const key = marker[0]
  if (seen.has(key)) continue
  seen.add(key)
  records.push({ family: marker[1], kind, status, fields, rawFields: marker[4], position: records.length, startOffset, endOffset: offset })
}
// A UI core has a distinct runId. Its diagnostic copies must share the UI PID,
// including foreign copies that appeared before the binding in the capture.
for (const r of records) {
  if (r.family === 'NitroBgSmoke' && r.kind === 'UI_CORE_BINDING' && r.fields.runId === runId && foreignRunIds.has(r.fields.coreRunId)) fail('marker_process_mismatch')
}
const requiredSteps = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'batchOrdering', 'reentrancy', 'backgroundWindow', 'dispose']
function core(id) {
  const xs = records.filter(r => r.family === 'NitroBgSmoke' && r.fields.runId === id)
  const start = xs.find(r => r.kind === 'START')
  const result = xs.find(r => r.kind === 'RESULT' && r.status === 'PASS')
  if (!result) return false
  if (!start || start.position >= result.position) fail('missing_or_late_START')
  const steps = xs.filter(r => r.kind === 'STEP' && r.status === 'PASS')
  const expected = platform === 'ios'
    ? ['iosEventDiagnostics', 'setTimeout', 'clearTimeout', 'setInterval', 'iosEventDelivery', ...requiredSteps.slice(3)]
    : requiredSteps
  if (steps.map(r => r.fields.name).join(',') !== expected.join(',')) fail('missing_or_unordered_steps')
  if (steps.some(r => r.position <= start.position || r.position >= result.position)) fail('steps_outside_run')
  const evidence = (kind, fields, beforeName) => {
    const event = xs.find(r => r.kind === kind && Object.entries(fields).every(([k,v]) => r.fields[k] === v))
    const step = steps.find(r => r.fields.name === beforeName)
    const lowerBound = steps[steps.indexOf(step) - 1] ?? start
    if (!event || event.position <= lowerBound.position || event.position >= step.position) fail(`missing_or_late_${kind}`)
  }
  evidence('TIMER_CALLBACK', { kind: 'timeout' }, 'setTimeout')
  evidence('TIMER_CALLBACK', { kind: 'interval', ticks: '3' }, 'setInterval')
  evidence('CLEAR_TIMEOUT_CAUSALITY', { status: 'valid' }, 'clearTimeout')
  const cancellation = xs.find(r => r.kind === 'CLEAR_TIMEOUT_CAUSALITY')
  const events = xs.filter(r => r.kind === 'CLEAR_TIMEOUT_EVENT')
  const order = ['schedule', 'clearRequested', 'clear', 'observed']
  if (events.map(r => r.fields.kind).join(',') !== order.join(',') ||
      events.some((r, i) => r.fields.seq !== String(i + 1) || !Number.isFinite(Number(r.fields.at))) ||
      events.some((r, i) => i && Number(r.fields.at) < Number(events[i - 1].fields.at)) ||
      events[0]?.position <= steps.find(r => r.fields.name === 'setTimeout').position || events.at(-1)?.position >= cancellation.position ||
      cancellation.fields.order !== order.join(',') || cancellation.fields.callbackAt !== 'none' ||
      cancellation.fields.delayMs !== '160' ||
      Number(cancellation.fields.scheduleAt) !== Number(events[0]?.fields.at) ||
      Number(cancellation.fields.clearAt) !== Number(events[2]?.fields.at) ||
      Number(cancellation.fields.clearAt) - Number(cancellation.fields.scheduleAt) >= 160 ||
      Number(events[3]?.fields.at) - Number(events[0]?.fields.at) < 160) fail('invalid_clear_causality')
  const ticks = xs.filter(r => r.kind === 'BACKGROUND_TICK')
  if (ticks.map(r => r.fields.tick).join(',') !== '1,2,3,4,5,6') fail('missing_background_callbacks')
  evidence('BACKGROUND_READY', {}, 'backgroundWindow')
  const ready = xs.find(r => r.kind === 'BACKGROUND_READY')
  const backgroundStep = steps.find(r => r.fields.name === 'backgroundWindow')
  if (ticks.some(r => r.position <= ready.position || r.position >= backgroundStep.position)) fail('background_ticks_outside_step')
  if (platform === 'ios') {
    evidence('IOS_ARCH', {}, 'iosEventDiagnostics')
    evidence('IOS_EVENT_MODULE', { nativeModulePresent: 'true' }, 'iosEventDiagnostics')
    evidence('IOS_EVENT_LISTENER', { installed: 'true' }, 'iosEventDiagnostics')
    evidence('IOS_TIMER', { marker: 'ios-timeout-fired' }, 'setTimeout')
    evidence('IOS_TIMER', { marker: 'ios-interval-fired' }, 'setInterval')
    evidence('IOS_EVENT_DELIVERY', { timeoutFired: 'true', intervalFired: 'true', status: 'ok' }, 'iosEventDelivery')
    evidence('IOS_EVENT_DELIVERY_OK', {}, 'iosEventDelivery')
  }
  return true
}
let complete = false
if (flow === 'core') complete = core(runId)
else {
  const context = records.find(r => r.family === 'NitroBgUiSmoke' && r.kind === 'CONTEXT' && r.fields.runId === runId && r.fields.mode === 'ui')
  const actions = flow === 'main'
    ? ['set-timeout/schedule', 'set-timeout/cancel', 'set-interval/start', 'set-interval/stop', 'set-interval/reset', 'background/js-comparison', 'background/configure-notification', 'background/start-mode', 'background/stop-mode', 'background/start', 'background/stop', 'concurrent/start-all', 'concurrent/stop-all', 'cleanup/mount', 'cleanup/unmount', 'hook/start', 'hook/restart', 'hook/stop', 'stress/create-100', 'core-smoke/run']
    : flow === 'fgs-optout' ? ['background/disable-fgs']
    : ['background/fgs-optout-disable', 'background/fgs-optout-timeout-started', 'background/fgs-optout-timeout-fired']
  for (const r of records) {
    if (r.family === 'NitroBgUiSmoke' && r.fields.runId !== runId) fail('stale_ui_execution')
    if (r.family === 'NitroBgSmoke' && r.kind === 'START') {
      const action = records.find(x => x.family === 'NitroBgUiSmoke' && x.kind === 'START' && x.fields.section === 'core-smoke' && x.fields.action === 'run')
      if (!context || !action || r.position < action.position) fail('stale_core_disposed_before_UI')
    }
  }
  let position = context?.position ?? -1
  complete = Boolean(context)
  for (const action of actions) {
    const [section, name] = action.split('/')
    const xs = records.filter(r => r.family === 'NitroBgUiSmoke' && r.fields.runId === runId && r.fields.section === section && r.fields.action === name)
    const start = xs.find(r => r.kind === 'START')
    const pass = xs.find(r => r.kind === 'PASS')
    if (pass && (!context || !start || start.position <= position || pass.position <= start.position)) fail('UI_action_missing_START_or_order')
    if (!pass) complete = false
    if (pass) position = pass.position
  }
  if (complete && flow === 'main') {
    const starts = records.filter(r => r.family === 'NitroBgSmoke' && r.kind === 'START')
    if (starts.length !== 1 || !core(starts[0].fields.runId)) fail('UI_core_incomplete')
    const result = records.find(r => r.family === 'NitroBgSmoke' && r.kind === 'RESULT')
    if (result.position >= position) fail('UI_core_result_after_action_PASS')
  }
}
// Background qualification is separate from core completion. Boundaries are
// byte offsets captured by this runner immediately BEFORE each adb action.
// Markers already buffered before HOME/resume cannot satisfy those actions.
if (backgroundPhase !== 'none') {
  if (platform !== 'android' || flow !== 'core' || !['ready', 'away', 'resumed'].includes(backgroundPhase)) process.exit(2)
  const xs = records.filter(r => r.family === 'NitroBgSmoke' && r.fields.runId === runId)
  const ready = xs.find(r => r.kind === 'BACKGROUND_READY')
  const ended = xs.some(r => r.kind === 'RESULT' || (r.kind === 'STEP' && r.fields.name === 'backgroundWindow'))
  const gap = why => fail('background_precondition:' + why)
  const pending = () => { if (ended || mode === 'final') gap('window_lost_or_incomplete'); process.exit(3) }
  if (!ready) pending()
  const initial = xs.find(r => r.kind === 'APP_STATE' && r.fields.state === 'active' && r.position < ready.position)
  if (!initial) gap('initial_active_missing')
  // Validate the FIRST qualifying active marker; never replace an invalid origin
  // with a later active/mirror. Require a whole decimal token before conversion.
  const clock = r => {
    // Include empty occurrences: `monotonicAt= monotonicAt=0` is not a clock.
    const values = [...r.rawFields.matchAll(/(?:^|\s)monotonicAt=([^\s]*)/g)]
    const value = values.length === 1 ? values[0][1] : ''
    return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) ? Number(value) : NaN
  }
  if (!Number.isFinite(clock(initial))) gap('initial_active_clock_invalid')
  if (backgroundPhase === 'ready') {
    if (ended || xs.some(r => r.kind === 'BACKGROUND_TICK' && r.fields.tick === '6')) gap('core_completed_before_HOME')
    const state = xs.filter(r => r.kind === 'APP_STATE').at(-1)
    if (state?.fields.state !== 'active') gap('not_active_before_HOME')
    console.log(`BACKGROUND_PRECONDITION ready runId=${runId} pid=${pid}`)
    process.exit(0)
  }
  const home = Number(homeBoundary), resume = Number(resumeBoundary)
  if (!Number.isSafeInteger(home) || home < ready.endOffset) gap('HOME_boundary_invalid')
  const away = xs.find(r => r.kind === 'APP_STATE' && r.fields.state === 'background' && r.position > ready.position && r.startOffset >= home)
  if (!away) pending()
  const tick = xs.find(r => r.kind === 'BACKGROUND_TICK' && r.fields.state === 'background' && r.position > away.position && r.startOffset >= home)
  if (!tick) pending()
  if (xs.some(r => r.kind === 'APP_STATE' && r.fields.state === 'active' && r.position > away.position && r.position < tick.position)) gap('tick_after_resume')
  // initial <= background <= callback <= resumed active. Equal clocks are
  // allowed: the position/byte-boundary checks above and below order the events.
  if (!Number.isFinite(clock(away)) || !Number.isFinite(clock(tick)) || clock(initial) > clock(away) || clock(away) > clock(tick)) gap('background_clock_invalid')
  if (backgroundPhase === 'away') {
    if (ended) gap('window_completed_before_resume')
    console.log(`BACKGROUND_PRECONDITION callback runId=${runId} pid=${pid} tick=${tick.fields.tick}`)
    process.exit(0)
  }
  if (!Number.isSafeInteger(resume) || resume < tick.endOffset || resume < home) gap('resume_boundary_invalid')
  const active = xs.find(r => r.kind === 'APP_STATE' && r.fields.state === 'active' && r.position > tick.position && r.startOffset >= resume)
  if (!active) pending()
  if (!Number.isFinite(clock(active)) || clock(active) < clock(tick)) gap('resume_clock_invalid')
  const step = xs.find(r => r.kind === 'STEP' && r.fields.name === 'backgroundWindow')
  if (step && active.position >= step.position) gap('resume_after_window')
  if (!complete) process.exit(3)
  console.log(`BACKGROUND_VALIDATED runId=${runId} pid=${pid} HOME=0 resume=0 active-background-active callback=${tick.fields.tick}`)
}
if (complete) { console.log(`VALIDATED runId=${runId} pid=${pid} platform=${platform} flow=${flow}`); process.exit(0) }
if (mode === 'final') fail('incomplete_sequence')
process.exit(3)
JS
}

harness_lock() {
  local key
  key="$(printf '%s' "$1:$2" | shasum -a 256 | cut -d ' ' -f 1)"
  HARNESS_LOCK_DIR="${TMPDIR:-/tmp}/nitro-smoke-lock-${key}"
  if ! mkdir "$HARNESS_LOCK_DIR" 2>/dev/null; then
    echo "HARNESS/TOOLING target busy or interrupted lock: ${HARNESS_LOCK_DIR}" >&2
    return 2
  fi
  echo "$$" >"${HARNESS_LOCK_DIR}/pid"
  if [[ -n "${3:-}" ]] && ! mkdir "${TMPDIR:-/tmp}/nitro-smoke-run-${key}-$3" 2>/dev/null; then
    echo "Refusing reused runId=$3 for target=$2" >&2
    return 2
  fi
}

harness_unlock() {
  if [[ -n "${HARNESS_LOCK_DIR:-}" && -f "${HARNESS_LOCK_DIR}/pid" ]] &&
    [[ "$(cat "${HARNESS_LOCK_DIR}/pid")" == "$$" ]]; then
    rm "${HARNESS_LOCK_DIR}/pid"
    rmdir "$HARNESS_LOCK_DIR"
  fi
}

harness_android_artifact() {
  local adb_bin="$1" device="$2" package="$3" expected="${4:-}" installed_path copied hash
  local expected_pid="${5:-}" capture_pid="${6:-}" actual_pid
  installed_path="$("$adb_bin" -s "$device" shell pm path "$package" | tr -d '\r' || true)"
  if [[ "$installed_path" != package:* || "$installed_path" == *$'\n'* ]]; then
    echo "Cannot identify a single installed APK for ${package}" >&2
    return 2
  fi
  copied="$(mktemp -t nitro-smoke-installed.XXXXXX.apk)"
  "$adb_bin" -s "$device" pull "${installed_path#package:}" "$copied" >/dev/null
  hash="$(shasum -a 256 "$copied" | cut -d ' ' -f 1)"
  if [[ -n "$expected" && "$hash" != "$(shasum -a 256 "$expected" | cut -d ' ' -f 1)" ]]; then
    echo "Installed APK does not match ${expected}" >&2
    return 2
  fi
  echo "ARTIFACT installed=${installed_path#package:} sha256=${hash} copy=${copied}"
  HARNESS_APK_HASH="$hash"
  # Pull/hash can outlive the observed process or the capture. Recheck the final
  # authority here so every Android PASS path uses the same boundary.
  if [[ -n "$expected_pid" ]]; then
    actual_pid="$("$adb_bin" -s "$device" shell pidof "$package" 2>/dev/null | tr -d '\r' || true)"
    [[ "$actual_pid" == "$expected_pid" ]] || { echo "FAIL process_changed expected=$expected_pid actual=$actual_pid"; return 1; }
    kill -0 "$capture_pid" 2>/dev/null || { echo "FAIL log_capture_ended"; return 1; }
  fi
}

harness_compare_apps() {
  node - "$1" "$2" <<'JS'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
function inventory(root, sub = '') {
  return fs.readdirSync(path.join(root, sub)).sort().flatMap(name => {
    const file = path.join(sub, name), full = path.join(root, file)
    return fs.statSync(full).isDirectory() ? inventory(root, file) : [[file, crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')]]
  })
}
try {
  const a = JSON.stringify(inventory(process.argv[2])), b = JSON.stringify(inventory(process.argv[3]))
  if (a !== b) throw new Error('installed_app_does_not_match_build')
  console.log('ARTIFACT app=' + process.argv[2] + ' installed=' + process.argv[3] + ' sha256=' + crypto.createHash('sha256').update(a).digest('hex'))
} catch (e) { console.error(e.message); process.exit(2) }
JS
}

# Keep the lock until the command supervisor proves its entire owned group settled.
# Interrupted/unknown owners are never reclaimed automatically (including SIGKILL).
harness_with_maestro_lock() {
  local lock_dir="${TMPDIR:-/tmp}/nitro-maestro-driver.lock"
  local owner="$$-$(node -e 'console.log(require("node:crypto").randomUUID())')"
  local worker status=0 cancelled=0 old_term old_int
  old_term="$(trap -p TERM)"; old_int="$(trap -p INT)"
  if ! mkdir "$lock_dir" 2>/dev/null; then
    echo "HARNESS/TOOLING Maestro driver busy; manual recovery if interrupted: $lock_dir" >&2
    return 2
  fi
  # Install cancellation before writing ownership or spawning. A partial lock is
  # deliberately retained if ownership/state cannot be written or verified.
  trap 'cancelled=143; [[ "$(cat "$lock_dir/owner" 2>/dev/null)" != "$owner" ]] || : >"$lock_dir/cancel"' TERM
  trap 'cancelled=130; [[ "$(cat "$lock_dir/owner" 2>/dev/null)" != "$owner" ]] || : >"$lock_dir/cancel"' INT
  if printf '%s\n' "$owner" >"$lock_dir/owner" &&
     printf '%s\n' "$$" >"$lock_dir/pid" &&
     printf 'settled\n' >"$lock_dir/state"; then
    if [[ "$cancelled" -eq 0 ]]; then
      ( export HARNESS_DRIVER_LOCK="$lock_dir" HARNESS_DRIVER_OWNER="$owner"; "$@" ) &
      worker=$!
      # wait is interruptible; a signal is a cancellation request, not settlement.
      while kill -0 "$worker" 2>/dev/null; do
        wait "$worker" || status=$?
      done
      wait "$worker" || status=$?
    fi
  else
    status=2
  fi
  trap - TERM INT
  [[ -z "$old_term" ]] || eval "$old_term"
  [[ -z "$old_int" ]] || eval "$old_int"
  if [[ "$(cat "$lock_dir/owner" 2>/dev/null)" == "$owner" &&
        "$(cat "$lock_dir/state" 2>/dev/null)" == settled ]]; then
    rm -f "$lock_dir/owner" "$lock_dir/pid" "$lock_dir/state" "$lock_dir/cancel" "$lock_dir/supervisor" "$lock_dir/group"
    rmdir "$lock_dir" || status=2
  else
    echo "HARNESS/TOOLING Maestro unsettled/unknown ownership; lock retained. Manual recovery requires verifying the recorded group is no longer live: $lock_dir" >&2
    status=2
  fi
  [[ "$cancelled" -eq 0 ]] || status="$cancelled"
  return "$status"
}

harness_maestro_command() {
  node - "${TIMEOUT_SECONDS:-90}" "$@" <<'JS'
const fs = require('node:fs'), path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const seconds = Number(process.argv[2])
const dir = process.env.HARNESS_DRIVER_LOCK, owner = process.env.HARNESS_DRIVER_OWNER
if (!Number.isInteger(seconds) || seconds <= 0 || !dir || !owner) process.exit(2)
const read = name => { try { return fs.readFileSync(path.join(dir, name), 'utf8').trim() } catch { return undefined } }
const owned = () => read('owner') === owner
const write = (name, value) => {
  if (!owned()) throw new Error('driver_lock_owner_changed')
  fs.writeFileSync(path.join(dir, name), String(value) + '\n')
}
let child, exitStatus, requested, stoppingAt, unknown = false, finished = false
const now = () => performance.now()
const request = status => { requested ??= status; stoppingAt ??= now() }
process.on('SIGTERM', () => request(143))
process.on('SIGINT', () => request(130))
// ps is the settlement oracle. A failed query is UNKNOWN, never an empty group.
function processes() {
  const r = spawnSync('ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8', timeout: 1000 })
  if (r.status !== 0 || r.error) throw new Error('process_group_unverifiable')
  const lines = r.stdout.trim().split('\n').filter(Boolean)
  if (!lines.length || lines.some(x => !/^\s*\d+\s+\d+\s+\S+\s*$/.test(x))) throw new Error('process_table_unverifiable')
  return lines.map(x => { const [pid, pgid, state] = x.trim().split(/\s+/); return { pid: Number(pid), pgid: Number(pgid), live: !state.startsWith('Z') } })
}
function signalGroup(signal) {
  try { process.kill(-child.pid, signal) } catch (e) { if (e.code !== 'ESRCH') { unknown = true; console.error(e.message) } }
}
function finish(status, settled) {
  if (finished) return
  finished = true
  clearInterval(poll); clearTimeout(deadline)
  if (settled && !unknown && owned()) {
    try { write('state', 'settled') } catch { unknown = true }
  } else unknown = true
  if (unknown) console.error(`HARNESS/TOOLING Maestro unsettled/unverifiable; manual recovery required: ${dir}`)
  process.exit(unknown ? 2 : status)
}
const parent = Number(read('pid'))
try {
  write('state', 'pending')
  write('supervisor', process.pid)
  if (fs.existsSync(path.join(dir, 'cancel'))) request(143)
  if (!requested) {
    child = spawn('maestro', process.argv.slice(3), { stdio: 'inherit', detached: true })
    if (child.pid) write('group', child.pid)
    child.on('error', e => { console.error(e.message); exitStatus = 2 })
    child.on('exit', (code, signal) => { exitStatus = code ?? (signal === 'SIGINT' ? 130 : 1) })
  } else exitStatus = requested
} catch (e) { console.error(e.message); unknown = true; request(2); if (!child) exitStatus = 2 }
let termSent = false, killSent = false
const started = now()
const deadline = setTimeout(() => {
  console.error(`HARNESS/TOOLING Maestro command timeout after ${seconds}s`)
  request(124)
}, seconds * 1000)
const poll = setInterval(() => {
  let table
  try { table = processes() } catch (e) { unknown = true; request(2); console.error(e.message) }
  if (!owned()) request(2)
  if (fs.existsSync(path.join(dir, 'cancel'))) request(143)
  if (table && !table.some(p => p.pid === parent && p.live)) request(143)
  const live = child?.pid && table?.some(p => p.pgid === child.pid && p.live)
  if (exitStatus !== undefined && table && !live) return finish(requested ?? exitStatus, true)
  // A successful direct child is insufficient if grandchildren outlive it.
  if (exitStatus !== undefined) stoppingAt ??= now()
  if (stoppingAt !== undefined && child?.pid) {
    if (!termSent) { termSent = true; signalGroup('SIGTERM') }
    if (now() - stoppingAt >= 500 && !killSent) {
      killSent = true; console.error(`MAESTRO_ESCALATION group=${child.pid} signal=KILL`); signalGroup('SIGKILL')
    }
  }
  if (stoppingAt !== undefined && now() - stoppingAt >= 2000) finish(requested ?? exitStatus ?? 2, false)
  if (!child && now() - started >= 100) finish(requested ?? 2, Boolean(table))
}, 50)
JS
}

harness_maestro() {
  harness_with_maestro_lock harness_maestro_command "$@"
}

# Keep the driver lock for the complete UI flow. Each existing YAML section has
# its own command deadline; individual gesture/assertion bounds stay unchanged.
harness_ui_flow() {
  harness_with_maestro_lock harness_ui_phases "$@"
}

harness_ui_phases() {
  local phase_dir phase_file flow_file last
  local args=("$@")
  last=$((${#args[@]} - 1))
  flow_file="${args[$last]}"
  if [[ "${flow_file##*/}" != ui-smoke-main.yaml ]]; then
    harness_maestro_command "$@"
    return $?
  fi
  declare -F validate_ui_progress >/dev/null || return 2
  phase_dir="$(mktemp -d -t nitro-ui-phases.XXXXXX)"
  node - "$flow_file" "$phase_dir" <<'JS'
const fs = require('node:fs'), path = require('node:path')
const parts = fs.readFileSync(process.argv[2], 'utf8').replace(/\r\n/g, '\n').split('\n---\n')
if (parts.length !== 2) throw new Error('UI flow requires one YAML document separator')
const phases = parts[1].trim().split(/\n[ \t]*\n/)
if (phases.some(phase => !phase.startsWith('- '))) throw new Error('UI phase must start with a top-level command')
phases.forEach((phase, i) => fs.writeFileSync(path.join(process.argv[3], String(i + 1).padStart(2, '0') + '.yaml'), parts[0] + '\n---\n' + phase + '\n'))
console.log(`UI_PHASE_COUNT count=${phases.length} source=${process.argv[2]} fixtures=${process.argv[3]}`)
JS
  local status=$?
  [[ "$status" -eq 0 ]] || return "$status"
  unset "args[$last]"
  for phase_file in "$phase_dir"/*.yaml; do
    echo "UI_PHASE_START file=$phase_file"
    harness_maestro_command "${args[@]}" "$phase_file" || return $?
    validate_ui_progress || return $?
    echo "UI_PHASE_COMPLETE file=$phase_file"
  done
}

# A bounded UI fixture: cancel old URL prompts BEFORE sending the current URL.
# Every gesture is conditional on an observed prompt for this example app.
harness_ios_dialogs() {
  local simulator="$1" bundle="$2" phase="$3" flow_file dialog_log status
  command -v maestro >/dev/null || { echo "Maestro required for --simulator-dialogs" >&2; return 2; }
  flow_file="$(mktemp -t nitro-ios-dialogs.XXXXXX.yaml)"
  dialog_log="$(mktemp -t nitro-ios-dialogs.XXXXXX.log)"
  cat >"$flow_file" <<'YAML'
appId: "${APP_ID}"
---
YAML
  if [[ "$phase" == prepare ]]; then
    cat >>"$flow_file" <<'YAML'
- repeat:
    times: 3
    commands:
      - runFlow:
          when:
            visible: '(?is).*(open|aprire).*NitroBgTimerExample.*'
          commands:
            - tapOn: 'Annulla|Cancel'
- assertNotVisible: '(?is).*(open|aprire).*NitroBgTimerExample.*'
- runFlow:
    when:
      visible: '(?is).*NitroBgTimerExample.*notific.*'
    commands:
      - tapOn: 'Consenti|Allow'
- assertNotVisible: '(?is).*NitroBgTimerExample.*notific.*'
YAML
  else
    cat >>"$flow_file" <<'YAML'
- runFlow:
    when:
      visible: '(?is).*(open|aprire).*NitroBgTimerExample.*'
    commands:
      - tapOn: 'Apri|Open'
- assertNotVisible: '(?is).*(open|aprire).*NitroBgTimerExample.*'
YAML
  fi
  echo "DIALOG_PREFLIGHT phase=$phase fixture=$flow_file log=$dialog_log"
  status=0
  harness_maestro test --device "$simulator" -e "APP_ID=$bundle" "$flow_file" >"$dialog_log" 2>&1 || status=$?
  if [[ "$status" -ne 0 ]]; then
    cat "$dialog_log" >&2
    echo "HARNESS/TOOLING dialog_precondition_failed phase=$phase exit=$status" >&2
    return 2
  fi
}

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then return 0; fi
if [[ "${1:-}" == "--validate-log" ]]; then shift; harness_validate "$@"; exit $?; fi


PACKAGE_NAME="com.nitrobgtimerexample"
TIMEOUT_SECONDS=45
BACKGROUND=0
INSTALL=0
DEVICE=""
RUN_ID=""
APK=""
ADB_BIN="${ADB:-adb}"

usage() {
  cat <<'EOF'
Usage: bash scripts/smoke-android.sh [options]

Options:
  --run-id <id>      Unique smoke run id.
  --apk <path>       Require installed APK bytes to match this build.
  --device <serial>   adb device serial. Required when multiple devices are authorized.
  --timeout <sec>     Overall timeout in seconds. Default: 45.
  --background        Require HOME, background callback and active resume in one process.
  --install           Run yarn example:android before opening the smoke deep link.
  -h, --help          Show this help.

Prerequisites:
  - A physical/emulated Android device is connected and authorized.
  - The example app is installed, unless --install is provided.
  - Metro is running for debug builds. Node is available.
  - Runs force-stop this app first; run ids are single-use per target.
EOF
}


while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id) RUN_ID="${2:?}"; shift 2 ;;
    --apk) APK="${2:?}"; shift 2 ;;
    --device)
      DEVICE="${2:-}"
      shift 2
      ;;
    --timeout)
      TIMEOUT_SECONDS="${2:-}"
      shift 2
      ;;
    --background)
      BACKGROUND=1
      shift
      ;;
    --install)
      INSTALL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v "$ADB_BIN" >/dev/null 2>&1; then
  echo "adb not found. Set ADB=/path/to/adb or add adb to PATH." >&2
  exit 2
fi

if [[ -z "$DEVICE" ]]; then
  AUTHORIZED_DEVICES="$("$ADB_BIN" devices | awk 'NR > 1 && $2 == "device" { print $1 }')"
  DEVICE_COUNT="$(printf '%s\n' "$AUTHORIZED_DEVICES" | sed '/^$/d' | wc -l | tr -d ' ')"

  if [[ "$DEVICE_COUNT" -eq 0 ]]; then
    echo "No authorized adb device found." >&2
    "$ADB_BIN" devices >&2
    exit 2
  fi

  if [[ "$DEVICE_COUNT" -gt 1 ]]; then
    echo "Multiple authorized adb devices found. Use --device <serial>." >&2
    printf '%s\n' "$AUTHORIZED_DEVICES" | sed '/^$/d; s/^/  /' >&2
    exit 2
  fi

  DEVICE="$AUTHORIZED_DEVICES"
fi

ADB_CMD=("$ADB_BIN" -s "$DEVICE")

LOGCAT_PID=""
cleanup() {
  if [[ -n "${LOG_FILE:-}" ]]; then echo "Log: $LOG_FILE"; fi
  if [[ -n "$LOGCAT_PID" ]]; then
    kill "$LOGCAT_PID" >/dev/null 2>&1 || true
    wait "$LOGCAT_PID" >/dev/null 2>&1 || true
  fi
}
trap 'cleanup; harness_unlock' EXIT
RUN_ID="${RUN_ID:-android-$(date +%s)-$$}"
[[ "$RUN_ID" =~ ^[A-Za-z0-9._-]{1,80}$ ]] || exit 2
[[ "$TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || exit 2
harness_lock android "$DEVICE" "$RUN_ID"
if [[ "$INSTALL" -eq 1 ]]; then
  yarn example:android --deviceId "$DEVICE"
fi

if ! "${ADB_CMD[@]}" shell pm path "$PACKAGE_NAME" >/dev/null 2>&1; then
  echo "Example app is not installed on $DEVICE." >&2
  echo "Run yarn example:android, or rerun this script with --install." >&2
  exit 2
fi

"${ADB_CMD[@]}" shell pm grant "$PACKAGE_NAME" android.permission.POST_NOTIFICATIONS >/dev/null 2>&1 || true

harness_android_artifact "$ADB_BIN" "$DEVICE" "$PACKAGE_NAME" "$APK"
INITIAL_APK_HASH="$HARNESS_APK_HASH"
SMOKE_URL="nitrobgtimerexample://smoke?runId=${RUN_ID}"
LOG_FILE="$(mktemp -t nitro-bg-smoke-android.XXXXXX.log)"
LOG_SINCE="$(date '+%m-%d %H:%M:%S.000')"
LOGCAT_PID=""



echo "Android smoke runId=${RUN_ID} device=${DEVICE}"

"${ADB_CMD[@]}" logcat -v threadtime -T "$LOG_SINCE" >"$LOG_FILE" 2>&1 &
LOGCAT_PID="$!"
sleep 0.5

"${ADB_CMD[@]}" shell am force-stop "$PACKAGE_NAME"
"${ADB_CMD[@]}" shell am start -W \
  -a android.intent.action.VIEW \
  -d "$SMOKE_URL" \
  "$PACKAGE_NAME" >/dev/null

APP_PID="$("${ADB_CMD[@]}" shell pidof "$PACKAGE_NAME" 2>/dev/null | tr -d '\r' || true)"
[[ "$APP_PID" =~ ^[0-9]+$ ]] || { echo "FAIL app_pid_unavailable"; exit 1; }
echo "PID: $APP_PID Log: $LOG_FILE"

deadline=$((SECONDS + TIMEOUT_SECONDS))
background_phase=ready
home_boundary=-1
resume_boundary=-1

while (( SECONDS < deadline )); do
  if ! kill -0 "$LOGCAT_PID" 2>/dev/null; then
    echo "FAIL log_capture_ended"; exit 1
  fi
  current_pid="$("${ADB_CMD[@]}" shell pidof "$PACKAGE_NAME" 2>/dev/null | tr -d '\r' || true)"
  [[ "$current_pid" == "$APP_PID" ]] || { echo "FAIL process_changed expected=$APP_PID actual=$current_pid"; exit 1; }
  status=0
  harness_validate "$LOG_FILE" "$RUN_ID" android "$APP_PID" core poll || status=$?
  [[ "$status" -eq 0 || "$status" -eq 3 ]] || exit "$status"
  if [[ "$BACKGROUND" -eq 1 ]]; then
    background_status=0
    harness_validate "$LOG_FILE" "$RUN_ID" android "$APP_PID" core poll NitroBgTimerExample "$background_phase" "$home_boundary" "$resume_boundary" || background_status=$?
    [[ "$background_status" -eq 0 || "$background_status" -eq 3 ]] || exit "$background_status"
    if [[ "$background_status" -eq 0 && "$background_phase" == ready ]]; then
      home_boundary="$(wc -c <"$LOG_FILE" | tr -d ' ')"
      echo "BACKGROUND_HOME_REQUEST runId=$RUN_ID pid=$APP_PID boundary=$home_boundary"
      if ! "${ADB_CMD[@]}" shell input keyevent HOME; then
        echo "FAIL background_precondition:HOME_failed VALIDATION_GAP"; exit 1
      fi
      echo "BACKGROUND_HOME_EXIT runId=$RUN_ID pid=$APP_PID exit=0"
      background_phase=away
    elif [[ "$background_status" -eq 0 && "$background_phase" == away ]]; then
      resume_boundary="$(wc -c <"$LOG_FILE" | tr -d ' ')"
      echo "BACKGROUND_RESUME_REQUEST runId=$RUN_ID pid=$APP_PID boundary=$resume_boundary"
      if ! "${ADB_CMD[@]}" shell am start -W -n "$PACKAGE_NAME/.MainActivity"; then
        echo "FAIL background_precondition:resume_failed VALIDATION_GAP"; exit 1
      fi
      echo "BACKGROUND_RESUME_EXIT runId=$RUN_ID pid=$APP_PID exit=0"
      background_phase=resumed
    elif [[ "$background_status" -eq 0 && "$background_phase" == resumed ]]; then
      status=0
    fi
    [[ "$background_phase" == resumed && "$background_status" -eq 0 ]] || status=3
  fi
  if [[ "$status" -eq 0 ]]; then
    harness_android_artifact "$ADB_BIN" "$DEVICE" "$PACKAGE_NAME" "$APK" "$APP_PID" "$LOGCAT_PID"
    [[ "$HARNESS_APK_HASH" == "$INITIAL_APK_HASH" ]] || exit 1
    if [[ "$BACKGROUND" -eq 1 ]]; then
      harness_validate "$LOG_FILE" "$RUN_ID" android "$APP_PID" core final NitroBgTimerExample resumed "$home_boundary" "$resume_boundary"
    else
      harness_validate "$LOG_FILE" "$RUN_ID" android "$APP_PID" core final
    fi
    echo "PASS runId=${RUN_ID} pid=${APP_PID} log=${LOG_FILE}"
    exit 0
  fi

  sleep 0.25
done

if [[ "$BACKGROUND" -eq 1 ]]; then
  echo "FAIL background_precondition:window_lost_or_incomplete VALIDATION_GAP phase=$background_phase runId=$RUN_ID" >&2
  exit 1
fi
echo "TIMEOUT runId=${RUN_ID} after ${TIMEOUT_SECONDS}s" >&2
grep -F "$RUN_ID" "$LOG_FILE" | tail -n 40 >&2 || true
echo "Full log: $LOG_FILE" >&2
exit 124
