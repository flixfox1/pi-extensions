# Accel Editor

Pi input editor long-press acceleration plugin.

## Command

```txt
/accel-editor
```

Opens a compact-panel-style overlay with one main entry and sub-options:

- `Toggle` — enable/disable acceleration
- `Arrow Max` — cycle arrow-key acceleration max multiplier
- `Delete Max` — cycle delete-key acceleration max multiplier
- `Repeat Window` — cycle long-press detection window
- `Reset` — restore safe defaults

Text subcommands are also available:

```txt
/accel-editor on
/accel-editor off
/accel-editor toggle
/accel-editor status
/accel-editor reset
/accel-editor arrow <1-12>
/accel-editor delete <1-4>
/accel-editor window <40-500>
```

## Persistence

Runtime state is stored locally at:

```txt
~/.pi/agent/extensions/accel-editor/config.json
```

That file is ignored by git so each machine can keep its own editor speed preferences.
Use `config.example.json` as a reference.

## Notes

- Arrow keys can safely use higher multipliers.
- Delete acceleration is capped lower to reduce accidental large deletions.
- Mouse wheel events are intentionally not accelerated at the input-editor layer.
  Translating wheel events into up/down keys conflicts with macOS/tmux scrolling and
  cycles the prompt input history instead of scrolling conversation/terminal history.
- The plugin accelerates repeated terminal key events; it does not change OS-level
  keyboard repeat settings.
