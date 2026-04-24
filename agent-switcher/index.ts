import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { Container, Text, getKeybindings } from "@mariozechner/pi-tui";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

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

const STATE_ENTRY = "agent-switcher-state";
const WIDGET_ID = "agent-switcher";

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

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	if (!isDirectory(dir)) return [];

	const result: AgentConfig[] = [];
	const entries = fs.readdirSync(dir, { withFileTypes: true });

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content = "";
		try {
			content = fs.readFileSync(filePath, "utf8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
		const name = asString(frontmatter.name);
		if (!name) continue;
		const description = asString(frontmatter.description) ?? "";
		const tools = asStringArray(frontmatter.tools);
		const model = asString(frontmatter.model);
		const welcomeMessage = asString(frontmatter.welcomeMessage);
		const prompt = body.trim();

		result.push({
			name,
			description,
			tools,
			model,
			welcomeMessage,
			prompt,
			source,
			filePath,
		});
	}

	return result;
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
		else console.log(`[agent-switcher:${level}] ${message}`);
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
			notify(ctx, agent.welcomeMessage ?? `Switched to agent: ${agent.name}`, "info");
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

	async function showAgentSelector(ctx: ExtensionContext): Promise<string | null> {
		const agents = discoverAgents(ctx.cwd);
		if (agents.length === 0) {
			notify(ctx, "未发现 agent。可放在 ~/.pi/agent/agents/*.md 或 .pi/agents/*.md", "warning");
			return null;
		}

		interface AgentItem {
			name: string;
			label: string;
			description?: string;
		}

		const items: AgentItem[] = [
			{
				name: "default",
				label: activeAgent ? "default" : "default (active)",
				description: "restore session defaults",
			},
			...agents.map((agent) => ({
				name: agent.name,
				label: `${agent.name}${activeAgent?.name === agent.name ? " (active)" : ""} [${agent.source === "project" ? "project" : "user"}]`,
				description: agent.description || undefined,
			})),
		];

		try {
			const result = await ctx.ui.custom<string>((tui, th, _kb, done) => {
				let selectedIndex = 0;
				const maxVisible = 8;
				const listContainer = new Container();

				function updateList() {
					listContainer.clear();

					const startIndex = Math.max(
						0,
						Math.min(selectedIndex - Math.floor(maxVisible / 2), items.length - maxVisible),
					);
					const endIndex = Math.min(startIndex + maxVisible, items.length);

					for (let i = startIndex; i < endIndex; i++) {
						const item = items[i];
						if (!item) continue;
						const isSelected = i === selectedIndex;

						if (isSelected) {
							listContainer.addChild(
								new Text(
									th.fg("accent", "→ ") + th.bold(th.fg("accent", item.label)),
									1,
									0,
								),
							);
							if (item.description) {
								listContainer.addChild(
									new Text(th.fg("muted", `  ${item.description}`), 1, 0),
								);
							}
						} else {
							listContainer.addChild(new Text(`  ${item.label}`, 1, 0));
							if (item.description) {
								listContainer.addChild(
									new Text(th.fg("dim", `  ${item.description}`), 1, 0),
								);
							}
						}
					}

					if (startIndex > 0 || endIndex < items.length) {
						const scrollText = `  (${selectedIndex + 1}/${items.length})`;
						listContainer.addChild(new Text(th.fg("muted", scrollText), 1, 0));
					}

					tui.requestRender();
				}

				updateList();

				const component = listContainer as typeof listContainer & {
					handleInput(keyData: unknown): void;
					dispose(): void;
				};
				component.handleInput = (keyData: unknown) => {
					const kb = getKeybindings();
					if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
						selectedIndex = Math.max(0, selectedIndex - 1);
						updateList();
					} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
						selectedIndex = Math.min(items.length - 1, selectedIndex + 1);
						updateList();
					} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
						done(items[selectedIndex].name);
					} else if (kb.matches(keyData, "tui.select.cancel")) {
						done("");
					}
				};
				component.dispose = () => {};

				return component;
			});

			return result || null;
		} catch {
			return null;
		}
	}

	function renderAgentList(cwd: string): string {
		const agents = discoverAgents(cwd);
		if (agents.length === 0) {
			return "未发现 agent。可放在 ~/.pi/agent/agents/*.md 或 .pi/agents/*.md";
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

	pi.on("before_agent_start", async (event) => {
		if (!activeAgent || !activeAgent.prompt) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n[Active agent: ${activeAgent.name}]\n${activeAgent.prompt}`,
		};
	});

	pi.registerCommand("agent", {
		description: "Switch main-session agent identity from ~/.pi/agent/agents/*.md or .pi/agents/*.md",
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
