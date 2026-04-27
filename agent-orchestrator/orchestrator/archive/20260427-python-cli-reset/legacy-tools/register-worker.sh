#!/usr/bin/env bash
# register-worker.sh — Write registry-first worker inventory entry atomically.
# Usage: register-worker.sh <run-dir> <agent-id> <tmux-target> <dispatch-file> <done-file> [status]

set -euo pipefail

RUN_DIR="${1:?Usage: register-worker.sh <run-dir> <agent-id> <tmux-target> <dispatch-file> <done-file> [status]}"
AGENT_ID="${2:?Usage: register-worker.sh <run-dir> <agent-id> <tmux-target> <dispatch-file> <done-file> [status]}"
TMUX_TARGET="${3:?Usage: register-worker.sh <run-dir> <agent-id> <tmux-target> <dispatch-file> <done-file> [status]}"
DISPATCH_PATH="${4:?Usage: register-worker.sh <run-dir> <agent-id> <tmux-target> <dispatch-file> <done-file> [status]}"
DONE_PATH="${5:?Usage: register-worker.sh <run-dir> <agent-id> <tmux-target> <dispatch-file> <done-file> [status]}"
STATUS="${6:-registered}"

RUN_BASENAME="$(basename "$RUN_DIR")"
RUN_ID="${RUN_BASENAME#RUN-}"
AGENTS_DIR="$RUN_DIR/agents"
mkdir -p "$AGENTS_DIR"

PANE_ID="$TMUX_TARGET"
if [ "${TMUX_TARGET#%}" = "$TMUX_TARGET" ]; then
  PANE_ID="$(tmux display-message -t "$TMUX_TARGET" -p '#{pane_id}' 2>/dev/null || printf '%s' "$TMUX_TARGET")"
fi

if command -v python3 >/dev/null 2>&1; then
  CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  UPDATED_AT="$CREATED_AT"
  TMP_FILE="$(mktemp "$AGENTS_DIR/.${AGENT_ID}.json.XXXXXX")"
  RUN_ID="$RUN_ID" AGENT_ID="$AGENT_ID" TMUX_TARGET="$TMUX_TARGET" PANE_ID="$PANE_ID" \
  DISPATCH_PATH="$DISPATCH_PATH" DONE_PATH="$DONE_PATH" STATUS="$STATUS" CREATED_AT="$CREATED_AT" UPDATED_AT="$UPDATED_AT" \
  python3 - <<'PY' > "$TMP_FILE"
import json, os
entry = {
    "schema_version": 1,
    "run_id": os.environ["RUN_ID"],
    "agent_id": os.environ["AGENT_ID"],
    "status": os.environ["STATUS"],
    "tmux_target": os.environ["TMUX_TARGET"],
    "pane_id": os.environ["PANE_ID"],
    "target": os.environ["PANE_ID"],
    "dispatch_path": os.environ["DISPATCH_PATH"],
    "done_path": os.environ["DONE_PATH"],
    "created_at": os.environ["CREATED_AT"],
    "updated_at": os.environ["UPDATED_AT"],
}
print(json.dumps(entry, ensure_ascii=False, indent=2, sort_keys=True))
PY
  mv "$TMP_FILE" "$AGENTS_DIR/${AGENT_ID}.json"
else
  echo "python3 is required to write registry JSON safely" >&2
  exit 1
fi

echo "Registered worker agent_id=${AGENT_ID} pane_id=${PANE_ID} registry=${AGENTS_DIR}/${AGENT_ID}.json"
