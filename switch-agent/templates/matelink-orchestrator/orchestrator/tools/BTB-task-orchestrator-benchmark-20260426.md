# Bob-The-Builder Task Orchestrator Benchmark

> External project reviewed: `/mnt/g/Ai Projects/.mutiple ai workflow/Bob-The-Builder-main`  
> Review date: 2026-04-26  
> Purpose: learn from another task-orchestrator system and summarize a better Matelink/Pi orchestrator technical stack.

## Executive Take

Bob-The-Builder is much more than a “spawn a few agents” wrapper. Its strongest design is that it treats orchestration as a **durable workflow engine**:

```text
spec/tasks.md → planner DAG → isolated git worktrees → worker processes → serialized merge → review gate → logs/TUI/service dashboard
```

The most important lesson for our Matelink orchestrator is not any single feature, but its source-of-truth discipline:

- runtime state is persisted in files/logs/queue records;
- UI is a projection over that state;
- workers are isolated with git worktrees;
- completion is explicit through task file mutation + completion token;
- review/fix loops are first-class workflow states;
- long-running worker health has dedicated detection logic.

This strongly supports our route correction for `ARCHITECTURE-monitor-extension.md`: **lifecycle truth must live outside the Pi extension runtime**. Extension/TUI should observe a durable registry, not own the workflow from memory.

---

## What Bob-The-Builder Is

Bob-The-Builder (`btb`) is a Kiro-oriented concurrent task runner. It reads a Kiro spec folder, analyzes dependencies, then executes leaf tasks in parallel.

Core files reviewed:

| Area | Files |
|---|---|
| Entry / scheduler | `btb.sh`, `config.sh` |
| DAG planning | `lib/dag.sh` |
| Worker loop | `lib/worker.sh` |
| Merge/sync | `lib/syncer.sh` |
| Review gate | `lib/reviewer.sh` |
| TUI | `lib/tui.sh` |
| Service mode | `server/main.py`, `server/executor.py`, `server/queue.py`, `server/streamer.py`, `server/models.py` |
| Agent roles | `.kiro/agents/*.json` |

---

## System Architecture

```text
                         ┌────────────────────────────┐
                         │ .kiro/specs/<spec>/tasks.md │
                         │ design.md / requirements.md │
                         └──────────────┬─────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────┐
│ btb.sh local orchestrator                                        │
│                                                                 │
│  1. validate spec/git/auth/deps                                  │
│  2. planner agent builds DAG                                     │
│  3. scheduler computes ready tasks                               │
│  4. spawn workers in git worktrees                               │
│  5. poll process/heartbeat/log state                             │
│  6. sync completed branches to main                              │
│  7. run review/fix gate per batch                                │
│  8. update TUI and logs                                          │
└──────────────┬──────────────────────────────────────────────────┘
               │
               ▼
       ┌───────────────┐      ┌───────────────┐
       │ worktree task │ ...  │ worktree task │
       │ worker.sh     │      │ worker.sh     │
       └───────┬───────┘      └───────┬───────┘
               │                      │
               ▼                      ▼
       task branch commit      task branch commit
               │                      │
               └──────────┬───────────┘
                          ▼
                  serialized merge lock
                          │
                          ▼
                     review gate
```

Service mode wraps this local runner with:

```text
GitHub webhook → disk queue → JobExecutor → script-captured TUI log → WebSocket dashboard → result push-back
```

---

## Key Design Patterns Worth Learning

### 1. Durable workflow state beats in-memory monitor state

BTB stores state in multiple durable layers:

- `.ralph-logs/` for debug/task/DAG/review logs;
- temp `STATE_DIR` files for task status/pid/retries/worktree/heartbeat during a run;
- disk queue JSON files in service mode;
- completed job JSON files in service mode;
- `tasks.md` checkboxes as a durable spec progress ledger;
- git commits/branches/worktrees as durable execution artifacts.

For Matelink, this means:

```text
run registry + DONE files + tmux pane ids + logs = source of truth
Pi extension memory = cache/view only
```

This directly validates the route correction we just made.

### 2. Worker isolation with git worktrees is a major robustness upgrade

BTB does not let parallel workers all mutate the same working tree. Each task gets:

- its own git worktree;
- its own branch (`ralph/task-*`);
- its own log file;
- its own process/heartbeat state;
- serialized merge back to the primary branch.

For Matelink, this is the biggest architectural lesson if we want true parallel implementers.

