#!/usr/bin/env bash
set -euo pipefail

PACKAGE_NAME="com.nitrobgtimerexample"
FLOW="main"
TIMEOUT_SECONDS=90
CONTEXT_TIMEOUT_SECONDS=30
RUN_ID=""
DEVICE=""
INSTALL=0
ADB_BIN="${ADB:-adb}"
SMOKE_RUN_ID_PATTERN='^[A-Za-z0-9._-]{1,80}$'
APP_RUNTIME_ERROR_PATTERN='FATAL EXCEPTION|ReactNativeJS.*(Error|Exception)|RedBox|Invariant Violation|SIGABRT|Fatal signal'
APP_PIDS=""
WAKE_LOCK_TAG="NitroBgTimer::WakeLock"
FGS_SERVICE_CLASS="NitroBackgroundTimerService"
FGS_LOG_PATTERN='Foreground service start requested|Service onCreate|Service running in foreground'

usage() {
  cat <<'EOF'
Usage: bash scripts/ui-smoke-android.sh [options]

Options:
  --device <serial>     adb device serial. Required when multiple devices are authorized.
  --run-id <id>         UI smoke run id, matching [A-Za-z0-9._-]{1,80}.
  --timeout <sec>       Marker wait timeout after Maestro finishes. Default: 90.
  --flow <name>         main, fgs-optout, or fgs-optout-deep. Default: main.
  --install             Run yarn example:android before the UI smoke.
  --package-name <id>   Android package id. Default: com.nitrobgtimerexample.
  -h, --help            Show this help.

Prerequisites:
  - Maestro is installed: https://maestro.mobile.dev/
  - A physical/emulated Android device is connected and authorized.
  - Metro is running for debug builds.
  - The example app is installed, unless --install is provided.
  - Opt-out flows run in a fresh app process; this script force-stops the
    package immediately before opening the UI smoke deep link.
EOF
}

die() {
  local code="$1"
  shift
  echo "$*" >&2
  exit "$code"
}

require_option_value() {
  local option="$1"
  local value="${2:-}"

  if [[ -z "$value" || "$value" == --* ]]; then
    die 2 "${option} requires a value."
  fi
}

validate_run_id() {
  local run_id="$1"

  if [[ ! "$run_id" =~ $SMOKE_RUN_ID_PATTERN ]]; then
    die 2 "Invalid --run-id '${run_id}'. Use 1..80 chars from [A-Za-z0-9._-]."
  fi
}

require_maestro() {
  if ! command -v maestro >/dev/null 2>&1; then
    die 2 "Maestro is required for UI smoke. Install it from https://maestro.mobile.dev/ and rerun this script."
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device)
      require_option_value "$1" "${2:-}"
      DEVICE="$2"
      shift 2
      ;;
    --run-id)
      require_option_value "$1" "${2:-}"
      RUN_ID="$2"
      shift 2
      ;;
    --timeout)
      require_option_value "$1" "${2:-}"
      TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    --flow)
      require_option_value "$1" "${2:-}"
      FLOW="$2"
      shift 2
      ;;
    --install)
      INSTALL=1
      shift
      ;;
    --package-name)
      require_option_value "$1" "${2:-}"
      PACKAGE_NAME="$2"
      shift 2
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

case "$FLOW" in
  main|fgs-optout|fgs-optout-deep)
    ;;
  *)
    die 2 "Invalid --flow '${FLOW}'. Use main, fgs-optout, or fgs-optout-deep."
    ;;
esac

