/**
 * Clear Context v2 — 上下文清理管理面板
 *
 * /clear-panel    → 主菜单（居中 overlay，显示 status + 子选项）
 *   Clear Now     → 立即清理上下文（迁移状态到新 session）
 *   Auto Clear    → 开关自动清理
 *   Idle Timeout  → 配置空闲超时时间（预设 + 自定义）
 *
 * /clear          → 快捷入口，立即清理（不经过面板）
 *
 * UI 规范（对齐 compact-panel）：
 *   - 所有面板用 ctx.ui.custom() + 手写 render(width)
 *   - ┌─┐│└─┘├─┤ 画完整矩形，每行恰好 width 列
 *   - 上标注：status 区显示关键指标
 *   - 下选择：菜单项 ↑↓ 选择 + Enter 确认
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, matchesKey, Key } from "@mariozechner/pi-tui";

// ──────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────

const STATE_ENTRY_TYPE = "clear-context-state";
const STATUS_ID = "clear-context";
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const BUSY_RETRY_MS = 15 * 1000;

// ──────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────

type PersistedState = {
	enabled: boolean;
	lastClearAt: number | null;
	idleTimeoutMs: number;
};

type SessionEntryLike = {
	type?: string;
	timestamp?: string | number;
	customType?: string;
	data?: unknown;
	thinkingLevel?: string;
	provider?: string;
	modelId?: string;
	name?: string;
	label?: string;
	targetId?: string;
	message?: {
		role?: string;
		timestamp?: number;
	};
};

type MigratedState = {
	customEntries: Array<{ customType: string; data: unknown }>;
	sessionName?: string;
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
};

const DEFAULT_STATE: PersistedState = {
	enabled: false,
	lastClearAt: null,
	idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
};

// ──────────────────────────────────────────────────────────────────
// Box border helpers — 所有 overlay 面板共用（对齐 compact-panel）
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
	return text.replace(/\x1b\[[0-9;]*m/g, "").slice(0, maxVisible - 1) + "…";
}

// ──────────────────────────────────────────────────────────────────
// Utility helpers
// ──────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const asFiniteNumber = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

const formatRelativeDuration = (ms: number): string => {
	const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes <= 0 ? `${seconds}s` : `${minutes}m ${seconds}s`;
};

const formatTimestamp = (timestamp: number | null): string => {
	if (timestamp === null) return "never";
	return new Date(timestamp).toLocaleString();
};

const formatIdleTimeout = (ms: number): string => {
	const minutes = Math.round(ms / 60000);
	return `${minutes}m`;
};

// ──────────────────────────────────────────────────────────────────
// 共用 overlay 选项
// ──────────────────────────────────────────────────────────────────

const OVERLAY = {
	overlay: true,
	overlayOptions: {
		width: "50%",
		minWidth: 48,
		maxHeight: "65%",
		anchor: "center",
	},
} as const;

// ──────────────────────────────────────────────────────────────────
// Context helpers
// ──────────────────────────────────────────────────────────────────

const getFallbackContextCount = (ctx: ExtensionContext): number => {
	const branch = ctx.sessionManager.getBranch() as SessionEntryLike[];
	let count = 0;
	for (const entry of branch) {
		if (
			entry.type === "message" ||
			entry.type === "custom_message" ||
			entry.type === "branch_summary" ||
			entry.type === "compaction"
		) {
			count++;
		}
	}
	return count;
};

const getContextTokenCount = (ctx: ExtensionContext): number => {
	const usage = ctx.getContextUsage();
	if (
		usage &&
		typeof usage.tokens === "number" &&
		Number.isFinite(usage.tokens)
	) {
		return Math.max(0, usage.tokens);
	}
	return getFallbackContextCount(ctx) > 0 ? 1 : 0;
};

const isClean = (ctx: ExtensionContext): boolean =>
	getContextTokenCount(ctx) === 0;

const notify = (
	ctx: any,
	msg: string,
	level: "info" | "success" | "warning" | "error",
) => {
	if (ctx.hasUI) ctx.ui.notify(msg, level);
	else console.log(`[clear-context:${level}] ${msg}`);
};

// ──────────────────────────────────────────────────────────────────
// Menu items 定义
// ──────────────────────────────────────────────────────────────────

const MENU_ITEMS = [
	{ id: "clear", label: "Clear Now", desc: "立即清理上下文，迁移状态到新 session" },
	{ id: "auto", label: "Auto Clear", desc: "开关自动清理" },
	{ id: "timeout", label: "Idle Timeout", desc: "配置空闲超时时间" },
] as const;

type MenuId = typeof MENU_ITEMS[number]["id"];

// ──────────────────────────────────────────────────────────────────
// TUI: 主菜单（循环，子面板 Esc 回退到此处）
// ──────────────────────────────────────────────────────────────────

async function showMainMenu(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	moduleState: ModuleState,
): Promise<void> {
	if (!ctx.hasUI) {
		notify(
			ctx,
			"交互菜单仅支持 TUI 模式，使用 /clear | /clear-panel auto|timeout",
			"info",
		);
		return;
	}

	let active = true;
	while (active) {
		let selected = 0;

		const result = await ctx.ui.custom<MenuId | null>((tui, theme, _kb, done) => {
			return {
				render(W: number) {
					const lines: string[] = [];

					lines.push(borderTop(W, theme));
					lines.push(
						borderLine(
							theme.fg("accent", theme.bold("Clear Context")),
							W,
							theme,
						),
					);
					lines.push(borderMid(W, theme));

					// ── 上标注：Status 区 ──
					const maxC = W - 4;
					const maxValW = maxC - 16;

					const autoVal = moduleState.state.enabled
						? theme.fg("success", "✓ enabled")
						: theme.fg("dim", "✗ disabled");
					const contextVal = isClean(ctx)
						? theme.fg("success", "clean (0)")
						: theme.fg("warning", `${getContextTokenCount(ctx)} tokens`);
					const idleVal = moduleState.state.enabled
						? theme.fg(
								"dim",
								formatRelativeDuration(
									Math.max(
										0,
										moduleState.state.idleTimeoutMs -
											(Date.now() - moduleState.lastActivityAt),
									),
								),
							)
						: theme.fg("dim", "—");
					const timeoutVal = theme.fg(
						"text",
						formatIdleTimeout(moduleState.state.idleTimeoutMs),
					);
					const lastClearVal = theme.fg(
						"dim",
						ellipsis(
							formatTimestamp(moduleState.state.lastClearAt),
							maxValW,
						),
					);

					const statusItems = [
						{ label: "Auto", value: autoVal },
						{ label: "Context", value: contextVal },
						{ label: "Idle", value: idleVal },
						{ label: "Timeout", value: timeoutVal },
						{ label: "Last Clear", value: lastClearVal },
					];

					for (const item of statusItems) {
						const padded = theme
							.fg("muted", `${item.label}`)
							.padEnd(14);
						const displayVal =
							visibleLen(item.value) > maxValW
								? ellipsis(item.value, maxValW)
								: item.value;
						lines.push(
							borderLine(`${padded} ${displayVal}`, W, theme),
						);
					}

					lines.push(borderMid(W, theme));

					// ── 下选择：菜单项 ──
					for (let i = 0; i < MENU_ITEMS.length; i++) {
						const item = MENU_ITEMS[i];
						if (i === selected) {
							lines.push(
								borderLine(
									theme.fg(
										"accent",
										`▸ ${theme.bold(item.label)}`,
									),
									W,
									theme,
								),
							);
							lines.push(
								borderLine(
									theme.fg("muted", `  ${item.desc}`),
									W,
									theme,
								),
							);
						} else {
							lines.push(
								borderLine(
									theme.fg("text", `  ${item.label}`),
									W,
									theme,
								),
							);
						}
					}

					lines.push(borderMid(W, theme));
					lines.push(
						borderLine(
							theme.fg("dim", "↑↓ 选择  Enter 确认  Esc 关闭"),
							W,
							theme,
						),
					);
					lines.push(borderBottom(W, theme));
					return lines;
				},
				invalidate() {},
				handleInput(data: string) {
					if (matchesKey(data, Key.up)) {
						selected =
							(selected - 1 + MENU_ITEMS.length) %
							MENU_ITEMS.length;
						tui.requestRender();
					} else if (matchesKey(data, Key.down)) {
						selected = (selected + 1) % MENU_ITEMS.length;
						tui.requestRender();
					} else if (matchesKey(data, Key.enter)) {
						done(MENU_ITEMS[selected].id);
					} else if (matchesKey(data, Key.escape)) {
						done(null);
					}
				},
			};
		}, OVERLAY);

		if (!result) {
			active = false;
			continue;
		}

		if (result === "clear") {
			await runClear(ctx, "manual", moduleState);
			active = false;
		} else if (result === "auto") {
			await handleAutoClear(ctx, moduleState);
		} else if (result === "timeout") {
			await handleIdleTimeout(ctx, moduleState);
		}
	}
}

// ──────────────────────────────────────────────────────────────────
// 子功能: Auto Clear 开关
// ──────────────────────────────────────────────────────────────────

async function handleAutoClear(
	ctx: ExtensionContext,
	moduleState: ModuleState,
): Promise<void> {
	if (!ctx.hasUI) {
		notify(ctx, "仅支持 TUI 模式", "warning");
		return;
	}

	let enabled = moduleState.state.enabled;

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		return {
			render(W: number) {
				const val = enabled
					? theme.fg("success", "enabled")
					: theme.fg("dim", "disabled");
				const lines: string[] = [];

				lines.push(borderTop(W, theme));
				lines.push(
					borderLine(
						theme.fg("accent", theme.bold("Auto Clear")),
						W,
						theme,
					),
				);
				lines.push(borderMid(W, theme));
				lines.push(
					borderLine(
						theme.fg(
							"muted",
							`空闲 ${formatIdleTimeout(moduleState.state.idleTimeoutMs)} 后自动清理上下文`,
						),
						W,
						theme,
					),
				);
				lines.push(
					borderLine(
						theme.fg(
							"muted",
							"开启后新 session 自动开始倒计时",
						),
						W,
						theme,
					),
				);
				lines.push(borderMid(W, theme));
				lines.push(
					borderLine(
						`▸ Auto Clear   ${val}`,
						W,
						theme,
					),
				);
				lines.push(borderMid(W, theme));
				lines.push(
					borderLine(
						theme.fg("dim", "Enter / Space 切换  Esc 返回"),
						W,
						theme,
					),
				);
				lines.push(borderBottom(W, theme));

				return lines;
			},
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, Key.escape)) {
					done(undefined);
					return;
				}
				if (
					matchesKey(data, Key.enter) ||
					matchesKey(data, Key.space)
				) {
					enabled = !enabled;
					moduleState.state = {
						...moduleState.state,
						enabled,
					};
					moduleState.persistOwnState();
					moduleState.touch(ctx);
					notify(
						ctx,
						`Auto-clear: ${enabled ? "✓ 启用" : "✗ 禁用"}`,
						"success",
					);
					tui.requestRender();
				}
			},
		};
	}, OVERLAY);
}

// ──────────────────────────────────────────────────────────────────
// 子功能: Idle Timeout 配置（预设 + 自定义）
// ──────────────────────────────────────────────────────────────────

const TIMEOUT_PRESETS = [
	{ value: 5 * 60 * 1000, label: "5m    (快速清理)" },
	{ value: 10 * 60 * 1000, label: "10m   (默认)" },
	{ value: 15 * 60 * 1000, label: "15m   (保守)" },
	{ value: 30 * 60 * 1000, label: "30m   (长对话)" },
];

async function handleIdleTimeout(
	ctx: ExtensionContext,
	moduleState: ModuleState,
): Promise<void> {
	if (!ctx.hasUI) {
		notify(
			ctx,
			`当前: ${formatIdleTimeout(moduleState.state.idleTimeoutMs)} | 用法: /clear-panel timeout <minutes>`,
			"info",
		);
		return;
	}

	const options = [
		...TIMEOUT_PRESETS,
		{ value: 0, label: "自定义..." },
	];
	let selected = options.findIndex(
		(o) => o.value === moduleState.state.idleTimeoutMs,
	);
	if (selected === -1) selected = options.length - 1;

	const choice = await ctx.ui.custom<{
		value: number;
		label: string;
	} | null>((tui, theme, _kb, done) => {
		return {
			render(W: number) {
				const lines: string[] = [];

				lines.push(borderTop(W, theme));
				lines.push(
					borderLine(
						theme.fg("accent", theme.bold("Idle Timeout")),
						W,
						theme,
					),
				);
				lines.push(
					borderLine(
						theme.fg(
							"muted",
							`空闲多久后自动清理 (当前: ${formatIdleTimeout(moduleState.state.idleTimeoutMs)})`,
						),
						W,
						theme,
					),
				);
				lines.push(borderMid(W, theme));

				for (let i = 0; i < options.length; i++) {
					const isCurrent =
						options[i].value !== 0 &&
						options[i].value === moduleState.state.idleTimeoutMs;
					const marker = isCurrent
						? theme.fg("dim", " ← current")
						: "";
					if (i === selected) {
						lines.push(
							borderLine(
								theme.fg(
									"accent",
									`▸ ${theme.bold(options[i].label)}${marker}`,
								),
								W,
								theme,
							),
						);
					} else {
						lines.push(
							borderLine(
								theme.fg(
									"text",
									`  ${options[i].label}${marker}`,
								),
								W,
								theme,
							),
						);
					}
				}

				lines.push(borderMid(W, theme));
				lines.push(
					borderLine(
						theme.fg("dim", "↑↓ 选择  Enter 确认  Esc 返回"),
						W,
						theme,
					),
				);
				lines.push(borderBottom(W, theme));
				return lines;
			},
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, Key.up)) {
					selected = (selected - 1 + options.length) % options.length;
					tui.requestRender();
				} else if (matchesKey(data, Key.down)) {
					selected = (selected + 1) % options.length;
					tui.requestRender();
				} else if (matchesKey(data, Key.enter)) {
					done(options[selected]);
				} else if (matchesKey(data, Key.escape)) {
					done(null);
				}
			},
		};
	}, OVERLAY);

	if (!choice) return;

	if (choice.value === 0) {
		await handleTimeoutCustom(ctx, moduleState);
		return;
	}

	moduleState.state = {
		...moduleState.state,
		idleTimeoutMs: choice.value,
	};
	moduleState.persistOwnState();
	moduleState.touch(ctx);
	notify(
		ctx,
		`✅ Idle Timeout: ${formatIdleTimeout(choice.value)}`,
		"success",
	);
}

/** 自定义 timeout 数值输入（分钟） */
async function handleTimeoutCustom(
	ctx: ExtensionContext,
	moduleState: ModuleState,
): Promise<void> {
	const currentMinutes = Math.round(
		moduleState.state.idleTimeoutMs / 60000,
	);
	let text = String(currentMinutes);
	let cursorPos = text.length;

	const result = await ctx.ui.custom<string | null>(
		(tui, theme, _kb, done) => {
			return {
				render(W: number) {
					const maxC = W - 4;
					const inputMax = maxC - 4;
					const lines: string[] = [];

					lines.push(borderTop(W, theme));
					lines.push(
						borderLine(
							theme.fg("accent", theme.bold("Idle Timeout")),
							W,
							theme,
						),
					);
					lines.push(borderMid(W, theme));
					lines.push(
						borderLine(
							theme.fg("muted", "输入自定义超时时间（分钟）"),
							W,
							theme,
						),
					);
					lines.push(borderMid(W, theme));

					let viewStart = 0;
					if (cursorPos > inputMax)
						viewStart = cursorPos - inputMax + 1;
					const before = text.slice(viewStart, cursorPos);
					const atCursor =
						text.slice(cursorPos, cursorPos + 1) || " ";
					const after = text.slice(
						cursorPos + 1,
						viewStart + inputMax,
					);
					lines.push(
						borderLine(
							`  > ${before}\x1b[7m${atCursor}\x1b[27m${after}`,
							W,
							theme,
						),
					);

					lines.push(borderMid(W, theme));
					lines.push(
						borderLine(
							theme.fg("dim", "Enter 确认  Esc 返回"),
							W,
							theme,
						),
					);
					lines.push(borderBottom(W, theme));
					return lines;
				},
				invalidate() {},
				handleInput(data: string) {
					if (matchesKey(data, Key.escape)) {
						done(null);
						return;
					}
					if (matchesKey(data, Key.enter)) {
						const val = parseInt(text, 10);
						if (isNaN(val) || val < 1) {
							notify(ctx, "❌ 无效值，最小 1 分钟", "error");
							return;
						}
						done(text);
						return;
					}
					if (data === "\x7f" || data === "\x08") {
						if (cursorPos > 0) {
							text =
								text.slice(0, cursorPos - 1) +
								text.slice(cursorPos);
							cursorPos--;
							tui.requestRender();
						}
						return;
					}
					if (data.startsWith("\x1b[")) {
						const code = data.slice(2);
						if (code === "D") {
							cursorPos = Math.max(0, cursorPos - 1);
						} else if (code === "C") {
							cursorPos = Math.min(text.length, cursorPos + 1);
						} else if (code === "1~" || code === "H") {
							cursorPos = 0;
						} else if (code === "4~" || code === "F") {
							cursorPos = text.length;
						} else if (code === "3~" && cursorPos < text.length) {
							text =
								text.slice(0, cursorPos) +
								text.slice(cursorPos + 1);
						}
						tui.requestRender();
						return;
					}
					// 只接受数字
					if (
						data.length === 1 &&
						data >= "0" &&
						data <= "9"
					) {
						text =
							text.slice(0, cursorPos) +
							data +
							text.slice(cursorPos);
						cursorPos++;
						tui.requestRender();
					}
				},
			};
		},
		OVERLAY,
	);

	if (result) {
		const val = parseInt(result, 10);
		moduleState.state = {
			...moduleState.state,
			idleTimeoutMs: val * 60 * 1000,
		};
		moduleState.persistOwnState();
		moduleState.touch(ctx);
		notify(ctx, `✅ Idle Timeout: ${val}m`, "success");
	}
}