Current Matelink tmux agents usually share the same repo checkout. That is acceptable for:

- read-only review agents;
- one writer + many reviewers;
- sequential implementation tasks.

It is risky for:

- multiple feature builders;
- concurrent refactors;
- parallel tests that generate files;
- agents editing overlapping files.

Recommendation:

```text
Default: same checkout for orchestrator + reviewers.
Parallel writers: mandatory git worktree isolation.
Merge/sync: orchestrator-owned serialized gate.
```

### 3. DAG planning is useful, but must have repair/fallback logic

`lib/dag.sh` asks a planner agent for JSON DAG waves, but it does not blindly trust the planner. It adds:

- JSON extraction from messy model output;
- schema validation;
- missing-task detection;
- repair prompts for missing tasks;
- final sequential fallback tail;
- cycle detection with fallback to sequential.

This is important: LLM planning output is treated as useful but unreliable.

For Matelink:

- task packets / `TASK-*.md` can be converted into a DAG;
- but the orchestrator must verify every task is represented;
- dependency cycles should degrade to sequential mode;
- missing tasks should never silently disappear.

### 4. Health checks are separate from liveness checks

BTB distinguishes:

| Check | Meaning |
|---|---|
| process alive | worker process still exists |
| heartbeat | worker is producing activity |
| descendant process tree | build/test subprocess may still be legitimately running |
| repetitive command analysis | worker may be stuck in a verification loop |
| LLM health-checker verdict | semantic judgement: continue / retry / fail |
| wall-clock timeout | final safety net |

This is much richer than “pane output hash changed or not.”

For Matelink, pane output hash should only be a weak signal. We should track:

- DONE file status;
- tmux pane alive/dead;
- last output timestamp;
- last command/send event;
- optional process tree if we own the process;
- semantic health check only for long-running/stalled workers.

### 5. Review/fix loops are workflow states, not ad hoc follow-up

`lib/reviewer.sh` implements a structured post-batch review gate:

1. reviewer audits changed files against spec;
2. if rejected, fixer agent gets focused rejection context;
3. review/fix history is carried across attempts;
4. retry count is bounded;
5. review can be non-blocking but is logged.

For Matelink, this suggests a stronger default route:

```text
implementation task → local verification → quality-guard review → fix if rejected → orchestrator accepts
```

This should be encoded in task orchestrator policy, not improvised every run.

### 6. TUI is deliberately fault-isolated

`lib/tui.sh` repeatedly states and enforces:

> TUI is cosmetic and must never crash the orchestrator.

It wraps TUI operations with `set +eu`, suppresses errors, and guards calls with `|| true`.

For our Pi extension/TUI dashboard, this is an important principle:

```text
monitor UI failure must not affect worker lifecycle, registry, or dispatch.
```

### 7. Service wrapper uses disk queue and log streaming

The Python service layer is useful as a reference for a future remote orchestrator:

- `server/queue.py`: disk-backed FIFO queue with `fcntl` lock;
- `server/executor.py`: single running job invariant, process group kill, timeout, result push;
- `server/streamer.py`: tails a `script` terminal log to WebSocket clients;
- `server/main.py`: startup recovery marks orphaned running jobs failed.

This is not immediately needed for Matelink local orchestration, but it is valuable if we later want a web dashboard or remote execution.

---

## What Not To Copy Directly

### 1. Do not copy the all-bash core blindly

BTB's shell implementation is pragmatic and powerful, but also very dense. `btb.sh` is a large imperative script with many responsibilities:

- argument parsing;
- validation;
- dependency install;
- DAG orchestration;
- worker spawning;
- stale checks;
- health checks;
- review scheduling;
- TUI updates;
- cleanup.

For Matelink, we should not let one script become the whole platform. Better split:

```text
bash = tmux/worktree/process primitives
TypeScript = registry schemas, state derivation, extension tools/UI
Markdown = task contract and reports
```

### 2. Do not make review non-blocking by default

BTB logs review failures but ultimately returns `0` from `review_wave` after retries are exhausted. That may be acceptable for its use case, but Matelink architecture/canvas changes are high-risk.

For Matelink:

```text
review failure should block acceptance unless orchestrator explicitly overrides.
```

### 3. Do not rely on task checkboxes as the only completion truth

BTB uses `tasks.md` `[x]` plus `TASK_COMPLETE::<id>`. That is good for Kiro specs, but our orchestrator also needs structured DONE reports.

