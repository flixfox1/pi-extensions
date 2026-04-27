#!/usr/bin/env bash
# tmux-run-window.sh — create/reuse an orchestrator run window without opening OS terminals.
#
# Usage:
#   tmux-run-window.sh <run-id> [window-name]
#
# Contract:
# - Prefer the current tmux session when called from inside tmux.
# - Otherwise create/reuse a single detached session named "mat-orch".
# - Create one tmux *window* per run, named <window-name> or "orch-<run-id>".
# - Print the canonical target: <session>:<window_index>
#
# This intentionally replaces the old pattern of creating many detached
# mat-orch-<RUN_ID> sessions plus GUI attach adapters. Workers are still panes
# in the returned window via smart-split.sh.

set -euo pipefail

RUN_ID="${1:?Usage: tmux-run-window.sh <run-id> [window-name]}"
WINDOW_NAME="${2:-orch-${RUN_ID}}"
FALLBACK_SESSION="${MAT_ORCH_SESSION:-mat-orch}"

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux-run-window.sh: tmux is required" >&2
  exit 127
fi

sanitize_name() {
  # tmux window names are permissive, but avoid ':' because it conflicts with
  # target syntax. Keep user-provided slugs readable.
  printf '%s' "$1" | tr ':' '-'
}

WINDOW_NAME="$(sanitize_name "$WINDOW_NAME")"

current_session() {
  tmux display-message -p '#{session_name}' 2>/dev/null || true
}

session_has_window_name() {
  local session="$1" name="$2"
  tmux list-windows -t "$session" -F '#{window_name}' 2>/dev/null | grep -Fxq "$name"
}

window_target_by_name() {
  local session="$1" name="$2"
  tmux list-windows -t "$session" -F '#{window_name}:#{window_index}' \
    | awk -F: -v n="$name" '$1 == n { print $2; exit }'
}

SESSION=""
if [ -n "${TMUX:-}" ]; then
  SESSION="$(current_session)"
fi
SESSION="${SESSION:-$FALLBACK_SESSION}"

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  # No existing client/session context: create one stable background session.
  tmux new-session -d -s "$SESSION" -n "$WINDOW_NAME"
  INDEX="$(window_target_by_name "$SESSION" "$WINDOW_NAME")"
  printf '%s:%s\n' "$SESSION" "$INDEX"
  exit 0
fi

if session_has_window_name "$SESSION" "$WINDOW_NAME"; then
  INDEX="$(window_target_by_name "$SESSION" "$WINDOW_NAME")"
else
  INDEX="$(tmux new-window -d -t "$SESSION" -n "$WINDOW_NAME" -P -F '#{window_index}')"
fi

printf '%s:%s\n' "$SESSION" "$INDEX"
