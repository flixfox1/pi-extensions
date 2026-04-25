/**
 * config.ts — 配置加载 / 持久化
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export interface ArchiveConfig {
	enabled: boolean;
	dir: string;
}

export interface DynamicInstructionConfig {
	enabled: boolean;
}

export interface StaticInstructionConfig {
	enabled: boolean;
	content: string;
	file?: string;
}

export interface CompactConfig {
	threshold: number;
	summarizeModel: string;
	maxTokens: number;
	archive: ArchiveConfig;
	dynamicInstruction: DynamicInstructionConfig;
	staticInstruction: StaticInstructionConfig;
}

const DEFAULTS: CompactConfig = {
	threshold: 85,
	summarizeModel: "zai/glm-4.7",
	maxTokens: 13107,  // 对齐 Pi 内置: Math.floor(0.8 * 16384)
	archive: { enabled: true, dir: ".pi/compaction-archives" },
	dynamicInstruction: { enabled: true },
	staticInstruction: { enabled: false, content: "" },
};

// ── YAML ──────────────────────────────────────────────────────────

interface YamlNode {
	[key: string]: string | number | boolean | YamlNode;
}

function parseYaml(text: string): YamlNode {
	const root: YamlNode = {};
	const stack: { indent: number; node: YamlNode }[] = [{ indent: -1, node: root }];

	for (const rawLine of text.split("\n")) {
		const trimmed = rawLine.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const indent = rawLine.search(/\S/);
		const colonIdx = trimmed.indexOf(":");
		if (colonIdx === -1) continue;

		const key = trimmed.slice(0, colonIdx).trim();
		const rawValue = trimmed.slice(colonIdx + 1).trim();

		// 子节点
		if (rawValue === "") {
			const child: YamlNode = {};
			while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
			stack[stack.length - 1].node[key] = child;
			stack.push({ indent, node: child });
			continue;
		}

		// 叶子
		let value: string | number | boolean = rawValue;
		if (value.length >= 2) {
			const f = value[0], l = value[value.length - 1];
			if ((f === '"' && l === '"') || (f === "'" && l === "'")) value = value.slice(1, -1);
		}
		if (value === "true") value = true;
		else if (value === "false") value = false;
		else if (/^\d+$/.test(value as string)) value = parseInt(value as string, 10);

		while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
		stack[stack.length - 1].node[key] = value;
	}
	return root;
}

// ── Helpers ───────────────────────────────────────────────────────

function str(raw: unknown, fb: string): string {
	return typeof raw === "string" && raw !== "" ? raw : fb;
}
function num(raw: unknown, fb: number): number {
	return typeof raw === "number" ? raw : fb;
}
function bool(raw: unknown, fb: boolean): boolean {
	return typeof raw === "boolean" ? raw : fb;
}

export function getExtDir(): string {
	return path.join(getAgentDir(), "extensions", "compact-tailor");
}

export function getConfigPath(): string {
	return path.join(getExtDir(), "config.yaml");
}

export function resolveModelSpec(spec: string): { provider: string; id: string } {
	const i = spec.indexOf("/");
	return i === -1 ? { provider: spec, id: spec } : { provider: spec.slice(0, i), id: spec.slice(i + 1) };
}

// ── Load ──────────────────────────────────────────────────────────

export function loadConfig(): CompactConfig {
	let raw: YamlNode = {};
	try { raw = parseYaml(fs.readFileSync(getConfigPath(), "utf-8")); } catch { /* */ }

	const a = raw.archive as YamlNode | undefined;
	const d = raw["dynamic-instruction"] as YamlNode | undefined;
	const s = raw["static-instruction"] as YamlNode | undefined;

	return {
		threshold: num(raw.threshold, DEFAULTS.threshold),
		summarizeModel: str((raw as any)["summarize-model"], str((raw as any).summarizeModel, DEFAULTS.summarizeModel)),
		maxTokens: num((raw as any)["max-tokens"], num((raw as any).maxTokens, DEFAULTS.maxTokens)),
		archive: { enabled: bool(a?.enabled, DEFAULTS.archive.enabled), dir: str(a?.dir, DEFAULTS.archive.dir) },
		dynamicInstruction: { enabled: bool(d?.enabled, DEFAULTS.dynamicInstruction.enabled) },
		staticInstruction: { enabled: bool(s?.enabled, DEFAULTS.staticInstruction.enabled), content: str(s?.content, DEFAULTS.staticInstruction.content), file: s?.file ? str(s?.file, "") : undefined },
	};
}

// ── Save helpers ──────────────────────────────────────────────────

function readLines(): string[] {
	try { return fs.readFileSync(getConfigPath(), "utf-8").split("\n"); }
	catch { return []; }
}

function writeLines(lines: string[]): void {
	fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
	fs.writeFileSync(getConfigPath(), lines.join("\n"), "utf-8");
}

function findLine(lines: string[], prefix: string): number {
	return lines.findIndex((l) => l.trimStart().startsWith(prefix));
}

/** 写回顶层 string 字段 */
function saveTopLevelString(key: string, value: string): void {
	const lines = readLines();
	// kebab 形式
	const kebab = key.replace(/([A-Z])/g, "-$1").toLowerCase();
	const yamlKey = kebab.includes("-") ? kebab : key;

	const idx = findLine(lines, `${yamlKey}:`);
	if (idx !== -1) { lines[idx] = `${yamlKey}: ${value}`; }
	else {
		const after = findLine(lines, "threshold:");
		lines.splice(after + 1, 0, `${yamlKey}: ${value}`);
	}
	writeLines(lines);
}

/** 写回嵌套 bool 字段 */
function saveNestedBool(section: string, key: string, value: boolean): void {
	const lines = readLines();
	const sectionIdx = findLine(lines, `${section}:`);
	if (sectionIdx === -1) return;

	// 在 section 下方找 key
	for (let i = sectionIdx + 1; i < lines.length; i++) {
		if (!lines[i].startsWith(" ") && !lines[i].startsWith("\t")) break;
		if (lines[i].trimStart().startsWith(`${key}:`)) {
			lines[i] = `  ${key}: ${value}`;
			writeLines(lines);
			return;
		}
	}
	// 没找到就插入
	lines.splice(sectionIdx + 1, 0, `  ${key}: ${value}`);
	writeLines(lines);
}

/** 写回 static-instruction.content */
function saveStaticContent(content: string): void {
	const lines = readLines();
	const sectionIdx = findLine(lines, "static-instruction:");
	if (sectionIdx === -1) return;

	for (let i = sectionIdx + 1; i < lines.length; i++) {
		if (!lines[i].startsWith(" ") && !lines[i].startsWith("\t")) break;
		if (lines[i].trimStart().startsWith("content:")) {
			lines[i] = `  content: "${content.replace(/"/g, '\\"')}"`;
			writeLines(lines);
			return;
		}
	}
	lines.splice(sectionIdx + 1, 0, `  content: "${content.replace(/"/g, '\\"')}"`);
	writeLines(lines);
}


export { saveTopLevelString, saveNestedBool, saveStaticContent, DEFAULTS };
