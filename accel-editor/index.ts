/**
 * Accel Editor — Pi input editor long-press acceleration
 *
 * /accel-editor          → 主菜单（居中 overlay，显示 status + 子选项）
 * /accel-editor on       → 启用并持久化
 * /accel-editor off      → 禁用并持久化
 * /accel-editor toggle   → 切换启用状态并持久化
 * /accel-editor status   → 查看状态
 * /accel-editor reset    → 恢复默认配置
 * /accel-editor arrow N  → 设置方向键最大倍率
 * /accel-editor delete N → 设置删除键最大倍率
 * /accel-editor window N → 设置长按识别窗口(ms)
 *
 * UI 规范：对齐 compact-panel / compact-tailor
 *   - 单一主入口 + 子命令
 *   - ctx.ui.custom() overlay
 *   - 手写完整矩形边框
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	CustomEditor,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { matchesKey, Key, truncateToWidth } from "@mariozechner/pi-tui";

interface AccelConfig {
	enabled: boolean;
	arrowMaxMultiplier: number;
	deleteMaxMultiplier: number;
	repeatWindowMs: number;
}

const DEFAULTS: AccelConfig = {
	enabled: false,
	arrowMaxMultiplier: 8,
	deleteMaxMultiplier: 2,
	repeatWindowMs: 120,
};

const STATUS_ID = "accel-editor";
const ARROW_VALUES = [1, 2, 4, 8, 12] as const;
const DELETE_VALUES = [1, 2, 4] as const;
const WINDOW_VALUES = [80, 100, 120, 160, 200] as const;

const OVERLAY = {
	overlay: true,
	overlayOptions: {
		width: "50%",
		minWidth: 52,
		maxHeight: "65%",
		anchor: "center",
	},
} as const;

function getExtDir(): string {
	return path.join(getAgentDir(), "extensions", "accel-editor");
}

function getConfigPath(): string {
	return path.join(getExtDir(), "config.json");
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
	const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseInt(raw, 10) : NaN;
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.round(n)));
}

function loadConfig(): AccelConfig {
	let raw: Partial<AccelConfig> = {};
	try {
		raw = JSON.parse(fs.readFileSync(getConfigPath(), "utf-8"));
	} catch {
		// Missing or invalid config: use defaults.
	}

	return {
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULTS.enabled,
		arrowMaxMultiplier: clampInt(raw.arrowMaxMultiplier, DEFAULTS.arrowMaxMultiplier, 1, 12),
		deleteMaxMultiplier: clampInt(raw.deleteMaxMultiplier, DEFAULTS.deleteMaxMultiplier, 1, 4),
		repeatWindowMs: clampInt(raw.repeatWindowMs, DEFAULTS.repeatWindowMs, 40, 500),
	};
}

function saveConfig(next: AccelConfig): void {
	fs.mkdirSync(getExtDir(), { recursive: true });
	fs.writeFileSync(getConfigPath(), JSON.stringify(next, null, 2) + "\n", "utf-8");
}

function updateConfig(patch: Partial<AccelConfig>): AccelConfig {
	const next = { ...loadConfig(), ...patch };
	const normalized: AccelConfig = {
		enabled: next.enabled,
		arrowMaxMultiplier: clampInt(next.arrowMaxMultiplier, DEFAULTS.arrowMaxMultiplier, 1, 12),
		deleteMaxMultiplier: clampInt(next.deleteMaxMultiplier, DEFAULTS.deleteMaxMultiplier, 1, 4),
		repeatWindowMs: clampInt(next.repeatWindowMs, DEFAULTS.repeatWindowMs, 40, 500),
	};
	saveConfig(normalized);
	return normalized;
}

function notify(ctx: any, msg: string, level: "info" | "success" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(msg, level);
	else console.log(`[accel-editor:${level}] ${msg}`);
}

function cycleValue(values: readonly number[], current: number): number {
	const idx = values.findIndex((v) => v === current);
	return values[(idx + 1) % values.length] ?? values[0]!;
}

function getRepeatMultiplier(repeatCount: number, maxMultiplier: number): number {
	let target = 1;
	if (repeatCount > 45) target = 12;
	else if (repeatCount > 30) target = 8;
	else if (repeatCount > 18) target = 4;
	else if (repeatCount > 8) target = 2;
	return Math.max(1, Math.min(target, maxMultiplier));
}

function isArrowKey(data: string): boolean {
	return matchesKey(data, Key.left) || matchesKey(data, Key.right) || matchesKey(data, Key.up) || matchesKey(data, Key.down);
}

function isDeleteKey(data: string): boolean {
	return matchesKey(data, Key.backspace) || matchesKey(data, Key.delete);
}

class AcceleratedEditor extends CustomEditor {
	private lastKey = "";
	private repeatCount = 0;
	private lastTime = 0;

	handleInput(data: string): void {
		const cfg = loadConfig();
		if (!cfg.enabled) {
			super.handleInput(data);
			return;
		}

		const arrow = isArrowKey(data);
		const del = isDeleteKey(data);
		if (!arrow && !del) {
			this.lastKey = "";
			this.repeatCount = 0;
			super.handleInput(data);
			return;
		}

		const now = Date.now();
		if (data === this.lastKey && now - this.lastTime <= cfg.repeatWindowMs) {
			this.repeatCount++;
		} else {
			this.lastKey = data;
			this.repeatCount = 0;
		}
		this.lastTime = now;

		const maxMultiplier = arrow ? cfg.arrowMaxMultiplier : cfg.deleteMaxMultiplier;
		const multiplier = getRepeatMultiplier(this.repeatCount, maxMultiplier);
		for (let i = 0; i < multiplier; i++) super.handleInput(data);
	}
}

function applyRuntime(ctx: ExtensionContext, cfg = loadConfig()): void {
	if (!ctx.hasUI) return;

	if (cfg.enabled) {
		ctx.ui.setEditorComponent((tui, theme, kb) => new AcceleratedEditor(tui, theme, kb));
		ctx.ui.setStatus(
			STATUS_ID,
			`accel ${cfg.arrowMaxMultiplier}x/${cfg.deleteMaxMultiplier}x ${cfg.repeatWindowMs}ms`,
		);
	} else {
		ctx.ui.setEditorComponent(undefined);
		ctx.ui.setStatus(STATUS_ID, undefined);
	}
}

function statusText(cfg = loadConfig()): string {
	return [
		`enabled=${cfg.enabled ? "on" : "off"}`,
		`arrowMax=${cfg.arrowMaxMultiplier}x`,
		`deleteMax=${cfg.deleteMaxMultiplier}x`,
		`window=${cfg.repeatWindowMs}ms`,
	].join("  ");
}

function borderTop(w: number, theme: any): string {
	return theme.fg("border", `┌${"─".repeat(Math.max(0, w - 2))}┐`);
}

function borderBottom(w: number, theme: any): string {
	return theme.fg("border", `└${"─".repeat(Math.max(0, w - 2))}┘`);
}

function borderMid(w: number, theme: any): string {
	return theme.fg("border", `├${"─".repeat(Math.max(0, w - 2))}┤`);
}

function borderLine(text: string, w: number, theme: any): string {
	const bdr = theme.fg("border", "│");
	const maxC = Math.max(0, w - 4);
	return bdr + " " + truncateToWidth(text + " ".repeat(maxC), maxC, "") + " " + bdr;
}

type MenuId = "toggle" | "arrow" | "delete" | "window" | "reset";

const MENU_ITEMS: Array<{ id: MenuId; label: string; desc: string }> = [
	{ id: "toggle", label: "Toggle", desc: "启用 / 禁用长按加速，并写入 config.json" },
	{ id: "arrow", label: "Arrow Max", desc: "方向键最大倍率: 1x / 2x / 4x / 8x / 12x" },
	{ id: "delete", label: "Delete Max", desc: "删除键最大倍率: 1x / 2x / 4x，建议不要太高" },
	{ id: "window", label: "Repeat Window", desc: "同键连续触发识别窗口，越大越容易进入加速" },
	{ id: "reset", label: "Reset", desc: "恢复默认配置：off / arrow 8x / delete 2x / 120ms" },
];

async function showMainMenu(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		notify(ctx, "交互菜单仅支持 TUI 模式，使用 /accel-editor on|off|toggle|status|reset", "info");
		return;
	}

	let active = true;
	// Keep the menu cursor stable while the panel re-opens after an action.
	// This lets users repeatedly press Enter on Arrow/Delete/Window without
	// navigating back to the same row every time.
	let selected = 0;
	while (active) {
		const cfg = loadConfig();

		const result = await ctx.ui.custom<MenuId | null>((tui, theme, _kb, done) => {
			return {
				render(W: number) {
					const lines: string[] = [];
					lines.push(borderTop(W, theme));
					lines.push(borderLine(theme.fg("accent", theme.bold("Accel Editor")), W, theme));
					lines.push(borderMid(W, theme));

					const enabled = cfg.enabled ? theme.fg("success", "✓ enabled") : theme.fg("dim", "✗ disabled");
					const statusItems = [
						["State", enabled],
						["Arrow Max", theme.fg("text", `${cfg.arrowMaxMultiplier}x`)],
						["Delete Max", theme.fg("text", `${cfg.deleteMaxMultiplier}x`)],
						["Window", theme.fg("text", `${cfg.repeatWindowMs}ms`)],
						["Config", theme.fg("dim", getConfigPath())],
					] as const;

					for (const [label, value] of statusItems) {
						lines.push(borderLine(`${theme.fg("muted", label.padEnd(12))} ${value}`, W, theme));
					}

					lines.push(borderMid(W, theme));
					for (let i = 0; i < MENU_ITEMS.length; i++) {
						const item = MENU_ITEMS[i]!;
						if (i === selected) {
							lines.push(borderLine(theme.fg("accent", `▸ ${theme.bold(item.label)}`), W, theme));
							lines.push(borderLine(theme.fg("muted", `  ${item.desc}`), W, theme));
						} else {
							lines.push(borderLine(theme.fg("text", `  ${item.label}`), W, theme));
						}
					}

					lines.push(borderMid(W, theme));
					lines.push(borderLine(theme.fg("dim", "↑↓ 选择  Enter 确认/循环配置  Esc 关闭"), W, theme));
					lines.push(borderBottom(W, theme));
					return lines;
				},
				invalidate() {},
				handleInput(data: string) {
					if (matchesKey(data, Key.up)) {
						selected = (selected - 1 + MENU_ITEMS.length) % MENU_ITEMS.length;
						tui.requestRender();
					} else if (matchesKey(data, Key.down)) {
						selected = (selected + 1) % MENU_ITEMS.length;
						tui.requestRender();
					} else if (matchesKey(data, Key.enter)) {
						done(MENU_ITEMS[selected]!.id);
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

		if (result === "toggle") {
			const next = updateConfig({ enabled: !loadConfig().enabled });
			applyRuntime(ctx, next);
			notify(ctx, `Accel Editor: ${next.enabled ? "✓ enabled" : "✗ disabled"}`, next.enabled ? "success" : "info");
		} else if (result === "arrow") {
			const next = updateConfig({ arrowMaxMultiplier: cycleValue(ARROW_VALUES, loadConfig().arrowMaxMultiplier) });
			applyRuntime(ctx, next);
			notify(ctx, `Arrow Max: ${next.arrowMaxMultiplier}x`, "success");
		} else if (result === "delete") {
			const next = updateConfig({ deleteMaxMultiplier: cycleValue(DELETE_VALUES, loadConfig().deleteMaxMultiplier) });
			applyRuntime(ctx, next);
			notify(ctx, `Delete Max: ${next.deleteMaxMultiplier}x`, "success");
		} else if (result === "window") {
			const next = updateConfig({ repeatWindowMs: cycleValue(WINDOW_VALUES, loadConfig().repeatWindowMs) });
			applyRuntime(ctx, next);
			notify(ctx, `Repeat Window: ${next.repeatWindowMs}ms`, "success");
		} else if (result === "reset") {
			saveConfig(DEFAULTS);
			applyRuntime(ctx, DEFAULTS);
			notify(ctx, "Accel Editor 已恢复默认配置", "success");
		}
	}
}

function parsePositiveInt(text: string, label: string, min: number, max: number): number | undefined {
	const val = parseInt(text, 10);
	if (!Number.isFinite(val) || val < min || val > max) return undefined;
	return val;
}

const SUB_COMMANDS = ["on", "off", "toggle", "status", "reset", "arrow", "delete", "window"];

const COMMAND_HELP = `Accel Editor 长按加速面板

用法:
  /accel-editor              打开主菜单
  /accel-editor on           启用并持久化
  /accel-editor off          禁用并持久化
  /accel-editor toggle       切换启用状态并持久化
  /accel-editor status       查看当前配置
  /accel-editor reset        恢复默认配置
  /accel-editor arrow <n>    设置方向键最大倍率，1-12
  /accel-editor delete <n>   设置删除键最大倍率，1-4
  /accel-editor window <ms>  设置长按识别窗口，40-500ms`;

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		applyRuntime(ctx, loadConfig());
	});

	pi.registerCommand("accel-editor", {
		description: "Accel Editor 主面板: 长按方向键/删除键加速",
		getArgumentCompletions: (prefix: string) => {
			const items = SUB_COMMANDS
				.filter((s) => s.startsWith(prefix.trim()))
				.map((s) => ({ value: s, label: s }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const sub = args.trim();
			if (!sub) {
				await showMainMenu(ctx);
				return;
			}

			if (sub === "on") {
				const next = updateConfig({ enabled: true });
				applyRuntime(ctx, next);
				notify(ctx, "Accel Editor: ✓ enabled", "success");
				return;
			}
			if (sub === "off") {
				const next = updateConfig({ enabled: false });
				applyRuntime(ctx, next);
				notify(ctx, "Accel Editor: ✗ disabled", "info");
				return;
			}
			if (sub === "toggle") {
				const next = updateConfig({ enabled: !loadConfig().enabled });
				applyRuntime(ctx, next);
				notify(ctx, `Accel Editor: ${next.enabled ? "✓ enabled" : "✗ disabled"}`, next.enabled ? "success" : "info");
				return;
			}
			if (sub === "status") {
				notify(ctx, statusText(), "info");
				return;
			}
			if (sub === "reset") {
				saveConfig(DEFAULTS);
				applyRuntime(ctx, DEFAULTS);
				notify(ctx, "Accel Editor 已恢复默认配置", "success");
				return;
			}

			if (sub === "arrow" || sub.startsWith("arrow ")) {
				const raw = sub.slice("arrow".length).trim();
				if (!raw) {
					const next = updateConfig({ arrowMaxMultiplier: cycleValue(ARROW_VALUES, loadConfig().arrowMaxMultiplier) });
					applyRuntime(ctx, next);
					notify(ctx, `Arrow Max: ${next.arrowMaxMultiplier}x`, "success");
					return;
				}
				const val = parsePositiveInt(raw, "arrow", 1, 12);
				if (val === undefined) {
					notify(ctx, "无效 arrow 值：范围 1-12", "error");
					return;
				}
				const next = updateConfig({ arrowMaxMultiplier: val });
				applyRuntime(ctx, next);
				notify(ctx, `Arrow Max: ${next.arrowMaxMultiplier}x`, "success");
				return;
			}

			if (sub === "delete" || sub.startsWith("delete ")) {
				const raw = sub.slice("delete".length).trim();
				if (!raw) {
					const next = updateConfig({ deleteMaxMultiplier: cycleValue(DELETE_VALUES, loadConfig().deleteMaxMultiplier) });
					applyRuntime(ctx, next);
					notify(ctx, `Delete Max: ${next.deleteMaxMultiplier}x`, "success");
					return;
				}
				const val = parsePositiveInt(raw, "delete", 1, 4);
				if (val === undefined) {
					notify(ctx, "无效 delete 值：范围 1-4", "error");
					return;
				}
				const next = updateConfig({ deleteMaxMultiplier: val });
				applyRuntime(ctx, next);
				notify(ctx, `Delete Max: ${next.deleteMaxMultiplier}x`, "success");
				return;
			}

			if (sub === "window" || sub.startsWith("window ")) {
				const raw = sub.slice("window".length).trim();
				if (!raw) {
					const next = updateConfig({ repeatWindowMs: cycleValue(WINDOW_VALUES, loadConfig().repeatWindowMs) });
					applyRuntime(ctx, next);
					notify(ctx, `Repeat Window: ${next.repeatWindowMs}ms`, "success");
					return;
				}
				const val = parsePositiveInt(raw, "window", 40, 500);
				if (val === undefined) {
					notify(ctx, "无效 window 值：范围 40-500ms", "error");
					return;
				}
				const next = updateConfig({ repeatWindowMs: val });
				applyRuntime(ctx, next);
				notify(ctx, `Repeat Window: ${next.repeatWindowMs}ms`, "success");
				return;
			}

			notify(ctx, COMMAND_HELP, "info");
		},
	});
}
