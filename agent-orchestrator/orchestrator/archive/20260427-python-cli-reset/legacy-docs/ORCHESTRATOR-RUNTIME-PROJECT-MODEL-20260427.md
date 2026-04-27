 Orchestrator Runtime Project Model

 核心原则：

 ```text
   一个任务 = 一个  Directory
   Directory 是唯一持久化入口
   Matelink runtime = 持久、可观察、可介入、可恢复
   Agent Monitor 是可打开/可关闭的 viewer
   子 agent 生命周期通过 state / events / Workers 派生
   HANDOFF.md 是理解入口，CHECKLIST.md 是执行入口
  ```

 ────────────────────────────────────────────────────────────────────────────────

 1. Runtime 文件工程：每次只生成一个 run 子目录

 现在的问题是：

 ```text
   .Agent_ChatRoom/Orchestrator agent memory/
     SESSION_REGISTRY.md
     RUN-xxx.md
     RUN-xxx/
       dispatch/
       reports/
       agents/
 ```

 再加上临时报告、dispatch、DONE、registry，确实会让“一个 runtime 的意图”散掉。

 Bob-The-Builder 的启发是：任务权威文件、机器状态、过程日志要分层。但 Matelink 不能走 Bob 的“一次性 worker 跑完即退出”路线。Matelink 需要持久可介入：orchestrator 必须能看到子 agent 的当前状态、向已有 agent 继续发任务、暂停、恢复、重试、审查后退回。

 所以这里不是纯 handoff 文档布局，而是“handoff + control plane”布局：

 ```text
   .Agent_ChatRoom/orchestrator-runs/
     INDEX.json
     20260427-xxxx-short-slug/
       HANDOFF.md              # 理解入口：用户意图 / 当前局势 / 关键决策 / 恢复路径
       CHECKLIST.md            # 执行入口：打勾任务书 / 状态 / action / source / 审查备注
       Runtime/
         state.json            # control plane：run / tasks / agents / panes / dispatch / retry
         events.jsonl          # append-only 事实流：run + 所有 agent lifecycle events
       Workers/                # 按需创建：每个子 agent 一个接力文档
         <agent-id>.md
       Artifacts/              # 按需创建：任务真实产物，不放 runtime 噪音
         ...
  ```

 默认新 run 只必须创建：

 ```text
   HANDOFF.md
   CHECKLIST.md
   Runtime/state.json
   Runtime/events.jsonl
  ```

 `Workers/`、`Artifacts/` 都是 lazy directories：没有对应内容时不创建。
 这样一个 runtime 的常规视野保持在 4 个核心文件以内，必要时才展开细节。

 注意：上面的 `<agent-id>` 是占位符，不代表固定两个子 agent。一个 run 可以有 0、1、2 或 N 个子 agent；agent 列表以 `Runtime/state.json.agents[]` 和 `Runtime/events.jsonl` 为准。

 全局只保留一个轻量索引：

 ```text
   .Agent_ChatRoom/orchestrator-runs/INDEX.json
 ```

 它只负责记录：

 ```json
   {
     "run_id": "...",
     "run_dir": "...",
     "status": "active",
     "title": "...",
     "created_at": "...",
     "updated_at": "..."
   }
 ```

 这样以后清理、迁移、恢复都只需要看一个 run 目录；全局层只负责定位，不承载运行细节。

 ────────────────────────────────────────────────────────────────────────────────

 2. Runtime control plane：state.json 管当前，events.jsonl 管历史

 `Runtime/state.json` 是 orchestrator 的当前控制面。它不是给人讲故事的文档，而是让 runtime 可以稳定管理持久 agent：

 ```json
   {
     "run_id": "20260427-xxxx-short-slug",
     "status": "active",
     "active_task": "C002",
     "updated_at": "...",
     "agents": [
       {
         "agent_id": "builder-1",
         "role": "implementation",
         "status": "working",
         "pane_id": "%12",
         "session_id": "matelink-orchestrator",
         "assigned_task": "C002",
         "last_seen_at": "...",
         "last_dispatch_at": "...",
         "dispatch_count": 2,
         "retry_count": 0,
         "worker_doc": "Workers/builder-1.md"
       }
     ],
     "tasks": [
       {
         "id": "C002",
         "status": "working",
         "assigned_agent": "builder-1",
         "source": "CHECKLIST.md#C002"
       }
     ]
   }
 ```

 `Runtime/events.jsonl` 是 append-only 事实流，用来恢复、审计、debug：

 ```json
   {"ts":"...","type":"agent_registered","agent_id":"builder-1"}
   {"ts":"...","type":"task_dispatched","task_id":"C002","agent_id":"builder-1"}
   {"ts":"...","type":"agent_interrupted","agent_id":"builder-1","reason":"user_decision"}
   {"ts":"...","type":"quality_reset","task_id":"C002","from":"done","to":"pending"}
 ```

 关键边界：

 - `state.json` 可以重写，始终表示当前真相。
 - `events.jsonl` 只能追加，用来重建和追责。
 - `HANDOFF.md` 和 `CHECKLIST.md` 给人和 agent 快速恢复。
 - `Workers/<agent-id>.md` 只在该 agent 产生有意义接力时创建。
 - Matelink 允许唤醒已有 agent：通过 `state.json.agents[].pane_id/session_id` 定位，通过 event 记录 dispatch，通过 monitor 观察反馈。
 - Matelink 不把 tmux 当状态源；tmux 只是执行载体。状态源是 `state.json + events.jsonl`。

 持久可介入操作必须落到控制面：

 ```text
   dispatch task   = 更新 state.tasks/agents + append task_dispatched + 向 pane 发送 prompt
   pause agent     = 更新 agent.status=paused + append agent_paused，不删除 pane
   resume agent    = 读取 assigned_task/source + append agent_resumed + 向原 pane 发送恢复 prompt
   reset by review = CHECKLIST item done -> pending + append quality_reset + 更新 state task
   recover crash   = 读取 state + events，校验 pane liveness，必要时重建 agent 或标记 crashed
 ```

 ────────────────────────────────────────────────────────────────────────────────

 3. Agent Monitor：从持久 UI 改成可打开/关闭的 viewer

 现在的 monitor 问题是：

 - session start 后默认启动 poll timer。
 - widget 常驻。
 - UI 和 registry 绑定得太紧。
 - 用户没有“关闭 monitor”的明确动作。
 - monitor 像 lifecycle owner，而不是 viewer。

 新的设计应该是：

 ```text
   Runtime/state / Runtime/events / Workers = 持久化事实
   Agent Monitor = 可触发的只读窗口
 ```

 建议命令语义：

 ```text
   /agents                 # one-shot 查看当前/最近 run
   /agents open <run_dir>  # 打开 monitor widget + poll
   /agents close           # 关闭 widget + 停止 poll
   /agents status <run_dir># 打印结构化状态
   /agents capture <agent> # 只读 capture
 ```

 或者 tools：

 ```text
   agent_monitor_open(run_dir)
   agent_monitor_close()
   agent_status(run_dir?, agent_id?)
   agent_capture(run_dir, agent_id)
 ```

 关键点：

 - monitor 打开时才 poll。
 - close 后必须 clearInterval + ctx.ui.setWidget(id, undefined)。
 - close 不删除 Runtime/state / Runtime/events / Workers。
 - Pi extension restart 后不会自动恢复常驻 monitor，除非用户再次 open。
 - /agents 默认只是 one-shot dashboard，不自动开启常驻 UI。

 ────────────────────────────────────────────────────────────────────────────────

 4. 子 agent 生命周期：需要事件协议，而不只是 DONE 文件

 现在只有：

 ```text
   registered / running / stalled / done / blocked / failed / crashed / unknown
 ```

 但这些主要是 monitor 推断出来的，不是 runtime 主动表达的生命周期。

 建议加一个 lifecycle event protocol：

 ```text
   registered        # state.agents[] 写入
   pane_created      # tmux pane/window 创建
   cli_starting      # mpi 已发送
   cli_ready         # Pi CLI readiness detected
   agent_switching   # /agent xxx 已发送
   agent_ready       # 已切换到目标 agent
   dispatch_sent     # dispatch prompt 已发送
   working           # pane output active / worker acknowledged
   stalled           # 长时间无输出
   done              # DONE status done
   blocked           # DONE status blocked
   failed            # DONE status failed
   crashed           # pane gone + no DONE
   paused            # orchestrator 主动暂停
   needs_decision    # worker 请求仲裁
 ```

 展示图标可以先定成：

 ```text
   ⚪ registered
   🔵 cli_starting / booting
   🟡 dispatch_sent / waiting
   🟢 working
   ⚠️  stalled
   ✅ done
   🟠 blocked / needs_decision
   🔴 failed
   💀 crashed
   ⏸ paused
   ❓ unknown
 ```

 数据来源优先级：

 ```text
   Workers/<agent-id>.md final status
     > explicit lifecycle event
     > state agent current_state
     > tmux liveness/output inference
 ```

 这样 monitor 不需要“猜太多”，而是读事实。

 ────────────────────────────────────────────────────────────────────────────────

 5. 持久化 HANDOFF.md + CHECKLIST.md：每个 run 的双入口

 这个非常关键。

 每次任务开始时，Orchestrator 应该自动生成：

 ```text
   RUN-xxx/HANDOFF.md
   RUN-xxx/CHECKLIST.md
 ```

 它们不是普通 notes，而是 runtime 的恢复和推进入口：

 ```text
   HANDOFF.md   = 理解局势，回答“为什么 / 现在在哪 / 接下来判断什么”
   CHECKLIST.md = 推进执行，回答“做什么 / 谁来做 / 做到哪 / 从哪里追溯”
 ```

 每个生成的文档和每一行文字都必须能作为 handoff：让下游 agent 快速追溯上下文、接上当前动作、继续稳定推进。

 `HANDOFF.md` 建议格式：

 ```md
   # HANDOFF — RUN-20260427-xxxx

   ## Intent

   用户原始目标：

   > ...

   ## Current Status

   - status: active | waiting-worker | needs-decision | verifying | done | blocked
   - last_updated: ...
   - next_action: ...

   ## Acceptance / Done Definition

   - [ ] ...
   - [ ] ...
   - [ ] ...

   ## Active Checklist

   See `CHECKLIST.md`.

   ## Agents

   | agent_id | role | status | handoff |
   |---|---|---|---|
   | <agent-id> | <role> | working | Workers/<agent-id>.md |

   ## Recovery Instructions

   If interrupted, resume by reading:

   1. this `HANDOFF.md`
   2. `CHECKLIST.md`
   3. `Runtime/state.json`
   4. latest entries in `Runtime/events.jsonl`
   5. relevant worker handoff under `Workers/`

   Then continue from:

   > next_action here

   ## Decisions

   - ...

   ## Open Questions

   - ...
 ```

 `CHECKLIST.md` 建议格式：

 ```md
   # CHECKLIST — RUN-20260427-xxxx

   | id | status | action | source |
   |---|---|---|---|
   | C001 | [ ] pending | Freeze runtime handoff model | HANDOFF.md#current-status |
   | C002 | [/] working | Implement run folder creator | HANDOFF.md#next-action |
   | C003 | [x] done | Verify monitor reads new runtime layout | Workers/quality-agent.md |
   | C004 | [!] blocked | Migrate legacy run memory | HANDOFF.md#open-questions |

   ## Notes

   ### C003

   Quality review reset this from done to pending: ...
 ```

 `CHECKLIST.md` 的 status 保持直观：

 ```text
   [ ] pending
   [/] working
   [x] done
   [!] blocked
 ```

 Orchestrator 初始化 `HANDOFF.md` 和 `CHECKLIST.md`。Worker agent 完成自己的任务后，可以把对应 checklist item 改成 done，并在 `Workers/<agent-id>.md` 写入最终接力。Quality agent 如果审查不通过，则把对应 item 从 done 改回 pending，并在 `CHECKLIST.md#Notes` 下追加一句原因。

 详细事件追加到 `Runtime/events.jsonl`。`CHECKLIST.md` 只维护当前推进真相，不承担完整历史；完整历史由 append-only events 保留。

 这会解决你说的：当出现突发情况时，后续 agent 可以先读 `HANDOFF.md` 理解局势，再读 `CHECKLIST.md` 接上执行。

 ────────────────────────────────────────────────────────────────────────────────

 我建议下一步这样推进

 不要直接 patch monitor。先把这些 runtime contract 冻结，然后再实现。

 我建议执行顺序：

 ### Phase A — Runtime Contract Freeze

 产出一个 authority doc：

 ```text
   .pi/agents/orchestrator/tools/ORCHESTRATOR-RUNTIME-PROJECT-MODEL-20260427.md
 ```

 内容包括：

 - run directory contract
 - HANDOFF.md contract
 - CHECKLIST.md contract
 - state.json schema
 - state agents[] / tasks[] schema
 - lifecycle event schema
 - monitor open/close contract
 - migration strategy

 ### Phase B — Tool substrate

 实现：

 ```text
   create-run.sh          # 创建单一 run 目录 + HANDOFF.md + CHECKLIST.md + Runtime/state.json + Runtime/events.jsonl
   run-event.sh           # append-only 写 Runtime/events.jsonl
   agent-event.sh         # append-only 写 Runtime/events.jsonl
   update-state.sh        # 原子更新 Runtime/state.json 当前控制面
   update-handoff.sh      # 更新 HANDOFF.md 当前状态区
   update-checklist.sh    # 更新 CHECKLIST.md 任务状态和审查备注
   register-worker.sh     # 改为适配新 run layout
   dispatch-agent.sh      # dispatch 时写 lifecycle events
 ```

 ### Phase C — Monitor rewrite v2

 修改：

 ```text
   .pi/extensions/agent-monitor/index.ts
 ```

 目标：

 - 默认不常驻。
 - /agents open 才启动 widget + poll。
 - /agents close 关闭 widget + poll。
 - 状态来自 Runtime/state.json + Runtime/events.jsonl + Workers/*.md。
 - lifecycle icons 完整展示。

 ### Phase D — Orchestrator prompt / AGENT.md 更新

 修改 orchestrator 规则，让未来 run 默认：

 ```text
   只创建一个 RUN 子目录
   HANDOFF.md + CHECKLIST.md 是双入口
   当前控制面进入 Runtime/state.json
   历史事实进入 Runtime/events.jsonl
   子 agent 接力进入 Workers/
   root 只保留 INDEX.json / latest 指针
 ```

 ────────────────────────────────────────────────────────────────────────────────

 如果你同意，我下一步会先做 Phase A：冻结 runtime project model
 文档，不急着写代码。这样后续实现不会越改越乱。
