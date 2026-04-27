# agent-monitor

Pi coding agent 的多 Worker 编排可观测性插件。提供 TUI 仪表盘、LLM 工具和 Widget，用于监控由 `orch` Python CLI 管理的 tmux 多 Worker 编排系统。

## 系统架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户 / LLM                               │
│                                                                  │
│  Pi TUI (主会话)                                                 │
│    ├─ /monitor-agent  →  Directory → Panel → Widget             │
│    ├─ agent_status    →  读取 registry/DONE/tmux，返回 JSON     │
│    ├─ agent_capture   →  只读抓取 worker pane 输出              │
│    └─ (agent_register →  deprecated no-op)                      │
│                                                                  │
│  LLM 工具调用                                                    │
│    └─ Orchestrator Agent 通过 bash 调用 orch CLI                │
└─────────────────────────────────────────────────────────────────┘
         │ 读                            │ 写
         ▼                               ▼
┌─────────────────────┐    ┌──────────────────────────────────────┐
│  Pi Extension       │    │  Python CLI `orch`                   │
│  (agent-monitor)    │    │  (orchestrator/tools/orch.py)        │
│                     │    │                                      │
│  只读投影层：        │    │  生命周期操作层（唯一写入方）：        │
│  · 读 registry JSON │◄───│  · 写 agents/<id>.json (原子写入)   │
│  · 读 DONE 报告     │◄───│  · 创建/复用 tmux pane              │
│  · 查 tmux liveness │    │  · dispatch worker (mpi + /agent)    │
│  · 派生状态         │    │  · wait / status / stop              │
│  · stalled 检测     │    │  · 解析 DONE 报告                    │
│                     │    │  · 派生状态                           │
└─────────────────────┘    └──────────────────────────────────────┘
                                    │
                                    ▼
                          ┌──────────────────────┐
                          │  文件系统             │
                          │  (Source of Truth)   │
                          │                      │
                          │  RUN-<id>/run.json   │
                          │  RUN-<id>/agents/    │
                          │    <id>.json         │
                          │  RUN-<id>/dispatch/  │
                          │    <id>.md           │
                          │  RUN-<id>/reports/   │
                          │    <id>.DONE.md      │
                          └──────────────────────┘
```

### 三层分离

| 层 | 文件 | 职责 | 读/写 |
|---|---|---|---|
| **Extension** | `index.ts` | TUI 仪表盘、LLM 工具、Widget 展示 | 只读 |
| **Python CLI** | `orchestrator/tools/orch.py` | tmux pane 生命周期、registry 写入、dispatch | 读写 |
| **Agent Prompt** | `orchestrator/AGENT.md` | LLM 行为约束、调度决策规则、工作流程 | 无 (纯 prompt) |

**核心设计原则：Extension 永远不是 lifecycle owner。** 所有写入操作走 `orch` CLI，Extension 只读取 registry + DONE + tmux 状态并展示。

## 文件说明

```
agent-monitor/
├── README.md                          ← 本文档
├── index.ts                           ← Pi Extension（~980 行 TypeScript）
│
└── orchestrator/                      ← 安装到 .pi/agents/orchestrator/
    ├── AGENT.md                       ← Orchestrator Agent 系统提示词
    ├── dispatch-template.md           ← Dispatch/DONE 文件格式模板
    ├── runtime/
    │   └── README.md                  ← 运行时权威规则文档
    └── tools/
        ├── orch                       ← Bash 入口（exec python3 orch.py）
        └── orch.py                    ← Python CLI 生命周期管理（~560 行）
```

### `index.ts` — Pi Extension

注册以下能力到 Pi：

| 注册项 | 类型 | 说明 |
|--------|------|------|
| `agent_register` | tool | 已废弃的兼容 shim，返回当前 snapshot |
| `agent_status` | tool | 读取 registry/DONE/tmux，返回结构化状态 |
| `agent_capture` | tool | 只读抓取 worker pane 最近 N 行 |
| `agent_wait` | tool | 已禁用，提示使用 `orch worker wait` |
| `agent_send` | tool | 已禁用，Extension 不发送 tmux 按键 |
| `/monitor-agent` | command | 打开 TUI：Directory → Panel → Widget |
| Widget | auto | 编译器面板上方 compact 状态摘要（10s 刷新） |

状态派生优先级（DONE 覆盖 tmux）：
1. DONE 文件有效 → `done` / `blocked` / `failed`
2. Pane 死亡且无 DONE → `crashed`
3. Pane 存活、无 DONE → `running` / `registered`
4. Pane 输出连续 12 次不变 → `stalled`

### `orch.py` — Python CLI

命令树：

```
orch run create <run_id> [--title]        创建/复用 tmux run window + run.json
orch worker create <run_id> <agent_id>    创建/复用 worker pane + registry
       [--assigned-agent] [--size]
orch worker dispatch <run_id> <agent_id>  启动 mpi → /agent → 发送 dispatch 指令
       [--dispatch] [--done]
