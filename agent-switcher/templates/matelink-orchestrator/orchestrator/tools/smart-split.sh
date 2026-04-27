#!/usr/bin/env bash
# smart-split.sh — Intelligent pane splitter for tmux orchestrator
# Usage: smart-split.sh <target> <pane-name> [percentage]
#
# Splits the current pane, choosing -h or -v based on aspect ratio.
# Prints the new pane's stable tmux %pane_id for send-keys / capture-pane.

set -euo pipefail

TARGET="${1:?Usage: smart-split.sh <target> <pane-name> [percentage]}"
PANE_NAME="${2:?Usage: smart-split.sh <target> <pane-name> [percentage]}"
PERCENTAGE="${3:-40}"

W=$(tmux display-message -t "$TARGET" -p '#{pane_width}')
H=$(tmux display-message -t "$TARGET" -p '#{pane_height}')

if [ "$W" -gt "$((H * 2))" ]; then
  SPLIT="-h"
  SIZE=$(( W * PERCENTAGE / 100 ))
else
  SPLIT="-v"
  SIZE=$(( H * PERCENTAGE / 100 ))
fi

# -P prints details for the newly created pane; #{pane_id} is stable across index changes.
PANE_ID="$(tmux split-window "$SPLIT" -t "$TARGET" -l "$SIZE" -P -F '#{pane_id}')"
tmux select-pane -t "$PANE_ID" -T "$PANE_NAME" 2>/dev/null || true
printf '%s\n' "$PANE_ID"
