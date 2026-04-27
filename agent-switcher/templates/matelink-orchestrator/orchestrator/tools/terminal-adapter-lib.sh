#!/usr/bin/env bash
# terminal-adapter-lib.sh — cross-platform terminal adapter helpers for tmux attach.

terminal_adapter_manual_fallback() {
  local target="${1:?target required}"
  local session_target
  session_target="$(tmux display-message -t "$target" -p '#{session_name}' 2>/dev/null || true)"
  session_target="${session_target:-$target}"
  printf 'Manual fallback: tmux attach -t %q\n' "$session_target"
}

terminal_adapter_command() {
  local target="${1:?target required}"
  local session_target
  session_target="$(tmux display-message -t "$target" -p '#{session_name}' 2>/dev/null || true)"
  session_target="${session_target:-$target}"
  printf 'tmux select-pane -t %q 2>/dev/null || true; tmux attach -t %q' "$target" "$session_target"
}

terminal_adapter_attach_current() {
  local target="${1:?target required}"
  local session_target window_target

  session_target="$(tmux display-message -t "$target" -p '#{session_name}' 2>/dev/null || true)"
  session_target="${session_target:-$target}"
  window_target="$(tmux display-message -t "$target" -p '#{session_name}:#{window_index}' 2>/dev/null || true)"
  window_target="${window_target:-$target}"

  tmux select-window -t "$window_target" 2>/dev/null || true
  tmux select-pane -t "$target" 2>/dev/null || true

  if [ -n "${TMUX:-}" ]; then
    tmux switch-client -t "$window_target" 2>/dev/null || tmux switch-client -t "$session_target"
  else
    tmux attach -t "$session_target"
  fi
}

terminal_adapter_is_headless_context() {
  [ "${CI:-}" = "true" ] || [ "${CI:-}" = "1" ] || [ -n "${SSH_TTY:-}" ] || [ -n "${SSH_CONNECTION:-}" ] || [ "${NO_GUI:-}" = "1" ]
}

terminal_adapter_macos_iterm2_available() {
  [ "$(uname -s 2>/dev/null || true)" = "Darwin" ] || return 1
  command -v osascript >/dev/null 2>&1 || return 1
  osascript -e 'id of application "iTerm2"' >/dev/null 2>&1
}

terminal_adapter_macos_prefers_iterm2() {
  [ "${LC_TERMINAL:-}" = "iTerm2" ] || [ "${TERM_PROGRAM:-}" = "iTerm.app" ] || [ -n "${ITERM_SESSION_ID:-}" ]
}

terminal_adapter_detect() {
  if terminal_adapter_is_headless_context; then
    echo "headless"
    return 0
  fi

  if command -v tmux >/dev/null 2>&1 && [ -n "${TMUX:-}" ]; then
    echo "current"
    return 0
  fi

  # Outside an existing tmux client, prefer opening a local GUI terminal when
  # available. This makes `attach-pane.sh tab <session>` usable on macOS while
  # still preserving headless/SSH fallback behavior above.
  terminal_adapter_detect_gui
}

terminal_adapter_detect_gui() {
  if terminal_adapter_is_headless_context; then
    echo "headless"
    return 0
  fi

  case "$(uname -s 2>/dev/null || echo unknown)" in
    Darwin)
      if terminal_adapter_macos_prefers_iterm2 && terminal_adapter_macos_iterm2_available; then
        echo "mac-iterm2"
      elif command -v osascript >/dev/null 2>&1; then
        echo "mac-terminal"
      else
        echo "headless"
      fi
      ;;
    Linux*)
      if grep -qi microsoft /proc/version 2>/dev/null && command -v wt.exe >/dev/null 2>&1; then
        echo "wsl-wt"
      elif [ -n "${TERMINAL:-}" ] || command -v x-terminal-emulator >/dev/null 2>&1 || command -v gnome-terminal >/dev/null 2>&1 || command -v konsole >/dev/null 2>&1 || command -v kitty >/dev/null 2>&1 || command -v wezterm >/dev/null 2>&1 || command -v xterm >/dev/null 2>&1; then
        echo "linux-terminal"
      else
        echo "headless"
      fi
      ;;
    *)
      echo "headless"
      ;;
  esac
}

