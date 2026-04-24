/**
 * Compaction Tailor Extension
 *
 * 在 agent 系统中解决 compaction 后任务中断的问题。
 *
 * 架构：
 *   1. 与 agent-switcher 共享 agent discovery（读取 ~/.pi/agent/agents/*.md）
 *   2. 每个 agent 定义文件可声明 on-compact 策略
 *   3. 检测当前 session 的 active agent（从 custom entry 读取）
 *   4. compaction 后根据策略自动生成 continuation prompt
 *
 * Agent 定义文件格式（在 frontmatter 中新增字段）：
 *
 *   ---
 *   name: worker
 *   description: General-purpose agent
 *   tools: read, bash, edit, write, grep, find, ls
 *   model: glm-5.1
 *   on-compact: continue          # continue | stop | summarize
 *   compact-focus: preserve current task progress and next steps
 *   summarize-target: ~/.pi/agent/summaries/worker/      # 目录: 自动生成时间戳 .md
 *   # summarize-target: ./logs/worker-summary.md         # 文件: 追加写入
 *   # 未配置 summarize-target 时，默认归档到 <project-root>/.summarize/<agent-name>/
 *   ---
 *
 * 策略说明：
 *   - continue:  自动生成 continuation prompt 并注入，agent 无缝继续
 *   - stop:      compact 后不自动继续，等待外部指令
 *   - summarize: 将摘要写入指定目标文件/文件夹；若未配置则写入默认归档目录；不继续
 *
 * 与现有系统的集成点：
 *   - 复用 agent-switcher 的 STATE_ENTRY 机制读取当前 active agent
 *   - 复用 compact.ts 的触发逻辑和自定义摘要
 *   - 复用 subagent/agents.ts 的 agent discovery
 *
 * 安装：
 *   # 替换现有的 compact.ts（或并存）
 *   ln -sf /path/to/compaction-tailor.ts ~/.pi/agent/extensions/compact-tailor.ts
 *
 *   # 确保 settings.json 中 compaction.enabled = false
 *
 * 用法：
 *   /compact-tailor status      — 查看当前配置
 *   /compact-tailor test        — 模拟一次 compaction（不实际执行）
 */

import { complete } from "@mariozechner/pi-ai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { convertToLlm, getAgentDir, parseFrontmatter, serializeConversation } from "@mariozechner/pi-coding-agent";

// ──────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────

type CompactStrategy = "continue" | "stop" | "summarize";

interface AgentCompactConfig {
	name: string;
	strategy: CompactStrategy;
	focus?: string; // 传给 tailor 的重点指令
	model?: string; // 指定 tailor 用的模型
	summarizeTarget?: string; // summarize 模式下写入的目标文件/目录
}

interface SummaryTemplateContext {
	summary: string;
	agentName: string;
	generatedAt: string;
	tokensBefore: string;
	firstKeptEntryId: string;
}

interface AgentFile {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	onCompact?: CompactStrategy;
	compactFocus?: string;
	summarizeTarget?: string;
	systemPrompt: string;
	filePath: string;
}

// ──────────────────────────────────────────────────────────────────
// Agent Discovery（复用 subagent/agent-switcher 的逻辑）
// ──────────────────────────────────────────────────────────────────

function loadAgentFiles(dir: string): AgentFile[] {
	if (!fs.existsSync(dir)) return [];

	const agents: AgentFile[] = [];
	const entries = fs.readdirSync(dir, { withFileTypes: true });

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		const name = frontmatter.name ?? path.basename(entry.name, ".md");

		agents.push({
			name,
			description: frontmatter.description ?? "",
			tools: frontmatter.tools?.split(",").map((t: string) => t.trim()).filter(Boolean),
			model: frontmatter.model,
			onCompact: (frontmatter["on-compact"] as CompactStrategy) || undefined,
			compactFocus: frontmatter["compact-focus"] || undefined,
			summarizeTarget:
				frontmatter["summarize-target"] || frontmatter["summary-target"] || undefined,
			systemPrompt: body.trim(),
			filePath,
		});
	}

	return agents;
}

function discoverAgentConfigs(): Map<string, AgentFile> {
	const userDir = path.join(getAgentDir(), "agents");
	const agents = loadAgentFiles(userDir);
	const map = new Map<string, AgentFile>();
	for (const agent of agents) map.set(agent.name, agent);
	return map;
}

