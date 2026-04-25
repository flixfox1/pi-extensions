/**
 * Compaction v3 — 系统级上下文压缩管理器
 *
 * /compact-panel    → 主菜单（居中 overlay，显示 status + 6 个子选项）
 *   start           → 立即触发一次 compaction（带续接）
 *   dynamic         → 开关 dynamic instruction
 *   static          → 编辑 static instruction
 *   archive         → 归档设置
 *   model           → 摘要模型选择
 *   max-tokens      → 摘要 token 预算
 *
 * /compact          → Pi 内置原生压缩（不拦截，无续接）
 *
 * 后台 hook 自动运行：agent_end → 阈值检查 → compact → 摘要 + 续接
 * 扩展只拦截自己发起的 compact，用户的 /compact 走 Pi 原生逻辑。
 *
 * UI 规范：
 *   - 所有面板用 ctx.ui.custom() + 手写 render(width)
 *   - ┌─┐│└─┘├─┤ 画完整矩形，每行恰好 width 列
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, matchesKey, Key } from "@mariozechner/pi-tui";
import {
	loadConfig, getExtDir, resolveModelSpec,
	saveTopLevelString, saveNestedBool, saveStaticContent,
} from "./config";
import { generateCompaction } from "./compactor";
import type { ParsedOutput } from "./compactor";
import { writeArchive } from "./archive";

// ──────────────────────────────────────────────────────────────────
// Box border helpers — 所有 overlay 面板共用
// ──────────────────────────────────────────────────────────────────

function borderTop(w: number, theme: any): string {
	return theme.fg("border", `┌${"─".repeat(w - 2)}┐`);
}
function borderBottom(w: number, theme: any): string {
	return theme.fg("border", `└${"─".repeat(w - 2)}┘`);
}
function borderMid(w: number, theme: any): string {
	return theme.fg("border", `├${"─".repeat(w - 2)}┤`);
}
function borderLine(text: string, w: number, theme: any): string {
	const bdr = theme.fg("border", "│");
	const maxC = w - 4;  // │ + 1sp + content + 1sp + │
	return bdr + " " + truncateToWidth(text + " ".repeat(maxC), maxC) + " " + bdr;
}

/** Strip ANSI escape codes to get visible length */
function visibleLen(text: string): number {
	return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** 对长文本做预截断 + …，防止溢出后突然截断 */
function ellipsis(text: string, maxVisible: number): string {
	const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
	if (plain.length <= maxVisible) return text;
	// 截断纯文本部分，保留 …
	return text.replace(/\x1b\[[0-9;]*m/g, "").slice(0, maxVisible - 1) + "…";
}

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

const AGENT_SWITCHER_ENTRY = "agent-switcher-state";

function detectActiveAgent(ctx: ExtensionContext): string | null {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as any;
		if (entry?.type === "custom" && entry?.customType === AGENT_SWITCHER_ENTRY) {
			const data = entry.data as { activeAgent?: string } | undefined;
			if (data?.activeAgent) return data.activeAgent;
		}
	}
	return null;
}

function resolveStaticContent(cfg: { enabled: boolean; content: string; file?: string }, cwd: string): string | null {
	if (!cfg.enabled) return null;
	if (cfg.file) {
		const p = path.isAbsolute(cfg.file) ? cfg.file : path.resolve(cwd, cfg.file);
		try { return fs.readFileSync(p, "utf-8").trim() || null; } catch { return null; }
	}
	return cfg.content?.trim() || null;
}

function notify(ctx: any, msg: string, level: "info" | "success" | "warning" | "error") {
	if (ctx.hasUI) ctx.ui.notify(msg, level);
	else console.log(`[compact:${level}] ${msg}`);
}

/**
 * 候选模型列表
 * 1) 优先读 settings.json enabledModels（用户在 /scoped-models 里精心选的 Ctrl+P 列表）
 * 2) 确保当前 summarize-model 始终在列表中
 * 3) enabledModels 为空时降级到 modelRegistry.getAvailable()
 */
function getModelCandidates(currentModel: string, ctx: any): string[] {
	let candidates: string[] = [];

	// 主数据源：settings.json enabledModels
	try {
		const settingsPath = path.join(getExtDir(), "..", "..", "settings.json");
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		if (Array.isArray(settings.enabledModels) && settings.enabledModels.length > 0) {
			candidates = [...settings.enabledModels];
		}
	} catch { /* */ }

	// 兜底：enabledModels 为空，用 registry 里所有已配置 auth 的模型
	if (candidates.length === 0) {
		try {
			const models = ctx.modelRegistry.getAvailable() as Array<{ provider: string; id: string }>;
			candidates = models.map((m) => `${m.provider}/${m.id}`);
		} catch { /* */ }
	}

	// 确保当前模型始终在列表中
	if (currentModel && !candidates.includes(currentModel)) {
		candidates.unshift(currentModel);
	}

	return candidates;
}

// ──────────────────────────────────────────────────────────────────
// 三路指令注入
// ──────────────────────────────────────────────────────────────────

function injectContinuation(output: ParsedOutput, pi: ExtensionAPI, ctx: any, config: ReturnType<typeof loadConfig>) {
	const staticContent = resolveStaticContent(config.staticInstruction, ctx.cwd);

	if (staticContent) {
		notify(ctx, `📝 注入 static instruction`, "info");
		pi.sendUserMessage(staticContent);
		return;
	}

	if (config.dynamicInstruction.enabled && output.continuation) {
		if (output.continuation === "TASK_COMPLETE") {
			notify(ctx, `✅ 任务已完成`, "info");
			return;
		}
		notify(ctx, `🔗 注入 dynamic instruction: ${output.continuation.slice(0, 80)}...`, "info");
		pi.sendUserMessage(output.continuation);
		return;
	}

	notify(ctx, `⏸ Compaction 完成，等待指令`, "info");
}

// ──────────────────────────────────────────────────────────────────
// 共用 overlay 选项
// ──────────────────────────────────────────────────────────────────

const OVERLAY = {
	overlay: true,
	overlayOptions: {
		width: "50%", minWidth: 48, maxHeight: "65%", anchor: "center",
	},
} as const;

// ──────────────────────────────────────────────────────────────────
// TUI: 主菜单（循环，子面板 Esc 回退到此处）
// ──────────────────────────────────────────────────────────────────

const MENU_ITEMS = [
	{ id: "start", label: "Start", desc: "立即触发一次 compaction" },
	{ id: "dynamic", label: "Dynamic Instruction", desc: "LLM 从上下文推断续接指令" },
	{ id: "static", label: "Static Instruction", desc: "用户手写的固定续接指令" },
	{ id: "archive", label: "Archive", desc: "摘要归档设置" },
	{ id: "model", label: "Model", desc: "摘要模型选择" },
	{ id: "maxtokens", label: "Max Tokens", desc: "摘要生成的 token 预算" },
] as const;

type MenuId = typeof MENU_ITEMS[number]["id"];

async function showMainMenu(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		notify(ctx, "交互菜单仅支持 TUI 模式，使用 /compact-panel start|dynamic|static|archive|model|maxtokens", "info");
		return;
	}

	let active = true;
	while (active) {
		const config = loadConfig();
		const activeAgent = detectActiveAgent(ctx);
		let selected = 0;

		const result = await ctx.ui.custom<MenuId | null>((tui, theme, _kb, done) => {
			return {
				render(W: number) {
					const lines: string[] = [];

					lines.push(borderTop(W, theme));
					lines.push(borderLine(theme.fg("accent", theme.bold("Compaction")), W, theme));
					lines.push(borderMid(W, theme));

					// Status 区
					const maxC = W - 4;
					const maxValW = maxC - 14;
					const statusItems = [
						{ label: "Model", value: config.summarizeModel, color: "text" as const },
						{ label: "Threshold", value: `${config.threshold}%`, color: "text" as const },
						{ label: "Max Tokens", value: `${config.maxTokens.toLocaleString()}`, color: "text" as const },
						{ label: "Agent", value: activeAgent ?? "default", color: "dim" as const },
						{ label: "Dynamic", value: config.dynamicInstruction.enabled ? "✓" : "✗", color: config.dynamicInstruction.enabled ? "success" as const : "dim" as const },
						{ label: "Static", value: config.staticInstruction.enabled ? "✓" : "✗", color: config.staticInstruction.enabled ? "success" as const : "dim" as const },
						{ label: "Archive", value: config.archive.enabled ? "✓" : "✗", color: config.archive.enabled ? "success" as const : "dim" as const },
					];
					for (const item of statusItems) {
						const padded = theme.fg("muted", `${item.label}`.padEnd(12));
						const displayVal = visibleLen(item.value) > maxValW ? ellipsis(item.value, maxValW) : item.value;
						lines.push(borderLine(`${padded} ${theme.fg(item.color, displayVal)}`, W, theme));
					}

					lines.push(borderMid(W, theme));

					// 菜单项
					for (let i = 0; i < MENU_ITEMS.length; i++) {
						const item = MENU_ITEMS[i];
						if (i === selected) {
							lines.push(borderLine(theme.fg("accent", `▸ ${theme.bold(item.label)}`), W, theme));
							lines.push(borderLine(theme.fg("muted", `  ${item.desc}`), W, theme));
						} else {
							lines.push(borderLine(theme.fg("text", `  ${item.label}`), W, theme));
						}
					}

					lines.push(borderMid(W, theme));
					lines.push(borderLine(theme.fg("dim", "↑↓ 选择  Enter 确认  Esc 关闭"), W, theme));
					lines.push(borderBottom(W, theme));
					return lines;
				},
				invalidate() {},
				handleInput(data: string) {
					if (matchesKey(data, Key.up)) { selected = (selected - 1 + MENU_ITEMS.length) % MENU_ITEMS.length; tui.requestRender(); }
					else if (matchesKey(data, Key.down)) { selected = (selected + 1) % MENU_ITEMS.length; tui.requestRender(); }
					else if (matchesKey(data, Key.enter)) { done(MENU_ITEMS[selected].id); }
					else if (matchesKey(data, Key.escape)) { done(null); }
				},
			};
		}, OVERLAY);

		if (!result) { active = false; continue; }

		if (result === "start") { await handleStart(pi, ctx); active = false; }
		else if (result === "dynamic") await handleDynamic(ctx);
		else if (result === "static") await handleStatic(ctx);
		else if (result === "archive") await handleArchive(ctx);
		else if (result === "model") await handleModel(ctx);
		else if (result === "maxtokens") await handleMaxTokens(ctx);
	}
}

