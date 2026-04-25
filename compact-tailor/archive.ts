/**
 * archive.ts — 归档子功能
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ArchiveConfig } from "./config";

export async function writeArchive(
	summary: string,
	meta: { tokensBefore: number; firstKeptEntryId: string; activeAgent: string | null },
	cfg: ArchiveConfig,
	cwd: string,
): Promise<string | null> {
	if (!cfg.enabled) return null;

	const dir = path.isAbsolute(cfg.dir) ? cfg.dir : path.resolve(cwd, cfg.dir);
	await fs.promises.mkdir(dir, { recursive: true });

	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const slug = meta.activeAgent
		? `_${meta.activeAgent.replace(/[^a-zA-Z0-9._-]+/g, "-")}`
		: "_default";
	const fp = path.join(dir, `${ts}${slug}_compaction.md`);

	await fs.promises.writeFile(fp, [
		`# Compaction Archive`,
		``,
		`- Timestamp: ${new Date().toISOString()}`,
		`- Tokens Before: ${meta.tokensBefore.toLocaleString()}`,
		`- First Kept Entry ID: ${meta.firstKeptEntryId}`,
		`- Active Agent: ${meta.activeAgent ?? "default"}`,
		``,
		`## Summary`,
		``,
		summary.trim(),
		``,
	].join("\n"), "utf-8");

	return fp;
}
