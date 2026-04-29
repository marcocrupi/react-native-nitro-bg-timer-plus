#!/usr/bin/env bash
set -euo pipefail

PACKAGE_NAME="com.nitrobgtimerexample"
FLOW="main"
TIMEOUT_SECONDS=90
RUN_ID=""
DEVICE=""
INSTALL=0
ADB_BIN="${ADB:-adb}"
SMOKE_RUN_ID_PATTERN='^[A-Za-z0-9._-]{1,80}$'
RUNTIME_ERROR_PATTERN='FATAL EXCEPTION|AndroidRuntime|ReactNativeJS.*(Error|Exception)|RedBox|Invariant Violation|SIGABRT'

usage() {
  cat <<'EOF'
Usage: bash scripts/ui-smoke-android.sh [options]

Options:
  --device <serial>     adb device serial. Required when multiple devices are authorized.
  --run-id <id>         UI smoke run id, matching [A-Za-z0-9._-]{1,80}.
  --timeout <sec>       Marker wait timeout after Maestro finishes. Default: 90.
  --flow <name>         main or fgs-optout. Default: main.
  --install             Run yarn example:android before the UI smoke.
  --package-name <id>   Android package id. Default: com.nitrobgtimerexample.
  -h, --help            Show this help.

Prerequisites:
  - Maestro is installed: https://maestro.mobile.dev/
  - A physical/emulated Android device is connected and authorized.
  - Metro is running for debug builds.
  - The example app is installed, unless --install is provided.
  - The fgs-optout flow needs a fresh app process. If the app is already
    running, close it manually or use --install before running that flow.
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
  main|fgs-optout)
    ;;
  *)
    die 2 "Invalid --flow '${FLOW}'. Use main or fgs-optout."
    ;;
esac

if ! [[ "$TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || (( TIMEOUT_SECONDS <= 0 )); then
  die 2 "Invalid --timeout '${TIMEOUT_SECONDS}'. Use a positive integer number of seconds."
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
LOG_FILE="$(mktemp -t nitro-bg-ui-smoke-android.XXXXXX.log)"
MAESTRO_LOG_FILE="$(mktemp -t nitro-bg-ui-smoke-maestro-android.XXXXXX.log)"
LOG_SINCE="$(date '+%m-%d %H:%M:%S.000')"
LOGCAT_PID=""

cleanup() {
  if [[ -n "$LOGCAT_PID" ]]; then
    kill "$LOGCAT_PID" >/dev/null 2>&1 || true
    wait "$LOGCAT_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

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

if [[ "$FLOW" == "fgs-optout" && "$INSTALL" -eq 0 ]]; then
  RUNNING_PID="$("${ADB_CMD[@]}" shell pidof "$PACKAGE_NAME" 2>/dev/null | tr -d '\r' || true)"
  if [[ -n "$RUNNING_PID" ]]; then
    echo "The fgs-optout flow needs a fresh app process, but ${PACKAGE_NAME} is already running on ${DEVICE}." >&2
    echo "Close the app manually, wait for the process to exit, or rerun with --install. This script will not use destructive reset commands." >&2
    exit 2
  fi
fi

echo "Android UI smoke runId=${RUN_ID} device=${DEVICE} flow=${FLOW}"
echo "URL: ${SMOKE_URL}"
echo "Log capture: logcat -> ${LOG_FILE}"

"${ADB_CMD[@]}" logcat -v time -T "$LOG_SINCE" >"$LOG_FILE" 2>&1 &
LOGCAT_PID="$!"
sleep 0.5

"${ADB_CMD[@]}" shell am start -W \
  -a android.intent.action.VIEW \
  -d "$SMOKE_URL" \
  "$PACKAGE_NAME" >/dev/null

set +e
APP_ID="$PACKAGE_NAME" SMOKE_URL="$SMOKE_URL" maestro test --device "$DEVICE" "$FLOW_FILE" >"$MAESTRO_LOG_FILE" 2>&1
MAESTRO_STATUS=$?
set -e

if [[ "$MAESTRO_STATUS" -ne 0 ]]; then
  echo "FAIL runId=${RUN_ID} maestro_failed exit=${MAESTRO_STATUS}" >&2
  tail -n 80 "$MAESTRO_LOG_FILE" >&2 || true
  echo "Maestro log: ${MAESTRO_LOG_FILE}" >&2
  exit 1
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

if [[ "$FLOW" == "main" ]]; then
  expected_markers=("${expected_markers_main[@]}")
else
  expected_markers=("${expected_markers_fgs_optout[@]}")
fi

deadline=$((SECONDS + TIMEOUT_SECONDS))
while (( SECONDS < deadline )); do
  if fail_line="$(grep -F "[NitroBgUiSmoke] FAIL runId=${RUN_ID}" "$LOG_FILE" | tail -n 1)"; then
    echo "FAIL runId=${RUN_ID}"
    echo "$fail_line"
    exit 1
  fi

  if crash_line="$(grep -E "$RUNTIME_ERROR_PATTERN" "$LOG_FILE" | tail -n 1)"; then
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
