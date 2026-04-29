#!/usr/bin/env bash
set -euo pipefail

BUNDLE_ID="org.reactjs.native.example.NitroBgTimerExample"
PROCESS_NAME="NitroBgTimerExample"
WORKSPACE="example/ios/NitroBgTimerExample.xcworkspace"
SCHEME="NitroBgTimerExample"
CONFIGURATION="Debug"
TIMEOUT_SECONDS=45
TIMEOUT_PROVIDED=0
MODE="simulator"
SIMULATOR="booted"
DEVICE=""
DEVICE_NAME=""
XCODEBUILD_DEVICE_ID=""
RUN_ID=""
OPEN_URL_ONLY=0
SKIP_BUILD=0
SKIP_INSTALL=0
TERMINATE_EXISTING=0
DERIVED_DATA_PATH=""
DERIVED_DATA_PROVIDED=0
METRO_PORT="${RCT_METRO_PORT:-8081}"
LAUNCH_STRATEGY="launch-then-open-url"
DEVICE_BOOT_WAIT_SECONDS=3
SMOKE_RUN_ID_PATTERN='^[A-Za-z0-9._-]{1,80}$'
RUNTIME_ERROR_PATTERN='NativeEventEmitter|RCTEventEmitter|RedBox|ReactNativeJS[[:space:]:]+Error|SIGABRT|std::terminate|Fatal error|RCTFatal|NSException|Terminating app'

LOG_FILE=""
LOG_PID=""
LOG_CAPTURE_KIND=""
URL_SENT=0
DEVICE_PROCESS_PID=""

usage() {
  cat <<'EOF'
Usage: bash scripts/smoke-ios.sh [options]

Modes:
  Automated simulator: bash scripts/smoke-ios.sh [--simulator [udid]]
  Automated device:    bash scripts/smoke-ios.sh --device <devicectl-id>
  Manual open only:    bash scripts/smoke-ios.sh [--device <udid>] --open-url-only

Options:
  --simulator [udid]       Use a booted simulator. Defaults to "booted".
  --device <id>            Use a physical device via xcrun devicectl.
  --xcodebuild-device-id <id>
                           xcodebuild destination id for the same physical device.
                           Use this when devicectl and xcodebuild expose different
                           identifiers for the same physical device.
  --run-id <id>            Smoke run id, matching [A-Za-z0-9._-]{1,80}.
  --timeout <sec>          Result timeout. Default: 45s simulator, 60s device.
  --skip-build             Do not run xcodebuild.
  --skip-install           Do not install the built app.
  --derived-data <path>    DerivedData path for xcodebuild and app lookup.
  --terminate-existing     Terminate only the example app if it is already running.
  --open-url-only          Open the smoke deep link only; no build/install/log wait.
  --bundle-id <id>         App bundle id. Default: org.reactjs.native.example.NitroBgTimerExample.
  --metro-port <port>      Metro port for the preflight check. Default: 8081.
  --launch-strategy <name> Device launch strategy:
                           launch-then-open-url (default) or payload-at-launch.
  -h, --help               Show this help.

Automated mode:
  - Verifies Metro at http://127.0.0.1:<port>/status.
  - Builds Debug example app into a temporary DerivedData path by default.
  - Installs the resulting .app before launching, unless --skip-install is set.
  - Fails if the example app is already running unless --terminate-existing is set.
  - Device mode launches with console attached, then sends the deep link separately
    by default. Use --launch-strategy payload-at-launch to use the legacy single
    launch command with --payload-url.
  - Waits for [NitroBgSmoke] RESULT PASS/FAIL matching the run id.

Manual open-url-only mode:
  - Does not build, install, terminate, or capture logs.
  - Sends nitrobgtimerexample://smoke?runId=<id> and exits after the command succeeds.
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

run_logged() {
  local label="$1"
  local log_path="$2"
  shift 2

  echo "${label}"
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
    --run-id)
      require_option_value "$1" "${2:-}"
      RUN_ID="$2"
      shift 2
      ;;
    --timeout)
      require_option_value "$1" "${2:-}"
      TIMEOUT_SECONDS="$2"
      TIMEOUT_PROVIDED=1
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
    --terminate-existing)
      TERMINATE_EXISTING=1
      shift
      ;;
    --open-url-only)
      OPEN_URL_ONLY=1
      shift
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
    --launch-strategy)
      require_option_value "$1" "${2:-}"
      LAUNCH_STRATEGY="$2"
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

