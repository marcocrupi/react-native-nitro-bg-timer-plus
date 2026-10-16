#!/usr/bin/env bash
set -euo pipefail

# Builds the packed library inside a fresh React Native app for each requested
# RN version. Peers are installed with --strict-peer-deps, so a version
# outside the declared peer range fails at install time.
#
# Usage: scripts/compat-matrix.sh [--platform android|ios|all] [--run]
#                                 [--work-dir DIR] [--keep] [--nitro-ios-compat]
#                                 <rn-version>...
#
# --run launches the release build on a booted Android emulator/device (adb) or
# a booted iOS simulator and waits for the in-app timer check to report PASS.
# With several adb devices attached, select one with ANDROID_SERIAL.

usage() {
  sed -n '7,14p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PLATFORM=all
RUN=0
KEEP=0
NITRO_IOS_COMPAT=0
WORK_DIR=""
VERSIONS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) [[ $# -ge 2 && -n "$2" ]] || usage; PLATFORM="$2"; shift 2 ;;
    --run) RUN=1; shift ;;
    --keep) KEEP=1; shift ;;
    --nitro-ios-compat) NITRO_IOS_COMPAT=1; shift ;;
    --work-dir) [[ $# -ge 2 && -n "$2" ]] || usage; WORK_DIR="$2"; shift 2 ;;
    -h|--help) usage ;;
    -*) echo "Unknown option: $1" >&2; usage ;;
    *) VERSIONS+=("$1"); shift ;;
  esac
done

