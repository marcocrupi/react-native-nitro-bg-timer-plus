#!/usr/bin/env bash
set -euo pipefail

BUNDLE_ID="org.reactjs.native.example.NitroBgTimerExample"
PROCESS_NAME="NitroBgTimerExample"
WORKSPACE="example/ios/NitroBgTimerExample.xcworkspace"
SCHEME="NitroBgTimerExample"
CONFIGURATION="Debug"
FLOW="main"
TIMEOUT_SECONDS=90
MODE="simulator"
SIMULATOR="booted"
DEVICE=""
XCODEBUILD_DEVICE_ID=""
MAESTRO_DEVICE_ID=""
RUN_ID=""
SKIP_BUILD=0
SKIP_INSTALL=0
DERIVED_DATA_PATH=""
DERIVED_DATA_PROVIDED=0
METRO_PORT="${RCT_METRO_PORT:-8081}"
SMOKE_RUN_ID_PATTERN='^[A-Za-z0-9._-]{1,80}$'
RUNTIME_ERROR_PATTERN='NativeEventEmitter|RCTEventEmitter|RedBox|ReactNativeJS[[:space:]:]+Error|SIGABRT|std::terminate|Fatal error|RCTFatal|NSException|Terminating app'

LOG_FILE=""
LOG_PID=""

usage() {
  cat <<'EOF'
Usage: bash scripts/ui-smoke-ios.sh [options]

Modes:
  Simulator: bash scripts/ui-smoke-ios.sh [--simulator [udid]]
  Device:    bash scripts/ui-smoke-ios.sh --device <devicectl-id> [--xcodebuild-device-id <id>] [--maestro-device-id <id>]

Options:
  --simulator [udid]       Use a booted simulator. Defaults to "booted".
  --device <id>            Use a physical device via xcrun devicectl.
  --xcodebuild-device-id <id>
                           xcodebuild destination id for the same physical device.
  --maestro-device-id <id>
                           Maestro device id for the same physical device.
  --run-id <id>            UI smoke run id, matching [A-Za-z0-9._-]{1,80}.
  --timeout <sec>          Marker wait timeout after Maestro finishes. Default: 90.
  --flow <name>            main or fgs-optout. Default: main.
  --skip-build             Do not run xcodebuild.
  --skip-install           Do not install the built app.
  --derived-data <path>    DerivedData path for xcodebuild and app lookup.
  --bundle-id <id>         App bundle id.
  --metro-port <port>      Metro port for the preflight check. Default: 8081.
  -h, --help               Show this help.

Notes:
  On physical iOS devices, devicectl, xcodebuild and Maestro may expose
  different device identifiers. Use --device for devicectl,
  --xcodebuild-device-id for xcodebuild, and --maestro-device-id for Maestro.

Prerequisites:
  - Maestro is installed: https://maestro.mobile.dev/
  - Metro is running for debug builds.
  - The target simulator is booted, or the physical device is connected,
    unlocked, and trusted.
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

require_command() {
  local command_name="$1"

  if ! command -v "$command_name" >/dev/null 2>&1; then
    die 2 "${command_name} not found."
  fi
}

require_maestro() {
  if ! command -v maestro >/dev/null 2>&1; then
    die 2 "Maestro is required for UI smoke. Install it from https://maestro.mobile.dev/ and rerun this script."
  fi
}

run_logged() {
  local label="$1"
  local log_path="$2"
  shift 2

  echo "$label"
  set +e
  "$@" >"$log_path" 2>&1
  local status=$?
  set -e

  if [[ "$status" -ne 0 ]]; then
    echo "${label} failed with exit code ${status}." >&2
    tail -n 80 "$log_path" >&2 || true
    echo "Full log: ${log_path}" >&2
    exit 2
  fi
}

cleanup() {
  if [[ -n "$LOG_PID" ]]; then
    kill "$LOG_PID" >/dev/null 2>&1 || true
    wait "$LOG_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --simulator)
      MODE="simulator"
      if [[ -n "${2:-}" && "${2:-}" != --* ]]; then
        SIMULATOR="$2"
        shift 2
      else
        shift
      fi
      ;;
    --device)
      require_option_value "$1" "${2:-}"
      MODE="device"
      DEVICE="$2"
      shift 2
      ;;
    --xcodebuild-device-id)
      require_option_value "$1" "${2:-}"
      XCODEBUILD_DEVICE_ID="$2"
      shift 2
      ;;
    --maestro-device-id)
      require_option_value "$1" "${2:-}"
      MAESTRO_DEVICE_ID="$2"
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
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --skip-install)
      SKIP_INSTALL=1
      shift
      ;;
    --derived-data)
      require_option_value "$1" "${2:-}"
      DERIVED_DATA_PATH="$2"
      DERIVED_DATA_PROVIDED=1
      shift 2
      ;;
    --bundle-id)
      require_option_value "$1" "${2:-}"
      BUNDLE_ID="$2"
      shift 2
      ;;
    --metro-port)
      require_option_value "$1" "${2:-}"
      METRO_PORT="$2"
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