require_command xcrun

if ! [[ "$TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || (( TIMEOUT_SECONDS <= 0 )); then
  die 2 "Invalid --timeout '${TIMEOUT_SECONDS}'. Use a positive integer number of seconds."
fi

if ! [[ "$METRO_PORT" =~ ^[0-9]+$ ]] || (( METRO_PORT <= 0 )); then
  die 2 "Invalid --metro-port '${METRO_PORT}'. Use a positive integer port."
fi

case "$LAUNCH_STRATEGY" in
  launch-then-open-url|payload-at-launch)
    ;;
  *)
    die 2 "Invalid --launch-strategy '${LAUNCH_STRATEGY}'. Use launch-then-open-url or payload-at-launch."
    ;;
esac

if [[ "$MODE" == "device" && "$TIMEOUT_PROVIDED" -eq 0 ]]; then
  TIMEOUT_SECONDS=60
fi

if [[ -z "$RUN_ID" ]]; then
  RUN_ID="ios-$(date +%s)-$$"
fi
validate_run_id "$RUN_ID"

SMOKE_URL="nitrobgtimerexample://smoke?runId=${RUN_ID}"
SIMULATOR_APP_PATH=""
DEVICE_APP_PATH=""

ensure_workspace_exists() {
  if [[ ! -d "$WORKSPACE" ]]; then
    die 2 "Workspace not found: ${WORKSPACE}. Run yarn example:pods first."
  fi
}

check_metro() {
  local host
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

ensure_device_available() {
  local json_path
  local output_path
  local status

  json_path="$(mktemp -t nitro-bg-smoke-ios-devices.XXXXXX.json)"
  output_path="$(mktemp -t nitro-bg-smoke-ios-devices.XXXXXX.log)"

  set +e
  xcrun devicectl list devices --timeout 10 --json-output "$json_path" >"$output_path" 2>&1
  status=$?
  set -e

  if [[ "$status" -ne 0 ]]; then
    echo "Could not list devices with devicectl." >&2
    tail -n 40 "$output_path" >&2 || true
    rm -f "$json_path" "$output_path"
    exit 2
  fi

  if command -v jq >/dev/null 2>&1 &&
    jq -e --arg device "$DEVICE" '.. | scalars | select(tostring == $device)' "$json_path" >/dev/null 2>&1; then
    DEVICE_NAME="$(
      jq -r --arg device "$DEVICE" '
        [
          .. | objects
          | select([.. | scalars | tostring] | index($device))
          | (.deviceProperties?.name? // .name? // .properties?.name? // empty)
          | select(. != "")
        ] | first // empty
      ' "$json_path" 2>/dev/null || true
    )"
    rm -f "$json_path" "$output_path"
    return 0
  fi

  if grep -F "$DEVICE" "$json_path" >/dev/null 2>&1 || grep -F "$DEVICE" "$output_path" >/dev/null 2>&1; then
    DEVICE_NAME="$(
      awk -v device="$DEVICE" '
        index($0, device) {
          line = substr($0, 1, index($0, device) - 1)
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
          print line
          exit
        }
      ' "$output_path" 2>/dev/null || true
    )"
    rm -f "$json_path" "$output_path"
    return 0
  fi

  echo "Device '${DEVICE}' was not found by devicectl." >&2
  echo "Connected devices:" >&2
  cat "$output_path" >&2 || true
  rm -f "$json_path" "$output_path"
  exit 2
}

