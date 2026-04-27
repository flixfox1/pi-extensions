#!/usr/bin/env bash
# poll-done.sh — Poll for a worker's DONE report
# Usage: poll-done.sh <done-file> [timeout-seconds]
#
# Checks whether the DONE file exists. Returns 0 if found, 1 if timeout.
# Prints the file path on success for easy chaining.
#
# Args:
#   done-file        - relative path to the expected DONE report
#   timeout-seconds  - optional, max wait in seconds (default: 300)

set -euo pipefail

DONE="${1:?Usage: poll-done.sh <done-file> [timeout-seconds]}"
TIMEOUT="${2:-300}"
INTERVAL=15
ELAPSED=0

while [ "$ELAPSED" -lt "$TIMEOUT" ]; do
  if [ -f "$DONE" ]; then
    echo "$DONE"
    exit 0
  fi
  sleep "$INTERVAL"
  ELAPSED=$((ELAPSED + INTERVAL))
done

echo "Timeout after ${TIMEOUT}s waiting for $DONE" >&2
exit 1
