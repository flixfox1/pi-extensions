import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

// ─── Types ──────────────────────────────────────────────────────────

type DerivedStatus =
  | "registered"
  | "running"
  | "stalled"
  | "done"
  | "blocked"
  | "failed"
  | "crashed"
  | "unknown";

type DoneStatus = "done" | "blocked" | "failed" | "unknown";

interface WorkerRegistryEntry {
  schema_version?: number;
  run_id?: string;
  agent_id?: string;
  status?: string;
  tmux_target?: string;
  pane_id?: string;
  target?: string;
  dispatch_path?: string;
  done_path?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

interface DoneReport {
  exists: boolean;
  path: string;
  status: DoneStatus;
  summary?: string;
  changed_files?: string;
  tests?: string;
  findings?: string;
  next_action?: string;
  completed_at?: string;
  parse_error?: string;
}

interface TmuxState {
  checked: boolean;
  alive: boolean;
  target?: string;
  pane_id?: string;
  error?: string;
}

interface AgentSnapshot {
  agent_id: string;
  run_id: string;
  run_dir: string;
  state: DerivedStatus;
  registry_status?: string;
  tmux_target?: string;
  pane_id?: string;
  target?: string;
  dispatch_path?: string;
  done_path?: string;
  created_at?: string;
  updated_at?: string;
  registry_path: string;
  done: DoneReport;
  tmux: TmuxState;
  diagnostics: string[];
}

interface MonitorSnapshot {
  run_dir?: string;
  run_id?: string;
  agents: AgentSnapshot[];
  diagnostics: string[];
}

interface PaneCacheEntry {
  hash: string;
  unchangedChecks: number;
}

// ─── Constants / in-memory cache (not source of truth) ──────────────

const WIDGET_ID = "agent-monitor";
const POLL_INTERVAL_MS = 10_000;
const STALLED_IDLE_THRESHOLD = 12;
const RUN_ENV_KEYS = [
  "PI_AGENT_MONITOR_RUN_DIR",
  "AGENT_MONITOR_RUN_DIR",
  "ORCH_RUN_DIR",
  "RUN_DIR",
];

type AgentMonitorWidget = string[] | ((tui: unknown, theme: any) => { render(width: number): string[]; invalidate(): void });

type AgentMonitorUi = {
  setWidget?: (id: string, widget?: AgentMonitorWidget, options?: { placement?: "aboveEditor" | "belowEditor" }) => void;
  notify?: (message: string, kind?: "info" | "success" | "warning" | "error") => void;
  custom?: <T>(factory: (tui: any, theme: any, keybindings: any, done: (value: T) => void) => { render(width: number): string[]; invalidate(): void; handleInput?(data: string): void }, options?: unknown) => Promise<T>;
};

let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastCtx: { cwd: string; ui?: AgentMonitorUi; hasUI?: boolean } | null = null;
// Opt-in widget: lifecycle is owned by orch.py + registry/DONE/tmux.
// Set AGENT_MONITOR_WIDGET=1|true|on|show|visible, or use /monitor-agent → monitor widge to display it.
let widgetHidden = !["1", "true", "on", "show", "visible"].includes((process.env.AGENT_MONITOR_WIDGET ?? "").toLowerCase());
const paneCache: Map<string, PaneCacheEntry> = new Map();

// ─── Path / discovery helpers ───────────────────────────────────────

function resolvePath(cwd: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}


function discoverRunDir(cwd: string, explicitRunDir?: string): { runDir?: string; diagnostics: string[] } {
  const diagnostics: string[] = [];

  if (explicitRunDir?.trim()) {
    const candidate = resolvePath(cwd, explicitRunDir.trim());
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return { runDir: candidate, diagnostics };
    }
    diagnostics.push(`Explicit run_dir not found or not a directory: ${candidate}`);
    return { diagnostics };
  }

  for (const key of RUN_ENV_KEYS) {
    const value = process.env[key];
    if (!value) continue;
    const candidate = resolvePath(cwd, value);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      diagnostics.push(`Using run dir from ${key}.`);
      return { runDir: candidate, diagnostics };
    }
    diagnostics.push(`${key} points to missing run dir: ${candidate}`);
  }

  const memoryDir = path.resolve(cwd, ".Agent_ChatRoom/Orchestrator agent memory");
  if (!fs.existsSync(memoryDir)) {
    diagnostics.push(`No run dir supplied and memory directory is missing: ${memoryDir}`);
    return { diagnostics };
  }

  const candidates = fs.readdirSync(memoryDir)
    .filter((name) => name.startsWith("RUN-"))
    .map((name) => path.join(memoryDir, name))
    .filter((candidate) => fs.statSync(candidate).isDirectory())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  if (candidates.length === 0) {
    diagnostics.push(`No RUN-* directories found under ${memoryDir}`);
    return { diagnostics };
  }

  return { runDir: candidates[0], diagnostics };
}