// ──────────────────────────────────────────────────────────────────
// 子功能: Start（标记为扩展发起，带续接）
// ──────────────────────────────────────────────────────────────────

async function handleStart(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const usage = ctx.getContextUsage();
	if (!usage || usage.percent === null) {
		notify(ctx, "无法读取上下文状态", "warning");
		return;
	}
	notify(ctx, `🔄 手动触发 compaction (当前 ${usage.percent.toFixed(0)}%)`, "info");
	setExtensionFlag(true);
	ctx.compact({
		onComplete: () => {
			const after = ctx.getContextUsage();
			notify(ctx, `✅ Compact 完成 (${usage.percent.toFixed(0)}% → ${after?.percent?.toFixed(0) ?? "?"}%)`, "success");
		},
		onError: (error) => {
			setExtensionFlag(false);
			notify(ctx, `❌ Compact 失败: ${error.message}`, "error");
		},
	});
}

// ──────────────────────────────────────────────────────────────────
// 子功能: Dynamic Instruction
// ──────────────────────────────────────────────────────────────────

async function handleDynamic(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) { notify(ctx, "仅支持 TUI 模式", "warning"); return; }

	const config = loadConfig();
	let enabled = config.dynamicInstruction.enabled;

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		return {
			render(W: number) {
				const val = enabled ? theme.fg("success", "enabled") : theme.fg("dim", "disabled");
				const lines: string[] = [];

				lines.push(borderTop(W, theme));
				lines.push(borderLine(theme.fg("accent", theme.bold("Dynamic Instruction")), W, theme));
				lines.push(borderMid(W, theme));
				lines.push(borderLine(theme.fg("muted", "开启后 LLM 在生成摘要的同时输出续接指令"), W, theme));
				lines.push(borderLine(theme.fg("muted", "关闭后 compaction 完成时 session 挂起"), W, theme));
				lines.push(borderMid(W, theme));
				lines.push(borderLine(`▸ Dynamic Instruction   ${val}`, W, theme));
				lines.push(borderMid(W, theme));
				lines.push(borderLine(theme.fg("dim", "Enter 切换  Esc 返回"), W, theme));
				lines.push(borderBottom(W, theme));

				return lines;
			},
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, Key.escape)) { done(undefined); return; }
				if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
					enabled = !enabled;
					saveNestedBool("dynamic-instruction", "enabled", enabled);
					if (enabled) saveNestedBool("static-instruction", "enabled", false);
					notify(ctx, `Dynamic instruction: ${enabled ? "✓ 启用" : "✗ 禁用"}`, "success");
					tui.requestRender();
				}
			},
		};
	}, OVERLAY);
}