function getAgentCompactConfig(agentName: string): AgentCompactConfig | null {
	const agents = discoverAgentConfigs();
	const agent = agents.get(agentName);
	if (!agent) return null;

	return {
		name: agent.name,
		strategy: agent.onCompact ?? "stop", // 默认 stop（安全）
		focus: agent.compactFocus,
		model: agent.model,
		summarizeTarget: agent.summarizeTarget,
	};
}

function normalizeSummaryTarget(input: string): string {
	const trimmed = input.trim();
	if (trimmed === "~") return os.homedir();
	if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
	return trimmed;
}

function resolveSummaryTarget(target: string, cwd: string): string {
	const normalized = normalizeSummaryTarget(target);
	return path.isAbsolute(normalized) ? normalized : path.resolve(cwd, normalized);
}

function isDirectoryTarget(rawTarget: string, resolvedTarget: string): boolean {
	if (/[\\/]$/.test(rawTarget)) return true;

	if (fs.existsSync(resolvedTarget)) {
		try {
			return fs.statSync(resolvedTarget).isDirectory();
		} catch {
			// ignore and fall through
		}
	}

	return path.extname(resolvedTarget) === "";
}

function sanitizeFileNameSegment(input: string): string {
	const cleaned = input
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned || "summary";
}

function findSummaryBaseDir(cwd: string): string {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi");
		if (fs.existsSync(candidate)) {
			try {
				if (fs.statSync(candidate).isDirectory()) return currentDir;
			} catch {
				// ignore and continue upward
			}
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return cwd;
		currentDir = parentDir;
	}
}

function getDefaultSummarizeTarget(agentName: string | null, cwd: string): string {
	const baseDir = findSummaryBaseDir(cwd);
	return path.join(baseDir, ".summarize", sanitizeFileNameSegment(agentName ?? "default"));
}

const DEFAULT_SUMMARY_TEMPLATE = `# Compaction Summary Export

## Metadata
- Generated: {{generatedAt}}
- Agent: {{agentName}}
- Tokens Before: {{tokensBefore}}
- First Kept Entry ID: {{firstKeptEntryId}}

## Summary

{{summary}}
`;

function getSummaryTemplatePath(): string {
	return path.join(getAgentDir(), "extensions", "compact-tailor", "summarize-template.md");
}

async function loadSummaryTemplate(): Promise<string> {
	const templatePath = getSummaryTemplatePath();
	try {
		const content = await fs.promises.readFile(templatePath, "utf-8");
		return content.trim() ? content : DEFAULT_SUMMARY_TEMPLATE;
	} catch {
		return DEFAULT_SUMMARY_TEMPLATE;
	}
}

function renderSummaryTemplate(template: string, context: SummaryTemplateContext): string {
	return template
		.replaceAll("{{summary}}", context.summary)
		.replaceAll("{{agentName}}", context.agentName)
		.replaceAll("{{generatedAt}}", context.generatedAt)
		.replaceAll("{{tokensBefore}}", context.tokensBefore)
		.replaceAll("{{firstKeptEntryId}}", context.firstKeptEntryId);
}

async function buildSummaryDocument(
	summary: string,
	meta: {
		agentName: string | null;
		timestamp: number;
		tokensBefore: number;
		firstKeptEntryId: string;
	},
): Promise<string> {
	const template = await loadSummaryTemplate();
	const generatedAt = new Date(meta.timestamp).toISOString();
	return renderSummaryTemplate(template, {
		summary: summary.trim(),
		agentName: meta.agentName ?? "default",
		generatedAt,
		tokensBefore: meta.tokensBefore.toLocaleString(),
		firstKeptEntryId: meta.firstKeptEntryId,
	});
}

async function writeSummaryToTarget(
	summary: string,
	target: string | undefined,
	meta: {
		agentName: string | null;
		timestamp: number;
		tokensBefore: number;
		firstKeptEntryId: string;
	},
	ctx: ExtensionContext,
): Promise<string> {
	const effectiveTarget = target || getDefaultSummarizeTarget(meta.agentName, ctx.cwd);
	const resolvedTarget = resolveSummaryTarget(effectiveTarget, ctx.cwd);
	const document = await buildSummaryDocument(summary, meta);

	if (isDirectoryTarget(effectiveTarget, resolvedTarget)) {
		await fs.promises.mkdir(resolvedTarget, { recursive: true });
		const stamp = new Date(meta.timestamp).toISOString().replace(/[:.]/g, "-");
		const fileName = `${stamp}_${sanitizeFileNameSegment(meta.agentName ?? "default")}_compaction.md`;
		const finalPath = path.join(resolvedTarget, fileName);
		await fs.promises.writeFile(finalPath, document, "utf-8");
		return finalPath;
	}

	await fs.promises.mkdir(path.dirname(resolvedTarget), { recursive: true });
	let prefix = "";
	if (fs.existsSync(resolvedTarget)) {
		try {
			if (fs.statSync(resolvedTarget).size > 0) prefix = "\n\n---\n\n";
		} catch {
			// ignore and append without separator
		}
	}
	await fs.promises.appendFile(resolvedTarget, `${prefix}${document}`, "utf-8");
	return resolvedTarget;
}

