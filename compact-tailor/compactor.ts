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

const BASE_PROMPT = `You are a conversation summarizer. Create a comprehensive summary of this conversation that captures:

1. The main goals and objectives discussed
2. Key decisions made and their rationale
3. Important code changes, file modifications, or technical details
4. Current state of any ongoing work (CRITICAL — include file paths, function names, variable states)
5. Any blockers, issues, or open questions
6. Next steps that were planned or suggested (CRITICAL)

Be thorough but concise. The summary will replace the ENTIRE conversation history, so include all information needed to continue the work effectively.
Format the summary as structured markdown with clear section headers.`;

const DYNAMIC_APPENDIX = `

## Continuation Instruction (Required)

After the summary, you MUST output a section titled exactly \`## Continuation\`.

Analyze the last user intent and tool calling results in the conversation.
Generate a single direct instruction for the agent to resume work.
Reference specific files and states from the conversation.
No preamble — output the instruction directly.

If the task is fully complete with no remaining work, output: TASK_COMPLETE`;

const CONTINUATION_MARKER = "## Continuation";

export function parseCompactionOutput(raw: string): ParsedOutput {
	const idx = raw.lastIndexOf(CONTINUATION_MARKER);
	if (idx === -1) return { summary: raw.trim(), continuation: null };
	return {
		summary: raw.slice(0, idx).trim(),
		continuation: raw.slice(idx + CONTINUATION_MARKER.length).trim() || null,
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

	const raw = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	if (!raw.trim()) throw new Error("LLM output was empty");

	return parseCompactionOutput(raw);
}