// ──────────────────────────────────────────────────────────────────
// 子功能: Static Instruction
// ──────────────────────────────────────────────────────────────────

async function handleStatic(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) { notify(ctx, "仅支持 TUI 模式", "warning"); return; }

	const config = loadConfig();
	let currentContent = config.staticInstruction.content;
	let cursorPos = currentContent.length;
	let enabled = config.staticInstruction.enabled;

	// 两个可聚焦区域：0=开关 1=输入框
	let focus = 0;

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		return {
			render(W: number) {
				const maxC = W - 4;
				const inputMax = maxC - 4;

				const lines: string[] = [];

				lines.push(borderTop(W, theme));
				lines.push(borderLine(theme.fg("accent", theme.bold("Static Instruction")), W, theme));
				lines.push(borderMid(W, theme));
				lines.push(borderLine(theme.fg("muted", "Compaction 后注入这段固定文本，覆盖 dynamic"), W, theme));
				lines.push(borderMid(W, theme));

				// 区域 0: 开关
				const val = enabled ? theme.fg("success", "enabled") : theme.fg("dim", "disabled");
				const togglePrefix = focus === 0 ? "▸ " : "  ";
				lines.push(borderLine(`${togglePrefix}开关   ${val}`, W, theme));

				// 区域 1: 输入框
				const inputPrefix = focus === 1 ? "▸ " : "  ";
				let viewStart = 0;
				if (cursorPos > inputMax) viewStart = cursorPos - inputMax + 1;
				const before = currentContent.slice(viewStart, cursorPos);
				const atCursor = focus === 1 ? (currentContent.slice(cursorPos, cursorPos + 1) || " ") : " ";
				const cursorSeq = focus === 1 ? "\x1b[7m" : "";
				const cursorReset = focus === 1 ? "\x1b[27m" : "";
				const after = currentContent.slice(cursorPos + 1, viewStart + inputMax);
				lines.push(borderLine(`${inputPrefix}> ${before}${cursorSeq}${atCursor}${cursorReset}${after}`, W, theme));

				lines.push(borderMid(W, theme));
				lines.push(borderLine(theme.fg("dim", "↑↓ 切换区域  Enter 确认  Esc 返回"), W, theme));
				lines.push(borderBottom(W, theme));
				return lines;
			},
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, Key.escape)) {
					// Esc = 保存 + 返回（和 Dynamic 面板一致：离开即生效）
					saveStaticContent(currentContent);
					if (enabled !== config.staticInstruction.enabled) {
						saveNestedBool("static-instruction", "enabled", enabled);
						if (enabled) saveNestedBool("dynamic-instruction", "enabled", false);
					}
					notify(ctx, `Static instruction 已保存 (${enabled ? "启用" : "禁用"})`, "success");
					done(undefined);
					return;
				}

				// ↑↓ 在开关和输入框之间切换
				if (matchesKey(data, Key.up)) { focus = 0; tui.requestRender(); return; }
				if (matchesKey(data, Key.down)) { focus = 1; tui.requestRender(); return; }

				if (matchesKey(data, Key.enter)) {
					if (focus === 0) {
						// 切换开关
						enabled = !enabled;
						tui.requestRender();
					} else {
						// 保存并退出
						saveStaticContent(currentContent);
						if (enabled !== config.staticInstruction.enabled) {
							saveNestedBool("static-instruction", "enabled", enabled);
							if (enabled) saveNestedBool("dynamic-instruction", "enabled", false);
						}
						notify(ctx, `Static instruction 已保存 (${enabled ? "启用" : "禁用"})`, "success");
						done(undefined);
					}
					return;
				}

				// 输入区域：处理文字编辑
				if (focus !== 1) return;

				if (data === "\x7f" || data === "\x08") {
					if (cursorPos > 0) {
						currentContent = currentContent.slice(0, cursorPos - 1) + currentContent.slice(cursorPos);
						cursorPos--;
						tui.requestRender();
					}
					return;
				}
				if (data.startsWith("\x1b[")) {
					const code = data.slice(2);
					if (code === "D") { cursorPos = Math.max(0, cursorPos - 1); }
					else if (code === "C") { cursorPos = Math.min(currentContent.length, cursorPos + 1); }
					else if (code === "1~" || code === "H") { cursorPos = 0; }
					else if (code === "4~" || code === "F") { cursorPos = currentContent.length; }
					else if (code === "3~") {
						if (cursorPos < currentContent.length) {
							currentContent = currentContent.slice(0, cursorPos) + currentContent.slice(cursorPos + 1);
						}
					}
					tui.requestRender();
					return;
				}
				if (data.length === 1 && data.charCodeAt(0) >= 32) {
					currentContent = currentContent.slice(0, cursorPos) + data + currentContent.slice(cursorPos);
					cursorPos++;
					tui.requestRender();
				}
			},
		};
	}, { overlay: true, overlayOptions: { width: "60%", minWidth: 48, maxHeight: "50%", anchor: "center" } });
}