// ──────────────────────────────────────────────────────────────────
// 检测当前 active agent（兼容 agent-switcher 的持久化格式）
// ──────────────────────────────────────────────────────────────────

const AGENT_SWITCHER_ENTRY = "agent-switcher-state";

interface AgentSwitcherState {
	activeAgent: string | null;
}

function detectActiveAgent(ctx: ExtensionContext): string | null {
	const entries = ctx.sessionManager.getEntries();
	// agent-switcher 用 appendEntry 持久化，取最后一个
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as any;
		if (entry?.type === "custom" && entry?.customType === AGENT_SWITCHER_ENTRY) {
			const data = entry.data as AgentSwitcherState | undefined;
			if (data?.activeAgent) return data.activeAgent;
		}
	}
	return null;
}

// ──────────────────────────────────────────────────────────────────
// Tailor: 生成 continuation prompt
// ──────────────────────────────────────────────────────────────────

const TAILOR_SYSTEM_PROMPT = `你是一个任务续接助手。一个 coding agent 刚完成了上下文压缩（compaction），
需要你生成一个精准的续接指令让它无缝继续工作。

输入：
- compaction 摘要（包含 Goal、Progress、Next Steps、Key Decisions 等）
- agent 的角色和关注点（可选）

输出要求：
1. 直接输出续接指令，不加任何前言
2. 引用摘要中提到的具体文件和状态
3. 明确指出下一步要做什么
4. 简洁但完整，让 agent 能直接继续
5. 如果摘要表明任务已完成且无明确下一步，输出 "TASK_COMPLETE"`;

async function generateContinuationPrompt(
	summary: string,
	agentConfig: AgentCompactConfig | null,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<string> {
	// 选择 tailor 模型：优先用 agent 定义的模型，其次用快速模型
	const candidates = [
		agentConfig?.model
			? ctx.modelRegistry.find(
					agentConfig.model.includes("/") ? agentConfig.model.split("/")[0] : ctx.model?.provider ?? "zai",
					agentConfig.model.includes("/") ? agentConfig.model.split("/").slice(1).join("/") : agentConfig.model,
				)
			: null,
		ctx.modelRegistry.find("zai", "glm-4.5-air"),     // 快速便宜
		ctx.modelRegistry.find("google", "gemini-2.5-flash"),
		ctx.modelRegistry.find("anthropic", "claude-haiku-4-5"),
		ctx.model, // fallback
	].filter(Boolean);

	for (const model of candidates) {
		if (!model) continue;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) continue;

		const focusHint = agentConfig?.focus
			? `\n\n## Agent Focus\n${agentConfig.name} 的关注点：${agentConfig.focus}`
			: "";
		const agentRole = agentConfig
			? `\n\n## Agent Role\n当前 agent 是 "${agentConfig.name}"，策略是 "${agentConfig.strategy}"。`
			: "";

		const res = await complete(
			model,
			{
				systemPrompt: TAILOR_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: `## Compaction Summary\n\n${summary}${agentRole}${focusHint}\n\n生成续接指令。`,
							},
						],
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: 2048, signal },
		);

		return res.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();
	}

	throw new Error("No available model for tailoring");
}

// ──────────────────────────────────────────────────────────────────
// Main Extension
// ──────────────────────────────────────────────────────────────────

const COMPACT_THRESHOLD_PERCENT = 85;

