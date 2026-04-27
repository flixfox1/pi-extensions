#!/usr/bin/env bash
# attach-pane.sh — tmux-only visibility helper for orchestrator targets.
# Usage: attach-pane.sh <mode> <tmux-target> [--adapter ignored]
#
# Modes accepted for backward compatibility: auto | tab | split | popout | current | print | probe
# No mode opens an OS terminal/tab. If already inside tmux, this switches the
# current client to the target window/pane. Outside tmux, it prints a manual
# `tmux attach -t ...` command and exits 0.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=terminal-adapter-lib.sh
source "$SCRIPT_DIR/terminal-adapter-lib.sh"

MODE="${1:-auto}"
TARGET="${2:-}"
if [ -z "$TARGET" ]; then
  echo "Usage: attach-pane.sh <mode> <tmux-target> [--adapter ignored]" >&2
  exit 2
fi
shift 2 || true

# Preserve old call sites that pass --adapter, but intentionally ignore it.
while [ "$#" -gt 0 ]; do
  case "$1" in
    --adapter)
      shift 2 || true
      ;;
    --adapter=*)
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

terminal_adapter_attach "$MODE" "$TARGET" "tmux"