// ──────────────────────────────────────────────────────────────────
// 子功能: Archive
// ──────────────────────────────────────────────────────────────────

async function handleArchive(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) { notify(ctx, "仅支持 TUI 模式", "warning"); return; }

	const config = loadConfig();
	let enabled = config.archive.enabled;

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		return {
			render(W: number) {
				const val = enabled ? theme.fg("success", "enabled") : theme.fg("dim", "disabled");
				const lines: string[] = [];

				lines.push(borderTop(W, theme));
				lines.push(borderLine(theme.fg("accent", theme.bold("Archive")), W, theme));
				lines.push(borderMid(W, theme));
				lines.push(borderLine(theme.fg("muted", `归档目录: ${config.archive.dir}`), W, theme));
				lines.push(borderMid(W, theme));
				lines.push(borderLine(`▸ 归档   ${val}`, W, theme));
				lines.push(borderMid(W, theme));
				lines.push(borderLine(theme.fg("dim", "Enter 切换  Esc 返回"), W, theme));
				lines.push(borderBottom(W, theme));

				return lines;
			},
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, Key.escape)) { done(undefined); return; }
				if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
					enabled = !enabled;
					saveNestedBool("archive", "enabled", enabled);
					notify(ctx, `归档: ${enabled ? "✓ 启用" : "✗ 禁用"}`, "success");
					tui.requestRender();
				}
			},
		};
	}, OVERLAY);
}

