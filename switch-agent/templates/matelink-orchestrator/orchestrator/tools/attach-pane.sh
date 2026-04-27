#!/usr/bin/env bash
# attach-pane.sh — Cross-platform terminal adapter dispatcher for tmux targets.
# Usage: attach-pane.sh <mode> <tmux-target> [--adapter <adapter>]
#
# Modes: tab | split | auto | popout | print | probe
# Adapters: auto | current | wsl-wt | mac-terminal | mac-iterm2 | linux-terminal | headless
#
# Attach failures are non-fatal by design; a manual tmux attach fallback is printed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=terminal-adapter-lib.sh
source "$SCRIPT_DIR/terminal-adapter-lib.sh"

MODE="${1:-tab}"
TARGET="${2:-}"
if [ -z "$TARGET" ]; then
  echo "Usage: attach-pane.sh <mode> <tmux-target> [--adapter <adapter>]" >&2
  exit 2
fi
shift 2 || true

ADAPTER="auto"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --adapter)
      ADAPTER="${2:?--adapter requires a value}"
      shift 2
      ;;
    --adapter=*)
      ADAPTER="${1#--adapter=}"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

case "$MODE" in
  tab|split|auto|popout|print|probe)
    terminal_adapter_attach "$MODE" "$TARGET" "$ADAPTER"
    ;;
  *)
    echo "Unknown mode: $MODE. Use tab, split, auto, popout, print, or probe." >&2
    exit 2
    ;;
esac