extract_xcodebuild_destination_id() {
  local destination_line="$1"

  printf '%s\n' "$destination_line" | sed -n 's/.*id:\([^,}]*\).*/\1/p' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

extract_xcodebuild_destination_name() {
  local destination_line="$1"

  printf '%s\n' "$destination_line" | sed -n 's/.*name:\([^}]*\).*/\1/p' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

collect_available_xcodebuild_ios_destinations() {
  local showdestinations_log="$1"
  local destinations_path="$2"

  awk '
    /Available destinations for/ {
      in_available = 1
      next
    }
    /Ineligible destinations for/ {
      in_available = 0
    }
    in_available && /\{[[:space:]]*platform:iOS,/ {
      print
    }
  ' "$showdestinations_log" >"$destinations_path" || true

  if [[ ! -s "$destinations_path" ]]; then
    grep -E '\{[[:space:]]*platform:iOS,' "$showdestinations_log" >"$destinations_path" 2>/dev/null || true
  fi
}

fail_xcodebuild_destination_resolution() {
  local detail="$1"
  local showdestinations_log="$2"

  echo "Could not resolve an xcodebuild destination for device ${DEVICE}." >&2
  if [[ -n "$DEVICE_NAME" ]]; then
    echo "devicectl device name: ${DEVICE_NAME}" >&2
  fi
  if [[ -n "$detail" ]]; then
    echo "$detail" >&2
  fi
  echo "devicectl id and xcodebuild destination id may differ." >&2
  echo "Pass --xcodebuild-device-id <id>." >&2
  echo >&2
  echo "Available xcodebuild destinations:" >&2
  if [[ -s "$showdestinations_log" ]]; then
    cat "$showdestinations_log" >&2
  else
    echo "(none listed)" >&2
  fi
  exit 2
}

resolve_xcodebuild_device_id() {
  local showdestinations_log
  local destinations_path
  local status
  local line
  local destination_id
  local destination_name
  local matched_id=""
  local match_count=0

  if [[ -n "$XCODEBUILD_DEVICE_ID" ]]; then
    echo "xcodebuild destination id: ${XCODEBUILD_DEVICE_ID} (provided)"
    return 0
  fi

  showdestinations_log="$(mktemp -t nitro-bg-smoke-ios-destinations.XXXXXX.log)"
  destinations_path="$(mktemp -t nitro-bg-smoke-ios-available-destinations.XXXXXX.log)"

  echo "Resolving xcodebuild destination for devicectl device ${DEVICE}..."
  set +e
  xcodebuild \
    -workspace "$WORKSPACE" \
    -scheme "$SCHEME" \
    -showdestinations \
    >"$showdestinations_log" 2>&1
  status=$?
  set -e

  if [[ "$status" -ne 0 ]]; then
    fail_xcodebuild_destination_resolution "xcodebuild -showdestinations failed with exit code ${status}." "$showdestinations_log"
  fi

  collect_available_xcodebuild_ios_destinations "$showdestinations_log" "$destinations_path"

  while IFS= read -r line; do
    destination_id="$(extract_xcodebuild_destination_id "$line")"
    if [[ "$destination_id" == "$DEVICE" ]]; then
      XCODEBUILD_DEVICE_ID="$DEVICE"
      rm -f "$showdestinations_log" "$destinations_path"
      echo "xcodebuild destination id: ${XCODEBUILD_DEVICE_ID} (matched devicectl id)"
      return 0
    fi
  done <"$destinations_path"

  if [[ -z "$DEVICE_NAME" ]]; then
    fail_xcodebuild_destination_resolution "devicectl did not expose a device name to match against xcodebuild destinations." "$showdestinations_log"
  fi

  while IFS= read -r line; do
    destination_name="$(extract_xcodebuild_destination_name "$line")"
    if [[ "$destination_name" == "$DEVICE_NAME" ]]; then
      destination_id="$(extract_xcodebuild_destination_id "$line")"
      if [[ -n "$destination_id" ]]; then
        matched_id="$destination_id"
        match_count=$((match_count + 1))
      fi
    fi
  done <"$destinations_path"

  if [[ "$match_count" -eq 1 ]]; then
    XCODEBUILD_DEVICE_ID="$matched_id"
    rm -f "$showdestinations_log" "$destinations_path"
    echo "xcodebuild destination id: ${XCODEBUILD_DEVICE_ID} (matched device name '${DEVICE_NAME}')"
    return 0
  fi

  if [[ "$match_count" -gt 1 ]]; then
    fail_xcodebuild_destination_resolution "Multiple xcodebuild destinations matched device name '${DEVICE_NAME}'." "$showdestinations_log"
  fi

  fail_xcodebuild_destination_resolution "No xcodebuild destination matched device name '${DEVICE_NAME}'." "$showdestinations_log"
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
  build_log="$(mktemp -t nitro-bg-smoke-ios-build-sim.XXXXXX.log)"

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
  build_log="$(mktemp -t nitro-bg-smoke-ios-build-device.XXXXXX.log)"

  if [[ -z "$XCODEBUILD_DEVICE_ID" ]]; then
    die 2 "Internal error: xcodebuild destination id was not resolved before device build."
  fi

  run_logged "Building iOS device app into DerivedData: ${DERIVED_DATA_PATH}" "$build_log" \
    xcodebuild \
      -workspace "$WORKSPACE" \
      -scheme "$SCHEME" \
      -configuration "$CONFIGURATION" \
      -destination "platform=iOS,id=${XCODEBUILD_DEVICE_ID}" \
      -derivedDataPath "$DERIVED_DATA_PATH" \
      build

  assert_app_bundle_exists "$DEVICE_APP_PATH" "Check the xcodebuild output: ${build_log}"
}

install_simulator_app() {
  local install_log
  install_log="$(mktemp -t nitro-bg-smoke-ios-install-sim.XXXXXX.log)"

  assert_app_bundle_exists "$SIMULATOR_APP_PATH" "Run without --skip-build or pass --derived-data with a simulator build."
  run_logged "Installing simulator app: ${SIMULATOR_APP_PATH}" "$install_log" \
    xcrun simctl install "$SIMULATOR" "$SIMULATOR_APP_PATH"
}

install_device_app() {
  local install_log
  install_log="$(mktemp -t nitro-bg-smoke-ios-install-device.XXXXXX.log)"

  assert_app_bundle_exists "$DEVICE_APP_PATH" "Run without --skip-build or pass --derived-data with a device build."
  run_logged "Installing device app: ${DEVICE_APP_PATH}" "$install_log" \
    xcrun devicectl device install app --device "$DEVICE" "$DEVICE_APP_PATH"
}

ensure_simulator_app_installed() {
  local output_path
  output_path="$(mktemp -t nitro-bg-smoke-ios-appinfo-sim.XXXXXX.log)"

  if xcrun simctl appinfo "$SIMULATOR" "$BUNDLE_ID" >"$output_path" 2>&1; then
    rm -f "$output_path"
    return 0
  fi

  echo "Example app is not installed on simulator '${SIMULATOR}'." >&2
  echo "Run this script without --skip-install, or install ${SIMULATOR_APP_PATH}." >&2
  tail -n 20 "$output_path" >&2 || true
  rm -f "$output_path"
  exit 2
}

ensure_device_app_installed() {
  local json_path
  local output_path
  local status

  json_path="$(mktemp -t nitro-bg-smoke-ios-apps.XXXXXX.json)"
  output_path="$(mktemp -t nitro-bg-smoke-ios-apps.XXXXXX.log)"

  set +e
  xcrun devicectl device info apps \
    --device "$DEVICE" \
    --bundle-id "$BUNDLE_ID" \
    --timeout 10 \
    --json-output "$json_path" \
    >"$output_path" 2>&1
  status=$?
  set -e

  if [[ "$status" -ne 0 ]]; then
    echo "Could not inspect installed apps on device '${DEVICE}'." >&2
    tail -n 40 "$output_path" >&2 || true
    rm -f "$json_path" "$output_path"
    exit 2
  fi

  if grep -F "$BUNDLE_ID" "$json_path" >/dev/null 2>&1 || grep -F "$BUNDLE_ID" "$output_path" >/dev/null 2>&1; then
    rm -f "$json_path" "$output_path"
    return 0
  fi

  echo "Example app ${BUNDLE_ID} is not installed on device '${DEVICE}'." >&2
  echo "Run this script without --skip-install, or install ${DEVICE_APP_PATH}." >&2
  rm -f "$json_path" "$output_path"
  exit 2
}

is_simulator_app_running() {
  # Simulator process lookup uses pgrep inside the booted simulator runtime.
  # simctl has no stable JSON process API, so this intentionally stays narrow.
  xcrun simctl spawn "$SIMULATOR" pgrep -f "$PROCESS_NAME" >/dev/null 2>&1
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

handle_existing_simulator_app() {
  if is_simulator_app_running; then
    if [[ "$TERMINATE_EXISTING" -ne 1 ]]; then
      die 2 "The example app is already running on simulator '${SIMULATOR}'. Close it or rerun with --terminate-existing."
    fi

    local terminate_log
    terminate_log="$(mktemp -t nitro-bg-smoke-ios-terminate-sim.XXXXXX.log)"
    run_logged "Terminating existing simulator app ${BUNDLE_ID}" "$terminate_log" \
      xcrun simctl terminate "$SIMULATOR" "$BUNDLE_ID"
    sleep 1
  fi
}

handle_existing_device_app() {
  if find_device_app_process; then
    if [[ "$TERMINATE_EXISTING" -ne 1 ]]; then
      die 2 "The example app is already running on device '${DEVICE}'. Close only ${PROCESS_NAME}, or rerun with --terminate-existing."
    fi

    if [[ -z "$DEVICE_PROCESS_PID" ]]; then
      die 2 "The example app appears to be running, but devicectl did not expose a safe PID. Close ${PROCESS_NAME} manually and rerun."
    fi

    local terminate_log
    terminate_log="$(mktemp -t nitro-bg-smoke-ios-terminate-device.XXXXXX.log)"
    run_logged "Terminating existing device app ${BUNDLE_ID} pid=${DEVICE_PROCESS_PID}" "$terminate_log" \
      xcrun devicectl device process terminate --device "$DEVICE" --pid "$DEVICE_PROCESS_PID"
    sleep 1
    return 0
  else
    local status=$?
    if [[ "$status" -ne 1 ]]; then
      exit "$status"
    fi
  fi
}

print_open_url_instructions() {
  echo "iOS smoke open-url-only runId=${RUN_ID}"
  echo "URL: ${SMOKE_URL}"
  echo "Open-url command was sent successfully."
  echo "This mode did not build, install, terminate, or capture logs."
  echo "Watch Metro or Xcode for:"
  echo "  [NitroBgSmokeNative] OPEN_URL url=nitrobgtimerexample://smoke?runId=${RUN_ID}"
  echo "  [NitroBgSmokeNative] LAUNCH_URL url=nitrobgtimerexample://smoke?runId=${RUN_ID}"
  echo "  [NitroBgSmoke] NATIVE_PENDING_URL_FOUND runId=${RUN_ID}"
  echo "  [NitroBgSmoke] DEEPLINK_RECEIVED runId=${RUN_ID}"
  echo "  [NitroBgSmoke] RUN_REQUESTED runId=${RUN_ID}"
  echo "  [NitroBgSmoke] START runId=${RUN_ID}"
  echo "  [NitroBgSmoke] RESULT PASS runId=${RUN_ID}"
  echo "  [NitroBgSmoke] RESULT FAIL runId=${RUN_ID} reason=<reason>"
  echo "The smoke is one-shot per app process because it calls BackgroundTimer.dispose(); reload or restart before rerunning."
}

open_smoke_url_only() {
  if [[ "$MODE" == "simulator" ]]; then
    ensure_booted_simulator
    echo "Opening iOS simulator smoke URL runId=${RUN_ID} simulator=${SIMULATOR}"
    xcrun simctl openurl "$SIMULATOR" "$SMOKE_URL"
    return $?
  fi

  if [[ -z "$DEVICE" ]]; then
    echo "--device requires a physical device identifier." >&2
    return 2
  fi

  ensure_device_available
  echo "Opening iOS device smoke URL runId=${RUN_ID} device=${DEVICE}"
  xcrun devicectl device process launch \
    --device "$DEVICE" \
    --payload-url "$SMOKE_URL" \
    "$BUNDLE_ID"
}

start_simulator_log_capture() {
  local predicate
  LOG_FILE="$(mktemp -t nitro-bg-smoke-ios-simulator.XXXXXX.log)"
  LOG_CAPTURE_KIND="simctl log stream"
  predicate="process == \"${PROCESS_NAME}\" OR eventMessage CONTAINS \"${RUN_ID}\" OR eventMessage CONTAINS \"NitroBgSmoke\" OR eventMessage CONTAINS \"NativeEventEmitter\" OR eventMessage CONTAINS \"RCTEventEmitter\" OR eventMessage CONTAINS \"RedBox\" OR eventMessage CONTAINS \"ReactNativeJS\" OR eventMessage CONTAINS \"Fatal error\""

  xcrun simctl spawn "$SIMULATOR" log stream \
    --style compact \
    --level debug \
    --predicate "$predicate" \
    >"$LOG_FILE" 2>&1 &
  LOG_PID="$!"
  sleep 0.5
  echo "Log capture: ${LOG_CAPTURE_KIND} -> ${LOG_FILE}"
}

start_device_launch_capture() {
  local capture_status
  local classified_status
  local launch_command
  LOG_FILE="$(mktemp -t nitro-bg-smoke-ios-device.XXXXXX.log)"
  LOG_CAPTURE_KIND="devicectl --console"

  launch_command=(
    xcrun devicectl device process launch
    --device "$DEVICE"
    --console
  )

  if [[ "$LAUNCH_STRATEGY" == "payload-at-launch" ]]; then
    launch_command+=(--payload-url "$SMOKE_URL")
  fi

  launch_command+=("$BUNDLE_ID")

  echo "Device launch strategy: ${LAUNCH_STRATEGY}"
  "${launch_command[@]}" >"$LOG_FILE" 2>&1 &
  LOG_PID="$!"
  sleep 0.5
  echo "Log capture: ${LOG_CAPTURE_KIND} -> ${LOG_FILE}"

  if [[ "$LAUNCH_STRATEGY" == "payload-at-launch" ]]; then
    URL_SENT=1
    return 0
  fi

  echo "Waiting ${DEVICE_BOOT_WAIT_SECONDS}s before sending smoke deep link..."
  sleep "$DEVICE_BOOT_WAIT_SECONDS"

  if [[ -n "$LOG_PID" ]] && ! kill -0 "$LOG_PID" >/dev/null 2>&1; then
    set +e
    wait "$LOG_PID"
    capture_status=$?
    set -e
    LOG_PID=""
    set +e
    classify_finished_capture "$capture_status"
    classified_status=$?
    set -e
    return "$classified_status"
  fi

  send_device_smoke_url
}

send_device_smoke_url() {
  local open_url_log
  local status

  open_url_log="$(mktemp -t nitro-bg-smoke-ios-open-url-device.XXXXXX.log)"

  echo "Opening ${SMOKE_URL} on device via devicectl payload-url"
  set +e
  xcrun devicectl device process launch \
    --device "$DEVICE" \
    --payload-url "$SMOKE_URL" \
    "$BUNDLE_ID" \
    >"$open_url_log" 2>&1
  status=$?
  set -e

  if [[ "$status" -ne 0 ]]; then
    echo "Could not open smoke deep link after console launch (exit ${status})." >&2
    tail -n 60 "$open_url_log" >&2 || true
    echo "Open URL log: ${open_url_log}" >&2
    return 2
  fi

  URL_SENT=1
  echo "Open URL command succeeded. Log: ${open_url_log}"
}

classify_finished_capture() {
  local capture_status="$1"
  local phase

  if grep -E "$RUNTIME_ERROR_PATTERN" "$LOG_FILE" >/dev/null 2>&1; then
    echo "FAIL runId=${RUN_ID} runtime_error_detected"
    grep -E "$RUNTIME_ERROR_PATTERN" "$LOG_FILE" | tail -n 1
    return 1
  fi

  if grep -Eiq 'not installed|Application.*not.*found|Failed to launch|Could not launch|Unable to launch|invalid device|not paired|not trusted|locked|already running' "$LOG_FILE"; then
    echo "Launch/configuration failed before smoke markers were observed." >&2
    tail -n 60 "$LOG_FILE" >&2 || true
    echo "Full log: ${LOG_FILE}" >&2
    return 2
  fi

  echo "${LOG_CAPTURE_KIND} ended before RESULT PASS/FAIL was observed (exit ${capture_status})." >&2
  phase="$(last_smoke_phase)"
  echo "Last smoke phase observed: ${phase}" >&2
  tail -n 60 "$LOG_FILE" >&2 || true
  echo "Full log: ${LOG_FILE}" >&2
  return 1
}

native_url_marker_for_run() {
  if [[ -z "$LOG_FILE" || ! -f "$LOG_FILE" ]]; then
    return 1
  fi

  grep -E "\\[NitroBgSmokeNative\\] (OPEN_URL|LAUNCH_URL) " "$LOG_FILE" |
    grep -F "runId=${RUN_ID}"
}

last_smoke_phase() {
  local phase="none"

  if [[ -z "$LOG_FILE" || ! -f "$LOG_FILE" ]]; then
    echo "$phase"
    return 0
  fi

  if native_url_marker_for_run >/dev/null 2>&1; then
    phase="native_url_received"
  fi

  if grep -F "[NitroBgSmoke] NATIVE_PENDING_URL_FOUND runId=${RUN_ID}" "$LOG_FILE" >/dev/null 2>&1; then
    phase="native_pending_url_found"
  fi

  if grep -F "[NitroBgSmoke] DEEPLINK_RECEIVED runId=${RUN_ID}" "$LOG_FILE" >/dev/null 2>&1; then
    phase="deeplink_received"
  fi

  if grep -F "[NitroBgSmoke] RUN_REQUESTED runId=${RUN_ID}" "$LOG_FILE" >/dev/null 2>&1; then
    phase="run_requested"
  fi

  if grep -F "[NitroBgSmoke] RUN_STARTED runId=${RUN_ID}" "$LOG_FILE" >/dev/null 2>&1 ||
    grep -F "[NitroBgSmoke] START runId=${RUN_ID}" "$LOG_FILE" >/dev/null 2>&1; then
    phase="start"
  fi

  if grep -F "[NitroBgSmoke] STEP PASS runId=${RUN_ID}" "$LOG_FILE" >/dev/null 2>&1; then
    phase="step_pass"
  fi

  if grep -F "[NitroBgSmoke] STEP FAIL runId=${RUN_ID}" "$LOG_FILE" >/dev/null 2>&1; then
    phase="step_fail"
  fi

  if grep -F "[NitroBgSmoke] RESULT FAIL runId=${RUN_ID}" "$LOG_FILE" >/dev/null 2>&1; then
    phase="result_fail"
  fi

  if grep -F "[NitroBgSmoke] RESULT PASS runId=${RUN_ID}" "$LOG_FILE" >/dev/null 2>&1; then
    phase="result_pass"
  fi

  echo "$phase"
}

print_timeout_diagnostics() {
  local phase="$1"

  echo "Last smoke phase observed: ${phase}" >&2

  case "$phase" in
    none)
      if grep -F "[NitroBgSmoke]" "$LOG_FILE" >/dev/null 2>&1; then
        echo "JS smoke markers were observed, but none matched runId=${RUN_ID}." >&2
      elif grep -F "[NitroBgSmokeNative]" "$LOG_FILE" >/dev/null 2>&1; then
        echo "Native smoke markers were observed, but none matched runId=${RUN_ID}." >&2
      elif [[ "$URL_SENT" -eq 1 ]]; then
        echo "No [NitroBgSmoke] or [NitroBgSmokeNative] marker captured. This may indicate URL delivery failure or console capture failure." >&2
      else
        echo "No smoke marker captured, and the smoke URL was not marked as sent." >&2
      fi
      ;;
    native_url_received)
      echo "iOS received the smoke deep link, but JS did not produce DEEPLINK_RECEIVED." >&2
      echo "Probable React Native Linking, JS console, or app JS initialization issue." >&2
      ;;
    native_pending_url_found)
      echo "JS consumed the native pending smoke URL, but did not produce DEEPLINK_RECEIVED." >&2
      ;;
    deeplink_received)
      echo "Deep link reached JS, but smoke did not start." >&2
      ;;
    run_requested)
      echo "Smoke run was requested in JS, but START was not captured." >&2
      ;;
    start|step_pass|step_fail)
      echo "Smoke started but did not complete." >&2
      ;;
    result_fail|result_pass)
      echo "Result marker was present but poll_result did not return before timeout." >&2
      ;;
  esac
}

