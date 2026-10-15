#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/smoke-android.sh"
APP_PID=""
INSTALLED_APP=""

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

LOG_FILE=""
LOG_PID=""

usage() {
  cat <<'EOF'
Usage: bash scripts/ui-smoke-ios.sh [options]

Modes:
  Simulator: bash scripts/ui-smoke-ios.sh [--simulator [udid]]
  Device:    bash scripts/ui-smoke-ios.sh --device <devicectl-id> [--xcodebuild-device-id <id>] [--maestro-device-id <id>]

Options:
  --configuration <name>  Debug or Release. Default: Debug.
  --simulator [udid]       Use a booted simulator. Defaults to "booted".
  --device <id>            Use a physical device via xcrun devicectl.
  --xcodebuild-device-id <id>
                           xcodebuild destination id for the same physical device.
  --maestro-device-id <id>
                           Maestro device id for the same physical device.
  --run-id <id>            UI smoke run id, matching [A-Za-z0-9._-]{1,80}.
  --timeout <sec>          Bound each Maestro command and marker wait. Default: 90.
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
  if [[ -n "${LOG_FILE:-}" ]]; then echo "Log: $LOG_FILE"; fi
  if [[ -n "$LOG_PID" ]]; then
    kill "$LOG_PID" >/dev/null 2>&1 || true
    wait "$LOG_PID" >/dev/null 2>&1 || true
  fi
}
trap 'cleanup; harness_unlock' EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --configuration)
      require_option_value "$1" "${2:-}"
      CONFIGURATION="$2"; shift 2 ;;
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

if [[ -z "$BUNDLE_ID" ]]; then
  die 2 "App bundle id is empty."
fi

if [[ -z "$RUN_ID" ]]; then
  RUN_ID="ios-ui-$(date +%s)-$$"
fi
validate_run_id "$RUN_ID"

require_maestro
if [[ "$MODE" == device && "$SKIP_INSTALL" -eq 1 && "${OPEN_URL_ONLY:-0}" -eq 0 ]]; then
  die 2 "Physical qualification requires installing the supplied built app; --skip-install cannot prove its provenance."
fi
case "$CONFIGURATION" in Debug|Release) ;; *) die 2 "Invalid configuration" ;; esac
require_command node
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
  local resolved
  resolved="$(xcrun simctl list devices booted -j | node -e '
    let data="";process.stdin.on("data",x=>data+=x);process.stdin.on("end",()=>{
      const devices=Object.values(JSON.parse(data).devices).flat().filter(d=>d.state==="Booted");
      const wanted=process.argv[1];const xs=devices.filter(d=>wanted==="booted" || d.udid===wanted);
      if(xs.length!==1)process.exit(2);console.log(xs[0].udid);
    })' "$SIMULATOR")" || die 2 "Select exactly one booted simulator with --simulator <udid>."
  SIMULATOR="$resolved"
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

verify_simulator_artifact() {
  INSTALLED_APP="$(xcrun simctl get_app_container "$SIMULATOR" "$BUNDLE_ID" app)"
  harness_compare_apps "$SIMULATOR_APP_PATH" "$INSTALLED_APP" || die 2 "Installed app provenance failed. Provide the matching --derived-data."
}

launch_simulator_process() {
  local launch_output
  launch_output="$(xcrun simctl launch --terminate-running-process "$SIMULATOR" "$BUNDLE_ID")"
  APP_PID="${launch_output##*: }"
  [[ "$APP_PID" =~ ^[0-9]+$ ]] || die 2 "Launch PID unavailable: $launch_output"
  echo "PID: $APP_PID"
}

validate_current_process() {
  if [[ "$MODE" == simulator ]]; then
    kill -0 "$APP_PID" 2>/dev/null || die 1 "FAIL process_ended pid=$APP_PID"
    local actual
    actual="$(ps -p "$APP_PID" -o comm=)"
    [[ "$actual" == "$INSTALLED_APP/$PROCESS_NAME" ]] || die 1 "FAIL process_identity_changed"
  else
    find_device_app_process || die 1 "FAIL device_process_missing"
    [[ "$DEVICE_PROCESS_PID" == "$APP_PID" ]] || die 1 "FAIL device_process_changed"
  fi
  kill -0 "$LOG_PID" 2>/dev/null || die 1 "FAIL log_capture_ended"
}

