# Legacy Orchestrator Tool / Monitor Docs

Archived on 2026-04-27 for the Python CLI reset.

These documents described the previous shell-script-first and monitor-document-driven orchestration route. They are retained as historical reference only. The active workflow is now:

```text
Orchestrator Agent → Python CLI `orch` → tmux panes / Pi CLI workers
                      ↓
              durable run registry + DONE files
```

Active source of truth:

- `.pi/agents/orchestrator/tools/orch.py`
- `.pi/agents/orchestrator/tools/orch`
- `.pi/agents/orchestrator/AGENT.md`
- run registry under `.Agent_ChatRoom/Orchestrator agent memory/RUN-<RUN_ID>/`

The `agent-monitor` extension remains an opt-in, read-mostly dashboard over registry/DONE/tmux state. It does not own worker lifecycle.

Archived files:

- `ARCHITECTURE-monitor-extension.md`
- `BTB-task-orchestrator-benchmark-20260426.md`
- `MONITOR-ORCHESTRATOR-REFACTOR-PLAN-20260426.md`
- `ORCHESTRATOR-RUNTIME-PROJECT-MODEL-20260427.md`
