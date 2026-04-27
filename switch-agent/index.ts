import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { matchesKey, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import type { AutocompleteItem, Component, TUI, Theme } from "@mariozechner/pi-tui";

type AgentSource = "user" | "project";

interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	welcomeMessage?: string;
	prompt: string;
	source: AgentSource;
	filePath: string;
}

interface ModelRef {
	provider: string;
	id: string;
}

interface PersistedState {
	activeAgent: string | null;
	fallbackModel?: ModelRef;
	fallbackTools?: string[];
}

const STATE_ENTRY = "switch-agent-state";
const WIDGET_ID = "switch-agent";
const WELCOME_TYPE = "switch-agent-welcome";

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const values = value.map((item) => String(item).trim()).filter(Boolean);
		return values.length > 0 ? values : undefined;
	}
	if (typeof value === "string") {
		const values = value
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
		return values.length > 0 ? values : undefined;
	}
	return undefined;
}

function isDirectory(targetPath: string): boolean {
	try {
		return fs.statSync(targetPath).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

function warnAgentNameMismatch(filePath: string, directoryName: string, frontmatterName: string) {
	console.warn(
		`Agent directory name "${directoryName}" does not match AGENT.md frontmatter name "${frontmatterName}" in ${filePath}; using directory name.`,
	);
}

function parseAgentFile(filePath: string, source: AgentSource, nameOverride?: string): AgentConfig | null {
	let content = "";
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		return null;
	}

	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
	const frontmatterName = asString(frontmatter.name);
	const name = nameOverride ?? frontmatterName;
	if (!name) return null;

	if (nameOverride && frontmatterName && frontmatterName !== nameOverride) {
		warnAgentNameMismatch(filePath, nameOverride, frontmatterName);
	}

	const description = asString(frontmatter.description) ?? "";
	const tools = asStringArray(frontmatter.tools);
	const model = asString(frontmatter.model);
	const welcomeMessage = asString(frontmatter.welcomeMessage);
	const prompt = body.trim();

	return {
		name,
		description,
		tools,
		model,
		welcomeMessage,
		prompt,
		source,
		filePath,
	};
}

function collectDirectoryAgents(dir: string, source: AgentSource, resultByName: Map<string, AgentConfig>) {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return;
	}

	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name);
		if (!isDirectory(entryPath)) continue;

		const agentFilePath = path.join(entryPath, "AGENT.md");
		if (fs.existsSync(agentFilePath)) {
			const agent = parseAgentFile(agentFilePath, source, entry.name);
			if (agent) resultByName.set(agent.name, agent);
			continue;
		}

		collectDirectoryAgents(entryPath, source, resultByName);
	}
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	if (!isDirectory(dir)) return [];

	const resultByName = new Map<string, AgentConfig>();
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return [];
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const agent = parseAgentFile(path.join(dir, entry.name), source);
		if (agent) resultByName.set(agent.name, agent);
	}

	collectDirectoryAgents(dir, source, resultByName);

	return Array.from(resultByName.values());
}

