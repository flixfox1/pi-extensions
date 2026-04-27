# Legacy Orchestrator Shell Tools

Archived on 2026-04-27 for the Python CLI reset.

These scripts belonged to the pre-reset shell-first / supervisor-adjacent runtime path. They are retained only as historical reference while active orchestration uses:

```text
.pi/agents/orchestrator/tools/orch
.pi/agents/orchestrator/tools/orch.py
```

Do not use these archived scripts for normal worker lifecycle operations. Use `orch run ...` and `orch worker ...` instead.

Archived files:

- `attach-pane.sh` — old visibility helper / terminal adapter compatibility entry.
- `dispatch-agent.sh` — old tmux send-keys dispatch path, superseded by `orch worker dispatch`.
- `poll-done.sh` — old DONE polling helper, superseded by `orch worker wait/status`.
- `register-worker.sh` — old shell registry writer, superseded by `orch.py` registry writes.
- `smart-split.sh` — old pane split helper, superseded by `orch.py` pane creation.
- `sup-reg.sh` — old supervisor state writer.
- `sup-status.sh` — old supervisor status/wait helper.
- `sup-stop.sh` — old supervisor stop helper.
- `supervise.sh` — old background supervisor daemon and lifecycle owner candidate.
- `terminal-adapter-lib.sh` — helper for archived `attach-pane.sh`.
- `tmux-run-window.sh` — old run-window helper, superseded by `orch run create`.
