/**
 * compactor.ts — 单次 LLM 调用：摘要 + 可选续接
 */

import { complete } from "@mariozechner/pi-ai";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { CompactConfig } from "./config";
import { resolveModelSpec } from "./config";

export interface ParsedOutput {
	summary: string;
	continuation: string | null;
}

// ── Prompt ────────────────────────────────────────────────────────

const BASE_PROMPT = `You are a compaction summarizer for a coding-agent session.
Your output will replace older conversation history after context compaction.
The next agent will only see this summary plus the recent unsummarized messages, so preserve the execution state precisely.

Write the summary in this exact Markdown structure:

## Goal
[User's current goal. Include multiple goals only if still relevant.]

## Constraints & Preferences
- [User-stated constraints, preferences, or requirements]
- [Use "(none)" if none are known]

## Progress
### Done
- [x] [Completed work, decisions, files changed, commands/tests run]

### In Progress
- [ ] [The active task at the time of compaction, with concrete current state]

### Blocked
- [Blockers, failed commands, missing decisions, rate limits, or "(none)"]

## Key Decisions
- **[Decision]**: [Reason / evidence]

## Next Steps
1. [Concrete next action]
2. [Validation or follow-up action]

## Critical Context
- [Facts needed to continue without rereading the whole conversation]
- [Exact file paths, function names, config values, command outputs, error text]

<read-files>
path/or/none
</read-files>

<modified-files>
path/or/none
</modified-files>

Rules:
- Be concise but not lossy; prefer exact paths, symbols, config keys, commands, and error messages.
- Preserve unresolved user intent and the latest execution state.
- Do not invent completed work.
- Do not include conversational filler or meta commentary about summarization.`;

const DYNAMIC_APPENDIX = `

## Continuation Contract (Required)

After the summary, output a final section titled exactly:

## Continuation

The continuation is a single user-facing instruction that will be automatically sent to the next agent after compaction.
It must let the agent resume safely from the compacted state.

Continuation rules:
- Output only the instruction text under \`## Continuation\`; no bullets unless bullets are necessary for clarity.
- Make it executable: say what to do next, where to look, what files/configs matter, and how to validate.
- Do not ask the agent to repeat work already marked Done.
- Do not say vague things like "continue the task" without concrete next actions.
- If the user was asking for analysis rather than code, instruct the agent to answer or continue that analysis, not to edit files.
- If the task is blocked, instruct the agent to report the blocker and request the specific missing input.
- If there is truly no remaining work, output exactly: TASK_COMPLETE`;

const CONTINUATION_MARKER_RE = /(?:^|\n)#{1,6}\s*Continuation(?:\s+Instruction)?\s*$/gim;

export function parseCompactionOutput(raw: string): ParsedOutput {
	let last: RegExpExecArray | null = null;
	for (let match = CONTINUATION_MARKER_RE.exec(raw); match; match = CONTINUATION_MARKER_RE.exec(raw)) {
		last = match;
	}
	CONTINUATION_MARKER_RE.lastIndex = 0;

	if (!last) return { summary: raw.trim(), continuation: null };
	const markerStart = last.index + (last[0].startsWith("\n") ? 1 : 0);
	const continuationStart = last.index + last[0].length;
	return {
		summary: raw.slice(0, markerStart).trim(),
		continuation: raw.slice(continuationStart).trim() || null,
	};
}

// ── Generate ──────────────────────────────────────────────────────

export async function generateCompaction(
	messagesToSummarize: any[],
	turnPrefixMessages: any[],
	previousSummary: string | undefined,
	customInstructions: string | undefined,
	config: CompactConfig,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<ParsedOutput> {
	const spec = resolveModelSpec(config.summarizeModel);
	const model =
		ctx.modelRegistry.find(spec.provider, spec.id) ??
		ctx.modelRegistry.find("zai", "glm-4.7") ??
		ctx.model;
	if (!model) throw new Error("No model available for summarization");

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) throw new Error(`Auth failed for model ${model.id}`);

	const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
	const conversationText = serializeConversation(convertToLlm(allMessages));

	let prompt = BASE_PROMPT;
	// 互斥：static 开启时不附加 dynamic prompt
	const staticActive = config.staticInstruction.enabled
		&& (config.staticInstruction.content?.trim() || config.staticInstruction.file);
	if (config.dynamicInstruction.enabled && !staticActive) prompt += DYNAMIC_APPENDIX;

	const prev = previousSummary ? `\n\n<previous_summary>\n${previousSummary}\n</previous_summary>` : "";
	const focus = customInstructions ? `\n\nThe user specifically requested: ${customInstructions}` : "";

	const response = await complete(model, {
		messages: [{
			role: "user",
			content: [{ type: "text", text: `${prompt}${prev}${focus}\n\n<conversation>\n${conversationText}\n</conversation>` }],
			timestamp: Date.now(),
		}],
	}, { apiKey: auth.apiKey, headers: auth.headers, maxTokens: config.maxTokens, signal });

	if (response.stopReason === "error") {
		throw new Error(`LLM error from ${model.provider}/${model.id}: ${response.errorMessage ?? "unknown error"}`);
	}
	if (response.stopReason === "aborted") {
		throw new Error(`LLM request aborted for ${model.provider}/${model.id}`);
	}

	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	const thinking = response.content
		.filter((c): c is { type: "thinking"; thinking: string } => c.type === "thinking")
		.map((c) => c.thinking)
		.join("\n");
	const raw = text.trim() ? text : thinking;
	if (!raw.trim()) {
		const blockTypes = response.content.map((c) => c.type).join(",") || "none";
		const usage = response.usage ? ` input=${response.usage.input} output=${response.usage.output} total=${response.usage.totalTokens}` : "";
		throw new Error(`LLM output was empty (model=${model.provider}/${model.id}, stopReason=${response.stopReason}, blocks=${blockTypes},${usage})`);
	}
	if (!text.trim() && thinking.trim()) {
		try {
			if ((ctx as any).hasUI) (ctx as any).ui.notify("⚠️ summarizer returned thinking-only output; using it as fallback", "warning");
			else console.log("[compact:warning] summarizer returned thinking-only output; using it as fallback");
		} catch { /* notification best effort */ }
	}

	const parsed = parseCompactionOutput(raw);
	if (config.dynamicInstruction.enabled && !parsed.continuation) {
		try {
			if ((ctx as any).hasUI) (ctx as any).ui.notify("⚠️ dynamic continuation marker missing; compaction will finish without auto-resume", "warning");
			else console.log("[compact:warning] dynamic continuation marker missing; compaction will finish without auto-resume");
		} catch { /* notification best effort */ }
	}
	return parsed;
}