poll_result() {
  local deadline=$((SECONDS + TIMEOUT_SECONDS))
  local capture_status
  local fail_line
  local error_line
  local phase

  while (( SECONDS < deadline )); do
    if grep -F "[NitroBgSmoke] RESULT PASS runId=${RUN_ID}" "$LOG_FILE" >/dev/null 2>&1; then
      echo "PASS runId=${RUN_ID}"
      return 0
    fi

    if fail_line="$(grep -F "[NitroBgSmoke] RESULT FAIL runId=${RUN_ID}" "$LOG_FILE" | tail -n 1)"; then
      echo "FAIL runId=${RUN_ID}"
      echo "$fail_line"
      return 1
    fi

    if fail_line="$(grep -F "[NitroBgSmoke] STEP FAIL runId=${RUN_ID}" "$LOG_FILE" | tail -n 1)"; then
      echo "FAIL runId=${RUN_ID}"
      echo "$fail_line"
      return 1
    fi

    if error_line="$(grep -E "$RUNTIME_ERROR_PATTERN" "$LOG_FILE" | tail -n 1)"; then
      echo "FAIL runId=${RUN_ID} runtime_error_detected"
      echo "$error_line"
      return 1
    fi

    if [[ -n "$LOG_PID" ]] && ! kill -0 "$LOG_PID" >/dev/null 2>&1; then
      set +e
      wait "$LOG_PID"
      capture_status=$?
      set -e
      LOG_PID=""
      set +e
      classify_finished_capture "$capture_status"
      local classified_status=$?
      set -e
      return "$classified_status"
    fi

    sleep 0.25
  done

  echo "TIMEOUT runId=${RUN_ID} after ${TIMEOUT_SECONDS}s" >&2
  phase="$(last_smoke_phase)"
  print_timeout_diagnostics "$phase"
  echo "Log source: ${LOG_CAPTURE_KIND:-none}" >&2
  grep -F "$RUN_ID" "$LOG_FILE" | tail -n 40 >&2 || true
  echo "Full log: ${LOG_FILE}" >&2
  return 124
}

