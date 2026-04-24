# Compaction Tailor — 架构设计

## 问题

当 agent runtime scale 起来后（多个 subagent 并行跑长任务），每个 agent 独立管理
自己的上下文。compaction 发生时，只有该 agent 自己的 extension 能感知到，没有
集中式的监控和恢复机制。

## 为什么"扩展装在全局"不够？

全局扩展 (`~/.pi/agent/extensions/`) 确实会被每个 subagent 子进程加载。
`compact.ts` 会在每个子进程里独立运行。

但问题是：
1. 每个 agent 独立 compact → 独立生成摘要 → 独立停下来
2. 没有协调者来决定"这个 agent compact 后应该怎么继续"
3. 主 session 不知道子 agent 发生了什么
4. 不同 agent 需要不同的 continuation 策略（scout vs worker vs planner）
