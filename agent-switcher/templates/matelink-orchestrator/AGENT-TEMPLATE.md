# agent-switcher

pi coding agent由主会话级的 `/agent` 切换能力。

## Agent 文件格式

agent 支持两种 markdown + YAML frontmatter 结构：

1. 目录结构（推荐）：`.pi/agents/<agent-name>/AGENT.md` 或 `~/.pi/agent/agents/<agent-name>/AGENT.md`
2. 扁平结构（向后兼容）：`.pi/agents/<agent-name>.md` 或 `~/.pi/agent/agents/<agent-name>.md`

目录结构中，目录名是 agent 名；如果 `AGENT.md` frontmatter 的 `name` 与目录名不一致，会 warning，但以目录名为准。

```md
---
name: planner
description: Creates implementation plans from context and requirements
tools: read, grep, find, ls
model: zai/glm-5.1
thinkingIntensity: xhigh
welcomeMessage: Planning mode activated
---

You are a planning specialist...
```

## 支持字段

- `name: string`
- `description: string`
- `model: string`
- `tools: string[] | comma-separated string`
- `thinkingIntensity: off | minimal | low | medium | high | xhigh`
  - 兼容 `x-high`、`extra-high` 等写法，会规范化为 `xhigh`
  - 兼容 `thinking` 别名，但推荐统一使用 `thinkingIntensity`
- `welcomeMessage: string`
- markdown body 作为 `prompt`

## 语义

- `model` 未设置：恢复到 session 的 default model
- `tools` 未设置：恢复到 session 的 default tools
- `thinkingIntensity` 未设置：恢复到切换 agent 前的 session thinking level
- 同一目录下扁平 `<name>.md` 与目录 `<name>/AGENT.md` 同名时，目录结构优先
- project `.pi/agents/*/AGENT.md` / `.pi/agents/*.md` 与 user `~/.pi/agent/agents/*/AGENT.md` / `~/.pi/agent/agents/*.md` 同名时，project 优先

## 命令

- `/agent`：交互式选择
- `/agent list`：列出所有 agent
- `/agent reviewer`：切换到 reviewer
- `/agent default`：切回默认状态
