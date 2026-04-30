#!/usr/bin/env bash
set -euo pipefail

PACKAGE_NAME="com.nitrobgtimerexample"
TIMEOUT_SECONDS=45
BACKGROUND=0
INSTALL=0
DEVICE=""
ADB_BIN="${ADB:-adb}"
BENIGN_ANDROID_RUNTIME_PATTERN='AndroidRuntime:[[:space:]]+VM exiting with result code 0'
RUNTIME_ERROR_PATTERN='FATAL EXCEPTION|Fatal signal|Native crash|RedBox|Invariant Violation|ReactNativeJS.*(Error|Exception)|NativeEventEmitter|RCTEventEmitter|ForegroundServiceDidNotStartInTimeException|RemoteServiceException'
ANDROID_RUNTIME_CRASH_PATTERN='AndroidRuntime: (FATAL EXCEPTION|Process: com\.nitrobgtimerexample|Caused by:|[[:space:]]*at[[:space:]]|.*(Exception|Error))'
PROCESS_DIED_PATTERN='Process com\.nitrobgtimerexample( | .*)has died'

usage() {
  cat <<'EOF'
Usage: bash scripts/smoke-android.sh [options]

Options:
  --device <serial>   adb device serial. Required when multiple devices are authorized.
  --timeout <sec>     Overall timeout in seconds. Default: 45.
  --background        Send HOME after BACKGROUND_READY, wait briefly, then foreground.
  --install           Run yarn example:android before opening the smoke deep link.
  -h, --help          Show this help.

Prerequisites:
  - A physical/emulated Android device is connected and authorized.
  - The example app is installed, unless --install is provided.
  - Metro is running for debug builds.
EOF
}

find_runtime_error() {
  grep -E "${RUNTIME_ERROR_PATTERN}|${ANDROID_RUNTIME_CRASH_PATTERN}|${PROCESS_DIED_PATTERN}" "$LOG_FILE" |
    grep -Ev "$BENIGN_ANDROID_RUNTIME_PATTERN" |
    tail -n 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
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

if [[ "$INSTALL" -eq 1 ]]; then
  yarn example:android --deviceId "$DEVICE"
fi

if ! "${ADB_CMD[@]}" shell pm path "$PACKAGE_NAME" >/dev/null 2>&1; then
  echo "Example app is not installed on $DEVICE." >&2
  echo "Run yarn example:android, or rerun this script with --install." >&2
  exit 2
fi

"${ADB_CMD[@]}" shell pm grant "$PACKAGE_NAME" android.permission.POST_NOTIFICATIONS >/dev/null 2>&1 || true

RUN_ID="android-$(date +%s)-$$"
SMOKE_URL="nitrobgtimerexample://smoke?runId=${RUN_ID}"
LOG_FILE="$(mktemp -t nitro-bg-smoke-android.XXXXXX.log)"
LOG_SINCE="$(date '+%m-%d %H:%M:%S.000')"
LOGCAT_PID=""

cleanup() {
  if [[ -n "$LOGCAT_PID" ]]; then
    kill "$LOGCAT_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "Android smoke runId=${RUN_ID} device=${DEVICE}"

"${ADB_CMD[@]}" logcat -v time -T "$LOG_SINCE" >"$LOG_FILE" 2>&1 &
LOGCAT_PID="$!"
sleep 0.5

"${ADB_CMD[@]}" shell am start -W \
  -a android.intent.action.VIEW \
  -d "$SMOKE_URL" \
  "$PACKAGE_NAME" >/dev/null

deadline=$((SECONDS + TIMEOUT_SECONDS))
background_sent=0

while (( SECONDS < deadline )); do
  if fail_line="$(grep -F "[NitroBgSmoke] RESULT FAIL runId=${RUN_ID}" "$LOG_FILE" | tail -n 1)"; then
    echo "FAIL runId=${RUN_ID}"
    echo "$fail_line"
    exit 1
  fi

  if crash_line="$(find_runtime_error)"; then
    echo "FAIL runId=${RUN_ID} crash_or_redbox_detected"
    echo "$crash_line"
    exit 1
  fi

  if grep -F "[NitroBgSmoke] RESULT PASS runId=${RUN_ID}" "$LOG_FILE" >/dev/null; then
    echo "PASS runId=${RUN_ID}"
    exit 0
  fi

  if [[ "$BACKGROUND" -eq 1 && "$background_sent" -eq 0 ]] &&
    grep -F "[NitroBgSmoke] BACKGROUND_READY runId=${RUN_ID}" "$LOG_FILE" >/dev/null; then
    echo "BACKGROUND_READY runId=${RUN_ID}; sending HOME"
    "${ADB_CMD[@]}" shell input keyevent HOME >/dev/null 2>&1 || true
    sleep 2
    "${ADB_CMD[@]}" shell monkey -p "$PACKAGE_NAME" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 ||
      "${ADB_CMD[@]}" shell am start -n "$PACKAGE_NAME/.MainActivity" >/dev/null 2>&1 ||
      true
    background_sent=1
  fi

  sleep 0.25
done

echo "TIMEOUT runId=${RUN_ID} after ${TIMEOUT_SECONDS}s" >&2
grep -F "$RUN_ID" "$LOG_FILE" | tail -n 40 >&2 || true
echo "Full log: $LOG_FILE" >&2
exit 124