if [[ "$OPEN_URL_ONLY" -eq 1 ]]; then
  if ! open_smoke_url_only; then
    echo "Could not open smoke deep link: ${SMOKE_URL}" >&2
    exit 2
  fi

  print_open_url_instructions
  exit 0
fi

if [[ "$SKIP_BUILD" -eq 1 && "$SKIP_INSTALL" -eq 0 && "$DERIVED_DATA_PROVIDED" -eq 0 ]]; then
  die 2 "--skip-build with install enabled requires --derived-data <path> containing a previous ${SCHEME}.app, or use --skip-install."
fi

if [[ -n "$DERIVED_DATA_PATH" && -e "$DERIVED_DATA_PATH" && ! -d "$DERIVED_DATA_PATH" ]]; then
  die 2 "--derived-data path exists but is not a directory: ${DERIVED_DATA_PATH}"
fi

if [[ -z "$DERIVED_DATA_PATH" ]]; then
  DERIVED_DATA_PATH="$(mktemp -d "${TMPDIR:-/tmp}/nitro-bg-smoke-ios.XXXXXX")"
fi

SIMULATOR_APP_PATH="${DERIVED_DATA_PATH}/Build/Products/${CONFIGURATION}-iphonesimulator/${SCHEME}.app"
DEVICE_APP_PATH="${DERIVED_DATA_PATH}/Build/Products/${CONFIGURATION}-iphoneos/${SCHEME}.app"

