/**
 * compaction-tailor-lite.ts — 最小可运行版本
 *
 * 核心逻辑：session_compact → LLM 生成续接 prompt → sendUserMessage
 *
 * 用法: pi -e compaction-tailor-lite.ts
 */
import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const TAILOR_PROMPT = `You generate continuation prompts for a coding agent that just had its context compacted.
Given the compaction summary, output a single direct instruction for the agent to resume its work.
Reference specific files and next steps from the summary. No preamble.`;

export default function (pi: ExtensionAPI) {
	let busy = false;

	pi.on("session_compact", async (event, ctx) => {
		if (busy) return;
		busy = true;

		try {
			// Pick a fast model
			const model =
				ctx.modelRegistry.find("google", "gemini-2.5-flash") ??
				ctx.modelRegistry.find("anthropic", "claude-haiku-4-5") ??
				ctx.model;
			if (!model) return;

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) return;

			ctx.ui.notify("[tailor] Generating continuation prompt...", "info");

			const res = await complete(
				model,
				{
					systemPrompt: TAILOR_PROMPT,
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: event.compactionEntry.summary }],
							timestamp: Date.now(),
						},
					],
				},
				{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: 1024, signal: ctx.signal },
			);

			const prompt = res.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n")
				.trim();

			if (prompt && prompt !== "TASK_COMPLETE") {
				ctx.ui.notify(`[tailor] ✅ Resuming task`, "info");
				pi.sendUserMessage(prompt); // agent is idle → triggers new turn immediately
			}
		} catch (e) {
			ctx.ui.notify(`[tailor] ❌ ${e instanceof Error ? e.message : e}`, "error");
		} finally {
			busy = false;
		}
	});
}
