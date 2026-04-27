# Orchestrator Runtime Rules

This directory holds runtime/lifecycle rules for the Matelink Orchestrator. These rules are intentionally kept outside `.pi/agents/orchestrator/AGENT.md` so the agent prompt can remain stable while the runtime implementation evolves.

## Runtime layering

```text
Orchestrator Agent = 决策者 / 仲裁者 / 用户交付
Python CLI `orch` = lifecycle 操作层 / 流程引擎
tmux = pane/window runtime
Pi CLI `mpi` = worker agent runtime
Run registry + DONE = durable source of truth
agent-monitor = opt-in read-mostly observability layer
```

Lifecycle truth must come from tmux + durable registry + DONE files. Do not make the Pi extension, LLM memory, or pane output the only source of truth.

## Primary CLI path

Load tools first:

```bash
export PATH=".pi/agents/orchestrator/tools:$PATH"
```

Create/reuse a run window and registry:

```bash
RUN_ID="YYYYMMDD-HHMMSS-<short-slug>"
orch run create "$RUN_ID" --title "orch-$RUN_ID"
```

The CLI maintains:

```text
.Agent_ChatRoom/Orchestrator agent memory/RUN-<RUN_ID>/
  run.json
  agents/
  dispatch/
  reports/
```

`orch` stdout is machine-readable JSON. Diagnostics should go to stderr.

## Dispatch/DONE contract

Long instructions belong in dispatch files, not in `tmux send-keys`:

```text
.Agent_ChatRoom/Orchestrator agent memory/RUN-<RUN_ID>/dispatch/<agent-id>.md
```

Workers must write DONE reports to:

```text
.Agent_ChatRoom/Orchestrator agent memory/RUN-<RUN_ID>/reports/<agent-id>.DONE.md
```

DONE schema:

```markdown
# DONE <agent-id>

- run_id: <RUN_ID>
- agent_id: <agent-id>
- status: done | blocked | failed
- summary: <完成摘要>
- changed_files: <改动文件或 none>
- tests: <运行结果或未运行原因>
- findings: <关键发现>
- next_action: <建议下一步>
- completed_at: <ISO timestamp>
```

## Worker lifecycle commands

Create/reuse worker pane:

```bash
orch worker create "$RUN_ID" "feature-builder" --assigned-agent feature-builder --size 40
```

Dispatch worker:

```bash
orch worker dispatch "$RUN_ID" "feature-builder" \
  --dispatch ".Agent_ChatRoom/Orchestrator agent memory/RUN-$RUN_ID/dispatch/feature-builder.md" \
  --done ".Agent_ChatRoom/Orchestrator agent memory/RUN-$RUN_ID/reports/feature-builder.DONE.md"
```

Status / wait:

```bash
orch worker status "$RUN_ID"
orch worker status "$RUN_ID" "feature-builder"
orch worker wait "$RUN_ID" "feature-builder" --timeout 300
```

Safe stop:

```bash
orch worker stop "$RUN_ID" "feature-builder"
```

Default stop behavior should nudge/pause (`Ctrl-C` + pause message), not kill the pane.

## State derivation

Worker state is derived from:

1. `RUN-<RUN_ID>/agents/<agent-id>.json`
2. DONE report existence and valid `status`
3. tmux pane liveness

DONE status wins over tmux liveness. Missing/dead pane without DONE is a runtime failure/crash signal.

## Agent monitor role

`agent-monitor` is opt-in/read-mostly observability. It may read registry/DONE/tmux and expose dashboard/status/capture helpers, but it must not be the lifecycle owner.

Default rules:

- Do not depend on monitor for dispatch.
- Do not let monitor create panes, wait workers, send tasks, or kill workers by default.
- Use `/agents`, `agent_status`, or `agent_capture` only as diagnostics/observability helpers.

## Pane capture rule

Avoid repeated large `capture-pane` polling. Only capture recent output when:

- DONE is missing or malformed;
- `orch worker wait/status` reports unknown/crashed state;
- user explicitly asks to inspect live pane output;
- debugging startup/readiness failures.

Keep captures small, usually 80-120 recent lines.