[[ ${#VERSIONS[@]} -gt 0 ]] || usage
[[ "$PLATFORM" =~ ^(android|ios|all)$ ]] || usage
for rn in "${VERSIONS[@]}"; do
  [[ "$rn" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || usage
done
[[ "$PLATFORM" == android || "$(uname)" == Darwin ]] || { echo "iOS builds require macOS; use --platform android" >&2; exit 2; }

APP_NAME=NitroBgCompat
LOG_TAG='[NitroBgCompat]'
CLI_VERSION="${RN_CLI_VERSION:-latest}"
REPORT_PORT="${COMPAT_REPORT_PORT:-8765}"
NITRO_VERSION="${NITRO_VERSION:-$(node -p "require('${ROOT_DIR}/package.json').devDependencies['react-native-nitro-modules']")}"
WORK_DIR="${WORK_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/nitro-bg-compat.XXXXXX")}"
mkdir -p "$WORK_DIR"
WORK_DIR="$(cd "$WORK_DIR" && pwd -P)"
SUMMARY="${WORK_DIR}/summary.txt"
: > "$SUMMARY"

log() { printf '\n==> %s\n' "$*"; }

pack_library() {
  log "Packing library"
  local out="${WORK_DIR}/pack"
  rm -rf "$out" && mkdir -p "$out" || return
  (cd "$ROOT_DIR" && npm pack --silent --pack-destination "$out" >/dev/null) || return
  TARBALL="$(ls "$out"/*.tgz)" || return
  echo "$TARBALL"
}

write_app() {
  local app="$1" rn="$2"
  cat > "${app}/App.tsx" <<TSX
import React, { useEffect, useState } from 'react'
import { Platform, SafeAreaView, Text } from 'react-native'
import { BackgroundTimer } from 'react-native-nitro-bg-timer-plus'

const report = (result: object) => {
  const message = '${LOG_TAG} ' + JSON.stringify({
    runId: '${RUN_ID}',
    rn: '${rn}',
    os: Platform.OS,
    ...result,
  })
  console.log(message)
  // Release iOS builds drop JS console output; the simulator shares the host's
  // localhost, so report to the runner's listener instead.
  if (Platform.OS === 'ios') {
    fetch('http://localhost:${REPORT_PORT}/report', {
      method: 'POST',
      body: message,
    }).catch(() => {})
  }
}

export default function App() {
  const [status, setStatus] = useState('RUNNING')

  useEffect(() => {
    const startedAt = Date.now()
    let ticks = 0
    let clearedFired = false
    try {
      const interval = BackgroundTimer.setInterval(() => {
        ticks++
      }, 50)
      const cleared = BackgroundTimer.setTimeout(() => {
        clearedFired = true
      }, 100)
      BackgroundTimer.clearTimeout(cleared)
      BackgroundTimer.setTimeout(() => {
        BackgroundTimer.clearInterval(interval)
        const elapsed = Date.now() - startedAt
        const ok = elapsed >= 250 && ticks >= 2 && !clearedFired
        const result = ok ? 'PASS' : 'FAIL'
        report({ status: result, elapsed, ticks, clearedFired })
        setStatus(result)
      }, 300)
    } catch (error) {
      report({ status: 'FAIL', error: String(error) })
      setStatus('FAIL')
    }
  }, [])

  return (
    <SafeAreaView>
      <Text testID="status">{\`${LOG_TAG} \${status}\`}</Text>
    </SafeAreaView>
  )
}
TSX
}

create_app() {
  local rn="$1" app="$2"
  log "RN ${rn}: creating app"
  rm -rf "$app" || return
  npx --yes "@react-native-community/cli@${CLI_VERSION}" init "$APP_NAME" \
    --version "$rn" --directory "$app" --pm npm \
    --skip-install --skip-git-init --install-pods false || return
  write_app "$app" "$rn" || return
  log "RN ${rn}: installing app dependencies with strict peers"
  # Anchor RN's exact transitive version at the root as well. Otherwise npm's
  # strict resolver can select today's RN for virtualized-lists' wildcard peer
  # while constructing an older template's tree, conflicting with its React.
  # This preserves peer constraints and the version RN already requires.
  (cd "$app" && npm install --no-audit --no-fund --strict-peer-deps --legacy-peer-deps=false --force=false \
      --save-dev --save-exact "@react-native/virtualized-lists@${rn}" \
    && npm install --no-audit --no-fund --strict-peer-deps --legacy-peer-deps=false --force=false --save-exact \
      "$TARBALL" "react-native-nitro-modules@${NITRO_VERSION}")
}

build_android() {
  local app="$1"
  (cd "${app}/android" && ./gradlew assembleRelease --no-daemon --console=plain \
    -PnewArchEnabled=true -PreactNativeArchitectures="${ANDROID_ABI:-arm64-v8a}")
}

run_android() {
  local app="$1" rn="$2"
  local apk="${app}/android/app/build/outputs/apk/release/app-release.apk"
  local package
  package="$(sed -n 's/.*applicationId[ =]*"\(.*\)".*/\1/p' "${app}/android/app/build.gradle" | head -1)" || return
  node "${SCRIPT_DIR}/compat-runtime.cjs" android "$apk" "$package" "$rn" "$RUN_ID" \
    "${WORK_DIR}/rn-${rn}-android-runtime.log" "$REPORT_PORT"
}

# RN's fmt 11 pod fails under Xcode 26+ C++20 consteval rules regardless of
# this library; apply the usual app-side workaround (fmt target only, C++17).
apply_fmt_workaround() {
  local app="$1"
  local fmt_podspec="${app}/node_modules/react-native/third-party-podspecs/fmt.podspec"
  local xcode_major
  xcode_major="$(xcodebuild -version | sed -n 's/^Xcode \([0-9]*\).*/\1/p')" || return
  [[ "$xcode_major" =~ ^[0-9]+$ ]] || return 1
  grep -qs 'spec.version = "11\.' "$fmt_podspec" && (( xcode_major >= 26 )) || return 0
  echo "Applying fmt C++17 workaround (fmt 11 with Xcode ${xcode_major})"
  # Must follow react_native_post_install, which sets C++20 on every target.
  ruby -i -0pe '$_.sub!(/(react_native_post_install\([^)]*\)\n)/) { $1 + "    installer.pods_project.targets.each { |t| t.build_configurations.each { |c| c.build_settings[\"CLANG_CXX_LANGUAGE_STANDARD\"] = \"c++17\" } if t.name == \"fmt\" }\n" } or abort "react_native_post_install hook not found"' "${app}/ios/Podfile"
}

# Opt-in consumer workaround for Nitro 0.37.1's Swift-facing renderer headers.
# Use the patch shipped in the installed tarball, exactly as an npm app does.
apply_nitro_ios_compat() {
  local app="$1"
  local patch="${app}/node_modules/react-native-nitro-bg-timer-plus/compat/react-native-nitro-modules+0.37.1.patch"
  node -e 'const p = require(process.argv[1]); if (p.version !== "0.37.1") { console.error("Nitro iOS workaround requires exactly 0.37.1, found " + p.version); process.exit(1) }' \
    "${app}/node_modules/react-native-nitro-modules/package.json" || return
  [[ -f "$patch" ]] || { echo "Packed Nitro iOS compatibility patch missing: $patch" >&2; return 1; }
  mkdir -p "${app}/.nitro-ios-compat-patches" || return
  cp "$patch" "${app}/.nitro-ios-compat-patches/" || return
  echo "Applying opt-in Nitro 0.37.1 iOS compatibility patch (upstream #1575)"
  (cd "$app" && npx --yes patch-package@8.0.1 --error-on-fail --patch-dir .nitro-ios-compat-patches)
}

build_ios() {
  local app="$1"
  apply_fmt_workaround "$app" || return
  if [[ $NITRO_IOS_COMPAT -eq 1 ]]; then apply_nitro_ios_compat "$app" || return; fi
  (cd "${app}/ios" && RCT_NEW_ARCH_ENABLED=1 pod install) || return
  (cd "${app}/ios" && xcodebuild -workspace "${APP_NAME}.xcworkspace" -scheme "$APP_NAME" \
    -configuration Release -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath build CODE_SIGNING_ALLOWED=NO build -quiet)
}

run_ios() {
  local app="$1" rn="$2"
  local bundle_app="${app}/ios/build/Build/Products/Release-iphonesimulator/${APP_NAME}.app"
  node "${SCRIPT_DIR}/compat-runtime.cjs" ios "$bundle_app" '' "$rn" "$RUN_ID" \
    "${WORK_DIR}/rn-${rn}-ios-runtime.log" "$REPORT_PORT"
}

step() {
  local rn="$1" name="$2"; shift 2
  local logfile="${WORK_DIR}/rn-${rn}-${name}.log"
  log "RN ${rn}: ${name} (log: ${logfile})"
  # Bash suppresses errexit in this conditional, including inside functions.
  # Every mandatory command in a multi-command step must propagate failures.
  if "$@" > "$logfile" 2>&1; then
    echo "PASS ${rn} ${name}" | tee -a "$SUMMARY"
  else
    tail -40 "$logfile"
    echo "FAIL ${rn} ${name}" | tee -a "$SUMMARY"
    return 1
  fi
}

pack_library
FAILED=0
for rn in "${VERSIONS[@]}"; do
  app="${WORK_DIR}/rn-${rn}"
  RUN_ID="$(node -p "require('node:crypto').randomUUID()")"
  if ! step "$rn" install create_app "$rn" "$app"; then FAILED=1; continue; fi
  if [[ "$PLATFORM" != ios ]]; then
    if step "$rn" android-build build_android "$app"; then
      [[ $RUN -eq 0 ]] || step "$rn" android-run run_android "$app" "$rn" || FAILED=1
    else
      FAILED=1
    fi
  fi
  if [[ "$PLATFORM" != android ]]; then
    if step "$rn" ios-build build_ios "$app"; then
      [[ $RUN -eq 0 ]] || step "$rn" ios-run run_ios "$app" "$rn" || FAILED=1
    else
      FAILED=1
    fi
  fi
  [[ $KEEP -eq 1 ]] || rm -rf "$app"
done

log "Summary (Nitro ${NITRO_VERSION}, work dir ${WORK_DIR})"
cat "$SUMMARY"
exit "$FAILED"