ensure_workspace_exists
require_command xcodebuild

if [[ "$MODE" == "simulator" ]]; then
  ensure_booted_simulator
  check_metro

  echo "iOS simulator smoke runId=${RUN_ID} simulator=${SIMULATOR}"
  echo "URL: ${SMOKE_URL}"
  echo "DerivedData: ${DERIVED_DATA_PATH}"

  handle_existing_simulator_app

  if [[ "$SKIP_BUILD" -eq 0 ]]; then
    build_simulator_app
  else
    echo "Skipping simulator build by request."
  fi

  if [[ "$SKIP_INSTALL" -eq 0 ]]; then
    install_simulator_app
  else
    echo "Skipping simulator install by request; existing installed app will be tested."
    ensure_simulator_app_installed
  fi

  handle_existing_simulator_app
  start_simulator_log_capture

  echo "Opening ${SMOKE_URL}"
  if ! xcrun simctl openurl "$SIMULATOR" "$SMOKE_URL"; then
    echo "Could not open smoke deep link. The example app may not be installed for scheme ${SMOKE_URL}." >&2
    exit 2
  fi
  URL_SENT=1

  echo "Waiting up to ${TIMEOUT_SECONDS}s for [NitroBgSmoke] RESULT runId=${RUN_ID}"
  poll_result
  exit $?