start_simulator_log_capture() {
  local predicate
  LOG_FILE="$(mktemp -t nitro-bg-ui-smoke-ios-simulator.XXXXXX.log)"
  predicate="process == \"${PROCESS_NAME}\""

  xcrun simctl spawn "$SIMULATOR" log stream \
    --style compact \
    --level debug \
    --predicate "$predicate" \
    >"$LOG_FILE" 2>&1 &
  LOG_PID="$!"
  sleep 0.5
  echo "Log capture: simctl log stream -> ${LOG_FILE}"
}

find_device_app_process() {
  local json_path
  local output_path
  local status
  local pid

  DEVICE_PROCESS_PID=""
  json_path="$(mktemp -t nitro-bg-smoke-ios-processes.XXXXXX.json)"
  output_path="$(mktemp -t nitro-bg-smoke-ios-processes.XXXXXX.log)"

  set +e
  xcrun devicectl device info processes \
    --device "$DEVICE" \
    --timeout 10 \
    --json-output "$json_path" \
    >"$output_path" 2>&1
  status=$?
  set -e

  if [[ "$status" -ne 0 ]]; then
    echo "Could not inspect running processes for device ${DEVICE}." >&2
    echo "Make sure the device is connected, unlocked, trusted, and available to devicectl." >&2
    tail -n 40 "$output_path" >&2 || true
    rm -f "$json_path" "$output_path"
    return 2
  fi

  if command -v jq >/dev/null 2>&1; then
    # devicectl JSON is the stable interface, but process field names have
    # varied across Xcode releases. Match known bundle/process name fields and
    # only treat numeric process identifiers as terminable PIDs.
    pid="$(
      jq -r --arg bundle "$BUNDLE_ID" --arg name "$PROCESS_NAME" '
        def matches_app:
          (.bundleIdentifier? == $bundle)
          or (.bundleID? == $bundle)
          or (.bundleId? == $bundle)
          or (.applicationIdentifier? == $bundle)
          or (.name? == $name)
          or (.processName? == $name)
          or (.executableName? == $name)
          or (((.executable? // "") | tostring | endswith("/" + $name)) == true)
          or (((.path? // "") | tostring | endswith("/" + $name)) == true);

        [.. | objects | select(matches_app) | (.processIdentifier? // .pid? // .processID? // empty)]
        | map(tostring)
        | map(select(test("^[0-9]+$")))
        | first // empty
      ' "$json_path" 2>/dev/null || true
    )"

    if [[ -n "$pid" ]]; then
      DEVICE_PROCESS_PID="$pid"
      rm -f "$json_path" "$output_path"
      return 0
    fi

    if jq -e --arg bundle "$BUNDLE_ID" --arg name "$PROCESS_NAME" '
      def matches_app:
        (.bundleIdentifier? == $bundle)
        or (.bundleID? == $bundle)
        or (.bundleId? == $bundle)
        or (.applicationIdentifier? == $bundle)
        or (.name? == $name)
        or (.processName? == $name)
        or (.executableName? == $name)
        or (((.executable? // "") | tostring | endswith("/" + $name)) == true)
        or (((.path? // "") | tostring | endswith("/" + $name)) == true);

      [.. | objects | select(matches_app)] | length > 0
    ' "$json_path" >/dev/null 2>&1; then
      rm -f "$json_path" "$output_path"
      return 0
    fi
  fi

  # Fallback for hosts without jq or unexpected JSON shape. This can only
  # answer "running/not running"; it cannot safely provide a PID to terminate.
  if grep -F "$BUNDLE_ID" "$json_path" >/dev/null 2>&1 ||
    grep -F "$PROCESS_NAME" "$json_path" >/dev/null 2>&1 ||
    grep -F "$BUNDLE_ID" "$output_path" >/dev/null 2>&1 ||
    grep -F "$PROCESS_NAME" "$output_path" >/dev/null 2>&1; then
    rm -f "$json_path" "$output_path"
    return 0
  fi

  rm -f "$json_path" "$output_path"
  return 1
}

start_device_log_capture() {
  LOG_FILE="$(mktemp -t nitro-bg-ui-smoke-ios-device.XXXXXX.log)"

  xcrun devicectl device process launch \
    --device "$DEVICE" \
    --console \
    --terminate-existing \
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

  maestro_args+=(
    -e "APP_ID=${BUNDLE_ID}"
    -e "SMOKE_URL=${SMOKE_URL}"
    "$FLOW_FILE"
  )

  set +e
  echo "Maestro APP_ID: ${BUNDLE_ID}"
  harness_ui_flow "${maestro_args[@]}" >"$MAESTRO_LOG_FILE" 2>&1
  status=$?
  set -e

  if [[ "$status" -ne 0 ]]; then
    harness_validate "$LOG_FILE" "$RUN_ID" ios "$APP_PID" "$FLOW" poll "$PROCESS_NAME" || true
    echo "HARNESS/TOOLING FAIL runId=${RUN_ID} maestro_failed exit=${status}" >&2
    tail -n 80 "$MAESTRO_LOG_FILE" >&2 || true
    echo "Maestro log: ${MAESTRO_LOG_FILE}" >&2
    exit 1
  fi
}

validate_ui_progress() {
  local status=0
  validate_current_process
  harness_validate "$LOG_FILE" "$RUN_ID" ios "$APP_PID" "$FLOW" poll "$PROCESS_NAME" || status=$?
  [[ "$status" -eq 3 ]] || [[ "$status" -eq 0 ]] || return "$status"
}

wait_for_ui_context() {
  local deadline=$((SECONDS + 30)) status
  while (( SECONDS < deadline )); do
    validate_current_process
    status=0
    harness_validate "$LOG_FILE" "$RUN_ID" ios "$APP_PID" "$FLOW" poll "$PROCESS_NAME" || status=$?
    [[ "$status" -eq 3 ]] || [[ "$status" -eq 0 ]] || return "$status"
    if grep -F "[NitroBgUiSmoke] CONTEXT runId=$RUN_ID mode=ui" "$LOG_FILE" >/dev/null; then return 0; fi
    sleep 0.25
  done
  die 124 "TIMEOUT UI context runId=$RUN_ID log=$LOG_FILE"
}

poll_markers() {
  local deadline=$((SECONDS + TIMEOUT_SECONDS)) status
  while (( SECONDS < deadline )); do
    validate_current_process
    status=0
    harness_validate "$LOG_FILE" "$RUN_ID" ios "$APP_PID" "$FLOW" poll "$PROCESS_NAME" || status=$?
    if [[ "$status" -eq 0 ]]; then
      if [[ "$MODE" == simulator ]]; then verify_simulator_artifact; fi
      validate_current_process
      harness_validate "$LOG_FILE" "$RUN_ID" ios "$APP_PID" "$FLOW" final "$PROCESS_NAME"
      echo "PASS runId=$RUN_ID pid=$APP_PID flow=$FLOW log=$LOG_FILE maestro=$MAESTRO_LOG_FILE"
      return 0
    fi
    [[ "$status" -eq 3 ]] || return "$status"
    sleep 0.25
  done
  die 124 "TIMEOUT UI markers runId=$RUN_ID log=$LOG_FILE maestro=$MAESTRO_LOG_FILE"
}

ensure_workspace_exists
if [[ "$CONFIGURATION" == Debug ]]; then check_metro; fi

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  require_command xcodebuild
fi

if [[ "$MODE" == "simulator" ]]; then
  ensure_booted_simulator
  harness_lock ios "$SIMULATOR" "$RUN_ID"
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

  verify_simulator_artifact
  start_simulator_log_capture
  launch_simulator_process
  harness_ios_dialogs "$SIMULATOR" "$BUNDLE_ID" prepare
  status=0
  harness_validate "$LOG_FILE" "$RUN_ID" ios "$APP_PID" "$FLOW" poll "$PROCESS_NAME" || status=$?
  [[ "$status" -eq 3 ]] || die 1 "FAIL unexpected_execution_before_current_URL"
  open_smoke_url
  harness_ios_dialogs "$SIMULATOR" "$BUNDLE_ID" confirm
  wait_for_ui_context
  run_maestro_flow
  poll_markers
  exit $?
fi

if [[ -z "$DEVICE" ]]; then
  die 2 "--device requires a physical device identifier."
fi

harness_lock ios "$DEVICE" "$RUN_ID"
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
find_device_app_process || die 1 "FAIL device_pid_unavailable"
APP_PID="$DEVICE_PROCESS_PID"
echo "PID: $APP_PID"
open_smoke_url
wait_for_ui_context
run_maestro_flow
poll_markers
exit $?