For Matelink, completion should require:

- DONE file with `status`;
- verification summary;
- changed files;
- optional task checklist update;
- orchestrator quality gate.

### 4. Do not adopt remote service mode before local UX is stable

BTB's Python web service is good, but our immediate problem is local tmux/Pi UX. A web service would add more moving parts before fixing:

- pane layout;
- registry;
- extension dashboard;
- worktree isolation.

Service/dashboard should be a later stage.

---

## Recommended Matelink Orchestrator Technical Stack

### Layer 1 — Execution substrate

| Concern | Recommended tech |
|---|---|
| visible local agents | `tmux` panes inside one run session |
| user terminal | Windows Terminal attach once per run |
| process dispatch | bash scripts (`smart-split.sh`, `dispatch-agent.sh`) |
| stable pane identity | tmux `%pane_id` |
| optional writer isolation | `git worktree` per writer task |
| merge serialization | lock file + orchestrator-controlled merge gate |

### Layer 2 — Durable workflow state

| Concern | Recommended tech |
|---|---|
| run registry | JSON files under `.Agent_ChatRoom/Orchestrator agent memory/RUN-*/agents/` |
| dispatch instructions | Markdown dispatch files |
| worker completion | structured DONE Markdown |
| event log | append-only run log |
| health/stale hints | derived state snapshots, not authoritative memory |
| queue/future remote mode | disk JSON queue, BTB-style, only later |

### Layer 3 — Orchestration logic

| Concern | Recommended tech |
|---|---|
| simple run coordination | orchestrator agent + scripts |
| multi-task dependency graph | parse `TASK-*.md` dependency metadata into DAG |
| LLM DAG planning | optional, verified and repaired; never blindly trusted |
| review gate | `quality-guard` / `test-writer` as explicit workflow stages |
| stuck worker diagnosis | first deterministic signals, then optional semantic health-check agent |

### Layer 4 — UI / observability

| Concern | Recommended tech |
|---|---|
| local live view | tmux split layout |
| Pi dashboard | project-local Pi extension reading registry |
| widget | read-only compact summary |
| detailed status | `/agents` command + `agent_status` tool |
| capture | `agent_capture(agent_id)` resolves pane id from registry |
| future web dashboard | Python/aiohttp or Node service that tails logs, not Phase 1 |

### Layer 5 — Safety policy

| Concern | Recommended policy |
|---|---|
| parallel writers | must use worktree isolation |
| parallel reviewers | same checkout allowed if read-only |
| overlapping file edits | serialized by orchestrator |
| review failure | blocks acceptance by default |
| extension failure | must not affect dispatch or worker lifecycle |
| TUI failure | cosmetic only, never fatal |

---

## Concrete Changes Suggested for Matelink

### Immediate P0

1. Change `smart-split.sh` to return `%pane_id`.
2. Stop attaching a new Windows Terminal tab for every worker by default.
3. Add run registry files written by the dispatch path.
4. Make extension `/agents` read registry instead of requiring `agent_register`.
5. Make widget read-only and visibly report missing registry.

### P1

1. Add structured DONE schema with `run_id`, `agent_id`, `status`, `completed_at`.
2. Add `agent_status` as derived-state query over registry + DONE + tmux.
3. Add fault-isolated extension UI pattern: UI errors cannot break monitor state.
4. Add bounded event log per agent.

### P2

1. Add git worktree mode for concurrent writer agents.
2. Add serialized merge/sync gate.
3. Add quality-review gate as a first-class workflow state.
4. Add health-check route for long-running workers.

### P3

1. Add web dashboard only if local tmux/Pi UX is stable.
2. Add queue/server mode only if we need remote execution or GitHub webhook automation.

---

## Final Recommendation

The stack we should converge on is:

```text
Bash/tmux for visible local process control
+ JSON/Markdown run registry as durable truth
+ Pi TypeScript extension as read-only dashboard/control client
+ optional git worktrees for concurrent writers
+ explicit review/fix gates
+ deterministic health checks before semantic LLM health checks
```

Bob-The-Builder confirms that a reliable task orchestrator is not primarily an “agent spawning” problem. It is a **workflow state, isolation, synchronization, and observability** problem.

For our current monitor-extension work, the most important imported lesson is:

> Build the registry and pane/worktree lifecycle first; then build the extension dashboard on top of it.