if ! [[ "$METRO_PORT" =~ ^[0-9]+$ ]] || (( METRO_PORT <= 0 )); then
  die 2 "Invalid --metro-port '${METRO_PORT}'. Use a positive integer port."
fi

if [[ -z "$RUN_ID" ]]; then
  RUN_ID="ios-ui-$(date +%s)-$$"
fi
validate_run_id "$RUN_ID"

require_maestro
require_command xcrun

if [[ "$SKIP_BUILD" -eq 1 && "$SKIP_INSTALL" -eq 0 && "$DERIVED_DATA_PROVIDED" -eq 0 ]]; then
  die 2 "--skip-build with install enabled requires --derived-data <path>, or use --skip-install."
fi

if [[ -n "$DERIVED_DATA_PATH" && -e "$DERIVED_DATA_PATH" && ! -d "$DERIVED_DATA_PATH" ]]; then
  die 2 "--derived-data path exists but is not a directory: ${DERIVED_DATA_PATH}"
fi

if [[ -z "$DERIVED_DATA_PATH" ]]; then
  DERIVED_DATA_PATH="$(mktemp -d "${TMPDIR:-/tmp}/nitro-bg-ui-smoke-ios.XXXXXX")"
fi

FLOW_FILE=".maestro/ui-smoke-${FLOW}.yaml"
SMOKE_URL="nitrobgtimerexample://smoke?runId=${RUN_ID}&mode=ui"
SIMULATOR_APP_PATH="${DERIVED_DATA_PATH}/Build/Products/${CONFIGURATION}-iphonesimulator/${SCHEME}.app"
DEVICE_APP_PATH="${DERIVED_DATA_PATH}/Build/Products/${CONFIGURATION}-iphoneos/${SCHEME}.app"
MAESTRO_LOG_FILE="$(mktemp -t nitro-bg-ui-smoke-maestro-ios.XXXXXX.log)"

if [[ ! -f "$FLOW_FILE" ]]; then
  die 2 "Maestro flow not found: ${FLOW_FILE}"
fi

ensure_workspace_exists() {
  if [[ ! -d "$WORKSPACE" ]]; then
    die 2 "Workspace not found: ${WORKSPACE}. Run yarn example:pods first."
  fi
}

check_metro() {
  local status_body

  for host in "127.0.0.1" "localhost"; do
    if status_body="$(curl --silent --show-error --fail --max-time 2 "http://${host}:${METRO_PORT}/status" 2>/dev/null)" &&
      grep -F "packager-status:running" <<<"$status_body" >/dev/null; then
      echo "Metro: running at http://${host}:${METRO_PORT}"
      return 0
    fi
  done

  die 2 "Metro is not running at port ${METRO_PORT}. Start it with: yarn example:start"
}

ensure_booted_simulator() {
  if [[ "$SIMULATOR" == "booted" ]]; then
    if xcrun simctl list devices booted | grep -q '(Booted)'; then
      return 0
    fi

    die 2 "No booted simulator found. Boot one with 'xcrun simctl boot <udid>' or open Simulator, then rerun."
  fi

  if xcrun simctl list devices booted | grep -F "$SIMULATOR" | grep -q '(Booted)'; then
    return 0
  fi

  die 2 "Simulator '${SIMULATOR}' is not booted. Boot it with: xcrun simctl boot ${SIMULATOR}"
}

assert_app_bundle_exists() {
  local app_path="$1"
  local hint="$2"

  if [[ ! -d "$app_path" ]]; then
    die 2 "Expected app bundle not found: ${app_path}. ${hint}"
  fi
}

