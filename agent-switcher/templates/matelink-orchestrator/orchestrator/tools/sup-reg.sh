#!/usr/bin/env bash
# sup-reg.sh — Register an agent for supervisor monitoring
# Usage: sup-reg.sh <run-dir> <agent-name> <tmux-target> <dispatch-file> <done-file>
#
# Creates the initial state file. Called automatically by dispatch-agent.sh,
# or manually by the orchestrator for pre-registration.

set -euo pipefail

RUN_DIR="${1:?Usage: sup-reg.sh <run-dir> <agent-name> <tmux-target> <dispatch-file> <done-file>}"
AGENT="${2:?Usage: sup-reg.sh <run-dir> <agent-name> <tmux-target> <dispatch-file> <done-file>}"
TMUX_TARGET="${3:?Usage: sup-reg.sh <run-dir> <agent-name> <tmux-target> <dispatch-file> <done-file>}"
DISPATCH="${4:?Usage: sup-reg.sh <run-dir> <agent-name> <tmux-target> <dispatch-file> <done-file>}"
DONE="${5:?Usage: sup-reg.sh <run-dir> <agent-name> <tmux-target> <dispatch-file> <done-file>}"

AGENTS_DIR="${RUN_DIR}/supervisor/agents"
mkdir -p "$AGENTS_DIR"

STATE_FILE="${AGENTS_DIR}/${AGENT}.state"
NOW=$(date +%s)

# Don't overwrite existing state (agent might be re-registered after crash)
if [ -f "$STATE_FILE" ]; then
  echo "Agent ${AGENT} already registered ($(grep '^STATUS=' "$STATE_FILE" | cut -d= -f2))"
  exit 0
fi

cat > "${STATE_FILE}.tmp" << EOF
STATUS=spawned
TMUX_TARGET=${TMUX_TARGET}
DISPATCH_FILE=${DISPATCH}
DONE_FILE=${DONE}
STARTED_AT=${NOW}
LAST_SEEN_AT=${NOW}
LAST_CHANGE_AT=${NOW}
PANE_HASH=
IDLE_CHECKS=0
EOF
mv "${STATE_FILE}.tmp" "$STATE_FILE"

echo "Registered agent=${AGENT} target=${TMUX_TARGET}"