orch worker status <run_id> [agent_id]    派生状态：registry + DONE + tmux
orch worker wait <run_id> <agent_id>      轮询 DONE + tmux liveness
       [--timeout]
orch worker stop <run_id> <agent_id>      安全停止：Ctrl-C + 暂停消息
       [--no-message]
```

关键实现细节：
- **原子写入**：`write_json_atomic()` 使用 tempfile → `os.replace()`，防止 registry 损坏
- **Pane 复用**：如果 registry 中已有 pane_id 且 tmux 确认存活，跳过 split
- **自动布局**：宽 pane 水平 split，窄 pane 垂直 split，之后 `select-layout tiled`
- **Pi 就绪检测**：`wait_for_pi_ready()` 轮询 pane 输出匹配 Pi 启动标志
- **DONE 解析**：正则 `^\s*-\s*(key)\s*:\s*(value)$` 提取结构化字段

### `AGENT.md` — Orchestrator Agent Prompt

定义 LLM 在 orchestrator 角色下的完整行为：
- 何时自己做、何时分派给下游 agent
- 标准 `orch-first` 启动流程（6 步）
- 下游 agent 路由表（canvas-architect, feature-builder, test-writer, quality-guard, bug-recorder）
- Dispatch 文件格式和 DONE 报告 schema
- 冲突仲裁规则和最终交付格式

### `runtime/README.md` — 运行时权威规则

与 AGENT.md 互补的运行时规则，分离 prompt 稳定性和实现可变性。包含：
- 分层定义、lifecycle 命令、状态派生规则
- DONE 报告合约、Pane capture 规则
- Agent monitor 的角色边界（opt-in/read-mostly）

## 安装

### 前置条件

- [pi coding agent](https://github.com/mariozechner/pi-coding-agent) 已安装
- Python 3.10+
- tmux
- `mpi` 命令可用（Pi CLI 的快捷命令）

### 方式一：Git Clone + Symlink（推荐）

```bash
# 1. Clone 仓库
git clone https://github.com/flixfox1/pi-extensions.git ~/pi-extensions

# 2. 创建 Extension symlink
#    Pi 会自动发现 ~/.pi/agent/extensions/agent-monitor/index.ts
mkdir -p ~/.pi/agent/extensions
ln -s ~/pi-extensions/agent-monitor ~/.pi/agent/extensions/agent-monitor

# 3. 创建 Agent symlink
#    Pi 会自动发现 ~/.pi/agent/agents/orchestrator/AGENT.md
mkdir -p ~/.pi/agent/agents
ln -s ~/pi-extensions/agent-monitor/orchestrator ~/.pi/agent/agents/orchestrator

# 4. (可选) 项目级安装替代全局安装
#    mkdir -p .pi/extensions .pi/agents
#    ln -s ~/pi-extensions/agent-monitor .pi/extensions/agent-monitor
#    ln -s ~/pi-extensions/agent-monitor/orchestrator .pi/agents/orchestrator
```

### 方式二：pi -e 快速测试

```bash
pi -e ~/pi-extensions/agent-monitor/index.ts
```

这种方式只加载 Extension，不包含 Agent 定义和 Python CLI。

### 安装后验证

```bash
# 检查 extension 已加载
# 启动 pi 后执行：
/monitor-agent

# 检查 agent 已注册
/agent list
# 应显示 orchestrator

# 检查 orch CLI 可用
export PATH=".pi/agents/orchestrator/tools:$PATH"
orch --help
```

## 使用流程

### 1. 切换到 Orchestrator Agent

```
/agent orchestrator
```

### 2. 给出任务目标

Orchestrator 会判断是否需要拆分任务、分派下游 agent。

### 3. Orchestrator 自动执行的标准流程

```
orch run create "20260428-120000-my-task" --title "My Task"
       ↓ 创建 tmux window + run.json
orch worker create "20260428-120000-my-task" "feature-builder" --assigned-agent feature-builder
       ↓ 创建 worker pane + registry JSON
       ↓ (同时) 写入 dispatch/<agent-id>.md 任务文件
orch worker dispatch "20260428-120000-my-task" "feature-builder" \
       --dispatch ".../dispatch/feature-builder.md" \
       --done ".../reports/feature-builder.DONE.md"
       ↓ 在 worker pane 启动 mpi → /agent feature-builder → 读取 dispatch 文件
orch worker wait "20260428-120000-my-task" "feature-builder" --timeout 300
       ↓ 轮询 DONE 文件 + tmux liveness
orch worker status "20260428-120000-my-task"
       ↓ 汇总所有 worker 状态
```

### 4. 监控进度

在 Orchestrator 工作期间，你可以随时：

- **`/monitor-agent`** 打开 TUI 仪表盘查看所有 worker 状态
- **设置环境变量 `AGENT_MONITOR_WIDGET=1`** 启用编译器上方常驻 Widget
- **让 LLM 调用 `agent_status`** 获取结构化状态 JSON
- **让 LLM 调用 `agent_capture`** 查看某个 worker 的终端输出

### 5. 状态流转

```
registered ──→ dispatching ──→ dispatched ──→ running ──→ done
                                                    ├──→ blocked
                                                    ├──→ failed
                                                    ├──→ crashed (pane 死亡，无 DONE)
                                                    └──→ stalled (输出长时间不变)
