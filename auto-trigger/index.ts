/**
 * Auto-Trigger Extension
 *
 * 监控文件夹变化或 Git worktree 更新，自动触发 sub-agent 工作流。
 *
 * 功能：
 *   1. 文件夹监控 — 文件变化时自动触发指定 agent
 *   2. Git worktree 监控 — 检测到新 commit 时自动触发
 *   3. GitHub webhook 模式 — 接收 webhook 触发
 *
 * 使用：
 *   /auto-trigger              — 查看当前配置和状态
 *   /auto-trigger watch <path> <agent> [globs...]  — 监控文件夹
 *   /auto-trigger git <repo-path> <agent> [branch] — 监控 git 更新
 *   /auto-trigger stop [name]  — 停止监控
 *   /auto-trigger list         — 列出所有监控
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as cp from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ─── Types ──────────────────────────────────────────────────────────

interface WatchConfig {
	name: string;
	type: "file" | "git";
	agent: string;
	task?: string;          // 自定义任务模板，{files} {diff} 为占位符
	globs?: string[];       // 文件 glob 过滤（file 模式）
	branch?: string;        // 监控分支（git 模式）
	debounceMs: number;     // 防抖时间
	lastTriggered: number;  // 上次触发时间
	active: boolean;
}

// ─── Extension ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const watches = new Map<string, { config: WatchConfig; watcher?: fs.FSWatcher; interval?: ReturnType<typeof setInterval> }>();
	let globalCtx: ExtensionAPI = pi;

	// ─── 文件夹监控 ────────────────────────────────────────────────

	function startFileWatch(config: WatchConfig): fs.FSWatcher | null {
		const watchPath = config.name;
		let debounceTimer: ReturnType<typeof setTimeout> | null = null;
		let changedFiles = new Set<string>();

		try {
			const watcher = fs.watch(watchPath, { recursive: true }, (eventType, filename) => {
				if (!filename) return;

				// Glob 过滤
				if (config.globs && config.globs.length > 0) {
					const matches = config.globs.some(g => {
						// 简单 glob 匹配：支持 *.ext 和 directory/**
						if (g.startsWith("*.")) {
							return filename.endsWith(g.slice(1));
						}
						if (g.endsWith("/**")) {
							return filename.startsWith(g.slice(0, -3));
						}
						return filename.includes(g.replace("*", ""));
					});
					if (!matches) return;
				}

				// 排除常见噪声
				if (filename.includes("node_modules") || filename.includes(".git/") || filename.endsWith(".DS_Store")) return;

				changedFiles.add(filename);

				// 防抖
				if (debounceTimer) clearTimeout(debounceTimer);
				debounceTimer = setTimeout(() => {
					const now = Date.now();
					if (now - config.lastTriggered < config.debounceMs) return;
					config.lastTriggered = now;

					const fileList = Array.from(changedFiles).join(", ");
					changedFiles.clear();

					const task = config.task
						? config.task.replace("{files}", fileList)
						: `以下文件发生了变化：${fileList}。请分析变化并执行你的专属任务。`;

					triggerAgent(config.agent, task);
					debounceTimer = null;
				}, config.debounceMs);
			});

			return watcher;
		} catch (e) {
			console.error(`[auto-trigger] Failed to watch ${watchPath}:`, e);
			return null;
		}
	}

	// ─── Git 监控 ──────────────────────────────────────────────────

	function startGitWatch(config: WatchConfig): ReturnType<typeof setInterval> | null {
		const repoPath = config.name;
		const branch = config.branch || "main";
		let lastHead = getCurrentHead(repoPath);

		const interval = setInterval(() => {
			try {
				const currentHead = getCurrentHead(repoPath);
				if (!currentHead || currentHead === lastHead) return;

				// 有新 commit
				const diff = getCommitMessages(repoPath, lastHead!, currentHead);
				lastHead = currentHead;

				const now = Date.now();
				if (now - config.lastTriggered < config.debounceMs) return;
				config.lastTriggered = now;

				const task = config.task
					? config.task.replace("{diff}", diff).replace("{branch}", branch)
					: `${branch} 分支有新提交：\n${diff}\n\n请分析变化并执行你的专属任务。`;

				triggerAgent(config.agent, task);
			} catch {
				// repo might be temporarily unavailable
			}
		}, 30000); // 每 30 秒检查一次

		return interval;
	}

	function getCurrentHead(repoPath: string): string | null {
		try {
			return cp.execSync("git rev-parse HEAD", { cwd: repoPath, encoding: "utf-8" }).trim();
		} catch {
			return null;
		}
	}

	function getCommitMessages(repoPath: string, from: string, to: string): string {
		try {
			return cp.execSync(`git log --oneline ${from}..${to}`, { cwd: repoPath, encoding: "utf-8" }).trim();
		} catch {
			return "(unable to get commit messages)";
		}
	}

	// ─── 触发 Agent ────────────────────────────────────────────────

	function triggerAgent(agentName: string, task: string) {
		// 通过 sendUserMessage 让主 LLM 调用 subagent tool
		// 这样 LLM 可以自行决定用 single/parallel/chain 模式
		const message = `自动触发：请用 ${agentName} agent 执行以下任务。\n\n${task}`;

		globalCtx.sendUserMessage(message, { deliverAs: "followUp" });
	}

	// ─── 停止监控 ──────────────────────────────────────────────────

	function stopWatch(name: string): boolean {
		const entry = watches.get(name);
		if (!entry) return false;

		entry.watcher?.close();
		if (entry.interval) clearInterval(entry.interval);
		entry.config.active = false;
		watches.delete(name);
		return true;
	}

	// ─── 启动 ──────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setWidget("auto-trigger", undefined); // 初始隐藏
		}
	});

	// ─── 命令 ──────────────────────────────────────────────────────

	pi.registerCommand("auto-trigger", {
		description: "管理自动触发监控（watch / git / stop / list）",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0];

			// ── 列表 ──
			if (subcommand === "list" || !subcommand) {
				if (watches.size === 0) {
					ctx.ui.notify("没有活跃的监控。用法：/auto-trigger watch <path> <agent> [globs...]", "info");
					return;
				}
				const lines = ["📋 活跃的自动触发监控："];
				for (const [name, entry] of watches) {
					const icon = entry.config.active ? "🟢" : "🔴";
					const type = entry.config.type === "git" ? "Git" : "文件";
					lines.push(`  ${icon} [${type}] ${name} → ${entry.config.agent}`);
					if (entry.config.globs) lines.push(`     过滤: ${entry.config.globs.join(", ")}`);
					if (entry.config.branch) lines.push(`     分支: ${entry.config.branch}`);
				}
				ctx.ui.notify(lines.join("\n"), "info");

				// 更新 widget
				updateWidget(ctx);
				return;
			}

			// ── 文件夹监控 ──
			if (subcommand === "watch") {
				const watchPath = parts[1];
				const agent = parts[2];
				const globs = parts.slice(3);

				if (!watchPath || !agent) {
					ctx.ui.notify("用法：/auto-trigger watch <path> <agent> [globs...]", "warning");
					return;
				}

				const resolvedPath = path.resolve(ctx.cwd, watchPath);
				if (!fs.existsSync(resolvedPath)) {
					ctx.ui.notify(`路径不存在：${resolvedPath}`, "error");
					return;
				}

				// 停止已有的同名监控
				stopWatch(resolvedPath);

				const config: WatchConfig = {
					name: resolvedPath,
					type: "file",
					agent,
					globs: globs.length > 0 ? globs : undefined,
					debounceMs: 5000, // 5 秒防抖
					lastTriggered: 0,
					active: true,
				};

				const watcher = startFileWatch(config);
				if (!watcher) {
					ctx.ui.notify(`启动监控失败：${resolvedPath}`, "error");
					return;
				}

				watches.set(resolvedPath, { config, watcher });
				ctx.ui.notify(`📁 监控已启动：${watchPath} → ${agent}${globs.length ? ` [${globs.join(", ")}]` : ""}`, "success");
				updateWidget(ctx);
				return;
			}

			// ── Git 监控 ──
			if (subcommand === "git") {
				const repoPath = parts[1];
				const agent = parts[2];
				const branch = parts[3] || "main";

				if (!repoPath || !agent) {
					ctx.ui.notify("用法：/auto-trigger git <repo-path> <agent> [branch]", "warning");
					return;
				}

				const resolvedPath = path.resolve(ctx.cwd, repoPath);
				const gitDir = path.join(resolvedPath, ".git");
				if (!fs.existsSync(gitDir)) {
					ctx.ui.notify(`不是 Git 仓库：${resolvedPath}`, "error");
					return;
				}

				stopWatch(resolvedPath);

				const config: WatchConfig = {
					name: resolvedPath,
					type: "git",
					agent,
					branch,
					debounceMs: 30000,
					lastTriggered: 0,
					active: true,
				};

				const interval = startGitWatch(config);
				if (!interval) {
					ctx.ui.notify(`启动 Git 监控失败：${resolvedPath}`, "error");
					return;
				}

				watches.set(resolvedPath, { config, interval });
				ctx.ui.notify(`🔀 Git 监控已启动：${repoPath} (${branch}) → ${agent}`, "success");
				updateWidget(ctx);
				return;
			}

			// ── 停止 ──
			if (subcommand === "stop") {
				const name = parts[1];
				if (!name) {
					// 停止所有
					for (const [key] of watches) stopWatch(key);
					ctx.ui.notify("已停止所有监控", "info");
					updateWidget(ctx);
					return;
				}
				const resolvedPath = path.resolve(ctx.cwd, name);
				if (stopWatch(resolvedPath)) {
					ctx.ui.notify(`已停止：${name}`, "info");
				} else {
					ctx.ui.notify(`未找到监控：${name}`, "warning");
				}
				updateWidget(ctx);
				return;
			}

			ctx.ui.notify("未知命令。用法：watch / git / stop / list", "warning");
		},
	});

	// ─── 自定义任务模板命令 ────────────────────────────────────────

	pi.registerCommand("auto-trigger-task", {
		description: "设置自动触发的自定义任务模板（支持 {files} {diff} {branch} 占位符）",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const watchName = parts[0];
			const taskTemplate = parts.slice(1).join(" ");

			if (!watchName || !taskTemplate) {
				ctx.ui.notify("用法：/auto-trigger-task <path> <task template with {files} {diff} {branch}>", "warning");
				return;
			}

			const resolvedPath = path.resolve(ctx.cwd, watchName);
			const entry = watches.get(resolvedPath);
			if (!entry) {
				ctx.ui.notify(`未找到监控：${watchName}。先用 /auto-trigger watch 或 /auto-trigger git 创建`, "warning");
				return;
			}

			entry.config.task = taskTemplate;
			ctx.ui.notify(`任务模板已更新：${watchName}\n模板：${taskTemplate}`, "success");
		},
	});

	// ─── Widget 显示 ───────────────────────────────────────────────

	function updateWidget(ctx: any) {
		if (!ctx.hasUI) return;

		if (watches.size === 0) {
			ctx.ui.setWidget("auto-trigger", undefined);
			return;
		}

		const lines = ["⚡ Auto-trigger:"];
		for (const [name, entry] of watches) {
			const icon = entry.config.active ? "🟢" : "🔴";
			const shortName = name.replace(process.env.HOME || "", "~");
			if (entry.config.type === "git") {
				lines.push(`  ${icon} ${shortName} (${entry.config.branch}) → ${entry.config.agent}`);
			} else {
				lines.push(`  ${icon} ${shortName} → ${entry.config.agent}`);
			}
		}

		ctx.ui.setWidget("auto-trigger", lines, { placement: "belowEditor" });
	}

	// ─── 注册 Flag ─────────────────────────────────────────────────

	pi.registerFlag("auto-trigger-config", {
		description: "JSON 配置文件路径，启动时自动加载监控规则",
		type: "string",
	});

	// 从配置文件自动加载
	pi.on("session_start", async (_event, ctx) => {
		const configFlag = pi.getFlag("--auto-trigger-config") as string | undefined;
		if (!configFlag) return;

		const configPath = path.resolve(ctx.cwd, configFlag);
		if (!fs.existsSync(configPath)) return;

		try {
			const raw = fs.readFileSync(configPath, "utf-8");
			const config = JSON.parse(raw);
			const rules: Array<{ path: string; agent: string; type: "file" | "git"; globs?: string[]; branch?: string; task?: string }> = config.rules || [];

			for (const rule of rules) {
				const resolvedPath = path.resolve(ctx.cwd, rule.path);

				// 跳过已存在的
				if (watches.has(resolvedPath)) continue;

				const watchConfig: WatchConfig = {
					name: resolvedPath,
					type: rule.type,
					agent: rule.agent,
					globs: rule.globs,
					branch: rule.branch,
					task: rule.task,
					debounceMs: rule.type === "git" ? 30000 : 5000,
					lastTriggered: 0,
					active: true,
				};

				if (rule.type === "git") {
					const interval = startGitWatch(watchConfig);
					if (interval) watches.set(resolvedPath, { config: watchConfig, interval });
				} else {
					const watcher = startFileWatch(watchConfig);
					if (watcher) watches.set(resolvedPath, { config: watchConfig, watcher });
				}
			}

			if (watches.size > 0 && ctx.hasUI) {
				ctx.ui.notify(`⚡ 已加载 ${rules.length} 条自动触发规则`, "info");
				updateWidget(ctx);
			}
		} catch (e) {
			console.error("[auto-trigger] Failed to load config:", e);
		}
	});

	// ─── 清理 ──────────────────────────────────────────────────────

	pi.on("session_shutdown", async () => {
		for (const [name, entry] of watches) {
			entry.watcher?.close();
			if (entry.interval) clearInterval(entry.interval);
		}
		watches.clear();
	});
}
