# Monitor / Orchestrator Refactor Plan

> Date: 2026-04-26  
> Source docs: `ARCHITECTURE-monitor-extension.md`, `BTB-task-orchestrator-benchmark-20260426.md`  
> Headless planning reports: `.Agent_ChatRoom/Orchestrator agent memory/RUN-20260426-203047-monitor-review/headless-refactor/reports/`

## Decision

This refactor is now a **route correction**, not a small monitor-extension patch.

Final direction:

```text
tmux core + durable run registry + cross-platform terminal adapter
  → Pi extension as read-only dashboard/control client
  → optional git worktree mode for parallel writers
  → explicit merge/review gates
```

The P0 user-facing requirements are:

1. Cross-platform terminal attach: WSL/Windows Terminal, macOS Terminal.app, iTerm2, Linux desktop, headless/CI fallback.
2. One visible terminal per run by default; no per-worker tab explosion.
3. Stable tmux `%pane_id` as target identity.
4. Registry-first lifecycle; no required `agent_register` memory-only step.
5. Extension dashboard must become useful by reading registry/DONE/tmux, not by owning lifecycle.

---

## Phase 0 — Contract Freeze

Update docs and usage rules before implementation:

- `ARCHITECTURE-monitor-extension.md` is now the route-correction authority.
- `attach-pane.sh` must be described as a platform adapter, not a Windows-only script.
- `RUN-*/agents/<agent_id>.json` is the worker inventory source of truth.
- Phase 1 extension is read-only.
- Worktree mode is mandatory only for parallel writers, not reviewers.

Gate: all implementers agree with these contracts.

---

## Phase 1 — Cross-platform tmux/terminal substrate

### Files likely involved

- `.pi/agents/orchestrator/tools/attach-pane.sh`
- `.pi/agents/orchestrator/tools/terminal-adapter-lib.sh` (new)
- `.pi/agents/orchestrator/tools/smart-split.sh`
- `.pi/agents/orchestrator/tools/dispatch-agent.sh` (audit only; keep attach-free)

### Work

1. Rewrite `attach-pane.sh` as adapter dispatcher.
2. Add modes: `tab`, `split`, `auto`, `popout`, `print`, `probe`.
3. Add adapters:
   - `wsl-wt`
   - `mac-terminal`
   - `mac-iterm2`
   - `linux-terminal`
   - `headless`
4. Make attach failure non-fatal by default; print manual `tmux attach -t ...` fallback.
5. Change `smart-split.sh` to return stable `%pane_id` from `tmux split-window -P -F '#{pane_id}'`.
6. Ensure worker dispatch does not call `attach-pane.sh tab` by default.

### Acceptance

- `attach-pane.sh probe dummy` works on current environment.
- `CI=true attach-pane.sh tab mat-orch-test --adapter headless` prints fallback and exits 0.
- `smart-split.sh` returns `^%[0-9]+$`.
- Dispatch path remains platform-neutral.

---

## Phase 2 — Registry-first lifecycle

### Files likely involved

- `.pi/agents/orchestrator/tools/register-worker.sh` (new)
- `.pi/agents/orchestrator/tools/dispatch-agent.sh`
- `.pi/agents/orchestrator/tools/sup-reg.sh`
- `.pi/agents/orchestrator/tools/poll-done.sh`
- dispatch prompt templates / orchestrator memory format

### Work

1. Add `register-worker.sh` to write `RUN-*/agents/<agent_id>.json` atomically.
2. Make `dispatch-agent.sh` auto-register when `RUN_DIR` is supplied.
3. Preserve supervisor `.state` as compatibility only.
4. Standardize DONE schema:

```markdown
# DONE <agent_id>

- run_id: <RUN_ID>
- agent_id: <agent_id>
- status: done | blocked | failed
- summary: ...
- changed_files: ...
- tests: ...
- findings: ...
- next_action: ...
- completed_at: <ISO timestamp>
```

5. Use `agent_id` as primary identity; `display_name` and `assigned_agent` are not unique keys.

### Acceptance

- Dispatch creates registry without manual extension tool call.
- Registry contains stable `%pane_id`, dispatch path, DONE path.
- DONE success/blocked/failed can be parsed deterministically.
- Missing/invalid registry entries do not crash dashboard consumers.

