#!/usr/bin/env bash
# sup-status.sh — Query agent status from the supervisor
# Usage:
#   sup-status.sh <run-dir>                          — dashboard of all agents
#   sup-status.sh <run-dir> <agent>                  — single agent status
#   sup-status.sh <run-dir> --wait <agent> <states> [timeout]
#      Block until <agent> reaches one of <states> (comma-separated)
#      e.g. sup-status.sh <run-dir> --wait feature-builder done,failed 600

set -euo pipefail

RUN_DIR="${1:?Usage: sup-status.sh <run-dir> [agent|--wait agent states timeout]}"
AGENTS_DIR="${RUN_DIR}/supervisor/agents"

# ─── Helpers ────────────────────────────────────────────────────────
fmt_duration() {
  local secs=$1
  if [ "$secs" -lt 60 ]; then printf '%ds' "$secs"
  elif [ "$secs" -lt 3600 ]; then printf '%dm%ds' $((secs/60)) $((secs%60))
  else printf '%dh%dm' $((secs/3600)) $((secs%3600/60))
  fi
}

read_state() {
  local f="$1"
  STATUS="" TMUX_TARGET="" DISPATCH_FILE="" DONE_FILE=""
  STARTED_AT=0 LAST_SEEN_AT=0 LAST_CHANGE_AT=0 PANE_HASH="" IDLE_CHECKS=0
  # shellcheck disable=SC1090
  source "$f"
}

print_agent_line() {
  local agent="$1" state_file="$2"
  read_state "$state_file"
  local now
  now=$(date +%s)
  local age=$(( now - STARTED_AT ))
  local since=$(( now - LAST_CHANGE_AT ))
  printf '%-20s %-12s %5s %8s %10s\n' \
    "$agent" "$STATUS" "${IDLE_CHECKS}" "$(fmt_duration "$age")" "$(fmt_duration "$since") ago"
}

# ─── Modes ──────────────────────────────────────────────────────────

if [ -z "${2:-}" ]; then
  # ── Dashboard mode ──
  if ! ls "$AGENTS_DIR"/*.state &>/dev/null; then
    echo "No agents registered."
    exit 0
  fi
  printf '%-20s %-12s %5s %8s %10s\n' "AGENT" "STATUS" "IDLE" "AGE" "LAST CHANGE"
  printf '%-20s %-12s %5s %8s %10s\n' "─────" "──────" "────" "───" "───────────"
  for f in "$AGENTS_DIR"/*.state; do
    [ -f "$f" ] || continue
    print_agent_line "$(basename "$f" .state)" "$f"
  done

elif [ "$2" = "--wait" ]; then
  # ── Wait mode ──
  AGENT="${3:?--wait requires <agent> <states> [timeout]}"
  WAIT_STATES="${4:?--wait requires <agent> <states> [timeout]}"
  TIMEOUT="${5:-600}"
  STATE_FILE="${AGENTS_DIR}/${AGENT}.state"
  POLL=5
  ELAPSED=0

  if [ ! -f "$STATE_FILE" ]; then
    echo "Agent ${AGENT} not registered." >&2; exit 1
  fi

  echo "Waiting for ${AGENT} to reach: ${WAIT_STATES} (timeout: ${TIMEOUT}s)"

  while [ "$ELAPSED" -lt "$TIMEOUT" ]; do
    read_state "$STATE_FILE"
    # Check if current STATUS is in the wait list
    IFS=',' read -ra TARGETS <<< "$WAIT_STATES"
    for t in "${TARGETS[@]}"; do
      if [ "$STATUS" = "$t" ]; then
        echo "✓ ${AGENT} → ${STATUS}"
        # Print DONE file summary if available
        if [ -f "$DONE_FILE" ]; then
          echo "--- DONE report ---"
          cat "$DONE_FILE"
        fi
        exit 0
      fi
    done
    sleep "$POLL"
    ELAPSED=$((ELAPSED + POLL))
  done

  echo "✗ Timeout: ${AGENT} still in ${STATUS} after ${TIMEOUT}s" >&2
  exit 1

else
  # ── Single agent mode ──
  AGENT="$2"
  STATE_FILE="${AGENTS_DIR}/${AGENT}.state"
  if [ ! -f "$STATE_FILE" ]; then
    echo "Agent ${AGENT} not registered." >&2; exit 1
  fi
  read_state "$STATE_FILE"
  local_now=$(date +%s)
  echo "agent:       ${AGENT}"
  echo "status:      ${STATUS}"
  echo "target:      ${TMUX_TARGET}"
  echo "age:         $(fmt_duration $(( local_now - STARTED_AT )))"
  echo "last_change: $(fmt_duration $(( local_now - LAST_CHANGE_AT ))) ago"
  echo "idle_checks: ${IDLE_CHECKS}"
  echo "dispatch:    ${DISPATCH_FILE}"
  echo "done_file:   ${DONE_FILE}"
fi