// ──────────────────────────────────────────────────────────────────
// 子功能: Model（居中 overlay 选择器）
// ──────────────────────────────────────────────────────────────────

async function handleModel(ctx: ExtensionContext): Promise<void> {
	const config = loadConfig();
	const candidates = getModelCandidates(config.summarizeModel, ctx);
	let selected = candidates.findIndex((c) => c === config.summarizeModel);
	if (selected === -1) selected = 0;

	if (!ctx.hasUI) {
		notify(ctx, `当前: ${config.summarizeModel} | 用法: /compact-panel model <provider/id>`, "info");
		return;
	}

	const choice = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		return {
			render(W: number) {
				const lines: string[] = [];

				lines.push(borderTop(W, theme));
				lines.push(borderLine(theme.fg("accent", theme.bold("Model")), W, theme));
				lines.push(borderLine(theme.fg("muted", "选择摘要模型"), W, theme));
				lines.push(borderLine(theme.fg("dim", `当前: ${config.summarizeModel}`), W, theme));
				lines.push(borderMid(W, theme));

				for (let i = 0; i < candidates.length; i++) {
					const isCurrent = candidates[i] === config.summarizeModel;
					const marker = isCurrent ? theme.fg("dim", " ← current") : "";
					if (i === selected) {
						lines.push(borderLine(theme.fg("accent", `▸ ${theme.bold(candidates[i])}${marker}`), W, theme));
					} else {
						lines.push(borderLine(theme.fg("text", `  ${candidates[i]}${marker}`), W, theme));
					}
				}

				lines.push(borderMid(W, theme));
				lines.push(borderLine(theme.fg("dim", "↑↓ 选择  Enter 确认  Esc 返回"), W, theme));
				lines.push(borderBottom(W, theme));
				return lines;
			},
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, Key.up)) { selected = (selected - 1 + candidates.length) % candidates.length; tui.requestRender(); }
				else if (matchesKey(data, Key.down)) { selected = (selected + 1) % candidates.length; tui.requestRender(); }
				else if (matchesKey(data, Key.enter)) { done(candidates[selected]); }
				else if (matchesKey(data, Key.escape)) { done(null); }
			},
		};
	}, OVERLAY);

	if (choice) {
		saveTopLevelString("summarize-model", choice);
		notify(ctx, `✅ 摘要模型: ${choice}`, "success");
	}
}