// ──────────────────────────────────────────────────────────────────
// Core: State management
// ──────────────────────────────────────────────────────────────────

interface ModuleState {
	state: PersistedState;
	lastActivityAt: number;
	currentCtx: ExtensionContext | null;
	shuttingDown: boolean;
	autoClearQueued: boolean;
	timer: ReturnType<typeof setTimeout> | null;

	persistOwnState: () => void;
	touch: (ctx: ExtensionContext) => void;
	restoreStateFromSession: (ctx: ExtensionContext) => void;
	scheduleAutoClear: (ctx: ExtensionContext | null) => void;
	updateStatus: (ctx: ExtensionContext | null) => void;
}

// ──────────────────────────────────────────────────────────────────
// Core: Clear execution
// ──────────────────────────────────────────────────────────────────

const collectMigratedState = (
	ctx: ExtensionCommandContext,
): MigratedState => {
	const branch = ctx.sessionManager.getBranch() as SessionEntryLike[];
	const customEntries: Array<{ customType: string; data: unknown }> = [];
	let latestSessionName: string | undefined;
	let latestModel: { provider: string; modelId: string } | undefined;
	let latestThinkingLevel: string | undefined;

	for (const entry of branch) {
		if (
			entry.type === "custom" &&
			typeof entry.customType === "string" &&
			entry.customType !== STATE_ENTRY_TYPE
		) {
			customEntries.push({
				customType: entry.customType,
				data: entry.data,
			});
			continue;
		}

		if (entry.type === "session_info" && typeof entry.name === "string") {
			latestSessionName = entry.name;
			continue;
		}

		if (
			entry.type === "model_change" &&
			typeof entry.provider === "string" &&
			typeof entry.modelId === "string"
		) {
			latestModel = { provider: entry.provider, modelId: entry.modelId };
			continue;
		}

		if (
			entry.type === "thinking_level_change" &&
			typeof entry.thinkingLevel === "string"
		) {
			latestThinkingLevel = entry.thinkingLevel;
		}
	}

	return {
		customEntries,
		sessionName: latestSessionName,
		model: latestModel,
		thinkingLevel: latestThinkingLevel,
	};
};

