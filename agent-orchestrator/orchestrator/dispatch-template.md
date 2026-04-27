# Orchestrator Dispatch Template

每个下游任务使用以下格式：

```markdown
# Dispatch: <agent-or-role>

run_id: <RUN_ID>
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
5. 写入 DONE 报告到指定 Report File

## Acceptance
- <可验证结果 1>
- <可验证结果 2>

## Report File
`.Agent_ChatRoom/Orchestrator agent memory/RUN-<RUN_ID>/reports/<agent-or-role>.DONE.md`

DONE 最低 schema：

```markdown
# DONE <agent-or-role>

- run_id: <RUN_ID>
- agent_id: <agent-or-role>
- status: done | blocked | failed
- summary: <完成摘要>
- changed_files: <改动文件或 none>
- tests: <运行结果或未运行原因>
- findings: <关键发现>
- next_action: <建议下一步>
- completed_at: <ISO timestamp>
```
```