```

## 运行时产生的文件

orch 在项目根目录的 `.Agent_ChatRoom/Orchestrator agent memory/` 下创建：

```
.Agent_ChatRoom/Orchestrator agent memory/
└── RUN-<RUN_ID>/
    ├── run.json                  # Run 级元信息
    ├── agents/
    │   └── <agent-id>.json       # Worker registry（source of truth）
    ├── dispatch/
    │   └── <agent-id>.md         # 下发任务文件
    └── reports/
        └── <agent-id>.DONE.md    # Worker 完成报告
```

### Registry Schema (`agents/<id>.json`)

```json
{
  "schema_version": 1,
  "run_id": "20260428-120000-my-task",
  "agent_id": "feature-builder",
  "assigned_agent": "feature-builder",
  "status": "dispatched",
  "tmux_target": "mat-orch:0",
  "pane_id": "%5",
  "target": "%5",
  "dispatch_path": ".Agent_ChatRoom/.../dispatch/feature-builder.md",
  "done_path": ".Agent_ChatRoom/.../reports/feature-builder.DONE.md",
  "created_at": "2026-04-28T00:00:00Z",
  "updated_at": "2026-04-28T00:01:00Z"
}
```

### DONE Report Schema (`reports/<id>.DONE.md`)

```markdown
# DONE feature-builder

- run_id: 20260428-120000-my-task
- agent_id: feature-builder
- status: done
- summary: 实现了 XXX 功能
- changed_files: src/view/foo.tsx, src/core/bar.ts
- tests: 全部通过
- findings: 无
- next_action: 建议后续做 YYY
- completed_at: 2026-04-28T00:05:00Z
```

## Extension 与 Agent 的关系

```
Extension (index.ts)          Agent (orchestrator/AGENT.md)
    │                              │
    │  注册到 Pi runtime           │  通过 /agent 切换激活
    │  提供 tools + commands       │  定义 LLM 行为规则
    │  读 registry/DONE/tmux       │  通过 bash 调用 orch CLI
    │                              │
    │         ┌────────────┐       │
    └── 读 ◄──┤ filesystem │ ◄── 写┘
              │ (registry) │
              │  + DONE    │
              │  + tmux    │
              └────────────┘
```

- **Extension** 是 Pi runtime 的插件，在主会话的 Pi 进程中运行。它注册 tools 和 commands，提供可观测性界面。
- **Agent** 是 LLM 的角色定义（system prompt），告诉 LLM 如何作为 Orchestrator 行事。
- **Python CLI** 是独立的命令行工具，被 Agent 通过 bash 调用，负责实际的 tmux 操作和 registry 写入。
- 三者通过文件系统（registry JSON + DONE 文件）解耦，没有运行时直接依赖。

**Extension 和 Agent 可以独立使用**：
- 只安装 Extension → 你获得 `/monitor-agent` 仪表盘和 `agent_status` 工具，可用于手动跟踪任何 orch 管理的 run
- 只安装 Agent → 你获得 Orchestrator 角色和 `orch` CLI，但无法在 Pi TUI 中看到 compact 仪表盘

## 设计决策

| 决策 | 理由 |
|------|------|
| Extension 只读，不写 registry | 避免双写竞争；registry 由 orch CLI 唯一写入 |
| `agent_register` 废弃为 no-op | 旧设计依赖 LLM 主动调用，实际经常遗漏；新设计由 orch CLI 自动写入 |
| `agent_wait` / `agent_send` 禁用 | Phase 1 只做可观测性；控制操作走 `orch worker wait/stop` |
| Stalled 检测用 MD5 哈希比较 | 轻量、无状态、不需要理解 pane 输出语义 |
| orch CLI 用 Python 而非 shell | 原子写入、JSON 处理、错误恢复比 shell 可靠；单文件无外部依赖 |
| Registry 放文件系统而非数据库 | 可 git 追踪、可人工检查、无额外进程依赖 |

## 限制与已知问题

- **tmux 依赖**：必须有 tmux，不支持 Windows 原生（WSL 下可用）
- **单机模型**：所有 worker 在同一台机器的 tmux session 中运行，不支持分布式
- **Stalled 误报**：Worker 在长时间思考/编译时可能触发 stalled 检测（阈值 12 × 10s = 2 分钟）
- **Widget 默认隐藏**：需要 `AGENT_MONITOR_WIDGET=1` 环境变量或 `/monitor-agent` 手动开启
- **DONE 格式脆弱**：使用正则解析 `- key: value`，而非 YAML/JSON 解析器

## 许可

与主仓库 [pi-extensions](https://github.com/flixfox1/pi-extensions) 一致。