fi

if [[ -z "$DEVICE" ]]; then
  die 2 "--device requires a physical device identifier."
fi

ensure_device_available
check_metro

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  resolve_xcodebuild_device_id
fi

echo "iOS device smoke runId=${RUN_ID} device=${DEVICE}"
if [[ -n "$DEVICE_NAME" ]]; then
  echo "Device name: ${DEVICE_NAME}"
fi
if [[ "$SKIP_BUILD" -eq 0 ]]; then
  echo "xcodebuild destination: platform=iOS,id=${XCODEBUILD_DEVICE_ID}"
fi
echo "URL: ${SMOKE_URL}"
echo "DerivedData: ${DERIVED_DATA_PATH}"
echo "Launch strategy: ${LAUNCH_STRATEGY}"
echo "Physical iOS backgrounding is manual/XCUITest follow-up; this runner launches the foreground smoke."

handle_existing_device_app

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  build_device_app
else
  echo "Skipping device build by request."
fi

if [[ "$SKIP_INSTALL" -eq 0 ]]; then
  install_device_app
else
  echo "Skipping device install by request; existing installed app will be tested."
  ensure_device_app_installed
fi

handle_existing_device_app
start_device_launch_capture

echo "Waiting up to ${TIMEOUT_SECONDS}s for [NitroBgSmoke] RESULT runId=${RUN_ID}"
poll_result
exit $?
