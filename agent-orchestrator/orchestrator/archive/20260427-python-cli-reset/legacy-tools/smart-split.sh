#!/usr/bin/env bash
# smart-split.sh — split a pane inside the current orchestrator run window.
# Usage: smart-split.sh <target-pane-or-window> <pane-name> [percentage]
#
# The script never creates a tmux session, tmux window, or OS terminal. It only
# splits the provided tmux target and prints the new stable %pane_id.

set -euo pipefail

TARGET="${1:?Usage: smart-split.sh <target-pane-or-window> <pane-name> [percentage]}"
PANE_NAME="${2:?Usage: smart-split.sh <target-pane-or-window> <pane-name> [percentage]}"
PERCENTAGE="${3:-40}"

if ! command -v tmux >/dev/null 2>&1; then
  echo "smart-split.sh: tmux is required" >&2
  exit 127
fi

if ! [[ "$PERCENTAGE" =~ ^[0-9]+$ ]] || [ "$PERCENTAGE" -lt 10 ] || [ "$PERCENTAGE" -gt 90 ]; then
  echo "smart-split.sh: percentage must be an integer between 10 and 90" >&2
  exit 2
fi

if ! tmux display-message -t "$TARGET" -p '#{pane_id}' >/dev/null 2>&1; then
  echo "smart-split.sh: tmux target not found: $TARGET" >&2
  exit 1
fi

W="$(tmux display-message -t "$TARGET" -p '#{pane_width}')"
H="$(tmux display-message -t "$TARGET" -p '#{pane_height}')"

if [ "$W" -gt "$((H * 2))" ]; then
  SPLIT="-h"
  SIZE=$(( W * PERCENTAGE / 100 ))
else
  SPLIT="-v"
  SIZE=$(( H * PERCENTAGE / 100 ))
fi

PANE_ID="$(tmux split-window "$SPLIT" -t "$TARGET" -l "$SIZE" -P -F '#{pane_id}')"
tmux select-pane -t "$PANE_ID" -T "$PANE_NAME" 2>/dev/null || true
# Keep many worker panes readable without manual layout maintenance.
tmux select-layout -t "$PANE_ID" tiled >/dev/null 2>&1 || true
printf '%s\n' "$PANE_ID"