// ──────────────────────────────────────────────────────────────────
// 子功能: Max Tokens（预设 + 自定义）
// ──────────────────────────────────────────────────────────────────

const MAX_TOKENS_PRESETS = [
	{ value: 4096, label: "4096   (极限压缩)" },
	{ value: 8192, label: "8192   (保守)" },
	{ value: 13107, label: "13107  (Pi 默认)" },
	{ value: 16384, label: "16384  (完整保留)" },
];

async function handleMaxTokens(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		notify(ctx, `当前: ${loadConfig().maxTokens} | 用法: /compact-panel maxtokens <number>`, "info");
		return;
	}

	const config = loadConfig();
	const options = [...MAX_TOKENS_PRESETS, { value: 0, label: "自定义..." }];
	let selected = options.findIndex((o) => o.value === config.maxTokens);
	if (selected === -1) selected = options.length - 1; // 默认选中"自定义"

	const choice = await ctx.ui.custom<{ value: number; label: string } | null>((tui, theme, _kb, done) => {
		return {
			render(W: number) {
				const lines: string[] = [];

				lines.push(borderTop(W, theme));
				lines.push(borderLine(theme.fg("accent", theme.bold("Max Tokens")), W, theme));
				lines.push(borderLine(theme.fg("muted", `摘要生成的最大 token 预算 (当前: ${config.maxTokens.toLocaleString()})`), W, theme));
				lines.push(borderMid(W, theme));

				for (let i = 0; i < options.length; i++) {
					const isCurrent = options[i].value === config.maxTokens;
					const marker = isCurrent ? theme.fg("dim", " ← current") : "";
					if (i === selected) {
						lines.push(borderLine(theme.fg("accent", `▸ ${theme.bold(options[i].label)}${marker}`), W, theme));
					} else {
						lines.push(borderLine(theme.fg("text", `  ${options[i].label}${marker}`), W, theme));
					}
				}

				lines.push(borderMid(W, theme));
				lines.push(borderLine(theme.fg("dim", "↑↓ 选择  Enter 确认  Esc 返回"), W, theme));
				lines.push(borderBottom(W, theme));
				return lines;
			},
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, Key.up)) { selected = (selected - 1 + options.length) % options.length; tui.requestRender(); }
				else if (matchesKey(data, Key.down)) { selected = (selected + 1) % options.length; tui.requestRender(); }
				else if (matchesKey(data, Key.enter)) { done(options[selected]); }
				else if (matchesKey(data, Key.escape)) { done(null); }
			},
		};
	}, OVERLAY);

	if (!choice) return;

	if (choice.value === 0) {
		// 自定义：进入数值输入面板
		await handleMaxTokensCustom(ctx, config.maxTokens);
		return;
	}

	saveTopLevelString("max-tokens", String(choice.value));
	notify(ctx, `✅ Max Tokens: ${choice.value.toLocaleString()}`, "success");
}

