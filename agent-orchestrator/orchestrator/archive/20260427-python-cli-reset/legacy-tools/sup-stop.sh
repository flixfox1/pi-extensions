#!/usr/bin/env bash
# sup-stop.sh — Stop the supervisor daemon gracefully
# Usage: sup-stop.sh <run-dir>

set -euo pipefail

RUN_DIR="${1:?Usage: sup-stop.sh <run-dir>}"
PID_FILE="${RUN_DIR}/supervisor/pid"

if [ ! -f "$PID_FILE" ]; then
  echo "Supervisor not running (no PID file)."
  exit 0
fi

PID=$(cat "$PID_FILE")
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  # Wait briefly for cleanup
  local_i=0
  while [ -f "$PID_FILE" ] && [ "$local_i" -lt 10 ]; do
    sleep 0.5
    local_i=$((local_i + 1))
  done
  echo "Supervisor stopped (PID $PID)."
else
  rm -f "$PID_FILE"
  echo "Supervisor was not running (stale PID $PID, cleaned up)."
fi
