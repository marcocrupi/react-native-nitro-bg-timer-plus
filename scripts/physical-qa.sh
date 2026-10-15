#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Shared target lock/run-id admission; cancellation retains ownership until the worker settles.
if [[ "${1:-}" == --locked || "${1:-}" == --locked-command ]]; then
  operation="$1"; shift
  source "$SCRIPT_DIR/smoke-android.sh"
  platform="$1"; device="$2"; shift 2
  QA_WORKER=""
  QA_CANCELLED=0
  release_lock() {
    if [[ -n "$QA_WORKER" ]] && kill -0 "$QA_WORKER" 2>/dev/null; then
      echo "QA worker unsettled; target lock retained: $HARNESS_LOCK_DIR" >&2
    elif [[ -f "${QA_SETTLEMENT_FILE:-}" ]] && [[ "$(cat "$QA_SETTLEMENT_FILE")" == "$$" ]]; then
      rm "$QA_SETTLEMENT_FILE"
      harness_unlock
    elif [[ -n "$QA_WORKER" ]]; then
      echo "QA settlement unproven; target lock retained: $HARNESS_LOCK_DIR" >&2
    else
      harness_unlock
    fi
  }
  cancel_worker() {
    QA_CANCELLED=1
    if [[ -n "$QA_WORKER" ]]; then kill -TERM "$QA_WORKER" 2>/dev/null || true; fi
  }
  trap release_lock EXIT
  trap cancel_worker TERM INT
  if [[ "$operation" == --locked ]]; then
    run_id="$1"; shift
    harness_lock "$platform" "$device" "$run_id"
    export QA_SETTLEMENT_FILE="$HARNESS_LOCK_DIR/qa-settled-$$"
    python3 "$SCRIPT_DIR/physical-qa.py" --execute "$platform" "$device" "$run_id" "$@" &
  else
    harness_lock "$platform" "$device"
    export QA_SETTLEMENT_FILE="$HARNESS_LOCK_DIR/qa-settled-$$"
    python3 "$SCRIPT_DIR/physical-qa.py" --supervise "$@" &
  fi
  QA_WORKER="$!"
  [[ "$QA_CANCELLED" -eq 0 ]] || cancel_worker
  status=0
  while kill -0 "$QA_WORKER" 2>/dev/null; do wait "$QA_WORKER" || status=$?; done
  wait "$QA_WORKER" || status=$?
  [[ "$QA_CANCELLED" -eq 0 ]] || status=143
  exit "$status"
else
  exec python3 "$SCRIPT_DIR/physical-qa.py" "$@"
fi