if ! [[ "$TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || (( TIMEOUT_SECONDS <= 0 )); then
  die 2 "Invalid --timeout '${TIMEOUT_SECONDS}'. Use a positive integer number of seconds."
fi

if [[ -z "$PACKAGE_NAME" ]]; then
  die 2 "Android package id is empty."
fi

if [[ -z "$RUN_ID" ]]; then
  RUN_ID="android-ui-$(date +%s)-$$"
fi
validate_run_id "$RUN_ID"

require_maestro

if ! command -v "$ADB_BIN" >/dev/null 2>&1; then
  die 2 "adb not found. Set ADB=/path/to/adb or add adb to PATH."
fi

if [[ -z "$DEVICE" ]]; then
  AUTHORIZED_DEVICES="$("$ADB_BIN" devices | awk 'NR > 1 && $2 == "device" { print $1 }')"
  DEVICE_COUNT="$(printf '%s\n' "$AUTHORIZED_DEVICES" | sed '/^$/d' | wc -l | tr -d ' ')"

  if [[ "$DEVICE_COUNT" -eq 0 ]]; then
    "$ADB_BIN" devices >&2
    die 2 "No authorized adb device found."
  fi

  if [[ "$DEVICE_COUNT" -gt 1 ]]; then
    echo "Multiple authorized adb devices found. Use --device <serial>." >&2
    printf '%s\n' "$AUTHORIZED_DEVICES" | sed '/^$/d; s/^/  /' >&2
    exit 2
  fi

  DEVICE="$AUTHORIZED_DEVICES"
fi

ADB_CMD=("$ADB_BIN" -s "$DEVICE")
FLOW_FILE=".maestro/ui-smoke-${FLOW}.yaml"
SMOKE_URL="nitrobgtimerexample://smoke?runId=${RUN_ID}&mode=ui"
# These quotes are parsed by the Android shell invoked through adb shell.
ADB_SHELL_SMOKE_URL="'${SMOKE_URL}'"
LOG_FILE="$(mktemp -t nitro-bg-ui-smoke-android.XXXXXX.log)"
MAESTRO_LOG_FILE="$(mktemp -t nitro-bg-ui-smoke-maestro-android.XXXXXX.log)"
EVIDENCE_DIR=""
LOG_SINCE="$(date '+%m-%d %H:%M:%S.000')"
LOGCAT_PID=""

cleanup() {
  if [[ -n "$LOGCAT_PID" ]]; then
    kill "$LOGCAT_PID" >/dev/null 2>&1 || true
    wait "$LOGCAT_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

remember_app_pids() {
  local current_pids=""
  local pid=""

  current_pids="$("${ADB_CMD[@]}" shell pidof "$PACKAGE_NAME" 2>/dev/null | tr -d '\r' || true)"
  for pid in $current_pids; do
    case " ${APP_PIDS} " in
      *" ${pid} "*)
        ;;
      *)
        APP_PIDS="${APP_PIDS:+${APP_PIDS} }${pid}"
        ;;
    esac
  done
}

find_app_runtime_error() {
  local crash_line=""

  if crash_line="$(grep -F "Crash of app ${PACKAGE_NAME}" "$LOG_FILE" | tail -n 1)"; then
    echo "$crash_line"
    return 0
  fi

  if crash_line="$(grep -F "AndroidRuntime" "$LOG_FILE" | grep -F "Process: ${PACKAGE_NAME}" | tail -n 1)"; then
    echo "$crash_line"
    return 0
  fi

  if crash_line="$(grep -F "$PACKAGE_NAME" "$LOG_FILE" | grep -E "$APP_RUNTIME_ERROR_PATTERN" | tail -n 1)"; then
    echo "$crash_line"
    return 0
  fi

  if [[ -n "$APP_PIDS" ]]; then
    if crash_line="$(awk -v app_pids="$APP_PIDS" -v pattern="$APP_RUNTIME_ERROR_PATTERN" '
      BEGIN {
        pid_count = split(app_pids, pids, /[[:space:]]+/)
        for (i = 1; i <= pid_count; i++) {
          if (pids[i] != "") {
            known_pids[pids[i]] = 1
          }
        }
      }
      ($3 in known_pids) && $0 ~ pattern {
        last = $0
      }
      END {
        if (last != "") {
          print last
          exit 0
        }
        exit 1
      }
    ' "$LOG_FILE")"; then
      echo "$crash_line"
      return 0
    fi
  fi

  return 1
}

find_run_fail_marker() {
  local fail_line=""

  if fail_line="$(grep -F "[NitroBgUiSmoke] FAIL runId=${RUN_ID}" "$LOG_FILE" | tail -n 1)"; then
    echo "$fail_line"
    return 0
  fi

  return 1
}

find_fgs_log_line() {
  local fgs_line=""

  if fgs_line="$(grep -F "NitroBgTimer" "$LOG_FILE" | grep -E "$FGS_LOG_PATTERN" | tail -n 1)"; then
    echo "$fgs_line"
    return 0
  fi

  return 1
}

check_deep_failure_signals() {
  local fail_line=""
  local crash_line=""
  local fgs_line=""

  if fail_line="$(find_run_fail_marker)"; then
    echo "FAIL runId=${RUN_ID}"
    echo "$fail_line"
    exit 1
  fi

  if crash_line="$(find_app_runtime_error)"; then
    echo "FAIL runId=${RUN_ID} crash_or_redbox_detected"
    echo "$crash_line"
    exit 1
  fi

  if fgs_line="$(find_fgs_log_line)"; then
    echo "FAIL runId=${RUN_ID} foreground_service_log_observed"
    echo "$fgs_line"
    exit 1
  fi
}

wait_for_ui_smoke_pass() {
  local marker="$1"
  local timeout_seconds="$2"
  local check_fgs_logs="${3:-}"
  local pass_marker="[NitroBgUiSmoke] PASS runId=${RUN_ID} ${marker}"
  local deadline=$((SECONDS + timeout_seconds))
  local fail_line=""
  local crash_line=""

  while (( SECONDS < deadline )); do
    if grep -F "$pass_marker" "$LOG_FILE" >/dev/null 2>&1; then
      echo "Observed PASS ${marker}"
      return 0
    fi

    if [[ "$check_fgs_logs" == "check-fgs" ]]; then
      check_deep_failure_signals
    else
      if fail_line="$(find_run_fail_marker)"; then
        echo "FAIL runId=${RUN_ID}"
        echo "$fail_line"
        exit 1
      fi

      if crash_line="$(find_app_runtime_error)"; then
        echo "FAIL runId=${RUN_ID} crash_or_redbox_detected"
        echo "$crash_line"
        exit 1
      fi
    fi

    sleep 0.25
  done

  echo "TIMEOUT runId=${RUN_ID} after ${timeout_seconds}s waiting for PASS ${marker}" >&2
  grep -F "$RUN_ID" "$LOG_FILE" | tail -n 80 >&2 || true
  echo "Full log: ${LOG_FILE}" >&2
  echo "Maestro log: ${MAESTRO_LOG_FILE}" >&2
  exit 124
}

extract_last_log_pid() {
  local needle="$1"

  awk -v needle="$needle" '
    index($0, needle) > 0 {
      pid = $3
    }
    END {
      if (pid != "") {
        print pid
        exit 0
      }
      exit 1
    }
  ' "$LOG_FILE"
}

assert_deep_log_pid_consistency() {
  local include_fired="${1:-0}"
  local base_pid=""
  local pid=""
  local needle=""
  local needles=(
    "[NitroBgUiSmoke] CONTEXT runId=${RUN_ID} mode=ui"
    "[NitroBgUiSmoke] PASS runId=${RUN_ID} section=background action=fgs-optout-disable"
    "[NitroBgUiSmoke] PASS runId=${RUN_ID} section=background action=fgs-optout-timeout-started"
  )

  if [[ "$include_fired" -eq 1 ]]; then
    needles+=("[NitroBgUiSmoke] PASS runId=${RUN_ID} section=background action=fgs-optout-timeout-fired")
  fi

  for needle in "${needles[@]}"; do
    pid="$(extract_last_log_pid "$needle" 2>/dev/null || true)"
    if [[ -z "$pid" ]]; then
      echo "WARN runId=${RUN_ID} marker_pid_unavailable needle=${needle}"
      continue
    fi

    if [[ -z "$base_pid" ]]; then
      base_pid="$pid"
      continue
    fi

    if [[ "$pid" != "$base_pid" ]]; then
      echo "FAIL runId=${RUN_ID} marker_pid_changed expected=${base_pid} actual=${pid}"
      echo "Needle: ${needle}"
      exit 1
    fi
  done

  if [[ -n "$base_pid" ]]; then
    echo "Marker PID consistent runId=${RUN_ID} pid=${base_pid}"
  fi
}

capture_deep_dumpsys() {
  local phase="$1"

  if [[ -z "$EVIDENCE_DIR" ]]; then
    EVIDENCE_DIR="$(mktemp -d -t nitro-bg-ui-smoke-android-evidence.XXXXXX)"
  fi

  DEEP_POWER_DUMP="${EVIDENCE_DIR}/${RUN_ID}-${phase}-power.txt"
  DEEP_SERVICE_DUMP="${EVIDENCE_DIR}/${RUN_ID}-${phase}-activity-services.txt"
  DEEP_NOTIFICATION_DUMP="${EVIDENCE_DIR}/${RUN_ID}-${phase}-notification.txt"

  if ! "${ADB_CMD[@]}" shell dumpsys power >"$DEEP_POWER_DUMP" 2>&1; then
    echo "FAIL runId=${RUN_ID} dumpsys_power_failed phase=${phase}" >&2
    cat "$DEEP_POWER_DUMP" >&2 || true
    exit 1
  fi

  if ! "${ADB_CMD[@]}" shell dumpsys activity services >"$DEEP_SERVICE_DUMP" 2>&1; then
    echo "FAIL runId=${RUN_ID} dumpsys_activity_services_failed phase=${phase}" >&2
    cat "$DEEP_SERVICE_DUMP" >&2 || true
    exit 1
  fi

  if ! "${ADB_CMD[@]}" shell dumpsys notification --noredact >"$DEEP_NOTIFICATION_DUMP" 2>&1; then
    if ! "${ADB_CMD[@]}" shell dumpsys notification >"$DEEP_NOTIFICATION_DUMP" 2>&1; then
      echo "FAIL runId=${RUN_ID} dumpsys_notification_failed phase=${phase}" >&2
      cat "$DEEP_NOTIFICATION_DUMP" >&2 || true
      exit 1
    fi
  fi

  echo "Captured dumpsys phase=${phase}"
  echo "  power: ${DEEP_POWER_DUMP}"
  echo "  services: ${DEEP_SERVICE_DUMP}"
  echo "  notification: ${DEEP_NOTIFICATION_DUMP}"
}

find_service_running_line() {
  local service_dump="$1"
  local service_line=""

  if service_line="$(grep -F -m 1 "$FGS_SERVICE_CLASS" "$service_dump")"; then
    echo "$service_line"
    return 0
  fi

  return 1
}

find_fgs_notification_line() {
  local notification_dump="$1"

  awk -v pkg="$PACKAGE_NAME" '
    BEGIN {
      found = 0
    }
    /NotificationRecord/ && index($0, pkg) > 0 {
      print
      found = 1
      exit
    }
    index($0, pkg) > 0 && /(FLAG_FOREGROUND_SERVICE|foregroundService|fgService)/ {
      print
      found = 1
      exit
    }
    END {
      if (found) {
        exit 0
      }
      exit 1
    }
  ' "$notification_dump"
}

find_wake_lock_line() {
  local power_dump="$1"

  awk -v tag="$WAKE_LOCK_TAG" '
    BEGIN {
      in_wake_locks = 0
      found = 0
    }
    /^Wake Locks:/ {
      in_wake_locks = 1
      next
    }
    in_wake_locks && /^[^[:space:]]/ {
      in_wake_locks = 0
    }
    in_wake_locks && index($0, tag) > 0 {
      print
      found = 1
      exit
    }
    END {
      if (found) {
        exit 0
      }
      exit 1
    }
  ' "$power_dump"
}

assert_no_foreground_service_observed() {
  local phase="$1"
  local observed_line=""

  if observed_line="$(find_service_running_line "$DEEP_SERVICE_DUMP")"; then
    echo "FAIL runId=${RUN_ID} service_running phase=${phase}"
    echo "$observed_line"
    exit 1
  fi
  echo "Evidence phase=${phase}: ${FGS_SERVICE_CLASS} not running"

  if observed_line="$(find_fgs_notification_line "$DEEP_NOTIFICATION_DUMP")"; then
    echo "FAIL runId=${RUN_ID} fgs_notification_observed phase=${phase}"
    echo "$observed_line"
    exit 1
  fi
  echo "Evidence phase=${phase}: FGS notification absent for ${PACKAGE_NAME}"

  if observed_line="$(find_fgs_log_line)"; then
    echo "FAIL runId=${RUN_ID} foreground_service_log_observed phase=${phase}"
    echo "$observed_line"
    exit 1
  fi
  echo "Evidence phase=${phase}: no foreground-service start logs observed"
}

run_fgs_optout_deep_verification() {
  local wake_lock_observed=0
  local wake_line=""

  wait_for_ui_smoke_pass "section=background action=fgs-optout-disable" 10 check-fgs
  wait_for_ui_smoke_pass "section=background action=fgs-optout-timeout-started" 10 check-fgs
  assert_deep_log_pid_consistency 0

  echo "Sending ${PACKAGE_NAME} to background with HOME"
  "${ADB_CMD[@]}" shell input keyevent HOME >/dev/null
  sleep 0.5

  capture_deep_dumpsys "active"
  assert_no_foreground_service_observed "active"

  if wake_line="$(find_wake_lock_line "$DEEP_POWER_DUMP")"; then
    wake_lock_observed=1
    echo "Evidence phase=active: wake lock held"
    echo "$wake_line"
  else
    echo "WARN runId=${RUN_ID} wake_lock_not_observed_during_active_timer tag=${WAKE_LOCK_TAG}"
    echo "WARN runId=${RUN_ID} wake_lock_validation=best-effort"
  fi

  wait_for_ui_smoke_pass "section=background action=fgs-optout-timeout-fired" "$TIMEOUT_SECONDS" check-fgs
  sleep 0.5
  remember_app_pids
  assert_deep_log_pid_consistency 1

  capture_deep_dumpsys "after-fired"
  assert_no_foreground_service_observed "after-fired"

  if wake_line="$(find_wake_lock_line "$DEEP_POWER_DUMP")"; then
    echo "FAIL runId=${RUN_ID} wake_lock_held_after_timeout_fired tag=${WAKE_LOCK_TAG}"
    echo "$wake_line"
    exit 1
  fi

  if [[ "$wake_lock_observed" -eq 1 ]]; then
    echo "Evidence phase=after-fired: wake lock released"
  else
    echo "WARN runId=${RUN_ID} wake_lock_release_not_proven tag=${WAKE_LOCK_TAG}"
    echo "WARN runId=${RUN_ID} wake_lock_validation=best-effort"
  fi

  echo "PASS runId=${RUN_ID} flow=${FLOW}"
  echo "Log: ${LOG_FILE}"
  echo "Maestro log: ${MAESTRO_LOG_FILE}"
  echo "Evidence dir: ${EVIDENCE_DIR}"
  exit 0
}

wait_for_ui_smoke_context() {
  local context_marker="[NitroBgUiSmoke] CONTEXT runId=${RUN_ID} mode=ui"
  local deadline=$((SECONDS + CONTEXT_TIMEOUT_SECONDS))
  local context_line=""
  local fail_line=""
  local crash_line=""

  echo "Waiting up to ${CONTEXT_TIMEOUT_SECONDS}s for UI smoke context"
  while (( SECONDS < deadline )); do
    if [[ -z "$APP_PIDS" ]]; then
      remember_app_pids
    fi

    if context_line="$(grep -F "$context_marker" "$LOG_FILE" | tail -n 1)"; then
      echo "Context ready runId=${RUN_ID}"
      echo "$context_line"
      return 0
    fi

    if fail_line="$(grep -F "[NitroBgUiSmoke] FAIL runId=${RUN_ID}" "$LOG_FILE" | tail -n 1)"; then
      echo "FAIL runId=${RUN_ID}"
      echo "$fail_line"
      exit 1
    fi

    if crash_line="$(find_app_runtime_error)"; then
      echo "FAIL runId=${RUN_ID} crash_or_redbox_detected"
      echo "$crash_line"
      exit 1
    fi

    sleep 0.25
  done

  echo "TIMEOUT runId=${RUN_ID} after ${CONTEXT_TIMEOUT_SECONDS}s waiting for UI smoke context" >&2
  grep -F "$RUN_ID" "$LOG_FILE" | tail -n 80 >&2 || true
  echo "Full log: ${LOG_FILE}" >&2
  exit 124
}

if [[ ! -f "$FLOW_FILE" ]]; then
  die 2 "Maestro flow not found: ${FLOW_FILE}"
fi

if [[ "$INSTALL" -eq 1 ]]; then
  yarn example:android --deviceId "$DEVICE"
fi

if ! "${ADB_CMD[@]}" shell pm path "$PACKAGE_NAME" >/dev/null 2>&1; then
  echo "Example app is not installed on ${DEVICE}." >&2
  echo "Run yarn example:android, or rerun with --install." >&2
  exit 2
fi

"${ADB_CMD[@]}" shell pm grant "$PACKAGE_NAME" android.permission.POST_NOTIFICATIONS >/dev/null 2>&1 || true

echo "Android UI smoke runId=${RUN_ID} device=${DEVICE} flow=${FLOW}"
echo "URL: ${SMOKE_URL}"
echo "Log capture: logcat -> ${LOG_FILE}"

echo "Clearing logcat before opening UI smoke deep link"
"${ADB_CMD[@]}" logcat -c >/dev/null 2>&1 || true
"${ADB_CMD[@]}" logcat -v time -T "$LOG_SINCE" >"$LOG_FILE" 2>&1 &
LOGCAT_PID="$!"
sleep 0.5

echo "Force-stopping ${PACKAGE_NAME} before opening UI smoke deep link"
"${ADB_CMD[@]}" shell am force-stop "$PACKAGE_NAME" >/dev/null

"${ADB_CMD[@]}" shell am start -W \
  -a android.intent.action.VIEW \
  -d "$ADB_SHELL_SMOKE_URL" \
  "$PACKAGE_NAME" >/dev/null

remember_app_pids
if [[ -n "$APP_PIDS" ]]; then
  echo "App PID(s): ${APP_PIDS}"
fi

wait_for_ui_smoke_context

set +e
echo "Maestro APP_ID: ${PACKAGE_NAME}"
maestro test \
  --device "$DEVICE" \
  -e "APP_ID=${PACKAGE_NAME}" \
  -e "SMOKE_URL=${SMOKE_URL}" \
  "$FLOW_FILE" >"$MAESTRO_LOG_FILE" 2>&1
MAESTRO_STATUS=$?
set -e

if [[ "$MAESTRO_STATUS" -ne 0 ]]; then
  echo "FAIL runId=${RUN_ID} maestro_failed exit=${MAESTRO_STATUS}" >&2
  tail -n 80 "$MAESTRO_LOG_FILE" >&2 || true
  echo "Maestro log: ${MAESTRO_LOG_FILE}" >&2
  exit 1
fi

remember_app_pids

if [[ "$FLOW" == "fgs-optout-deep" ]]; then
  run_fgs_optout_deep_verification
fi

expected_markers_main=(
  "section=set-timeout action=schedule"
  "section=set-timeout action=cancel"
  "section=set-interval action=start"
  "section=set-interval action=stop"
  "section=set-interval action=reset"
  "section=background action=js-comparison"
  "section=background action=configure-notification"
  "section=background action=start-mode"
  "section=background action=stop-mode"
  "section=background action=start"
  "section=background action=stop"
  "section=concurrent action=start-all"
  "section=concurrent action=stop-all"
  "section=cleanup action=mount"
  "section=cleanup action=unmount"
  "section=hook action=start"
  "section=hook action=restart"
  "section=hook action=stop"
  "section=stress action=create-100"
  "section=core-smoke action=run"
)

expected_markers_fgs_optout=(
  "section=background action=disable-fgs"
)

expected_markers_fgs_optout_deep=(
  "section=background action=fgs-optout-disable"
  "section=background action=fgs-optout-timeout-started"
  "section=background action=fgs-optout-timeout-fired"
)

if [[ "$FLOW" == "main" ]]; then
  expected_markers=("${expected_markers_main[@]}")
elif [[ "$FLOW" == "fgs-optout" ]]; then
  expected_markers=("${expected_markers_fgs_optout[@]}")
else
  expected_markers=("${expected_markers_fgs_optout_deep[@]}")
fi

deadline=$((SECONDS + TIMEOUT_SECONDS))
while (( SECONDS < deadline )); do
  if fail_line="$(grep -F "[NitroBgUiSmoke] FAIL runId=${RUN_ID}" "$LOG_FILE" | tail -n 1)"; then
    echo "FAIL runId=${RUN_ID}"
    echo "$fail_line"
    exit 1
  fi

  if crash_line="$(find_app_runtime_error)"; then
    echo "FAIL runId=${RUN_ID} crash_or_redbox_detected"
    echo "$crash_line"
    exit 1
  fi

  missing=()
  for marker in "${expected_markers[@]}"; do
    if ! grep -F "[NitroBgUiSmoke] PASS runId=${RUN_ID} ${marker}" "$LOG_FILE" >/dev/null 2>&1; then
      missing+=("$marker")
    fi
  done

  if [[ "${#missing[@]}" -eq 0 ]]; then
    echo "PASS runId=${RUN_ID} flow=${FLOW}"
    echo "Log: ${LOG_FILE}"
    exit 0
  fi

  sleep 0.25
done

echo "TIMEOUT runId=${RUN_ID} after ${TIMEOUT_SECONDS}s waiting for UI smoke markers" >&2
echo "Missing markers:" >&2
printf '  %s\n' "${missing[@]}" >&2
grep -F "$RUN_ID" "$LOG_FILE" | tail -n 80 >&2 || true
echo "Full log: ${LOG_FILE}" >&2
echo "Maestro log: ${MAESTRO_LOG_FILE}" >&2
exit 124