const runClear = async (
	ctx: ExtensionCommandContext,
	source: "manual" | "auto",
	moduleState: ModuleState,
) => {
	moduleState.touch(ctx);
	moduleState.autoClearQueued = false;
	await ctx.waitForIdle();

	if (isClean(ctx)) {
		if (ctx.hasUI && source === "manual") {
			notify(ctx, "Session is already clean (context window is 0)", "info");
		}
		moduleState.updateStatus(ctx);
		return;
	}

	const migratedState = collectMigratedState(ctx);
	const parentSession = ctx.sessionManager.getSessionFile();
	const nextClearState: PersistedState = {
		enabled: moduleState.state.enabled,
		lastClearAt: Date.now(),
		idleTimeoutMs: moduleState.state.idleTimeoutMs,
	};

	const result = await ctx.newSession({
		parentSession,
		setup: async (sm) => {
			for (const entry of migratedState.customEntries) {
				sm.appendCustomEntry(entry.customType, entry.data);
			}

			sm.appendCustomEntry(STATE_ENTRY_TYPE, {
				enabled: nextClearState.enabled,
				lastClearAt: nextClearState.lastClearAt,
				idleTimeoutMs: nextClearState.idleTimeoutMs,
				savedAt: Date.now(),
			});

			if (migratedState.sessionName) {
				sm.appendSessionInfo(migratedState.sessionName);
			}

			if (migratedState.model) {
				sm.appendModelChange(
					migratedState.model.provider,
					migratedState.model.modelId,
				);
			}

			if (migratedState.thinkingLevel) {
				sm.appendThinkingLevelChange(migratedState.thinkingLevel);
			}
		},
		withSession: async (nextCtx) => {
			if (nextCtx.hasUI) {
				nextCtx.ui.notify(
					source === "manual"
						? "✨ 已清理上下文，迁移状态到新 session"
						: "✨ Auto-clear 已清理上下文，迁移状态到新 session",
					"success",
				);
			}
		},
	});

	if (result.cancelled && ctx.hasUI) {
		notify(
			ctx,
			source === "manual" ? "Clear cancelled" : "Auto-clear cancelled",
			"info",
		);
	}
};

