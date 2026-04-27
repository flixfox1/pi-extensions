# Agent Monitor Extension — 路线修正文档

## 定位修正

**保留 tmux 多 agent 可见并行架构，但生命周期 source of truth 不放在 Pi extension 内存里。**

本轮路线修正后的核心判断：

```text
tmux + run registry + DONE files = lifecycle source of truth
Pi extension = read-only dashboard + optional control client
```

Extension 不再被设计为 agent 生命周期的唯一权威控制器。它负责读取已经存在的 run registry、tmux pane 状态和 DONE 文件，并在 Pi TUI / LLM tools 中提供状态展示与辅助操作。

这次修正来自实际使用中的两个 UX 发现：

1. **窗口扩散问题**：worker 启动时虽然创建了 tmux pane，但 `attach-pane.sh tab` 又为每个 worker 打开新的 Windows Terminal tab，导致用户看到的是多 tab 扩散，而不是一个窗口内的 tmux 分屏。
2. **extension 无可见作用问题**：当前 extension 需要 LLM 显式调用 `agent_register` 才有状态；真实 orchestrator 流程仍使用 `poll-done.sh` / tmux capture，因此 extension 的内存 map 大多数时候为空，TUI/widget 看不到任何东西。

因此，新的设计目标不是“把 supervisor 完整搬进 extension”，而是先稳定 **可见调度 UX + 持久化 registry + 自动发现 dashboard**。

---

## 非目标

本阶段不做：

- 不让 Pi extension 负责创建 tmux pane。
- 不让 Pi extension 成为唯一生命周期 owner。
- 不依赖 LLM 每次记得调用 `agent_register`。
- 不默认让 extension 在 `session_shutdown` 时 kill worker panes。
- 不把 `agent_wait` / `agent_send` 作为第一阶段核心能力。
- 不默认每个 worker 打开新的 Windows Terminal tab。

---

## UX 原则

### 1. 一个 run 默认一个可见 terminal tab/window

跨平台是 P0 要求。tmux 核心操作本身可跨 WSL/Linux/macOS，但 terminal attach 层必须做 platform adapter，不能硬编码 Windows Terminal。

启动 run 时只 attach 一次：

```bash
tmux new-session -d -s "mat-orch-<RUN_ID>" -n orchestrator
attach-pane.sh tab "mat-orch-<RUN_ID>"
```

后续 worker 创建只在这个 tmux session/window 内 split pane：

```bash
smart-split.sh "mat-orch-<RUN_ID>:orchestrator" "feature-builder" 40
```

默认不再对每个 worker 执行：

```bash
attach-pane.sh tab "<worker-pane>"
```

如果用户明确要求把某个 worker 单独弹出查看，才使用 platform adapter 的 pop-out attach 模式。

### 2. attach-pane 必须跨平台

`attach-pane.sh` 当前实现依赖 `wt.exe` + `wsl.exe`，这只适用于 WSL + Windows Terminal。修正后的 attach 层必须拆成 adapter：

| Platform | Attach adapter | Requirement |
|---|---|---|
| WSL + Windows Terminal | `wt.exe` + `wsl.exe` | supported current path |
| macOS Terminal.app | `osascript` Terminal `do script` | required |
| macOS iTerm2 | AppleScript iTerm2 tab/split | optional but preferred |
| Linux desktop | `$TERMINAL`, `x-terminal-emulator`, `gnome-terminal`, `kitty`, `wezterm` | required best-effort |
| headless/CI | no attach; print tmux attach command | required fallback |

Rules:

- tmux session/pane lifecycle must not depend on Windows Terminal.
- attach failure must not fail dispatch; it should return a visible diagnostic and the manual `tmux attach -t ...` command.
- The default UX remains one visible terminal per run, regardless of OS.
- Worker pop-out is opt-in and adapter-specific.

### 3. tmux pane id 是调度 target

`smart-split.sh` 必须返回稳定 pane id，例如：

```text
%5
```

而不是易失的：

```text
mat-orch-RUN:orchestrator.4
```

tmux pane index 在 split/kill/layout 调整后可能失效，容易出现 `can't find pane: 4`。pane id 才适合写入 registry 和后续 `send-keys` / `capture-pane`。

### 4. Extension 只展示，不隐藏真实状态

Extension 展示的内容必须能回溯到：

- run registry
- tmux pane liveness
- DONE file
- dispatch file
- optional supervisor state

如果 extension 没有读到 registry，它应该显示：

```text
No run registry found for current session.
```

而不是静默空白。

---

## 架构修正