function discoverAgents(cwd: string): AgentConfig[] {
	const userDir = path.join(getAgentDir(), "agents");
	const projectDir = findNearestProjectAgentsDir(cwd);
	const userAgents = loadAgentsFromDir(userDir, "user");
	const projectAgents = projectDir ? loadAgentsFromDir(projectDir, "project") : [];

	const byName = new Map<string, AgentConfig>();
	for (const agent of userAgents) byName.set(agent.name, agent);
	for (const agent of projectAgents) byName.set(agent.name, agent);

	return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function resolveModelRef(ctx: ExtensionContext, modelSpec: string): ModelRef | null {
	if (modelSpec.includes("/")) {
		const [provider, ...rest] = modelSpec.split("/");
		const id = rest.join("/").trim();
		if (!provider || !id) return null;
		return { provider: provider.trim(), id };
	}

	if (ctx.model) {
		return { provider: ctx.model.provider, id: modelSpec.trim() };
	}

	return null;
}

function readPersistedState(ctx: ExtensionContext): PersistedState | null {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as any;
		if (entry?.type === "custom" && entry?.customType === STATE_ENTRY) {
			const data = entry.data as PersistedState | undefined;
			if (!data) return null;
			return {
				activeAgent: data.activeAgent ?? null,
				fallbackModel: data.fallbackModel,
				fallbackTools: data.fallbackTools,
			};
		}
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	let activeAgent: AgentConfig | null = null;
	let fallbackModel: ModelRef | null = null;
	let fallbackTools: string[] | null = null;

	function persistState(activeAgentName: string | null) {
		pi.appendEntry(STATE_ENTRY, {
			activeAgent: activeAgentName,
			fallbackModel: fallbackModel ?? undefined,
			fallbackTools: fallbackTools ?? undefined,
		});
	}

	function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") {
		if (ctx.hasUI) ctx.ui.notify(message, level);
		else console.log(`[switch-agent:${level}] ${message}`);
	}

	function updateWidget(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (!activeAgent) {
			ctx.ui.setWidget(WIDGET_ID, undefined);
			return;
		}

		const source = activeAgent.source === "project" ? "project" : "user";
		ctx.ui.setWidget(WIDGET_ID, [`🤖 Agent: ${activeAgent.name} [${source}]`]);
	}

	function availableToolNames(): Set<string> {
		return new Set(pi.getAllTools().map((tool) => tool.name));
	}

	function captureFallback(ctx: ExtensionContext) {
		fallbackTools = [...pi.getActiveTools()];
		fallbackModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null;
	}

	function restoreFallbackTools() {
		if (fallbackTools && fallbackTools.length > 0) {
			pi.setActiveTools(fallbackTools);
		}
	}

	async function restoreFallbackModel(ctx: ExtensionContext) {
		if (!fallbackModel) return;
		const model = ctx.modelRegistry.find(fallbackModel.provider, fallbackModel.id);
		if (!model) {
			notify(ctx, `找不到默认模型 ${fallbackModel.provider}/${fallbackModel.id}`,"warning");
			return;
		}
		const success = await pi.setModel(model);
		if (!success) {
			notify(ctx, `无法恢复默认模型 ${fallbackModel.provider}/${fallbackModel.id}`, "warning");
		}
	}

	async function applyAgent(
		agent: AgentConfig,
		ctx: ExtensionContext,
		options: { persist: boolean; notify: boolean; captureFallback: boolean },
	) {
		if (options.captureFallback) {
			captureFallback(ctx);
		}

		if (agent.tools && agent.tools.length > 0) {
			const knownTools = availableToolNames();
			const validTools = agent.tools.filter((tool) => knownTools.has(tool));
			const invalidTools = agent.tools.filter((tool) => !knownTools.has(tool));
			if (validTools.length === 0) {
				notify(ctx, `Agent ${agent.name} 的 tools 无法识别：${agent.tools.join(", ")}`, "error");
				return;
			}
			pi.setActiveTools(validTools);
			if (invalidTools.length > 0) {
				notify(ctx, `忽略未知 tools：${invalidTools.join(", ")}`, "warning");
			}
		} else {
			restoreFallbackTools();
		}

		if (agent.model) {
			const modelRef = resolveModelRef(ctx, agent.model);
			if (!modelRef) {
				notify(ctx, `无法解析 agent model：${agent.model}，保留当前模型`, "warning");
			} else {
				const model = ctx.modelRegistry.find(modelRef.provider, modelRef.id);
				if (!model) {
					notify(ctx, `找不到模型 ${agent.model}，保留当前模型`, "warning");
				} else {
					const success = await pi.setModel(model);
					if (!success) {
						notify(ctx, `无法切换到模型 ${agent.model}（可能缺少鉴权），保留当前模型`, "warning");
					}
				}
			}
		} else {
			await restoreFallbackModel(ctx);
		}

		activeAgent = agent;
		updateWidget(ctx);
		if (options.persist) persistState(agent.name);
		if (options.notify) {
			if (agent.welcomeMessage) {
				pi.sendMessage({
					customType: WELCOME_TYPE,
					content: agent.welcomeMessage,
					display: true,
				});
			} else {
				notify(ctx, `Switched to agent: ${agent.name}`, "info");
			}
		}
	}

	async function switchToDefault(ctx: ExtensionContext, options: { persist: boolean; notify: boolean }) {
		restoreFallbackTools();
		await restoreFallbackModel(ctx);

		activeAgent = null;
		updateWidget(ctx);
		if (options.persist) persistState(null);
		if (options.notify) {
			notify(ctx, "Switched to default agent", "info");
		}
	}

	// --- Selector UI helpers (overlay panel style) ---

	const SELECTOR_VIEWPORT = 8;
	const OVERLAY_WIDTH = 84;

	function selectorPad(s: string, len: number): string {
		return s + " ".repeat(Math.max(0, len - visibleWidth(s)));
	}

	function selectorRow(content: string, width: number, theme: Theme): string {
		const innerW = width - 2;
		return theme.fg("border", "│") + selectorPad(content, innerW) + theme.fg("border", "│");
	}

	function selectorHeader(text: string, width: number, theme: Theme): string {
		const innerW = width - 2;
		const padLen = Math.max(0, innerW - visibleWidth(text));
		const padLeft = Math.floor(padLen / 2);
		const padRight = padLen - padLeft;
		return (
			theme.fg("border", "╭" + "─".repeat(padLeft)) +
			theme.fg("accent", text) +
			theme.fg("border", "─".repeat(padRight) + "╮")
		);
	}

	function selectorFooter(text: string, width: number, theme: Theme): string {
		const innerW = width - 2;
		const padLen = Math.max(0, innerW - visibleWidth(text));
		const padLeft = Math.floor(padLen / 2);
		const padRight = padLen - padLeft;
		return (
			theme.fg("border", "╰" + "─".repeat(padLeft)) +
			theme.fg("dim", text) +
			theme.fg("border", "─".repeat(padRight) + "╯")
		);
	}

	interface SelectorItem {
		name: string;
		description: string;
		model?: string;
		source: AgentSource;
		isActive: boolean;
	}

	class AgentSelectorComponent implements Component {
		private tui: TUI;
		private theme: Theme;
		private done: (result: string | undefined) => void;
		private items: SelectorItem[];
		private filtered: SelectorItem[];
		private cursor = 0;
		private scrollOffset = 0;
		private filterQuery = "";
		private width: number;

		constructor(
			tui: TUI,
			theme: Theme,
			items: SelectorItem[],
			done: (result: string | undefined) => void,
		) {
			this.tui = tui;
			this.theme = theme;
			this.done = done;
			this.items = items;
			this.filtered = items;
			this.width = OVERLAY_WIDTH;
		}

		private applyFilter(): void {
			const q = this.filterQuery.trim().toLowerCase();
			if (!q) {
				this.filtered = this.items;
			} else {
				this.filtered = this.items.filter(
					(item) =>
						item.name.toLowerCase().includes(q) ||
						item.description.toLowerCase().includes(q),
				);
			}
			this.cursor = 0;
			this.scrollOffset = 0;
		}

		private clampCursor(): void {
			const f = this.filtered;
			if (f.length === 0) {
				this.cursor = 0;
				this.scrollOffset = 0;
				return;
			}
			this.cursor = Math.max(0, Math.min(this.cursor, f.length - 1));
			const maxOffset = Math.max(0, f.length - SELECTOR_VIEWPORT);
			this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
			if (this.cursor < this.scrollOffset) this.scrollOffset = this.cursor;
			else if (this.cursor >= this.scrollOffset + SELECTOR_VIEWPORT) this.scrollOffset = this.cursor - SELECTOR_VIEWPORT + 1;
		}

		handleInput(data: string): void {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
				if (this.filterQuery.length > 0) {
					this.filterQuery = "";
					this.applyFilter();
					this.tui.requestRender();
					return;
				}
				this.done(undefined);
				return;
			}

			if (matchesKey(data, "return")) {
				if (this.filtered.length > 0) {
					const item = this.filtered[this.cursor];
					this.done(item?.name);
				} else {
					this.done(undefined);
				}
				return;
			}

			if (matchesKey(data, "up")) {
				this.cursor -= 1;
				this.clampCursor();
				this.tui.requestRender();
				return;
			}

			if (matchesKey(data, "down")) {
				this.cursor += 1;
				this.clampCursor();
				this.tui.requestRender();
				return;
			}

			if (matchesKey(data, "backspace")) {
				if (this.filterQuery.length > 0) {
					this.filterQuery = this.filterQuery.slice(0, -1);
					this.applyFilter();
					this.tui.requestRender();
				}
				return;
			}

			if (data.length === 1 && data.charCodeAt(0) >= 32) {
				this.filterQuery += data;
				this.applyFilter();
				this.tui.requestRender();
				return;
			}
		}

		render(width: number): string[] {
			const w = Math.min(width, OVERLAY_WIDTH);
			const th = this.theme;
			const lines: string[] = [];

			const f = this.filtered;
			const cursor = f.length === 0 ? 0 : Math.max(0, Math.min(this.cursor, f.length - 1));
			const maxOffset = Math.max(0, f.length - SELECTOR_VIEWPORT);
			const scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
			const adjustedScroll = cursor < scrollOffset ? cursor
				: cursor >= scrollOffset + SELECTOR_VIEWPORT ? cursor - SELECTOR_VIEWPORT + 1
				: scrollOffset;

			const agentCount = this.items.filter((i) => i.name !== "default").length;
			lines.push(selectorHeader(` Switch Agent [${agentCount}] `, w, th));
			lines.push(selectorRow("", w, th));

			// Search bar
			const cursorCh = th.fg("accent", "│");
			const searchIcon = th.fg("dim", "◎");
			const placeholder = th.fg("dim", "\x1b[3mtype to filter...\x1b[23m");
			const queryDisplay = this.filterQuery ? `${this.filterQuery}${cursorCh}` : `${cursorCh}${placeholder}`;
			lines.push(selectorRow(` ${searchIcon}  ${queryDisplay}`, w, th));
			lines.push(selectorRow("", w, th));

			// Agent list
			const innerW = w - 2;
			const nameWidth = 18;
			const modelWidth = 12;
			const scopeWidth = 8;

			const startIdx = adjustedScroll;
			const endIdx = f.length === 0 ? 0 : Math.min(f.length, startIdx + SELECTOR_VIEWPORT);
			const visible = f.slice(startIdx, endIdx);

			if (f.length === 0) {
				lines.push(selectorRow(` ${th.fg("dim", "No matching agents")}`, w, th));
				for (let i = 1; i < SELECTOR_VIEWPORT; i++) lines.push(selectorRow("", w, th));
			} else {
				for (let i = 0; i < visible.length; i++) {
					const item = visible[i]!;
					const index = startIdx + i;
					const isCursor = index === cursor;
		
					const cursorChar = isCursor ? th.fg("accent", ">") : " ";
					const activeMarker = item.isActive ? th.fg("accent", "●") : " ";
		
					const nameText = isCursor ? th.fg("accent", item.name) : item.name;
		
					const modelRaw = item.model ?? "default";
					const modelDisplay = modelRaw.includes("/") ? modelRaw.split("/").pop() ?? modelRaw : modelRaw;
					const modelText = th.fg("dim", modelDisplay);

					const scopeLabel = item.name === "default"
						? "[default]"
						: `[${item.source === "project" ? "proj" : "user"}]`;
					const scopeBadge = th.fg("dim", scopeLabel);

					const descWidth = Math.max(0, innerW - 3 - nameWidth - modelWidth - scopeWidth - 4);
					const descClean = item.description.replace(/[\r\n]+/g, " ");
					const descText = th.fg("dim", descClean);

					const line =
						`${cursorChar}${activeMarker} ` +
						selectorPad(nameText, nameWidth) + " " +
						selectorPad(modelText, modelWidth) + " " +
						selectorPad(scopeBadge, scopeWidth) + " " +
						truncateToWidth(descText, descWidth);

					lines.push(selectorRow(` ${line}`, w, th));
				}

				for (let i = visible.length; i < SELECTOR_VIEWPORT; i++) {
					lines.push(selectorRow("", w, th));
				}
			}

			// Status line
			lines.push(selectorRow("", w, th));
			const cursorItem = f[cursor];
			const desc = cursorItem ? cursorItem.description.replace(/[\r\n]+/g, " ") : "";
			let scrollInfo = "";
			if (adjustedScroll > 0) scrollInfo += `↑ ${adjustedScroll} more`;
			if (endIdx < f.length) scrollInfo += `${scrollInfo ? "  " : ""}↓ ${f.length - endIdx} more`;
			const statusContent = desc || scrollInfo;
			lines.push(selectorRow(statusContent ? ` ${th.fg("dim", statusContent)}` : "", w, th));
			lines.push(selectorRow("", w, th));

			// Footer
			lines.push(selectorFooter(" [enter] switch  [esc] close ", w, th));

			return lines;
		}

		invalidate(): void {}
		dispose(): void {}
	}

	async function showAgentSelector(ctx: ExtensionContext): Promise<string | null> {
		const agents = discoverAgents(ctx.cwd);
		if (agents.length === 0) {
			notify(ctx, "未发现 agent。可放在 ~/.pi/agent/agents/*.md、~/.pi/agent/agents/*/AGENT.md、.pi/agents/*.md 或 .pi/agents/*/AGENT.md", "warning");
			return null;
		}

		const items: SelectorItem[] = [
			{
				name: "default",
				description: "restore session defaults",
				isActive: !activeAgent,
				source: "user" as AgentSource,
			},
			...agents.map((agent) => ({
				name: agent.name,
				description: agent.description || "",
				model: agent.model,
				source: agent.source,
				isActive: activeAgent?.name === agent.name,
			})),
		];

		try {
			const result = await ctx.ui.custom<string | undefined>(
				(tui, theme, _kb, done) =>
					new AgentSelectorComponent(tui, theme, items, done),
				{ overlay: true, overlayOptions: { anchor: "center", width: OVERLAY_WIDTH, maxHeight: "80%" } },
			);
			return result ?? null;
		} catch {
			return null;
		}
	}

	function renderAgentList(cwd: string): string {
		const agents = discoverAgents(cwd);
		if (agents.length === 0) {
			return "未发现 agent。可放在 ~/.pi/agent/agents/*.md、~/.pi/agent/agents/*/AGENT.md、.pi/agents/*.md 或 .pi/agents/*/AGENT.md";
		}

		const lines = [
			activeAgent ? `当前 active agent: ${activeAgent.name}` : "当前 active agent: default",
			"",
			"Available agents:",
		];

		for (const agent of agents) {
			const marker = activeAgent?.name === agent.name ? "*" : "-";
			const source = agent.source === "project" ? "project" : "user";
			const desc = agent.description ? ` — ${agent.description}` : "";
			lines.push(`${marker} ${agent.name} [${source}]${desc}`);
		}

		lines.push("", "用法: /agent <name>  或  /agent default");
		return lines.join("\n");
	}

	function parseAgentArg(rawArgs: string): string | null {
		const trimmed = rawArgs.trim();
		if (!trimmed) return null;
		const parts = trimmed.split(/\s+/);
		if ((parts[0] === "switch" || parts[0] === "swap") && parts[1]) {
			return parts[1];
		}
		return parts[0];
	}

	pi.on("session_start", async (_event, ctx) => {
		activeAgent = null;
		fallbackTools = [...pi.getActiveTools()];
		fallbackModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null;
		updateWidget(ctx);

		const state = readPersistedState(ctx);
		if (!state || !state.activeAgent) return;

		fallbackTools = state.fallbackTools && state.fallbackTools.length > 0 ? state.fallbackTools : fallbackTools;
		fallbackModel = state.fallbackModel ?? fallbackModel;

		const agents = discoverAgents(ctx.cwd);
		const restoredAgent = agents.find((agent) => agent.name === state.activeAgent);
		if (!restoredAgent) {
			notify(ctx, `恢复失败：找不到 agent ${state.activeAgent}，已回到 default`, "warning");
			persistState(null);
			return;
		}

		await applyAgent(restoredAgent, ctx, { persist: false, notify: true, captureFallback: false });
	});

	pi.on("model_select", async (event) => {
		if (!activeAgent) {
			fallbackModel = { provider: event.model.provider, id: event.model.id };
		}
	});

	pi.on("context", async (event) => {
		const filtered = event.messages.filter(
			(m: any) => !(m.customType === WELCOME_TYPE),
		);
		return { messages: filtered };
	});

	pi.registerMessageRenderer(WELCOME_TYPE, {
		renderMessage(event: any) {
			const text = typeof event.message?.content === "string"
				? event.message.content
				: "";
			return { lines: [{ text: `💬 ${text}` }] };
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (!activeAgent || !activeAgent.prompt) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n[Active agent: ${activeAgent.name}]\n${activeAgent.prompt}`,
		};
	});

	pi.registerCommand("switch-agent", {
		description: "Switch main-session agent identity from ~/.pi/agent/agents/*.md, ~/.pi/agent/agents/*/AGENT.md, .pi/agents/*.md, or .pi/agents/*/AGENT.md",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const candidates = [
				{ value: "default", label: "default", description: "restore session defaults" },
				...discoverAgents(process.cwd()).map((agent) => ({
					value: agent.name,
					label: agent.name,
					description: agent.description || undefined,
				})),
			];
			const filtered = candidates.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			let target = parseAgentArg(args);
			if (!target) {
				target = await showAgentSelector(ctx);
				if (!target) return;
			}

			if (target === "list" || target === "status") {
				notify(ctx, renderAgentList(ctx.cwd), "info");
				return;
			}

			if (target === "default" || target === "off" || target === "clear") {
				await switchToDefault(ctx, { persist: true, notify: true });
				return;
			}

			const agents = discoverAgents(ctx.cwd);
			const agent = agents.find((item) => item.name === target);
			if (!agent) {
				notify(ctx, `找不到 agent: ${target}`, "error");
				notify(ctx, renderAgentList(ctx.cwd), "info");
				return;
			}

			await applyAgent(agent, ctx, {
				persist: true,
				notify: true,
				captureFallback: !activeAgent,
			});
		},
	});
}
