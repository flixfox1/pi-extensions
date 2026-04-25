/**
 * Agent Run-Time Extension
 *
 * Main entry point for selecting and executing agent workflows.
 * Modeled after the subagent extension pattern:
 *   subagent  →  agents/*.md   → subagent tool discovers & invokes agents
 *   run-time  →  workflows/*.md → /run command discovers & executes workflows
 *
 * Usage:
 *   /run                                    → Interactive selector: pick workflow, then input task
 *   /run <workflow-name> <task>             → Run a specific workflow with task arguments
 *   /<workflow-name> <task>                 → Direct slash expansion (via resources_discover)
 *
 * Workflow files (workflows/*.md):
 *   Frontmatter:
 *     description:        One-line summary (shown in selector and autocomplete)
 *     argument-hint:      Optional, e.g. "<task description>"
 *   Body is a prompt template supporting:
 *     $@ / $ARGUMENTS     → all arguments joined
 *     $1, $2, ...         → positional arguments
 *     ${@:N}              → args from Nth position
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

const WORKFLOWS_DIR = path.join(__dirname, "workflows");

// ---------------------------------------------------------------------------
// Workflow discovery (mirrors agents.ts agent discovery pattern)
// ---------------------------------------------------------------------------

interface WorkflowDef {
	name: string;
	description: string;
	hint?: string;
	filePath: string;
	template: string;
}

function discoverWorkflows(): WorkflowDef[] {
	if (!fs.existsSync(WORKFLOWS_DIR)) return [];

	const workflows: WorkflowDef[] = [];

	for (const entry of fs.readdirSync(WORKFLOWS_DIR, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

		const filePath = path.join(WORKFLOWS_DIR, entry.name);
		const content = fs.readFileSync(filePath, "utf-8");

		// Parse frontmatter
		const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		const fm = fmMatch?.[1] ?? "";

		const description =
			fm.match(/description:\s*(.+)/)?.[1]?.trim() ??
			content.replace(/^---[\s\S]*?---\r?\n?/, "").trim().split("\n")[0];

		const hint = fm.match(/argument-hint:\s*(.+)/)?.[1]?.trim();
		const name = entry.name.replace(/\.md$/, "");
		const template = content.replace(/^---[\s\S]*?---\r?\n?/, "");

		workflows.push({ name, description, hint, filePath, template });
	}

	return workflows;
}

// ---------------------------------------------------------------------------
// Template expansion
// ---------------------------------------------------------------------------

function expandTemplate(template: string, args: string): string {
	const parts = args.split(/\s+/);

	let expanded = template
		.replace(/\$ARGUMENTS/g, args)
		.replace(/\$@/g, args);

	// ${@:N} — args from Nth position (1-indexed)
	for (const m of template.matchAll(/\$\{@:(\d+)\}/g)) {
		const from = parseInt(m[1], 10) - 1;
		expanded = expanded.replace(m[0], parts.slice(from).join(" "));
	}

	// ${@:N:L} — L args from Nth position
	for (const m of template.matchAll(/\$\{@:(\d+):(\d+)\}/g)) {
		const from = parseInt(m[1], 10) - 1;
		const len = parseInt(m[2], 10);
		expanded = expanded.replace(m[0], parts.slice(from, from + len).join(" "));
	}

	// $1, $2, ... positional (process in reverse to avoid $1 matching inside $10)
	for (let i = parts.length; i >= 1; i--) {
		expanded = expanded.replace(new RegExp(`\\$${i}`, "g"), parts[i - 1] || "");
	}

	return expanded.trim();
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// 1. Register workflows as prompt templates → direct /<workflow-name> usage
	pi.on("resources_discover", async () => {
		return { promptPaths: [WORKFLOWS_DIR] };
	});

	// 2. /run command — the main runtime entry point (like selecting an agent)
	pi.registerCommand("run", {
		description: "Select and run an agent workflow",

		getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
			const workflows = discoverWorkflows();
			// Match against first token (workflow name)
			const firstToken = prefix.split(/\s+/)[0] || "";
			const items: AutocompleteItem[] = workflows
				.filter((w) => w.name.startsWith(firstToken))
				.map((w) => ({
					value: w.name,
					label: w.name,
					description: w.description,
				}));
			return items.length > 0 ? items : null;
		},

		handler: async (args, ctx) => {
			const workflows = discoverWorkflows();

			if (workflows.length === 0) {
				ctx.ui.notify("No workflows found in agent-run-time/workflows/", "warning");
				return;
			}

			const trimmed = (args ?? "").trim();

			// ── Fast path: /run <workflow-name> <task> ──────────────────────
			if (trimmed) {
				const firstSpace = trimmed.search(/\s/);
				const workflowName = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
				const taskPart = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

				const workflow = workflows.find((w) => w.name === workflowName);
				if (workflow) {
					// If no task args given after the name, prompt for task
					const task =
						taskPart ||
						(await ctx.ui.input(`Task for ${workflow.name}:`, "Describe what to do..."));
					if (!task) {
						ctx.ui.notify("Canceled: no task provided", "info");
						return;
					}

					pi.sendUserMessage(expandTemplate(workflow.template, task));
					return;
				}

				// No exact match — fall through to interactive selector
			}

			// ── Interactive path: select workflow → input task ───────────────
			const labels = workflows.map((w) => `${w.name}  —  ${w.description}`);
			const choice = await ctx.ui.select("Select a workflow:", labels);
			if (!choice) return; // user canceled

			const selectedName = choice.split("  —  ")[0];
			const selected = workflows.find((w) => w.name === selectedName);
			if (!selected) return;

			const task = await ctx.ui.input(`Task for ${selected.name}:`, "Describe what to do...");
			if (!task) {
				ctx.ui.notify("Canceled: no task provided", "info");
				return;
			}

			pi.sendUserMessage(expandTemplate(selected.template, task));
		},
	});
}