// ──────────────────────────────────────────────────────────────────
// Extension entry
// ──────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Module-level mutable state
	const ms: ModuleState = {
		state: { ...DEFAULT_STATE },
		lastActivityAt: Date.now(),
		currentCtx: null,
		shuttingDown: false,
		autoClearQueued: false,
		timer: null,

		persistOwnState() {
			pi.appendEntry(STATE_ENTRY_TYPE, {
				enabled: ms.state.enabled,
				lastClearAt: ms.state.lastClearAt,
				idleTimeoutMs: ms.state.idleTimeoutMs,
				savedAt: Date.now(),
			});
		},

		touch(ctx: ExtensionContext) {
			ms.currentCtx = ctx;
			ms.lastActivityAt = Date.now();
			ms.scheduleAutoClear(ctx);
		},

		restoreStateFromSession(ctx: ExtensionContext) {
			ms.state = { ...DEFAULT_STATE };
			const branch = ctx.sessionManager.getBranch() as SessionEntryLike[];
			for (const entry of branch) {
				if (
					entry.type !== "custom" ||
					entry.customType !== STATE_ENTRY_TYPE ||
					!isRecord(entry.data)
				)
					continue;
				ms.state = {
					enabled: entry.data.enabled === true,
					lastClearAt: asFiniteNumber(entry.data.lastClearAt),
					idleTimeoutMs:
						asFiniteNumber(entry.data.idleTimeoutMs) ??
						DEFAULT_IDLE_TIMEOUT_MS,
				};
			}
		},

		scheduleAutoClear(ctx: ExtensionContext | null) {
			if (ms.timer !== null) {
				clearTimeout(ms.timer);
				ms.timer = null;
			}
			if (ms.shuttingDown || !ms.state.enabled || ctx === null) {
				ms.updateStatus(ctx);
				return;
			}
			const elapsed = Date.now() - ms.lastActivityAt;
			const delay = Math.max(0, ms.state.idleTimeoutMs - elapsed);
			ms.timer = setTimeout(() => {
				void maybeAutoClear();
			}, delay);
			ms.updateStatus(ctx);
		},

		updateStatus(ctx: ExtensionContext | null) {
			if (!ctx?.hasUI) return;
			const theme = ctx.ui.theme;
			const autoText = ms.state.enabled
				? theme.fg("success", "auto:on")
				: theme.fg("dim", "auto:off");
			const contextText = isClean(ctx)
				? theme.fg("success", "ctx:0")
				: theme.fg("warning", `ctx:${getContextTokenCount(ctx)}`);
			const idleText = ms.state.enabled
				? theme.fg(
						"dim",
						` idle:${formatRelativeDuration(Math.max(0, ms.state.idleTimeoutMs - (Date.now() - ms.lastActivityAt)))}`,
					)
				: "";
			ctx.ui.setStatus(
				STATUS_ID,
				`${autoText} ${contextText}${idleText}`.trim(),
			);
		},
	};

	const maybeAutoClear = async () => {
		if (
			ms.shuttingDown ||
			!ms.state.enabled ||
			ms.currentCtx === null ||
			ms.autoClearQueued
		)
			return;
		if (
			!ms.currentCtx.isIdle() ||
			ms.currentCtx.hasPendingMessages()
		) {
			if (ms.timer !== null) clearTimeout(ms.timer);
			ms.timer = setTimeout(() => {
				void maybeAutoClear();
			}, BUSY_RETRY_MS);
			ms.updateStatus(ms.currentCtx);
			return;
		}
		if (isClean(ms.currentCtx)) {
			ms.updateStatus(ms.currentCtx);
			ms.scheduleAutoClear(ms.currentCtx);
			return;
		}
		ms.autoClearQueued = true;
		await runClear(ms.currentCtx, "auto", ms);
	};

	// ─── 事件监听 ────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		ms.shuttingDown = false;
		ms.autoClearQueued = false;
		ms.currentCtx = ctx;
		ms.restoreStateFromSession(ctx);
		ms.lastActivityAt = Date.now();
		ms.scheduleAutoClear(ctx);
		ms.updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ms.shuttingDown = true;
		ms.autoClearQueued = false;
		if (ms.timer !== null) {
			clearTimeout(ms.timer);
			ms.timer = null;
		}
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_ID, "");
	});

	pi.on("input", async (_event, ctx) => {
		ms.touch(ctx);
		return { action: "continue" as const };
	});
	pi.on("user_bash", async (_event, ctx) => ms.touch(ctx));
	pi.on("before_agent_start", async (_event, ctx) => ms.touch(ctx));
	pi.on("turn_start", async (_event, ctx) => ms.touch(ctx));
	pi.on("turn_end", async (_event, ctx) => ms.touch(ctx));
	pi.on("message_start", async (_event, ctx) => ms.touch(ctx));
	pi.on("message_update", async (_event, ctx) => ms.touch(ctx));
	pi.on("message_end", async (_event, ctx) => ms.touch(ctx));
	pi.on("tool_execution_start", async (_event, ctx) => ms.touch(ctx));
	pi.on("tool_execution_update", async (_event, ctx) => ms.touch(ctx));
	pi.on("tool_execution_end", async (_event, ctx) => ms.touch(ctx));

	// ─── 命令: /clear-panel（统一入口）───────────────────────────

	const SUB_COMMANDS = ["auto", "timeout"];

	const COMMAND_HELP = `Clear Context 管理面板

用法:
  /clear-panel                打开主菜单
  /clear-panel auto           开关 auto-clear
  /clear-panel timeout        配置空闲超时时间
  /clear-panel timeout <min>  直接指定超时分钟数

快捷:
  /clear                      立即清理上下文`;

	pi.registerCommand("clear-panel", {
		description: "Clear Context 管理面板: 查看 status / 清理 / 配置",
		getArgumentCompletions: (prefix: string) => {
			const items = SUB_COMMANDS.filter((s) =>
				s.startsWith(prefix),
			).map((s) => ({ value: s, label: s }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const sub = args.trim();

			if (!sub) {
				await showMainMenu(pi, ctx, ms);
				return;
			}

			if (sub === "auto") {
				// 快捷切换
				ms.state = { ...ms.state, enabled: !ms.state.enabled };
				ms.persistOwnState();
				ms.touch(ctx);
				notify(
					ctx,
					ms.state.enabled
						? `Auto-clear ✓ 启用 (${formatIdleTimeout(ms.state.idleTimeoutMs)} idle timeout)`
						: "Auto-clear ✗ 禁用",
					ms.state.enabled ? "success" : "info",
				);
				return;
			}

			// timeout 或 timeout <minutes>
			if (sub === "timeout" || sub.startsWith("timeout ")) {
				const rest = sub.slice(7).trim();
				if (rest) {
					const val = parseInt(rest, 10);
					if (isNaN(val) || val < 1) {
						notify(ctx, "❌ 无效值，最小 1 分钟", "error");
						return;
					}
					ms.state = {
						...ms.state,
						idleTimeoutMs: val * 60 * 1000,
					};
					ms.persistOwnState();
					ms.touch(ctx);
					notify(
						ctx,
						`✅ Idle Timeout: ${val}m`,
						"success",
					);
					return;
				}
				await handleIdleTimeout(ctx, ms);
				return;
			}

			notify(ctx, COMMAND_HELP, "info");
		},
	});

	// ─── 命令: /clear（快捷清理）─────────────────────────────────

	pi.registerCommand("clear", {
		description: "立即清理上下文，迁移状态到新 session",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed.length > 0 && trimmed !== "--auto") {
				if (ctx.hasUI) notify(ctx, "Usage: /clear", "warning");
				return;
			}
			await runClear(ctx, trimmed === "--auto" ? "auto" : "manual", ms);
		},
	});
}