/** 自定义 maxTokens 数值输入 */
async function handleMaxTokensCustom(ctx: ExtensionContext, currentValue: number): Promise<void> {
	let text = String(currentValue);
	let cursorPos = text.length;

	return await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		return {
			render(W: number) {
				const maxC = W - 4;
				const inputMax = maxC - 4;
				const lines: string[] = [];

				lines.push(borderTop(W, theme));
				lines.push(borderLine(theme.fg("accent", theme.bold("Max Tokens")), W, theme));
				lines.push(borderMid(W, theme));
				lines.push(borderLine(theme.fg("muted", "输入自定义 max tokens 数值"), W, theme));
				lines.push(borderMid(W, theme));

				let viewStart = 0;
				if (cursorPos > inputMax) viewStart = cursorPos - inputMax + 1;
				const before = text.slice(viewStart, cursorPos);
				const atCursor = text.slice(cursorPos, cursorPos + 1) || " ";
				const after = text.slice(cursorPos + 1, viewStart + inputMax);
				lines.push(borderLine(`  > ${before}\x1b[7m${atCursor}\x1b[27m${after}`, W, theme));

				lines.push(borderMid(W, theme));
				lines.push(borderLine(theme.fg("dim", "Enter 确认  Esc 返回"), W, theme));
				lines.push(borderBottom(W, theme));
				return lines;
			},
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, Key.escape)) { done(null); return; }
				if (matchesKey(data, Key.enter)) {
					const val = parseInt(text, 10);
					if (isNaN(val) || val < 1024) {
						notify(ctx, "❌ 无效值，最小 1024", "error");
						return;
					}
					done(text);
					return;
				}
				if (data === "\x7f" || data === "\x08") {
					if (cursorPos > 0) {
						text = text.slice(0, cursorPos - 1) + text.slice(cursorPos);
						cursorPos--;
						tui.requestRender();
					}
					return;
				}
				if (data.startsWith("\x1b[")) {
					const code = data.slice(2);
					if (code === "D") { cursorPos = Math.max(0, cursorPos - 1); }
					else if (code === "C") { cursorPos = Math.min(text.length, cursorPos + 1); }
					else if (code === "1~" || code === "H") { cursorPos = 0; }
					else if (code === "4~" || code === "F") { cursorPos = text.length; }
					else if (code === "3~" && cursorPos < text.length) {
						text = text.slice(0, cursorPos) + text.slice(cursorPos + 1);
					}
					tui.requestRender();
					return;
				}
				// 只接受数字
				if (data.length === 1 && data >= "0" && data <= "9") {
					text = text.slice(0, cursorPos) + data + text.slice(cursorPos);
					cursorPos++;
					tui.requestRender();
				}
			},
		};
	}, OVERLAY);

	if (result) {
		const val = parseInt(result, 10);
		saveTopLevelString("max-tokens", result);
		notify(ctx, `✅ Max Tokens: ${val.toLocaleString()}`, "success");
	}
}

// ──────────────────────────────────────────────────────────────────
// Extension + 触发来源区分
// ──────────────────────────────────────────────────────────────────

/**
 * 标志位：区分"扩展主动发起的 compact"和"用户手动 /compact"
 *
 * Pi 的 SessionBeforeCompactEvent 没有 "source" 字段，
 * 所以用模块级变量在 ctx.compact() 前后标记。
 *
 * - true  → 扩展发起（agent_end 阈值触发 或 /compact-panel start）→ 自定义摘要 + 续接
 * - false → 用户手动 /compact → 不拦截，走 Pi 原生逻辑
 */
let triggeredByExtension = false;

function setExtensionFlag(value: boolean) {
	triggeredByExtension = value;
}

