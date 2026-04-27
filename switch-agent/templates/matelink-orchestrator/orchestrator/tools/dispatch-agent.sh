#!/usr/bin/env bash
# dispatch-agent.sh — Dispatch a Pi agent into a tmux pane and register in run registry.
# Usage: dispatch-agent.sh <tmux-target> <agent-id> <dispatch-file> <done-file> [run-dir]
#
# Sends the startup sequence to a tmux pane:
#   1. mpi              — start Pi coding agent CLI
#   2. /agent <agent>   — switch to target agent
#   3. Read dispatch file and execute, write standardized DONE report.
#
# If <run-dir> is provided, writes RUN-*/agents/<agent_id>.json and also updates
# legacy supervisor .state when sup-reg.sh is available.

set -euo pipefail

TARGET="${1:?Usage: dispatch-agent.sh <target> <agent-id> <dispatch> <done> [run-dir]}"
AGENT_ID="${2:?Usage: dispatch-agent.sh <target> <agent-id> <dispatch> <done> [run-dir]}"
DISPATCH="${3:?Usage: dispatch-agent.sh <target> <agent-id> <dispatch> <done> [run-dir]}"
DONE="${4:?Usage: dispatch-agent.sh <target> <agent-id> <dispatch> <done> [run-dir]}"
RUN_DIR="${5:-}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_ID=""

# ── Auto-register with durable run registry if run-dir provided ──
if [ -n "$RUN_DIR" ]; then
  "$SCRIPT_DIR/register-worker.sh" "$RUN_DIR" "$AGENT_ID" "$TARGET" "$DISPATCH" "$DONE" "registered"
  RUN_ID="$(basename "$RUN_DIR")"
  RUN_ID="${RUN_ID#RUN-}"

  # Compatibility only: legacy supervisor state is no longer the source of truth.
  if [ -x "$SCRIPT_DIR/sup-reg.sh" ]; then
    "$SCRIPT_DIR/sup-reg.sh" "$RUN_DIR" "$AGENT_ID" "$TARGET" "$DISPATCH" "$DONE" || true
  fi
fi

# ── Wait for shell to be ready in the pane ──
sleep 1

# ── Step 1: Start Pi CLI ──
tmux send-keys -t "$TARGET" "mpi" Enter

# ── Step 2: Wait for Pi CLI to be ready ──
wait_for_pi() {
  local max_wait=30 elapsed=0
  while [ "$elapsed" -lt "$max_wait" ]; do
    local output
    output=$(tmux capture-pane -t "$TARGET" -p -S -10 2>/dev/null || true)
    if printf '%s' "$output" | grep -qE '(0\.0%/|Cursor|Update Available)' 2>/dev/null; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  echo "Warning: Pi CLI readiness not confirmed after ${max_wait}s, proceeding anyway" >&2
}
wait_for_pi

# ── Step 3: Switch to target agent ──
tmux send-keys -t "$TARGET" "/agent $AGENT_ID" Enter
sleep 2

# ── Step 4: Send standardized task instruction ──
PROMPT="请读取 $DISPATCH 并执行；完成后写入 $DONE 。DONE 报告必须使用以下 schema：
# DONE $AGENT_ID

- run_id: ${RUN_ID:-<RUN_ID>}
- agent_id: $AGENT_ID
- status: done | blocked | failed
- summary: <完成摘要>
- changed_files: <改动文件或 none>
- tests: <运行结果或未运行原因>
- findings: <关键发现>
- next_action: <建议下一步>
- completed_at: <ISO timestamp>"

tmux send-keys -t "$TARGET" "$PROMPT" Enter

echo "Dispatched agent_id=$AGENT_ID target=$TARGET done=$DONE"