---

## Phase 3 — Read-only Pi extension dashboard

### Files likely involved

- `.pi/extensions/agent-monitor/index.ts`

### Work

1. Replace memory-only `agents: Map` source of truth with filesystem/tmux-derived state.
2. Add run discovery:
   - explicit run dir argument;
   - env var;
   - latest `RUN-*` fallback;
   - visible diagnostic if none found.
3. Implement registry loader and DONE parser.
4. Derive states:
   - `registered`
   - `running`
   - `stalled`
   - `done`
   - `blocked`
   - `failed`
   - `crashed`
   - `unknown`
5. Rewrite `/agents` dashboard.
6. Rewrite `agent_status` to return structured JSON.
7. Keep `agent_capture(agent_id)` read-only.
8. Deprecate or convert `agent_register`; defer `agent_wait` and `agent_send`.
9. Widget shows compact summary and visible missing-registry diagnostics.

### Acceptance

- `/agents` sees workers created by normal dispatch.
- Extension restart recovers state from registry.
- DONE overrides pane liveness.
- Missing pane + no DONE becomes `crashed`.
- UI/widget failures do not affect dispatch or worker lifecycle.

---

## Phase 4 — Optional worktree mode for parallel writers

### Files likely involved

- `.pi/agents/orchestrator/tools/dispatch-agent.sh`
- `.pi/agents/orchestrator/tools/register-worker.sh`
- `.pi/agents/orchestrator/tools/sync-agent-worktree.sh` (new)
- `.pi/agents/orchestrator/tools/cleanup-agent-worktree.sh` (new later)

### Work

1. Add explicit `--worktree` mode for writer agents.
2. Refuse dirty main checkout by default.
3. Create worktree outside repo:

```text
../.matelink-orch-worktrees/<run_id>/<agent_id>
```

4. Branch naming:

```text
orch/<run_id>/<agent_id>
```

5. Start worker pane in worktree cwd.
6. Use absolute dispatch/DONE paths in central run dir.
7. Registry records `worktree_path`, `branch_name`, `base_sha`.

### Acceptance

- Parallel writer can run in isolated worktree.
- Main checkout is not mutated until merge gate.
- Dirty checkout protection prevents stale worktree starts.

---

## Phase 5 — Merge and review gates

### Files likely involved

- `.pi/agents/orchestrator/tools/sync-agent-worktree.sh` (new)
- gate report files under `RUN-*/gates/`
- orchestrator dispatch templates for `test-writer` / `quality-guard`

### Work

1. Implement serialized merge lock.
2. Merge one worktree branch at a time.
3. Stop on conflicts; no auto resolver in Phase 1.
4. Write merge gate report.
5. Run minimal smoke:
   - `git status --porcelain`
   - `git diff --check HEAD~1..HEAD`
6. Run `test-writer` gate when code/test behavior changed.
7. Run blocking `quality-guard` gate.
8. Add bounded fix loop, max 2 attempts.
9. Require explicit override file for accepting rejected work.

### Acceptance

- Merge gate serializes branches.
- Conflict blocks review.
- Review failure blocks acceptance by default.
- Quality pass produces durable accepted state.

---

## Immediate Implementation Order

Recommended next coding order:

1. `smart-split.sh` stable pane id.
2. `attach-pane.sh` cross-platform adapter + headless fallback.
3. `register-worker.sh` registry writer.
4. `dispatch-agent.sh` auto-register and no per-worker attach.
5. DONE schema template update.
6. `agent-monitor` extension read-only `/agents` rewrite.
7. Optional worktree mode.
8. Merge/review gates.

Do not start with extension `agent_wait` / `agent_send`. Those are Phase 2+ control tools after the read-only lifecycle dashboard is correct.

---

## Headless Subagent Evidence

Reports produced in current session:

- `cross-platform-adapter.md` — platform adapter design and smoke tests.
- `registry-lifecycle.md` — registry-first lifecycle and extension rewrite plan.
- `worktree-review-gate.md` — BTB-derived worktree + merge/review gate plan.