export default function (pi: ExtensionAPI) {
	let busy = false;
	let cachedContinuation: string | null = null;

	// ─── ① 上下文监视（自动触发，标记为扩展发起）───────────────

	pi.on("agent_end", async (_event, ctx) => {
		const config = loadConfig();
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null || usage.percent === null) return;

		if (usage.percent >= config.threshold) {
			notify(ctx, `🔄 上下文 ${usage.percent.toFixed(0)}% ≥ ${config.threshold}%，触发 compaction`, "info");
			triggeredByExtension = true;
			ctx.compact({
				onComplete: () => {
					const after = ctx.getContextUsage();
					notify(ctx, `✅ Compact 完成 (${usage.percent.toFixed(0)}% → ${after?.percent?.toFixed(0) ?? "?"}%)`, "success");
				},
				onError: (error) => {
					triggeredByExtension = false;
					notify(ctx, `❌ Compact 失败: ${error.message}`, "error");
				},
			});
		}
	});

	// ─── ② 自定义摘要（仅拦截扩展发起的 compact）───────────────

	pi.on("session_before_compact", async (event, ctx) => {
		if (!triggeredByExtension) {
			// 用户手动 /compact → 不拦截，让 Pi 走内置摘要
			return;
		}

		const config = loadConfig();
		const { preparation, customInstructions, signal } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;

		const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
		notify(ctx, `📝 用 ${config.summarizeModel} 压缩 ${allMessages.length} 条消息 (${tokensBefore.toLocaleString()} tokens)...`, "info");

		try {
			const output = await generateCompaction(
				messagesToSummarize, turnPrefixMessages, previousSummary,
				customInstructions, config, ctx, signal,
			);
			cachedContinuation = output.continuation;
			return {
				compaction: { summary: output.summary, firstKeptEntryId, tokensBefore },
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notify(ctx, `摘要生成失败: ${message}，降级使用默认 compaction`, "warning");
			return;
		}
	});

	// ─── ③ 归档 + ④ 指令注入（仅处理扩展发起的 compact）────────

	pi.on("session_compact", async (event, ctx) => {
		// reset 标志 — session_compact 是 compact 完成后必定触发的，在这里 reset 最安全
		const wasExtension = triggeredByExtension;
		triggeredByExtension = false;

		if (!wasExtension) return;  // 用户手动 /compact → 不注入续接
		if (busy) return;
		busy = true;

		try {
			const config = loadConfig();
			const { summary, tokensBefore, firstKeptEntryId } = event.compactionEntry;
			const activeAgent = detectActiveAgent(ctx);

			const output: ParsedOutput = { summary, continuation: cachedContinuation };
			cachedContinuation = null;

			const archivePath = await writeArchive(summary, { tokensBefore, firstKeptEntryId, activeAgent }, config.archive, ctx.cwd);
			if (archivePath) notify(ctx, `📁 归档: ${archivePath}`, "info");

			injectContinuation(output, pi, ctx, config);
		} catch (err) {
			notify(ctx, `❌ 续接失败: ${err instanceof Error ? err.message : String(err)}`, "error");
		} finally {
			busy = false;
		}
	});

	// ─── 命令: /compact-panel ──────────────────────────────────

	// 不能用 /compact — Pi 内核硬拦截 /compact → handleCompactCommand()

	const SUB_COMMANDS = ["start", "dynamic", "static", "archive", "model", "maxtokens"];

	const COMMAND_HELP = `Compaction 管理面板

用法:
  /compact-panel                打开主菜单
  /compact-panel start          立即触发 compaction（带续接）
  /compact-panel dynamic        配置 dynamic instruction
  /compact-panel static         编辑 static instruction
  /compact-panel archive        归档设置
  /compact-panel model          选择摘要模型
  /compact-panel model <id>     直接指定摘要模型
  /compact-panel maxtokens      设置 max tokens
  /compact-panel maxtokens <n>  直接指定 max tokens

内置 /compact = Pi 原生压缩（纯摘要，无续接）`;

	pi.registerCommand("compact-panel", {
		description: "Compaction 管理面板: 查看 status / 触发 / 配置",
		getArgumentCompletions: (prefix: string) => {
			const items = SUB_COMMANDS
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const sub = args.trim();

			if (!sub) { await showMainMenu(pi, ctx); return; }

			if (sub === "start") { await handleStart(pi, ctx); return; }
			if (sub === "dynamic") { await handleDynamic(ctx); return; }
			if (sub === "static") { await handleStatic(ctx); return; }
			if (sub === "archive") { await handleArchive(ctx); return; }

			// model 或 model <spec>
			if (sub === "model" || sub.startsWith("model ")) {
				const rest = sub.slice(5).trim();
				if (rest) {
					const spec = resolveModelSpec(rest);
					const model = ctx.modelRegistry.find(spec.provider, spec.id);
					if (!model) {
						notify(ctx, `❌ 找不到模型: ${rest}`, "error");
						return;
					}
					saveTopLevelString("summarize-model", rest);
					notify(ctx, `✅ 摘要模型: ${rest}`, "success");
					return;
				}
				await handleModel(ctx);
				return;
			}

			// maxtokens 或 maxtokens <n>
			if (sub === "maxtokens" || sub.startsWith("maxtokens ")) {
				const rest = sub.slice(9).trim();
				if (rest) {
					const val = parseInt(rest, 10);
					if (isNaN(val) || val < 1024) {
						notify(ctx, "❌ 无效值，最小 1024", "error");
						return;
					}
					saveTopLevelString("max-tokens", rest);
					notify(ctx, `✅ Max Tokens: ${val.toLocaleString()}`, "success");
					return;
				}
				await handleMaxTokens(ctx);
				return;
			}

			notify(ctx, COMMAND_HELP, "info");
		},
	});
}