build_simulator_app() {
  local build_log
  build_log="$(mktemp -t nitro-bg-ui-smoke-ios-build-sim.XXXXXX.log)"

  run_logged "Building iOS simulator app into DerivedData: ${DERIVED_DATA_PATH}" "$build_log" \
    xcodebuild \
      -workspace "$WORKSPACE" \
      -scheme "$SCHEME" \
      -configuration "$CONFIGURATION" \
      -sdk iphonesimulator \
      -destination "generic/platform=iOS Simulator" \
      -derivedDataPath "$DERIVED_DATA_PATH" \
      build

  assert_app_bundle_exists "$SIMULATOR_APP_PATH" "Check the xcodebuild output: ${build_log}"
}

build_device_app() {
  local build_log
  local xcodebuild_device_id
  build_log="$(mktemp -t nitro-bg-ui-smoke-ios-build-device.XXXXXX.log)"
  xcodebuild_device_id="$XCODEBUILD_DEVICE_ID"

  if [[ -z "$xcodebuild_device_id" ]]; then
    xcodebuild_device_id="$DEVICE"
  fi

  run_logged "Building iOS device app into DerivedData: ${DERIVED_DATA_PATH}" "$build_log" \
    xcodebuild \
      -workspace "$WORKSPACE" \
      -scheme "$SCHEME" \
      -configuration "$CONFIGURATION" \
      -destination "platform=iOS,id=${xcodebuild_device_id}" \
      -derivedDataPath "$DERIVED_DATA_PATH" \
      build

  assert_app_bundle_exists "$DEVICE_APP_PATH" "Check the xcodebuild output: ${build_log}"
}

install_simulator_app() {
  local install_log
  install_log="$(mktemp -t nitro-bg-ui-smoke-ios-install-sim.XXXXXX.log)"
  assert_app_bundle_exists "$SIMULATOR_APP_PATH" "Run without --skip-build or pass --derived-data with a simulator build."
  run_logged "Installing simulator app: ${SIMULATOR_APP_PATH}" "$install_log" \
    xcrun simctl install "$SIMULATOR" "$SIMULATOR_APP_PATH"
}

install_device_app() {
  local install_log
  install_log="$(mktemp -t nitro-bg-ui-smoke-ios-install-device.XXXXXX.log)"
  assert_app_bundle_exists "$DEVICE_APP_PATH" "Run without --skip-build or pass --derived-data with a device build."
  run_logged "Installing device app: ${DEVICE_APP_PATH}" "$install_log" \
    xcrun devicectl device install app --device "$DEVICE" "$DEVICE_APP_PATH"
}

start_simulator_log_capture() {
  local predicate
  LOG_FILE="$(mktemp -t nitro-bg-ui-smoke-ios-simulator.XXXXXX.log)"
  predicate="process == \"${PROCESS_NAME}\" OR eventMessage CONTAINS \"${RUN_ID}\" OR eventMessage CONTAINS \"NitroBgUiSmoke\" OR eventMessage CONTAINS \"NitroBgSmoke\" OR eventMessage CONTAINS \"RedBox\" OR eventMessage CONTAINS \"ReactNativeJS\" OR eventMessage CONTAINS \"Fatal error\""

  xcrun simctl spawn "$SIMULATOR" log stream \
    --style compact \
    --level debug \
    --predicate "$predicate" \
    >"$LOG_FILE" 2>&1 &
  LOG_PID="$!"
  sleep 0.5
  echo "Log capture: simctl log stream -> ${LOG_FILE}"
}

start_device_log_capture() {
  LOG_FILE="$(mktemp -t nitro-bg-ui-smoke-ios-device.XXXXXX.log)"

  xcrun devicectl device process launch \
    --device "$DEVICE" \
    --console \
    "$BUNDLE_ID" \
    >"$LOG_FILE" 2>&1 &
  LOG_PID="$!"
  sleep 2
  echo "Log capture: devicectl --console -> ${LOG_FILE}"
}

open_smoke_url() {
  if [[ "$MODE" == "simulator" ]]; then
    xcrun simctl openurl "$SIMULATOR" "$SMOKE_URL"
    return $?
  fi

  xcrun devicectl device process launch \
    --device "$DEVICE" \
    --payload-url "$SMOKE_URL" \
    "$BUNDLE_ID"
}

