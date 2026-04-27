#!/usr/bin/env bash
# terminal-adapter-lib.sh — minimal tmux-only visibility helpers.
#
# Historical note:
# This file used to contain platform GUI adapters (Windows Terminal, Terminal.app,
# iTerm2, Linux terminal emulators). That made orchestration noisy: every worker
# could accidentally create another OS tab/window. The orchestrator contract is
# now simple: one tmux run window, worker panes inside it. Tools may switch the
# current tmux client only when already running inside tmux; otherwise they print
# a manual attach command and exit successfully.

terminal_adapter_session_target() {
  local target="${1:?target required}"
  local session_target
  session_target="$(tmux display-message -t "$target" -p '#{session_name}' 2>/dev/null || true)"
  session_target="${session_target:-$target}"
  printf '%s\n' "$session_target"
}

terminal_adapter_window_target() {
  local target="${1:?target required}"
  local window_target
  window_target="$(tmux display-message -t "$target" -p '#{session_name}:#{window_index}' 2>/dev/null || true)"
  window_target="${window_target:-$target}"
  printf '%s\n' "$window_target"
}

terminal_adapter_manual_fallback() {
  local target="${1:?target required}"
  local session_target
  session_target="$(terminal_adapter_session_target "$target")"
  printf 'Manual fallback: tmux attach -t %q\n' "$session_target"
}

terminal_adapter_probe() {
  if command -v tmux >/dev/null 2>&1; then
    if [ -n "${TMUX:-}" ]; then
      echo "adapter=tmux-current available=true mode=switch-client"
    else
      echo "adapter=tmux-print available=true mode=manual-attach"
    fi
  else
    echo "adapter=tmux available=false reason=tmux-not-found"
    return 1
  fi
}

terminal_adapter_attach_current() {
  local target="${1:?target required}"
  local session_target window_target

  session_target="$(terminal_adapter_session_target "$target")"
  window_target="$(terminal_adapter_window_target "$target")"

  tmux select-window -t "$window_target" 2>/dev/null || true
  tmux select-pane -t "$target" 2>/dev/null || true

  if [ -n "${TMUX:-}" ]; then
    tmux switch-client -t "$window_target" 2>/dev/null || tmux switch-client -t "$session_target"
  else
    terminal_adapter_manual_fallback "$target"
  fi
}

terminal_adapter_attach() {
  local mode="${1:?mode required}"
  local target="${2:?target required}"
  local _adapter="${3:-tmux}"

  case "$mode" in
    print)
      terminal_adapter_manual_fallback "$target"
      ;;
    probe)
      terminal_adapter_probe
      ;;
    auto|tab|split|popout|current)
      # Backward-compatible mode names are accepted, but no GUI terminal is
      # opened. Inside tmux we switch the current client; outside tmux we print
      # the manual attach command.
      terminal_adapter_attach_current "$target"
      ;;
    *)
      echo "Unknown mode: $mode. Use auto, current, print, or probe." >&2
      return 2
      ;;
  esac
}
