# agent-switcher

为 pi 增加主会话级的 `/agent` 切换能力。

## 功能

- 从 `~/.pi/agent/agents/*.md` 和最近的 `.pi/agents/*.md` 发现 agent
- 支持 `/agent <name>` 切换 agent
- 支持 `/agent` 交互式选择
- 支持 `/agent list` 查看列表
- 支持 `/agent default` 恢复 default 模式
- 在 `before_agent_start` 中注入 agent prompt
- 根据 agent frontmatter 切换 model / tools
- 用 `pi.appendEntry()` 持久化 active agent 到 session
- session resume 时自动恢复
- 在编辑器上方显示当前 active agent widget

## Agent 文件格式

使用 markdown + YAML frontmatter：

```md
---
name: planner
description: Creates implementation plans from context and requirements
tools: read, grep, find, ls
model: zai/glm-5.1
welcomeMessage: Planning mode activated
---

You are a planning specialist...
```

## 支持字段

- `name: string`
- `description: string`
- `model: string`
- `tools: string[] | comma-separated string`
- `welcomeMessage: string`
- markdown body 作为 `prompt`

## 语义

- `model` 未设置：恢复到 session 的 default model
- `tools` 未设置：恢复到 session 的 default tools
- project `.pi/agents/*.md` 与 user `~/.pi/agent/agents/*.md` 同名时，project 优先

## 命令

- `/agent`：交互式选择
- `/agent list`：列出所有 agent
- `/agent reviewer`：切换到 reviewer
- `/agent default`：切回默认状态

## 安装/生效

该文件放在：

- `~/.pi/agent/extensions/agent-switcher/index.ts`

如果当前 pi session 已经启动，需要执行：

```text
/reload
```

或重启 pi，才能加载新扩展。
