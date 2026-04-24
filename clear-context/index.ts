import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";

const STATE_ENTRY_TYPE = "clear-context-state";
const STATUS_ID = "clear-context";
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const BUSY_RETRY_MS = 15 * 1000;
const AUTO_CLEAR_COMMAND = "/clear --auto";

type PersistedState = {
	enabled: boolean;
	lastClearAt: number | null;
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
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

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

export default function (pi: ExtensionAPI) {
	let state: PersistedState = { ...DEFAULT_STATE };
	let lastActivityAt = Date.now();
	let timer: ReturnType<typeof setTimeout> | null = null;
	let currentCtx: ExtensionContext | null = null;
	let shuttingDown = false;
	let autoClearQueued = false;

	const persistOwnState = () => {
		pi.appendEntry(STATE_ENTRY_TYPE, {
			enabled: state.enabled,
			lastClearAt: state.lastClearAt,
			savedAt: Date.now(),
		});
	};

	const getFallbackContextCount = (ctx: ExtensionContext): number => {
		const branch = ctx.sessionManager.getBranch() as SessionEntryLike[];
		let count = 0;
		for (const entry of branch) {
			if (entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary" || entry.type === "compaction") {
				count++;
			}
		}
		return count;
	};

	const getContextTokenCount = (ctx: ExtensionContext): number => {
		const usage = ctx.getContextUsage();
		if (usage && typeof usage.tokens === "number" && Number.isFinite(usage.tokens)) {
			return Math.max(0, usage.tokens);
		}
		return getFallbackContextCount(ctx) > 0 ? 1 : 0;
	};

	const isClean = (ctx: ExtensionContext): boolean => getContextTokenCount(ctx) === 0;

	const updateStatus = (ctx: ExtensionContext | null) => {
		if (!ctx?.hasUI) return;
		const theme = ctx.ui.theme;
		const autoText = state.enabled ? theme.fg("success", "auto:on") : theme.fg("dim", "auto:off");
		const contextText = isClean(ctx)
			? theme.fg("success", "context:0")
			: theme.fg("warning", `context:${getContextTokenCount(ctx)}`);
		const idleText = state.enabled
			? theme.fg("dim", ` idle:${formatRelativeDuration(Math.max(0, IDLE_TIMEOUT_MS - (Date.now() - lastActivityAt)))}`)
			: "";
		ctx.ui.setStatus(STATUS_ID, `${autoText} ${contextText}${idleText}`.trim());
	};

	const clearScheduledTimer = () => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	};

	const scheduleAutoClear = (ctx: ExtensionContext | null) => {
		clearScheduledTimer();
		if (shuttingDown || !state.enabled || ctx === null) {
			updateStatus(ctx);
			return;
		}
		const elapsed = Date.now() - lastActivityAt;
		const delay = Math.max(0, IDLE_TIMEOUT_MS - elapsed);
		timer = setTimeout(() => {
			void maybeAutoClear();
		}, delay);
		updateStatus(ctx);
	};

	const touch = (ctx: ExtensionContext) => {
		currentCtx = ctx;
		lastActivityAt = Date.now();
		scheduleAutoClear(ctx);
	};

	const restoreStateFromSession = (ctx: ExtensionContext) => {
		state = { ...DEFAULT_STATE };
		const branch = ctx.sessionManager.getBranch() as SessionEntryLike[];
		for (const entry of branch) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE || !isRecord(entry.data)) continue;
			state = {
				enabled: entry.data.enabled === true,
				lastClearAt: asFiniteNumber(entry.data.lastClearAt),
			};
		}
	};

	const buildStatusMessage = (ctx: ExtensionContext): string => {
		return [
			`auto-clear: ${state.enabled ? "enabled" : "disabled"}`,
			`context tokens: ${getContextTokenCount(ctx)}`,
			`session state: ${isClean(ctx) ? "clean" : "dirty"}`,
			`idle window: ${Math.round(IDLE_TIMEOUT_MS / 60000)} minutes`,
			`last clear: ${formatTimestamp(state.lastClearAt)}`,
		].join("\n");
	};

	const collectMigratedState = (ctx: ExtensionCommandContext): MigratedState => {
		const branch = ctx.sessionManager.getBranch() as SessionEntryLike[];
		const customEntries: Array<{ customType: string; data: unknown }> = [];
		let latestSessionName: string | undefined;
		let latestModel: { provider: string; modelId: string } | undefined;
		let latestThinkingLevel: string | undefined;

		for (const entry of branch) {
			if (entry.type === "custom" && typeof entry.customType === "string" && entry.customType !== STATE_ENTRY_TYPE) {
				customEntries.push({ customType: entry.customType, data: entry.data });
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

			if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
				latestThinkingLevel = entry.thinkingLevel;
			}
		}

		if (ctx.model && typeof ctx.model.provider === "string" && typeof ctx.model.id === "string") {
			latestModel = { provider: ctx.model.provider, modelId: ctx.model.id };
		}

		const thinkingLevel = pi.getThinkingLevel();
		if (typeof thinkingLevel === "string") {
			latestThinkingLevel = thinkingLevel;
		}

		const sessionName = ctx.sessionManager.getSessionName() ?? latestSessionName;
		return {
			customEntries,
			sessionName: sessionName || undefined,
			model: latestModel,
			thinkingLevel: latestThinkingLevel,
		};
	};

	const runClear = async (ctx: ExtensionCommandContext, source: "manual" | "auto") => {
		touch(ctx);
		autoClearQueued = false;
		await ctx.waitForIdle();

		if (isClean(ctx)) {
			if (ctx.hasUI && source === "manual") {
				ctx.ui.notify("Session is already clean (context window is 0)", "info");
			}
			updateStatus(ctx);
			return;
		}

		const migratedState = collectMigratedState(ctx);
		const parentSession = ctx.sessionManager.getSessionFile();
		const nextClearState: PersistedState = {
			enabled: state.enabled,
			lastClearAt: Date.now(),
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
					savedAt: Date.now(),
				});

				if (migratedState.sessionName) {
					sm.appendSessionInfo(migratedState.sessionName);
				}

				if (migratedState.model) {
					sm.appendModelChange(migratedState.model.provider, migratedState.model.modelId);
				}

				if (migratedState.thinkingLevel) {
					sm.appendThinkingLevelChange(migratedState.thinkingLevel);
				}
			},
			withSession: async (nextCtx) => {
				if (nextCtx.hasUI) {
					nextCtx.ui.notify(
						source === "manual"
							? "Started a clean replacement session and migrated persisted state"
							: "Auto-clear created a clean replacement session and migrated persisted state",
						"success",
					);
				}
			},
		});

		if (result.cancelled && ctx.hasUI) {
			ctx.ui.notify(source === "manual" ? "Clear cancelled" : "Auto-clear cancelled", "info");
		}
	};

	const maybeAutoClear = async () => {
		if (shuttingDown || !state.enabled || currentCtx === null || autoClearQueued) return;
		if (!currentCtx.isIdle() || currentCtx.hasPendingMessages()) {
			clearScheduledTimer();
			timer = setTimeout(() => {
				void maybeAutoClear();
			}, BUSY_RETRY_MS);
			updateStatus(currentCtx);
			return;
		}
		if (isClean(currentCtx)) {
			updateStatus(currentCtx);
			scheduleAutoClear(currentCtx);
			return;
		}
		autoClearQueued = true;
		pi.sendUserMessage(AUTO_CLEAR_COMMAND);
	};

	pi.on("session_start", async (_event, ctx) => {
		shuttingDown = false;
		autoClearQueued = false;
		currentCtx = ctx;
		restoreStateFromSession(ctx);
		lastActivityAt = Date.now();
		scheduleAutoClear(ctx);
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		shuttingDown = true;
		autoClearQueued = false;
		clearScheduledTimer();
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_ID, "");
	});

	pi.on("input", async (_event, ctx) => {
		touch(ctx);
		return { action: "continue" as const };
	});
	pi.on("user_bash", async (_event, ctx) => touch(ctx));
	pi.on("before_agent_start", async (_event, ctx) => touch(ctx));
	pi.on("turn_start", async (_event, ctx) => touch(ctx));
	pi.on("turn_end", async (_event, ctx) => touch(ctx));
	pi.on("message_start", async (_event, ctx) => touch(ctx));
	pi.on("message_update", async (_event, ctx) => touch(ctx));
	pi.on("message_end", async (_event, ctx) => touch(ctx));
	pi.on("tool_execution_start", async (_event, ctx) => touch(ctx));
	pi.on("tool_execution_update", async (_event, ctx) => touch(ctx));
	pi.on("tool_execution_end", async (_event, ctx) => touch(ctx));

	pi.registerCommand("clear", {
		description: "Start a clean replacement session and migrate persisted state",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed.length > 0 && trimmed !== "--auto") {
				if (ctx.hasUI) ctx.ui.notify("Usage: /clear", "warning");
				return;
			}
			await runClear(ctx, trimmed === "--auto" ? "auto" : "manual");
		},
	});

	pi.registerCommand("clear-auto", {
		description: "Manage auto-clear: on | off | status | toggle",
		handler: async (args, ctx) => {
			touch(ctx);
			autoClearQueued = false;
			const action = args.trim().toLowerCase();

			if (action === "" || action === "status") {
				if (ctx.hasUI) ctx.ui.notify(buildStatusMessage(ctx), "info");
				return;
			}

			if (action === "on") {
				if (!state.enabled) {
					state = { ...state, enabled: true };
					persistOwnState();
				}
				lastActivityAt = Date.now();
				scheduleAutoClear(ctx);
				if (ctx.hasUI) ctx.ui.notify("Auto-clear enabled (10 minute idle timeout)", "success");
				return;
			}

			if (action === "off") {
				if (state.enabled) {
					state = { ...state, enabled: false };
					persistOwnState();
				}
				clearScheduledTimer();
				updateStatus(ctx);
				if (ctx.hasUI) ctx.ui.notify("Auto-clear disabled", "info");
				return;
			}

			if (action === "toggle") {
				state = { ...state, enabled: !state.enabled };
				persistOwnState();
				lastActivityAt = Date.now();
				scheduleAutoClear(ctx);
				if (ctx.hasUI) {
					ctx.ui.notify(
						state.enabled ? "Auto-clear enabled (10 minute idle timeout)" : "Auto-clear disabled",
						state.enabled ? "success" : "info",
					);
				}
				return;
			}

			if (ctx.hasUI) ctx.ui.notify("Usage: /clear-auto on | off | status | toggle", "warning");
		},
	});
}