export default function (pi: ExtensionAPI) {
	let busy = false;

	function notify(ctx: ExtensionContext, msg: string, level: "info" | "success" | "warning" | "error") {
		if (ctx.hasUI) ctx.ui.notify(msg, level);
		else console.log(`[compact-tailor:${level}] ${msg}`);
	}

	// ─── 1. 触发 compaction（复用 compact.ts 的逻辑）──────────────
	//
	// 为什么用 agent_end：不在 turn 中途打断多轮工具调用

	pi.on("agent_end", async (_event, ctx) => {
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null || usage.percent === null) return;

		if (usage.percent >= COMPACT_THRESHOLD_PERCENT) {
			notify(ctx, `上下文 ${usage.percent.toFixed(0)}% ≥ ${COMPACT_THRESHOLD_PERCENT}%，触发 compaction`, "info");
			ctx.compact({
				onComplete: () => {
					const after = ctx.getContextUsage();
					notify(ctx, `Compact 完成 (${usage.percent.toFixed(0)}% → ${after?.percent?.toFixed(0) ?? "?"}%)`, "success");
				},
				onError: (error) => notify(ctx, `Compact 失败: ${error.message}`, "error"),
			});
		}
	});

	// ─── 2. 自定义摘要（复用 compact.ts 的 glm-5.1 摘要逻辑）─────────

	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, customInstructions, signal } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;

		const model = ctx.modelRegistry.find("zai", "glm-5.1");
		if (!model) {
			notify(ctx, "找不到 glm-5.1，降级使用默认 compaction", "warning");
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			notify(ctx, "glm-5.1 认证失败，降级使用默认 compaction", "warning");
			return;
		}

		const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
		notify(ctx, `用 ${model.id} 压缩 ${allMessages.length} 条消息 (${tokensBefore.toLocaleString()} tokens)...`, "info");

		const conversationText = serializeConversation(convertToLlm(allMessages));
		const previousContext = previousSummary ? `\n\n<previous_summary>\n${previousSummary}\n</previous_summary>` : "";
		const focusInstructions = customInstructions ? `\n\n用户特别关注：${customInstructions}` : "";

		try {
			const response = await complete(
				model,
				{
					messages: [
						{
							role: "user",
							content: [
								{
									type: "text",
									text: `你是一个对话摘要专家。请为以下对话生成一份完整的结构化摘要。

要求：
1. 捕获所有目标、决策及其理由
2. 记录重要的代码变更、文件修改、技术细节
3. 描述当前进行中工作的状态（这非常关键！）
4. 列出所有阻塞项、已知问题和开放问题
5. 记录已计划或建议的下一步（这非常关键！）
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
					],
				},
				{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: 8192, signal },
			);

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			if (!summary.trim()) {
				if (!signal?.aborted) notify(ctx, "摘要为空，降级使用默认 compaction", "warning");
				return;
			}

			return {
				compaction: { summary, firstKeptEntryId, tokensBefore },
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notify(ctx, `Compact 失败: ${message}，降级使用默认 compaction`, "error");
			return;
		}
	});

	// ─── 3. Compaction 后的 tailor 续接 ──────────────────────────
	//
	// 关键时序：
	//   session_compact 在 compaction entry 写入后、hasQueuedMessages() 检查前触发
	//   我们的 handler 是异步的，主 session 会在我们完成前就 idle
	//   所以 sendUserMessage() 调用时 agent 已 idle → 直接触发新 turn

	pi.on("session_compact", async (event, ctx) => {
		if (busy) return;
		busy = true;

		try {
			// 检测当前 active agent
			const activeAgentName = detectActiveAgent(ctx);
			const agentConfig = activeAgentName ? getAgentCompactConfig(activeAgentName) : null;

			// 确定策略
			const strategy = agentConfig?.strategy ?? "stop"; // 无 agent 时默认 stop（安全）

			notify(
				ctx,
				`[tailor] Compaction 完成. agent=${activeAgentName ?? "default"}, strategy=${strategy}`,
				"info",
			);

			if (strategy === "stop") {
				notify(ctx, "[tailor] 策略为 stop，等待外部指令", "info");
				return;
			}

			if (strategy === "summarize") {
				const summary = event.compactionEntry.summary;
				const target = agentConfig?.summarizeTarget;
				const outputPath = await writeSummaryToTarget(
					summary,
					target,
					{
						agentName: activeAgentName,
						timestamp: event.compactionEntry.timestamp,
						tokensBefore: event.compactionEntry.tokensBefore,
						firstKeptEntryId: event.compactionEntry.firstKeptEntryId,
					},
					ctx,
				);
				const targetLabel = target || getDefaultSummarizeTarget(activeAgentName, ctx.cwd);
				notify(ctx, `[tailor] 策略为 summarize，摘要已写入 ${outputPath} (target: ${targetLabel})`, "info");
				return;
			}

			// strategy === "continue" → 生成续接 prompt 并注入

			const continuationPrompt = await generateContinuationPrompt(
				event.compactionEntry.summary,
				agentConfig,
				ctx,
				ctx.signal,
			);

			if (!continuationPrompt || continuationPrompt === "TASK_COMPLETE") {
				notify(ctx, "[tailor] 任务已完成，不需要续接", "info");
				return;
			}

			notify(ctx, `[tailor] ✅ 注入续接指令: ${continuationPrompt.slice(0, 80)}...`, "info");
			pi.sendUserMessage(continuationPrompt);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			notify(ctx, `[tailor] ❌ 续接失败: ${msg}`, "error");
		} finally {
			busy = false;
		}
	});

	// ─── 4. 命令：查看状态 ───────────────────────────────────────

	pi.registerCommand("compact-tailor", {
		description: "查看 compaction tailor 配置和 agent 策略",
		handler: async (args, ctx) => {
			const sub = args.trim();

			if (sub === "status") {
				const activeAgentName = detectActiveAgent(ctx);
				const agentConfig = activeAgentName ? getAgentCompactConfig(activeAgentName) : null;
				const allAgents = discoverAgentConfigs();

				const lines = [
					"📋 Compaction Tailor 状态",
					`当前 agent: ${activeAgentName ?? "default (无 agent-switcher)"}`,
					`当前策略: ${agentConfig?.strategy ?? "stop"}`,
					`关注点: ${agentConfig?.focus ?? "(无)"}`,
					`摘要目标: ${agentConfig?.summarizeTarget ?? `(默认) ${getDefaultSummarizeTarget(activeAgentName, ctx.cwd)}`}`,
					`Tailor 模型: ${agentConfig?.model ?? "自动选择快速模型"}`,
					`触发阈值: ${COMPACT_THRESHOLD_PERCENT}%`,
					"",
					"已注册 agent 的 compaction 策略:",
				];

				for (const [name, agent] of allAgents) {
					const strategy = agent.onCompact ?? "stop (默认)";
					const focus = agent.compactFocus ? ` → ${agent.compactFocus}` : "";
					const target = ` [target: ${agent.summarizeTarget ?? getDefaultSummarizeTarget(name, ctx.cwd)}]`;
					const marker = name === activeAgentName ? " ◀ active" : "";
					lines.push(`  ${name}: ${strategy}${focus}${target}${marker}`);
				}

				if (allAgents.size === 0) {
					lines.push("  (无)");
				}

				notify(ctx, lines.join("\n"), "info");
				return;
			}

			if (sub === "agents") {
				const allAgents = discoverAgentConfigs();
				const lines = ["📋 已发现的 Agent 定义:"];

				for (const [name, agent] of allAgents) {
					lines.push(`  ${name} (${path.basename(agent.filePath)})`);
					lines.push(`    on-compact: ${agent.onCompact ?? "(未设置 → stop)"}`);
					lines.push(`    compact-focus: ${agent.compactFocus ?? "(未设置)"}`);
					lines.push(`    summarize-target: ${agent.summarizeTarget ?? `(默认) ${getDefaultSummarizeTarget(name, ctx.cwd)}`}`);
				}

				if (allAgents.size === 0) {
					lines.push("  ~/.pi/agent/agents/ 下没有 agent 定义文件");
				}

				notify(ctx, lines.join("\n"), "info");
				return;
			}

			// Default: show help
			notify(
				ctx,
				`用法:
  /compact-tailor status  — 查看当前配置和 agent 策略
  /compact-tailor agents  — 列出所有 agent 的 compaction 配置

frontmatter 示例:
  on-compact: summarize
  summarize-target: ~/.pi/agent/summaries/reviewer/
  # 或 summarize-target: ./logs/reviewer-summary.md
  # 未配置时默认: <project-root>/.summarize/<agent-name>/

导出模板文件:
  ${getSummaryTemplatePath()}`,
				"info",
			);
		},
	});

	// ─── 5. Widget ───────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		const activeAgentName = detectActiveAgent(ctx);
		const agentConfig = activeAgentName ? getAgentCompactConfig(activeAgentName) : null;

		if (agentConfig && agentConfig.strategy !== "stop") {
			ctx.ui.setWidget("compact-tailor", [
				`🔄 compact-tailor: ${activeAgentName} → ${agentConfig.strategy}`,
			]);
		}
	});
}