```
┌─────────────────────────────────────────────────────────┐
│ Platform Terminal Adapter                              │
│  (Windows Terminal / macOS Terminal / iTerm2 / Linux)   │
│                                                         │
│  Tab/Window: mat-orch-RUN                               │
│  └─ tmux session/window                                 │
│     ├─ pane %1: orchestrator Pi CLI                     │
│     ├─ pane %2: feature-builder Pi CLI                  │
│     ├─ pane %3: test-writer Pi CLI                      │
│     └─ pane %4: quality-guard Pi CLI                    │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Run Registry / Filesystem Truth                         │
│                                                         │
│ .Agent_ChatRoom/Orchestrator agent memory/RUN-.../      │
│   agents/                                               │
│     <agent_id>.json                                     │
│   dispatch/                                             │
│     <role>.md                                           │
│   reports/                                              │
│     <role>.DONE.md                                      │
│   supervisor/                                           │
│     agents/<role>.state        (optional fallback)       │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Pi Process: Orchestrator                                │
│                                                         │
│  bash tools                                             │
│    ├─ smart-split.sh  → split tmux pane, return pane id │
│    ├─ dispatch-agent.sh → start mpi + /agent + task     │
│    └─ attach-pane.sh  → only initial/default user attach │
│                                                         │
│  agent-monitor extension                               │
│    ├─ read run registry                                 │
│    ├─ read DONE files                                   │
│    ├─ check tmux pane liveness                          │
│    ├─ /agents dashboard                                 │
│    ├─ widget summary                                    │
│    └─ optional capture/send tools                       │
└─────────────────────────────────────────────────────────┘
```

---

## Source of Truth

| Concern | Source of truth | Notes |
|---|---|---|
| worker exists | run registry `agents/<agent_id>.json` | written by dispatch path, not by LLM memory |
| tmux target | stable pane id in registry | e.g. `%5` |
| task instructions | dispatch file | immutable after dispatch unless orchestrator appends a follow-up dispatch |
| task result | DONE report file | structured status required |
| pane alive/dead | tmux query | runtime evidence, not durable result |
| dashboard state | derived view | extension can recompute from registry + tmux + DONE |
| fallback monitoring | supervisor state | optional degraded/manual path, not concurrent authority unless read-only |

The extension may cache state for UI performance, but cache is never authoritative. On `/reload`, restart, or `/agents`, it must be able to reconstruct state from registry and files.

---

## Run Registry Schema

Each dispatched worker gets one durable file:

```text
.Agent_ChatRoom/Orchestrator agent memory/RUN-<RUN_ID>/agents/<agent_id>.json
```

Minimum schema:

```json
{
  "schema_version": 1,
  "run_id": "20260426-203047-monitor-review",
  "agent_id": "logic-reviewer-01",
  "display_name": "logic-reviewer",
  "assigned_agent": "quality-guard",
  "tmux_pane_id": "%5",
  "dispatch_file": ".Agent_ChatRoom/.../dispatch/logic-reviewer.md",
  "done_file": ".Agent_ChatRoom/.../reports/logic-reviewer.DONE.md",
  "created_at": "2026-04-26T20:31:46+12:00",
  "status_hint": "dispatched",
  "last_orchestrator_update": "2026-04-26T20:31:46+12:00"
}
```

Rules:

- `agent_id` is immutable and unique within a run.
- `display_name` is for UI only and may repeat.
- `tmux_pane_id` must be a stable `%N` pane id.
- Dispatch tooling writes this file before or during dispatch, not after worker completion.
- Extension must tolerate missing/invalid fields and display diagnostics.

---

## DONE Report Contract

DONE file existence alone is not enough. Each DONE file must include structured fields:

```markdown
# DONE <agent_id>

- run_id: <RUN_ID>
- agent_id: <agent_id>
- status: done | blocked | failed
- summary: <summary>
- changed_files: <files or none>
- tests: <verification or not run reason>
- findings: <key findings>
- next_action: <next step>
- completed_at: <ISO timestamp>
```

Mapping:

| DONE status | monitor state |
|---|---|
| `done` | `done` |
| `blocked` | `blocked` |
| `failed` | `failed` |

Partial-write handling:

- Preferred: worker writes temp file then renames to final DONE path.
- Acceptable fallback: extension treats DONE as valid only after parse succeeds or file size/mtime is stable across two polls.

Stale DONE handling:

- DONE file older than registry `created_at` is stale unless recovery mode explicitly accepts it.

---

## Derived State Model

The extension derives display state from registry + DONE + tmux:

| State | Meaning | Derived from |
|---|---|---|
| `registered` | registry exists, no dispatch evidence yet | registry only |
| `booting` | pane exists, Pi CLI/agent may be starting | pane alive, no DONE |
| `running` | pane alive and task not terminal | pane alive, no DONE |
| `stalled` | pane alive but no output change beyond threshold | non-terminal warning, not terminal |
| `done` | DONE parsed as success | DONE status `done` |
| `blocked` | worker reported blocked | DONE status `blocked` |
| `failed` | worker reported failed or DONE parse indicates failure | DONE status `failed` |
| `crashed` | pane missing/dead and no valid DONE | tmux dead, no DONE |
| `unknown` | registry invalid or tmux query unavailable | diagnostic state |

Terminal precedence:

1. valid DONE report → `done` / `blocked` / `failed`
2. pane missing with no DONE → `crashed`
3. registry invalid → `unknown`
4. pane alive with no DONE → `booting` / `running` / `stalled`

`stalled` is a warning flag, not proof of failure.

---

## Corrected Dispatch Flow

### Step 1: create run and attach once

```bash
tmux new-session -d -s "mat-orch-<RUN_ID>" -n orchestrator
attach-pane.sh tab "mat-orch-<RUN_ID>"
```

### Step 2: create worker pane

```bash
PANE_ID=$(smart-split.sh "mat-orch-<RUN_ID>:orchestrator" "feature-builder" 40)
# PANE_ID should be %5-like stable pane id
```

### Step 3: write registry

```bash
register-worker.sh \
  --run-id "<RUN_ID>" \
  --agent-id "feature-builder-01" \
  --display-name "feature-builder" \
  --assigned-agent "feature-builder" \
  --tmux-pane-id "$PANE_ID" \
  --dispatch-file ".../dispatch/feature-builder.md" \
  --done-file ".../reports/feature-builder.DONE.md"
```

This can be implemented inside `dispatch-agent.sh` or as a separate helper. The key rule is: **registry creation is automatic and not LLM-dependent**.

### Step 4: dispatch agent into pane

```bash
dispatch-agent.sh "$PANE_ID" "feature-builder" \
  ".../dispatch/feature-builder.md" \
  ".../reports/feature-builder.DONE.md"
```

### Step 5: extension reads registry

```text
/agents
```

or widget refresh reads the same run registry and derives state.

---

## Extension Scope — Phase 1

Phase 1 extension is read-only dashboard.

Tools/commands:

| Name | Type | Behavior |
|---|---|---|
| `/agents` | command | Show current run dashboard from registry |
| `agent_status` | tool | Return structured state for all or one agent |
| `agent_capture` | tool | Optional read-only pane capture by `agent_id` |

No Phase 1:

- no `agent_register` as required path
- no blocking `agent_wait`
- no default `agent_send`
- no in-memory-only lifecycle authority

Widget:

- displays compact summary only when registry exists
- should show diagnostics if registry path is missing or parse failed
- must be read-only projection of derived state

Example widget:

```text
Agent Monitor: 4 tracked · 2 running · 1 done · 1 blocked
```

---

## Extension Scope — Phase 2

After Phase 1 is reliable, add optional control tools:

| Tool | Rule |
|---|---|
| `agent_wait` | convenience wrapper over registry-derived state; not the state owner |
| `agent_send` | disabled by default or guarded by capability/confirmation |
| `agent_cancel` | explicit orchestrator decision; documents whether it sends Ctrl+C, kills pane, or only marks cancelled |

Security/capability rules:

- Tools accept `agent_id`, not arbitrary raw tmux target.
- Extension resolves `agent_id → tmux_pane_id` from registry.
- `agent_send` records audit event in run memory.
- Payload length and control characters are constrained.

---

## Fallback Supervisor Policy

`sup-*.sh` remains a fallback, but it must not silently become a competing lifecycle authority.

Allowed modes:

1. **Primary registry mode** — default. Dispatch writes registry. Extension reads registry. No bash supervisor loop required.
2. **Fallback supervisor mode** — used when extension is unavailable or user explicitly requests shell-only monitoring.
3. **Read-only parity mode** — supervisor and extension both read the same registry/DONE fixtures for debugging, but only one is allowed to emit authoritative lifecycle decisions.

Fallback activation must be explicit in run memory.

---

## Implementation Priorities

### P0 — Fix visible orchestration UX

- `smart-split.sh` returns stable `%pane_id`.
- Orchestrator attaches one platform terminal per run by default through adapter, not Windows-only hardcoding.
- Worker dispatch does not call `attach-pane.sh tab` unless user requests pop-out.
- Use `tmux select-layout tiled` or equivalent after multiple splits.

### P1 — Registry-first lifecycle

- Add `agents/<agent_id>.json` registry files.
- Make dispatch path automatically write registry.
- Update DONE report template to include `run_id`, `agent_id`, `status`, `completed_at`.

### P2 — Read-only extension dashboard

- `/agents` scans registry and derives state.
- `agent_status` returns structured JSON.
- widget displays compact summary.
- Extension handles missing registry with visible diagnostics.

### P3 — Optional control tools

- `agent_capture(agent_id)`.
- guarded `agent_send(agent_id, message)`.
- `agent_wait` only after derived state semantics are stable.

---

## Design Decision Summary

Previous design:

```text
Extension registers agents in memory → polls tmux → owns lifecycle
```

Corrected design:

```text
Dispatch writes registry → tmux/DONE provide evidence → extension derives dashboard state
```

The corrected route optimizes for the actual UX requirement: **visible, stable, recoverable multi-agent orchestration**. Extension is still useful, but only after the external lifecycle substrate is reliable.