terminal_adapter_available() {
  local adapter="${1:?adapter required}"
  case "$adapter" in
    current)
      command -v tmux >/dev/null 2>&1
      ;;
    wsl-wt)
      command -v wt.exe >/dev/null 2>&1 && command -v wsl.exe >/dev/null 2>&1
      ;;
    mac-terminal)
      [ "$(uname -s 2>/dev/null || true)" = "Darwin" ] && command -v osascript >/dev/null 2>&1
      ;;
    mac-iterm2)
      terminal_adapter_macos_iterm2_available
      ;;
    linux-terminal)
      [ -n "${TERMINAL:-}" ] || command -v x-terminal-emulator >/dev/null 2>&1 || command -v gnome-terminal >/dev/null 2>&1 || command -v konsole >/dev/null 2>&1 || command -v kitty >/dev/null 2>&1 || command -v wezterm >/dev/null 2>&1 || command -v xterm >/dev/null 2>&1
      ;;
    headless)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

terminal_adapter_probe() {
  local requested="${1:-auto}"
  local selected
  if [ "$requested" = "auto" ]; then
    selected="$(terminal_adapter_detect)"
  else
    selected="$requested"
  fi

  if terminal_adapter_available "$selected"; then
    echo "adapter=$selected available=true"
  else
    echo "adapter=$selected available=false fallback=headless"
  fi
}

terminal_adapter_attach() {
  local mode="${1:?mode required}"
  local target="${2:?target required}"
  local adapter="${3:-auto}"
  local selected cmd

  if [ "$adapter" = "auto" ]; then
    if [ "$mode" = "popout" ]; then
      selected="$(terminal_adapter_detect_gui)"
    else
      selected="$(terminal_adapter_detect)"
    fi
  else
    selected="$adapter"
  fi

  if ! terminal_adapter_available "$selected"; then
    echo "Adapter '$selected' unavailable; falling back to headless." >&2
    selected="headless"
  fi

  cmd="$(terminal_adapter_command "$target")"

  case "$mode" in
    print)
      terminal_adapter_manual_fallback "$target"
      return 0
      ;;
    probe)
      terminal_adapter_probe "$adapter"
      return 0
      ;;
  esac

  case "$selected" in
    current)
      case "$mode" in
        auto|tab|split|popout)
          terminal_adapter_attach_current "$target"
          ;;
        *) return 2 ;;
      esac
      ;;
    headless)
      echo "Headless adapter selected; no GUI terminal launched."
      terminal_adapter_manual_fallback "$target"
      return 0
      ;;
    wsl-wt)
      case "$mode" in
        tab)
          wt.exe -w 0 new-tab wsl.exe -e bash -lc "$cmd" || true
          ;;
        split)
          wt.exe -w 0 split-pane -H wsl.exe -e bash -lc "$cmd" || true
          ;;
        auto|popout)
          wt.exe -w 0 split-pane -H wsl.exe -e bash -lc "$cmd" 2>/dev/null || wt.exe -w 0 new-tab wsl.exe -e bash -lc "$cmd" || true
          ;;
        *) return 2 ;;
      esac
      ;;
    mac-terminal)
      osascript - "$cmd" >/dev/null 2>&1 <<'OSA' || true
on run argv
  set commandText to item 1 of argv
  tell application "Terminal"
    activate
    do script commandText
  end tell
end run
OSA
      ;;
    mac-iterm2)
      osascript - "$cmd" >/dev/null 2>&1 <<'OSA' || true
on run argv
  set commandText to item 1 of argv
  tell application "iTerm2"
    activate
    create window with default profile command commandText
  end tell
end run
OSA
      ;;
    linux-terminal)
      if [ -n "${TERMINAL:-}" ]; then
        "$TERMINAL" -e bash -lc "$cmd" >/dev/null 2>&1 || true
      elif command -v x-terminal-emulator >/dev/null 2>&1; then
        x-terminal-emulator -e bash -lc "$cmd" >/dev/null 2>&1 || true
      elif command -v gnome-terminal >/dev/null 2>&1; then
        gnome-terminal -- bash -lc "$cmd" >/dev/null 2>&1 || true
      elif command -v konsole >/dev/null 2>&1; then
        konsole -e bash -lc "$cmd" >/dev/null 2>&1 || true
      elif command -v kitty >/dev/null 2>&1; then
        kitty bash -lc "$cmd" >/dev/null 2>&1 || true
      elif command -v wezterm >/dev/null 2>&1; then
        wezterm start -- bash -lc "$cmd" >/dev/null 2>&1 || true
      elif command -v xterm >/dev/null 2>&1; then
        xterm -e bash -lc "$cmd" >/dev/null 2>&1 || true
      fi
      ;;
    *)
      echo "Unknown adapter '$selected'; falling back to manual attach." >&2
      ;;
  esac

  terminal_adapter_manual_fallback "$target"
  return 0
}