run_maestro_flow() {
  local status
  local maestro_device_id
  local maestro_args=(test)

  if [[ "$MODE" == "device" ]]; then
    if [[ -n "$MAESTRO_DEVICE_ID" ]]; then
      maestro_device_id="$MAESTRO_DEVICE_ID"
    elif [[ -n "$XCODEBUILD_DEVICE_ID" ]]; then
      maestro_device_id="$XCODEBUILD_DEVICE_ID"
    else
      maestro_device_id="$DEVICE"
      echo "Warning: Using --device as Maestro device id. On physical iOS devices Maestro may require the Xcode/Apple UDID; pass --maestro-device-id if needed." >&2
    fi

    maestro_args+=(--device "$maestro_device_id")
  elif [[ "$SIMULATOR" != "booted" ]]; then
    maestro_args+=(--device "$SIMULATOR")
  fi

  maestro_args+=("$FLOW_FILE")

  set +e
  APP_ID="$BUNDLE_ID" SMOKE_URL="$SMOKE_URL" maestro "${maestro_args[@]}" >"$MAESTRO_LOG_FILE" 2>&1
  status=$?
  set -e

  if [[ "$status" -ne 0 ]]; then
    echo "FAIL runId=${RUN_ID} maestro_failed exit=${status}" >&2
    tail -n 80 "$MAESTRO_LOG_FILE" >&2 || true
    echo "Maestro log: ${MAESTRO_LOG_FILE}" >&2
    exit 1
  fi
}

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

poll_markers() {
  local deadline=$((SECONDS + TIMEOUT_SECONDS))
  local fail_line
  local error_line
  local missing=()
  local expected_markers=()

  if [[ "$FLOW" == "main" ]]; then
    expected_markers=("${expected_markers_main[@]}")
  else
    expected_markers=("${expected_markers_fgs_optout[@]}")
  fi

  while (( SECONDS < deadline )); do
    if fail_line="$(grep -F "[NitroBgUiSmoke] FAIL runId=${RUN_ID}" "$LOG_FILE" | tail -n 1)"; then
      echo "FAIL runId=${RUN_ID}"
      echo "$fail_line"
      return 1
    fi

    if error_line="$(grep -E "$RUNTIME_ERROR_PATTERN" "$LOG_FILE" | tail -n 1)"; then
      echo "FAIL runId=${RUN_ID} runtime_error_detected"
      echo "$error_line"
      return 1
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
      return 0
    fi

    sleep 0.25
  done

  echo "TIMEOUT runId=${RUN_ID} after ${TIMEOUT_SECONDS}s waiting for UI smoke markers" >&2
  echo "Missing markers:" >&2
  printf '  %s\n' "${missing[@]}" >&2
  grep -F "$RUN_ID" "$LOG_FILE" | tail -n 80 >&2 || true
  echo "Full log: ${LOG_FILE}" >&2
  echo "Maestro log: ${MAESTRO_LOG_FILE}" >&2
  return 124
}

ensure_workspace_exists
check_metro

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  require_command xcodebuild
fi

if [[ "$MODE" == "simulator" ]]; then
  ensure_booted_simulator
  echo "iOS simulator UI smoke runId=${RUN_ID} simulator=${SIMULATOR} flow=${FLOW}"
  echo "URL: ${SMOKE_URL}"
  echo "DerivedData: ${DERIVED_DATA_PATH}"

  if [[ "$SKIP_BUILD" -eq 0 ]]; then
    build_simulator_app
  else
    echo "Skipping simulator build by request."
  fi

  if [[ "$SKIP_INSTALL" -eq 0 ]]; then
    install_simulator_app
  else
    echo "Skipping simulator install by request; existing installed app will be tested."
  fi

  xcrun simctl terminate "$SIMULATOR" "$BUNDLE_ID" >/dev/null 2>&1 || true
  start_simulator_log_capture
  open_smoke_url
  run_maestro_flow
  poll_markers
  exit $?
fi

if [[ -z "$DEVICE" ]]; then
  die 2 "--device requires a physical device identifier."
fi

echo "iOS device UI smoke runId=${RUN_ID} device=${DEVICE} flow=${FLOW}"
echo "URL: ${SMOKE_URL}"
echo "DerivedData: ${DERIVED_DATA_PATH}"

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  build_device_app
else
  echo "Skipping device build by request."
fi

if [[ "$SKIP_INSTALL" -eq 0 ]]; then
  install_device_app
else
  echo "Skipping device install by request; existing installed app will be tested."
fi

start_device_log_capture
open_smoke_url
run_maestro_flow
poll_markers
exit $?
