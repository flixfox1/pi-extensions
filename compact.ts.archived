/**
 * Compact Extension (v2)
 *
 * 功能：
 *   1. 基于百分比的自动触发 — 在 agent_end 时检查，不中断多轮工具调用
 *   2. 用 glm-5.1 生成中文结构化摘要（替代 pi 默认摘要）
 *   3. 支持用户通过内置 /compact 命令手动触发
 *
 * 设计：
 *   触发阈值 COMPACT_THRESHOLD_PERCENT 是相对于模型 contextWindow 的百分比。
 *   不同模型 provider 有不同的 contextWindow（200K / 1M / ...），
 *   百分比阈值自动适配，无需为每个模型维护硬编码数字。
 *
 * 前提：
 *   需要在 ~/.pi/agent/settings.json 中禁用内置 auto-compaction，
 *   避免内置机制与本扩展双重触发：
 *   { "compaction": { "enabled": false } }
 *
 * 参考：
 *   - docs/compaction.md
 *   - examples/extensions/custom-compaction.ts（官方自定义摘要示例）
 *   - examples/extensions/trigger-compact.ts（官方自定义触发示例）
 */

import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";

/** 上下文使用百分比达到此值时触发 compaction */
const COMPACT_THRESHOLD_PERCENT = 85;

export default function (pi: ExtensionAPI) {
	// ─── 百分比触发 ──────────────────────────────────────────
	//
	// 在 agent_end（所有 turn 完成、agent 循环结束后）检查上下文使用百分比。
	//
	// 为什么用 agent_end 而不是 turn_end：
	//   turn_end 在每轮 LLM+工具调用后触发，中途触发会 abort 正在进行的
	//   多轮工具调用序列，丢失当前任务进度。
	//   agent_end 在整个 agent 循环完成后才触发，不会打断任何进行中的工作。
	//
	// 时序：
	//   _processAgentEvent(agent_end) {
	//     1. await _emitExtensionEvent(event)  ← 扩展的 handler 在这里运行
	//     2. _checkCompaction(msg)              ← 内置机制在这里运行
	//   }
	//   因为 settings 中 compaction.enabled=false，内置 _checkCompaction 会直接 return，
	//   所以不会有双重触发。

	pi.on("agent_end", async (_event, ctx) => {
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null || usage.percent === null) return;

		if (usage.percent >= COMPACT_THRESHOLD_PERCENT) {
			ctx.ui.notify(
				`上下文 ${usage.percent.toFixed(0)}% ≥ ${COMPACT_THRESHOLD_PERCENT}%，触发 compaction`,
				"info",
			);
			ctx.compact({
				customInstructions: undefined,
				onComplete: () => {
					const after = ctx.getContextUsage();
					ctx.ui.notify(
						`Compact 完成 (${usage.percent.toFixed(0)}% → ${after?.percent?.toFixed(0) ?? "?"}%)`,
						"success",
					);
				},
				onError: (error) => ctx.ui.notify(`Compact 失败: ${error.message}`, "error"),
			});
		}
	});

	// ─── 自定义摘要：用 glm-5.1 替代默认行为 ─────────────────
	//
	// 在 session_before_compact 钩子中拦截：
	//   - 自动触发（agent_end 中的 ctx.compact()）会经过这里
	//   - 手动触发（用户执行内置 /compact 命令）也会经过这里
	//   - 内置 overflow recovery 也会经过这里
	//
	// 如果 glm-5.1 不可用或摘要生成失败，不返回结果 → pi 降级使用默认摘要逻辑。

	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, customInstructions, signal } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;

		// 选择摘要模型
		const model = ctx.modelRegistry.find("zai", "glm-5.1");
		if (!model) {
			ctx.ui.notify("Compact: 找不到 glm-5.1，降级使用默认 compaction", "warning");
			return; // 不返回 → pi 使用默认摘要
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			ctx.ui.notify("Compact: glm-5.1 认证失败，降级使用默认 compaction", "warning");
			return;
		}

		// 合并所有需要摘要的消息
		const allMessages = [...messagesToSummarize, ...turnPrefixMessages];

		ctx.ui.notify(
			`Compact: 用 ${model.id} 压缩 ${allMessages.length} 条消息 (${tokensBefore.toLocaleString()} tokens)...`,
			"info",
		);

		// 序列化对话为文本
		const conversationText = serializeConversation(convertToLlm(allMessages));
		const previousContext = previousSummary
			? `\n\n<previous_summary>\n${previousSummary}\n</previous_summary>`
			: "";
		const focusInstructions = customInstructions ? `\n\n用户特别关注：${customInstructions}` : "";

		const summaryMessages = [
			{
				role: "user" as const,
				content: [
					{
						type: "text" as const,
						text: `你是一个对话摘要专家。请为以下对话生成一份完整的结构化摘要。

要求：
1. 捕获所有目标、决策及其理由
2. 记录重要的代码变更、文件修改、技术细节
3. 描述当前进行中工作的状态
4. 列出所有阻塞项、已知问题和开放问题
5. 记录已计划或建议的下一步
6. 保留关键的上下文信息（变量名、文件路径、配置值等）

摘要将完全替换原始对话历史，所以必须包含继续工作所需的全部信息。
使用结构化 Markdown 格式，带清晰的章节标题。${previousContext}${focusInstructions}

<conversation>
${conversationText}
</conversation>`,
					},
				],
				timestamp: Date.now(),
			},
		];

		try {
			// 传递 signal 以支持用户取消
			const response = await complete(
				model,
				{ messages: summaryMessages },
				{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: 8192, signal },
			);

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			if (!summary.trim()) {
				if (!signal?.aborted) ctx.ui.notify("Compact: 摘要为空，降级使用默认 compaction", "warning");
				return; // 降级到默认
			}

			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Compact 失败: ${message}，降级使用默认 compaction`, "error");
			return; // 降级到默认
		}
	});
}