function runIdFromDir(runDir: string): string {
  const base = path.basename(runDir);
  return base.startsWith("RUN-") ? base.slice(4) : base;
}

// ─── tmux helpers ───────────────────────────────────────────────────

function tmuxExec(args: string[]): { ok: boolean; stdout: string; error?: string } {
  try {
    const stdout = execFileSync("tmux", args, {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return { ok: true, stdout };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, stdout: "", error: message };
  }
}

function capturePane(target: string, lines = 40): string {
  return tmuxExec(["capture-pane", "-t", target, "-p", "-S", `-${lines}`]).stdout;
}

function getTmuxState(target: string | undefined): TmuxState {
  if (!target) return { checked: false, alive: false, error: "No tmux target or pane_id in registry." };
  const result = tmuxExec(["display-message", "-t", target, "-p", "#{pane_id}"]);
  if (!result.ok || !result.stdout.trim()) return { checked: true, alive: false, target, error: result.error ?? "tmux target unreachable (empty reply)" };
  return { checked: true, alive: true, target, pane_id: result.stdout };
}

function hashOutput(output: string): string {
  return crypto.createHash("md5").update(output).digest("hex").slice(0, 16);
}

// ─── DONE / registry parsing ────────────────────────────────────────

function parseDoneReport(cwd: string, donePath: string | undefined): DoneReport {
  const absolute = donePath ? resolvePath(cwd, donePath) : "";
  if (!absolute) return { exists: false, path: "", status: "unknown", parse_error: "No done_path in registry." };
  if (!fs.existsSync(absolute)) return { exists: false, path: absolute, status: "unknown" };

  try {
    const content = fs.readFileSync(absolute, "utf8");
    const fields: Record<string, string> = {};
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*-\s*([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
      if (match) fields[match[1].toLowerCase().replace(/-/g, "_")] = match[2].trim();
    }

    const rawStatus = (fields.status ?? "done").toLowerCase();
    const status: DoneStatus = rawStatus === "blocked" || rawStatus === "failed" || rawStatus === "done"
      ? rawStatus
      : "unknown";

    return {
      exists: true,
      path: absolute,
      status,
      summary: fields.summary,
      changed_files: fields.changed_files,
      tests: fields.tests,
      findings: fields.findings,
      next_action: fields.next_action,
      completed_at: fields.completed_at,
      parse_error: status === "unknown" ? `Unknown DONE status: ${rawStatus}` : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exists: true, path: absolute, status: "unknown", parse_error: message };
  }
}

function loadRegistryEntries(runDir: string): { entries: Array<{ path: string; entry: WorkerRegistryEntry }>; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const agentsDir = path.join(runDir, "agents");
  if (!fs.existsSync(agentsDir)) {
    diagnostics.push(`Registry directory missing: ${agentsDir}`);
    return { entries: [], diagnostics };
  }

  const entries: Array<{ path: string; entry: WorkerRegistryEntry }> = [];
  for (const fileName of fs.readdirSync(agentsDir).filter((name) => name.endsWith(".json")).sort()) {
    const registryPath = path.join(agentsDir, fileName);
    try {
      const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8")) as WorkerRegistryEntry;
      entries.push({ path: registryPath, entry: parsed });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push(`Invalid registry JSON ${registryPath}: ${message}`);
    }
  }

  if (entries.length === 0 && diagnostics.length === 0) diagnostics.push(`No agent registry JSON files found in ${agentsDir}`);
  return { entries, diagnostics };
}

function deriveState(agentId: string, entry: WorkerRegistryEntry, done: DoneReport, tmux: TmuxState, diagnostics: string[]): DerivedStatus {
  if (done.exists) {
    if (done.status === "done") return "done";
    if (done.status === "blocked") return "blocked";
    if (done.status === "failed") return "failed";
    diagnostics.push(done.parse_error ?? "DONE file exists but status is unknown.");
    return "unknown";
  }

  if (tmux.checked && !tmux.alive) return "crashed";
  if (!tmux.checked) return entry.status === "registered" ? "registered" : "unknown";
  if (!tmux.alive) return "unknown";

  const captureTarget = tmux.target ?? entry.pane_id ?? entry.target ?? entry.tmux_target;
  const output = captureTarget ? capturePane(captureTarget, 40) : "";
  const hash = hashOutput(output);
  const cacheKey = `${entry.run_id ?? "unknown"}:${agentId}`;
  const previous = paneCache.get(cacheKey);
  const unchangedChecks = previous && previous.hash === hash ? previous.unchangedChecks + 1 : 0;
  paneCache.set(cacheKey, { hash, unchangedChecks });

  return unchangedChecks >= STALLED_IDLE_THRESHOLD ? "stalled" : "running";
}

function buildSnapshot(cwd: string, explicitRunDir?: string): MonitorSnapshot {
  const discovery = discoverRunDir(cwd, explicitRunDir);
  const diagnostics = [...discovery.diagnostics];
  if (!discovery.runDir) return { agents: [], diagnostics };

  const loaded = loadRegistryEntries(discovery.runDir);
  diagnostics.push(...loaded.diagnostics);
  const runId = runIdFromDir(discovery.runDir);

  const agents = loaded.entries.map(({ path: registryPath, entry }) => {
    const agentDiagnostics: string[] = [];
    const agentId = typeof entry.agent_id === "string" && entry.agent_id ? entry.agent_id : path.basename(registryPath, ".json");
    if (!entry.agent_id) agentDiagnostics.push("Registry missing agent_id; using file name.");

    const target = firstString(entry.pane_id, entry.target, entry.tmux_target);
    const tmux = getTmuxState(target);
    if (tmux.error) agentDiagnostics.push(tmux.error);

    const done = parseDoneReport(cwd, typeof entry.done_path === "string" ? entry.done_path : undefined);
    const state = deriveState(agentId, entry, done, tmux, agentDiagnostics);

    return {
      agent_id: agentId,
      run_id: typeof entry.run_id === "string" ? entry.run_id : runId,
      run_dir: discovery.runDir!,
      state,
      registry_status: typeof entry.status === "string" ? entry.status : undefined,
      tmux_target: typeof entry.tmux_target === "string" ? entry.tmux_target : undefined,
      pane_id: typeof entry.pane_id === "string" ? entry.pane_id : tmux.pane_id,
      target: typeof entry.target === "string" ? entry.target : target,
      dispatch_path: typeof entry.dispatch_path === "string" ? resolvePath(cwd, entry.dispatch_path) : undefined,
      done_path: done.path || undefined,
      created_at: typeof entry.created_at === "string" ? entry.created_at : undefined,
      updated_at: typeof entry.updated_at === "string" ? entry.updated_at : undefined,
      registry_path: registryPath,
      done,
      tmux,
      diagnostics: agentDiagnostics,
    } satisfies AgentSnapshot;
  });

  return { run_dir: discovery.runDir, run_id: runId, agents, diagnostics };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

// ─── Formatting / compaction-panel-inspired UI ─────────────────────

const STATUS_ORDER: DerivedStatus[] = ["running", "stalled", "blocked", "failed", "crashed", "registered", "unknown", "done"];

function fmtDurationFromIso(iso: string | undefined): string {
  if (!iso) return "?";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "?";
  const secs = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m`;
  return `${Math.floor(secs / 86_400)}d${Math.floor((secs % 86_400) / 3600)}h`;
}

function statusIcon(s: DerivedStatus): string {
  const icons: Record<DerivedStatus, string> = {
    registered: "○",
    running: "●",
    stalled: "▲",
    done: "✓",
    blocked: "◆",
    failed: "✕",
    crashed: "☠",
    unknown: "?",
  };
  return icons[s];
}

function statusColor(s: DerivedStatus): "success" | "warning" | "error" | "muted" | "dim" | "accent" {
  if (s === "running" || s === "done") return "success";
  if (s === "stalled" || s === "blocked") return "warning";
  if (s === "failed" || s === "crashed") return "error";
  if (s === "registered") return "dim";
  if (s === "unknown") return "muted";
  return "accent";
}

function statusText(s: DerivedStatus): string {
  return `${statusIcon(s)} ${s}`;
}

function styleStatus(theme: any, s: DerivedStatus): string {
  return theme.fg(statusColor(s), statusText(s));
}

function countStates(agents: AgentSnapshot[]): Record<DerivedStatus, number> {
  const counts: Record<DerivedStatus, number> = {
    registered: 0,
    running: 0,
    stalled: 0,
    done: 0,
    blocked: 0,
    failed: 0,
    crashed: 0,
    unknown: 0,
  };
  for (const agent of agents) counts[agent.state]++;
  return counts;
}

function summaryParts(agents: AgentSnapshot[]): string[] {
  const counts = countStates(agents);
  return STATUS_ORDER
    .filter((state) => counts[state] > 0)
    .map((state) => `${statusIcon(state)} ${state}:${counts[state]}`);
}

function sortedAgents(agents: AgentSnapshot[]): AgentSnapshot[] {
  return [...agents].sort((a, b) => {
    const stateDelta = STATUS_ORDER.indexOf(a.state) - STATUS_ORDER.indexOf(b.state);
    if (stateDelta !== 0) return stateDelta;
    return a.agent_id.localeCompare(b.agent_id);
  });
}

function padVisible(text: string, width: number): string {
  if (width <= 0) return "";
  const clipped = truncateToWidth(text, width, "…");
  // truncateToWidth emits \x1b[0m (full SGR reset) around ellipsis/padding,
  // which kills the outer theme.bg() background. Replace with fg-only reset
  // (\x1b[39m) so the purple bg survives past the truncation point.
  const bgSafe = clipped.replace(/\x1b\[0m/g, "\x1b[39m");
  return bgSafe + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function panelTop(theme: any, width: number, title: string): string {
  if (width <= 1) return theme.bg("customMessageBg", padVisible(title, width));
  const inner = Math.max(0, width - 2);
  const rawTitle = `─ ${title} `;
  const titlePart = truncateToWidth(rawTitle, inner, "");
  const fill = "─".repeat(Math.max(0, inner - visibleWidth(titlePart)));
  return theme.bg("customMessageBg", theme.fg("borderAccent", `╭${titlePart}${fill}╮`));
}

function panelBottom(theme: any, width: number): string {
  if (width <= 1) return theme.bg("customMessageBg", " ".repeat(width));
  return theme.bg("customMessageBg", theme.fg("borderAccent", `╰${"─".repeat(Math.max(0, width - 2))}╯`));
}

function panelLine(theme: any, width: number, content = ""): string {
  if (width <= 1) return theme.bg("customMessageBg", padVisible(content, width));
  const inner = Math.max(0, width - 2);
  return theme.bg("customMessageBg", `${theme.fg("borderMuted", "│")}${padVisible(content, inner)}${theme.fg("borderMuted", "│")}`);
}

function buildDashboardText(snapshot: MonitorSnapshot, agentFilter?: string): string {
  const agents = sortedAgents(agentFilter ? snapshot.agents.filter((agent) => agent.agent_id === agentFilter) : snapshot.agents);
  const lines: string[] = [];
  lines.push("[agent-monitor] registry/DONE/tmux read-only");
  if (snapshot.run_dir) lines.push(`run: ${snapshot.run_id}  ${snapshot.run_dir}`);
  if (snapshot.agents.length > 0) lines.push(`summary: ${summaryParts(snapshot.agents).join("  ") || "no state"}`);
  for (const diagnostic of snapshot.diagnostics) lines.push(`! ${diagnostic}`);

  if (agents.length === 0) {
    lines.push(agentFilter ? `No agent found for agent_id=${agentFilter}` : "No agents found.");
    return lines.join("\n");
  }

  const sep = "─".repeat(96);
  lines.push(sep);
  lines.push(`  ${"Agent".padEnd(30)} ${"State".padEnd(12)} ${"Age".padEnd(7)} ${"Pane".padEnd(10)} Done / signal`);
  lines.push(sep);
  for (const agent of agents) {
    const doneName = agent.done.exists ? path.basename(agent.done.path) : "-";
    const signal = agent.done.next_action ?? agent.done.findings ?? agent.done.summary ?? agent.diagnostics[0] ?? "";
    lines.push(
      `  ${statusIcon(agent.state)} ${agent.agent_id.padEnd(28)} ${agent.state.padEnd(12)} ${fmtDurationFromIso(agent.created_at).padEnd(7)} ${(agent.pane_id ?? "?").padEnd(10)} ${doneName}`
    );
    if (signal) lines.push(`     ${signal}`);
    for (const diagnostic of agent.diagnostics) lines.push(`     ! ${diagnostic}`);
  }
  lines.push(sep);
  lines.push("UX: /monitor-agent opens the compact directory; choose monitor panel or toggle monitor widge from that single entry.");
  return lines.join("\n");
}

function buildWidgetComponent(snapshot: MonitorSnapshot): AgentMonitorWidget {
  return (_tui: unknown, theme: any) => ({
    invalidate() {},
    render(width: number): string[] {
      const w = Math.max(1, width);
      const lines: string[] = [];
      const label = theme.fg("customMessageLabel", theme.bold("[agent-monitor]"));
      if (!snapshot.run_dir) {
        lines.push(`${label} ${theme.fg("warning", "no run")}`);
        for (const diagnostic of snapshot.diagnostics.slice(0, 2)) lines.push(theme.fg("dim", `! ${diagnostic}`));
        return lines.map((line) => theme.bg("customMessageBg", padVisible(line, w)));
      }

      const summary = summaryParts(snapshot.agents).join("  ") || "no agents";
      lines.push(`${label} ${theme.fg("dim", snapshot.run_id ?? "run")}  ${summary}`);

      const active = sortedAgents(snapshot.agents).filter((agent) => agent.state !== "done").slice(0, 3);
      for (const agent of active) {
        lines.push(`  ${styleStatus(theme, agent.state)} ${agent.agent_id} ${theme.fg("dim", `age ${fmtDurationFromIso(agent.created_at)} pane ${agent.pane_id ?? "?"}`)}`);
      }
      if (active.length === 0 && snapshot.agents.length > 0) lines.push(theme.fg("success", "  ✓ all registered agents have DONE reports"));
      if (snapshot.diagnostics.length > 0) lines.push(theme.fg("warning", `  ! ${snapshot.diagnostics[0]}`));
      return lines.slice(0, 5).map((line) => theme.bg("customMessageBg", padVisible(line, w)));
    },
  });
}

type AgentMonitorDirectoryAction = "panel" | "close";
type AgentMonitorPanelAction = "back" | "close";

class AgentMonitorPanel {
  private snapshot: MonitorSnapshot;
  private selectedIndex = 0;
  private showDetails = true;

  constructor(
    private readonly readSnapshot: () => MonitorSnapshot,
    private readonly theme: any,
    private readonly done: (action: AgentMonitorPanelAction) => void,
    private readonly requestRender: () => void,
    initialSnapshot: MonitorSnapshot,
  ) {
    this.snapshot = initialSnapshot;
    this.clampSelection();
  }

  invalidate(): void {}

  handleInput(data: string): void {
    const agents = sortedAgents(this.snapshot.agents);
    if (matchesKey(data, Key.escape)) {
      this.done("back");
      return;
    }
    if (matchesKey(data, Key.ctrl("c")) || data === "q") {
      this.done("close");
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(Math.max(0, agents.length - 1), this.selectedIndex + 1);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter) || data === "d" || data === " ") {
      this.showDetails = !this.showDetails;
      this.requestRender();
      return;
    }
    if (data === "r") {
      this.snapshot = this.readSnapshot();
      this.clampSelection();
      this.requestRender();
    }
  }

  render(width: number): string[] {
    const w = Math.max(1, width);
    const theme = this.theme;
    const lines: string[] = [panelTop(theme, w, "monitor agent")];
    const agents = sortedAgents(this.snapshot.agents);
    this.clampSelection();

    lines.push(panelLine(theme, w, `${theme.fg("customMessageLabel", theme.bold("[agent-monitor]"))} ${theme.fg("dim", "registry / DONE / tmux observer · read-only")}`));
    if (this.snapshot.run_dir) {
      lines.push(panelLine(theme, w, `${theme.fg("muted", "run")} ${theme.fg("accent", this.snapshot.run_id ?? "unknown")} ${theme.fg("dim", this.snapshot.run_dir)}`));
    } else {
      lines.push(panelLine(theme, w, theme.fg("warning", "No RUN-* directory discovered.")));
    }
    lines.push(panelLine(theme, w, `${theme.fg("muted", "state")} ${summaryParts(this.snapshot.agents).join("  ") || "no agents"}`));

    for (const diagnostic of this.snapshot.diagnostics.slice(0, 3)) {
      lines.push(panelLine(theme, w, theme.fg("warning", `! ${diagnostic}`)));
    }

    lines.push(panelLine(theme, w));
    if (agents.length === 0) {
      lines.push(panelLine(theme, w, theme.fg("dim", "No agents in registry. Use orch worker create/dispatch to populate RUN-*/agents/*.json.")));
    } else {
      lines.push(panelLine(theme, w, `${theme.fg("dim", "  ")} ${theme.fg("muted", "agent".padEnd(28))} ${theme.fg("muted", "state".padEnd(11))} ${theme.fg("muted", "age".padEnd(7))} ${theme.fg("muted", "pane".padEnd(9))} signal`));
      const maxRows = 10;
      const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxRows / 2), Math.max(0, agents.length - maxRows)));
      const visibleAgents = agents.slice(start, start + maxRows);
      if (start > 0) lines.push(panelLine(theme, w, theme.fg("dim", `  ↑ ${start} more`)));
      for (let i = 0; i < visibleAgents.length; i++) {
        const absoluteIndex = start + i;
        const agent = visibleAgents[i];
        const selected = absoluteIndex === this.selectedIndex;
        const signal = agent.done.summary ?? agent.done.next_action ?? agent.diagnostics[0] ?? (agent.done.exists ? path.basename(agent.done.path) : "waiting");
        const cursor = selected ? theme.fg("accent", "›") : " ";
        const row = `${cursor} ${agent.agent_id.padEnd(28)} ${statusText(agent.state).padEnd(11)} ${fmtDurationFromIso(agent.created_at).padEnd(7)} ${(agent.pane_id ?? "?").padEnd(9)} ${signal}`;
        lines.push(panelLine(theme, w, selected ? theme.bg("selectedBg", padVisible(row, Math.max(0, w - 2))) : row));
      }
      const hiddenBelow = agents.length - (start + visibleAgents.length);
      if (hiddenBelow > 0) lines.push(panelLine(theme, w, theme.fg("dim", `  ↓ ${hiddenBelow} more`)));
    }

    const selectedAgent = agents[this.selectedIndex];
    if (selectedAgent && this.showDetails) {
      lines.push(panelLine(theme, w));
      lines.push(panelLine(theme, w, `${theme.fg("muted", "selected")} ${theme.fg("accent", selectedAgent.agent_id)} ${styleStatus(theme, selectedAgent.state)}`));
      lines.push(panelLine(theme, w, `${theme.fg("muted", "registry")} ${selectedAgent.registry_path}`));
      lines.push(panelLine(theme, w, `${theme.fg("muted", "done")} ${selectedAgent.done.exists ? selectedAgent.done.path : "pending"}`));
      if (selectedAgent.done.summary) lines.push(panelLine(theme, w, `${theme.fg("muted", "summary")} ${selectedAgent.done.summary}`));
      if (selectedAgent.done.next_action) lines.push(panelLine(theme, w, `${theme.fg("muted", "next")} ${selectedAgent.done.next_action}`));
      if (selectedAgent.done.tests) lines.push(panelLine(theme, w, `${theme.fg("muted", "tests")} ${selectedAgent.done.tests}`));
      for (const diagnostic of selectedAgent.diagnostics.slice(0, 2)) lines.push(panelLine(theme, w, theme.fg("warning", `! ${diagnostic}`)));
    }

    lines.push(panelLine(theme, w));
    lines.push(panelLine(theme, w, theme.fg("dim", "↑↓ select · r refresh · enter/d details · esc back · q close · monitor never sends tmux keys")));
    lines.push(panelBottom(theme, w));
    return lines;
  }

  private clampSelection(): void {
    const max = Math.max(0, this.snapshot.agents.length - 1);
    this.selectedIndex = Math.min(Math.max(0, this.selectedIndex), max);
  }
}

class AgentMonitorDirectory {
  private selectedIndex = 0;
  private snapshot: MonitorSnapshot;
  private lastToggleMessage = "";

  constructor(
    private readonly readSnapshot: () => MonitorSnapshot,
    private readonly theme: any,
    private readonly done: (action: AgentMonitorDirectoryAction) => void,
    private readonly requestRender: () => void,
    private readonly toggleWidget: () => boolean,
    initialSnapshot: MonitorSnapshot,
  ) {
    this.snapshot = initialSnapshot;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") {
      this.done("close");
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(1, this.selectedIndex + 1);
      this.requestRender();
      return;
    }
    if (data === "r") {
      this.snapshot = this.readSnapshot();
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter) || data === " ") {
      if (this.selectedIndex === 0) {
        this.done("panel");
        return;
      }
      const visible = this.toggleWidget();
      this.lastToggleMessage = visible ? "monitor widge is now pinned" : "monitor widge is now hidden";
      this.snapshot = this.readSnapshot();
      this.requestRender();
    }
  }

  render(width: number): string[] {
    const w = Math.max(1, width);
    const theme = this.theme;
    const lines: string[] = [panelTop(theme, w, "monitor agent")];
    const widgetVisible = !widgetHidden;

    lines.push(panelLine(theme, w, `${theme.fg("customMessageLabel", theme.bold("/monitor-agent"))} ${theme.fg("dim", "compact directory entrance")}`));
    lines.push(panelLine(theme, w, `${theme.fg("muted", "method")} ${theme.fg("dim", "compaction panel: customMessageBg card · label first · summary/detail · esc returns")}`));
    if (this.snapshot.run_dir) {
      lines.push(panelLine(theme, w, `${theme.fg("muted", "run")} ${theme.fg("accent", this.snapshot.run_id ?? "unknown")} ${theme.fg("dim", summaryParts(this.snapshot.agents).join("  ") || "no agents")}`));
    } else {
      lines.push(panelLine(theme, w, theme.fg("warning", "No RUN-* directory discovered yet.")));
    }
    if (this.snapshot.diagnostics[0]) lines.push(panelLine(theme, w, theme.fg("warning", `! ${this.snapshot.diagnostics[0]}`)));

    lines.push(panelLine(theme, w));
    const entries = [
      {
        label: "monitor panel",
        description: "open the full compact read-only dashboard",
        meta: `${this.snapshot.agents.length} agents`,
      },
      {
        label: "monitor widge",
        description: "toggle the compact widget on/off without leaving the menu",
        meta: widgetVisible ? "visible" : "hidden",
      },
    ];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const selected = this.selectedIndex === i;
      const cursor = selected ? theme.fg("accent", "›") : " ";
      const meta = i === 1
        ? (widgetVisible ? theme.fg("success", entry.meta) : theme.fg("dim", entry.meta))
        : theme.fg("muted", entry.meta);
      const row = `${cursor} ${entry.label.padEnd(16)} ${entry.description} ${meta}`;
      lines.push(panelLine(theme, w, selected ? theme.bg("selectedBg", padVisible(row, Math.max(0, w - 2))) : row));
    }

    if (this.lastToggleMessage) {
      lines.push(panelLine(theme, w));
      lines.push(panelLine(theme, w, theme.fg(widgetVisible ? "success" : "muted", this.lastToggleMessage)));
    }

    lines.push(panelLine(theme, w));
    lines.push(panelLine(theme, w, theme.fg("dim", "↑↓ choose sub-entry · enter dispatch/toggle · r refresh · esc/q close")));
    lines.push(panelBottom(theme, w));
    return lines;
  }
}

function refreshWidget(): void {
  if (!lastCtx?.ui?.setWidget) return;
  if (widgetHidden) {
    lastCtx.ui.setWidget(WIDGET_ID, undefined);
    return;
  }
  const snapshot = buildSnapshot(lastCtx.cwd);
  lastCtx.ui.setWidget(WIDGET_ID, buildWidgetComponent(snapshot));
}

function stopWidgetPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startWidgetPolling(): void {
  stopWidgetPolling();
  if (!widgetHidden) pollTimer = setInterval(refreshWidget, POLL_INTERVAL_MS);
}

function clearWidget(): void {
  lastCtx?.ui?.setWidget?.(WIDGET_ID, undefined);
}

function setWidgetPinned(pinned: boolean): boolean {
  widgetHidden = !pinned;
  if (pinned) {
    refreshWidget();
    startWidgetPolling();
  } else {
    stopWidgetPolling();
    clearWidget();
  }
  return pinned;
}

function toggleWidgetPinned(): boolean {
  return setWidgetPinned(widgetHidden);
}

async function openMonitorPanel(ctx: { cwd: string; hasUI?: boolean; ui: AgentMonitorUi }, runDir?: string): Promise<AgentMonitorPanelAction> {
  lastCtx = ctx as typeof lastCtx;
  const initialSnapshot = buildSnapshot(ctx.cwd, runDir);
  refreshWidget();

  if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
    ctx.ui.notify?.(buildDashboardText(initialSnapshot), "info");
    return "close";
  }

  return await ctx.ui.custom<AgentMonitorPanelAction>((tui: any, theme: any, _keybindings: any, done: (value: AgentMonitorPanelAction) => void) => {
    const panel = new AgentMonitorPanel(
      () => buildSnapshot(ctx.cwd, runDir),
      theme,
      done,
      () => tui.requestRender(),
      initialSnapshot,
    );
    return panel;
  }, {
    overlay: true,
    overlayOptions: {
      anchor: "center",
      width: "88%",
      minWidth: 80,
      maxHeight: "92%",
      margin: 1,
    },
  });
}

async function openAgentMonitorDirectory(ctx: { cwd: string; hasUI?: boolean; ui: AgentMonitorUi }, runDir?: string): Promise<void> {
  lastCtx = ctx as typeof lastCtx;
  const initialSnapshot = buildSnapshot(ctx.cwd, runDir);

  if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
    ctx.ui.notify?.([
      "/monitor-agent",
      "  1. monitor panel  - open compact read-only dashboard",
      `  2. monitor widge  - ${widgetHidden ? "show" : "hide"} compact widget`,
      "compaction panel method: customMessageBg card, label-first summary, expandable detail, esc returns.",
      "Interactive TUI required for arrow-key dispatch.",
    ].join("\n"), "info");
    return;
  }

  const action = await ctx.ui.custom<AgentMonitorDirectoryAction>((tui: any, theme: any, _keybindings: any, done: (value: AgentMonitorDirectoryAction) => void) => {
    const directory = new AgentMonitorDirectory(
      () => buildSnapshot(ctx.cwd, runDir),
      theme,
      done,
      () => tui.requestRender(),
      toggleWidgetPinned,
      initialSnapshot,
    );
    return directory;
  }, {
    overlay: true,
    overlayOptions: {
      anchor: "center",
      width: "74%",
      minWidth: 72,
      maxHeight: "82%",
      margin: 1,
    },
  });

  if (action === "panel") {
    const panelAction = await openMonitorPanel(ctx, runDir);
    if (panelAction === "back") await openAgentMonitorDirectory(ctx, runDir);
  }
}

function parseMonitorAgentArgs(args: string): { ok: boolean; runDir?: string; reason?: string } {
  const trimmed = args.trim();
  if (!trimmed) return { ok: true };
  return { ok: true, runDir: trimmed };
}

// ─── Extension ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx as typeof lastCtx;
    refreshWidget();
    startWidgetPolling();
  });

  pi.on("session_shutdown", async () => {
    stopWidgetPolling();
    clearWidget();
    lastCtx = null;
  });

  // Deprecated compatibility shim: registry files are now source of truth.
  pi.registerTool({
    name: "agent_register",
    label: "Register Agent (Deprecated)",
    description: "Deprecated no-op. Agent monitor reads RUN-*/agents/*.json registry files written by the orch Python CLI.",
    promptSnippet: "Deprecated: agent_register is not required; registry files are source of truth",
    promptGuidelines: ["Do not use agent_register for normal orchestration; use orch worker create/dispatch so registry JSON is written."],
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Deprecated agent name" })),
      tmux_target: Type.Optional(Type.String({ description: "Deprecated tmux target" })),
      dispatch_file: Type.Optional(Type.String({ description: "Deprecated dispatch file" })),
      done_file: Type.Optional(Type.String({ description: "Deprecated done file" })),
      run_dir: Type.Optional(Type.String({ description: "Run directory to inspect instead" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const snapshot = buildSnapshot(ctx.cwd, params.run_dir);
      return {
        content: [{ type: "text", text: `agent_register is deprecated and did not mutate monitor state.\n\n${buildDashboardText(snapshot)}` }],
        details: { deprecated: true, guidance: "Use orch worker create/dispatch; monitor reads RUN-*/agents/*.json.", ...snapshot },
      };
    },
  });

  pi.registerTool({
    name: "agent_status",
    label: "Agent Status",
    description: "Read RUN registry, DONE files, and tmux liveness to report agent status as structured JSON.",
    promptSnippet: "Check registry-backed orchestrator agent status",
    promptGuidelines: [
      "Use agent_status to inspect registry-backed worker state; it does not require agent_register.",
      "DONE files override tmux liveness; missing pane without DONE is reported as crashed.",
    ],
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "Specific agent_id, or omit for all" })),
      run_dir: Type.Optional(Type.String({ description: "Explicit RUN-* directory; otherwise env/latest fallback is used" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const snapshot = buildSnapshot(ctx.cwd, params.run_dir);
      return {
        content: [{ type: "text", text: buildDashboardText(snapshot, params.agent) }],
        details: params.agent
          ? { ...snapshot, agents: snapshot.agents.filter((agent) => agent.agent_id === params.agent) }
          : snapshot,
      };
    },
  });

  pi.registerTool({
    name: "agent_capture",
    label: "Capture Agent Pane",
    description: "Read-only capture of recent output from an agent pane found in RUN registry.",
    promptSnippet: "Peek at a registry-backed agent's terminal output",
    promptGuidelines: ["Use agent_capture for read-only diagnosis; it never sends keys or mutates worker lifecycle."],
    parameters: Type.Object({
      agent: Type.String({ description: "agent_id from registry" }),
      lines: Type.Optional(Type.Number({ description: "Lines to capture (default 40, max 120)" })),
      run_dir: Type.Optional(Type.String({ description: "Explicit RUN-* directory; otherwise env/latest fallback is used" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const snapshot = buildSnapshot(ctx.cwd, params.run_dir);
      const agent = snapshot.agents.find((candidate) => candidate.agent_id === params.agent);
      if (!agent) {
        return { content: [{ type: "text", text: buildDashboardText(snapshot, params.agent) }], details: snapshot };
      }
      const target = agent.pane_id ?? agent.target ?? agent.tmux_target;
      if (!target) {
        return { content: [{ type: "text", text: `Agent ${params.agent} has no pane target in registry.` }], details: agent };
      }
      const n = Math.min(Math.max(params.lines ?? 40, 1), 120);
      const output = capturePane(target, n);
      return {
        content: [{ type: "text", text: `--- ${agent.agent_id} (${agent.state}) @ ${target} ---\n${output || "<empty or unreachable>"}` }],
        details: { agent, lines: n },
      };
    },
  });

  pi.registerTool({
    name: "agent_wait",
    label: "Wait for Agent (Disabled)",
    description: "Disabled in read-only dashboard phase; poll agent_status instead.",
    promptSnippet: "Disabled: agent_wait lifecycle ownership is deferred",
    parameters: Type.Object({
      agent: Type.Optional(Type.String()),
      states: Type.Optional(Type.String()),
      timeout: Type.Optional(Type.Number()),
    }),
    async execute() {
      return {
        content: [{ type: "text", text: "agent_wait is disabled for the read-only monitor. Use agent_status for observation and orch worker wait for lifecycle waiting." }],
        details: { disabled: true },
      };
    },
  });

  pi.registerTool({
    name: "agent_send",
    label: "Send to Agent Pane (Disabled)",
    description: "Disabled in read-only dashboard phase; this extension does not send messages to workers.",
    promptSnippet: "Disabled: agent_send is not available in read-only monitor",
    parameters: Type.Object({
      agent: Type.Optional(Type.String()),
      message: Type.Optional(Type.String()),
    }),
    async execute() {
      return {
        content: [{ type: "text", text: "agent_send is disabled. The monitor is read-only and never sends tmux keys to workers." }],
        details: { disabled: true },
      };
    },
  });

  pi.registerCommand("monitor-agent", {
    description: "Monitor Agent directory with monitor panel and monitor widge sub-entries.",
    handler: async (args, ctx) => {
      const parsed = parseMonitorAgentArgs(args);
      lastCtx = ctx as typeof lastCtx;
      if (!parsed.ok) {
        ctx.ui.notify(parsed.reason ?? "Usage: /monitor-agent [RUN-* directory]", "info");
        return;
      }
      await openAgentMonitorDirectory(ctx as { cwd: string; hasUI?: boolean; ui: AgentMonitorUi }, parsed.runDir);
    },
  });
}
