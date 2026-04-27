# Orchestrator Dispatch Template

每个下游任务使用以下格式：

```markdown
# Dispatch: <agent-or-role>

run_id: <RUN_ID>
tmux_session: mat-orch-<RUN_ID>
assigned_agent: <agent-name>
status: assigned

## Objective
<一句话目标>

## Scope
- 允许读取/修改的模块或文件
- 明确不属于本任务的范围

## Context
- 用户原始目标摘要
- 已知约束
- 相关文档或代码入口

## Required Workflow
1. 先读上下文和相关文件
2. 按 agent 自己的规则执行
3. 只在指定范围内修改
4. 完成后运行必要验证
5. 用下方格式回报

## Acceptance
- <可验证结果 1>
- <可验证结果 2>

## Report Format

请用以下格式回复：

### Status
DONE / BLOCKED / NEEDS_DECISION

### Summary
完成了什么。

### Files
- `path/to/file` - 修改说明

### Verification
运行了哪些命令，结果如何。

### Risks / Questions
需要 Orchestrator 仲裁的点。
```
