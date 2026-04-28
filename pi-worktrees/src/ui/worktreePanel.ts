import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent';
import { Key, matchesKey } from '@mariozechner/pi-tui';
import { basename, join } from 'path';
import type { CommandDeps } from '../types.ts';
import {
  ensureExcluded,
  getCurrentBranch,
  getMainWorktreePath,
  getProjectName,
  git,
  isGitRepo,
  isWorktree,
  listWorktrees,
  type WorktreeInfo,
} from '../services/git.ts';
import { expandTemplate } from '../services/templates.ts';
import { getConfiguredWorktreeRoot, type MatchingStrategy, type WorktreeSettingsConfig } from '../services/config/schema.ts';
import { cmdRemove } from '../cmds/cmdRemove.ts';
import { cmdPrune } from '../cmds/cmdPrune.ts';
import { cmdTemplates } from '../cmds/cmdTemplates.ts';
import { cmdInit } from '../cmds/cmdInit.ts';
import { resolveLogfilePath, runHook, runOnCreateHook, sanitizePathPart, type HookProgressEvent } from '../cmds/shared.ts';
import { DefaultLogfileTemplate } from '../services/config/config.ts';
import { withHookProgressPanel } from './hookProgressPanel.ts';
import {
  borderBottom,
  borderLine,
  borderMid,
  borderTop,
  boolMark,
  shortPath,
  valueLine,
  WORKTREE_OVERLAY,
} from './panelStyle.ts';

// ─── Constants ────────────────────────────────────────
const MENU_ITEMS = [
  { id: 'create', label: 'Create Worktree', desc: '创建新 branch-first worktree' },
  { id: 'list', label: 'Worktrees', desc: '查看全部 worktree，运行 onSwitch 或打印路径' },
  { id: 'remove', label: 'Remove', desc: '安全删除非 main/current worktree' },
  { id: 'settings', label: 'Settings', desc: '配置 worktreeRoot、匹配规则和 hook' },
  { id: 'templates', label: 'Templates', desc: '预览 {{path}}/{{name}}/{{branch}} 等变量' },
  { id: 'prune', label: 'Prune', desc: '清理 stale git worktree metadata' },
  { id: 'status', label: 'Status', desc: '查看 repo / branch / config 详情' },
] as const;

type MenuId = (typeof MENU_ITEMS)[number]['id'];
type PanelAction = MenuId | 'close' | 'refresh';

// ─── Snapshot ─────────────────────────────────────────
// ALL git calls happen here, exactly once.
// render() reads this object — zero git calls, zero IO.

interface PanelSnapshot {
  isRepo: boolean;
  project: string;
  branch: string;
  mainPath: string;
  isWorktreeDir: boolean;
  parentDir: string;
  matchedPattern: string | null;
  worktreeRoot: string;
  worktrees: WorktreeInfo[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  settings: any;
}

interface RemoveSnapshot extends PanelSnapshot {
  dirtyMap: Map<string, 'clean' | 'dirty' | 'unknown'>;
}

function buildSnapshot(ctx: ExtensionCommandContext, deps: CommandDeps): PanelSnapshot {
  if (!isGitRepo(ctx.cwd)) {
    return {
      isRepo: false, project: '', branch: '', mainPath: '',
      isWorktreeDir: false, parentDir: '', matchedPattern: null,
      worktreeRoot: '', worktrees: [], settings: {},
    };
  }
  const settings = getCurrentSettings(deps, ctx);
  return {
    isRepo: true,
    project: getProjectName(ctx.cwd),
    branch: getCurrentBranch(ctx.cwd),
    mainPath: getMainWorktreePath(ctx.cwd),
    isWorktreeDir: isWorktree(ctx.cwd),
    parentDir: settings.parentDir,
    matchedPattern: settings.matchedPattern ?? null,
    worktreeRoot: getConfiguredWorktreeRoot(settings) ?? '{{mainWorktree}}.worktrees',
    worktrees: listWorktrees(ctx.cwd),
    settings,
  };
}

function buildRemoveSnapshot(ctx: ExtensionCommandContext, deps: CommandDeps): RemoveSnapshot {
  const base = buildSnapshot(ctx, deps);
  const dirtyMap = new Map<string, 'clean' | 'dirty' | 'unknown'>();
  for (const wt of base.worktrees) {
    if (wt.isMain || wt.isCurrent) continue;
    try {
      dirtyMap.set(wt.path, git(['status', '--porcelain'], wt.path).trim() ? 'dirty' : 'clean');
    } catch {
      dirtyMap.set(wt.path, 'unknown');
    }
  }
  return { ...base, dirtyMap };
}

// ─── Helpers (no git) ─────────────────────────────────

function notify(ctx: any, msg: string, level: 'info' | 'success' | 'warning' | 'error' = 'info') {
  if (ctx.hasUI) ctx.ui.notify(msg, level);
  else console.log(`[worktree:${level}] ${msg}`);
}

function hookSummary(theme: any, settings: any): string {
  return `onCreate ${boolMark(theme, settings.onCreate)}  onSwitch ${boolMark(theme, settings.onSwitch)}  onBeforeRemove ${boolMark(theme, settings.onBeforeRemove)}`;
}

function getCurrentSettings(deps: CommandDeps, ctx: ExtensionCommandContext) {
  return deps.configService.current(ctx) as ReturnType<CommandDeps['configService']['current']> & { matchedPattern?: string | null };
}

function hookCommands(hookValue: unknown, createdCtx: { path: string; name: string; branch: string; project: string; mainWorktree: string }): string[] {
  const templates = Array.isArray(hookValue) ? hookValue : hookValue ? [hookValue] : [];
  return templates.map((t) => expandTemplate(String(t), createdCtx));
}

function initialHookEvent(
  hookName: HookProgressEvent['hookName'],
  createdCtx: HookProgressEvent['worktree'],
  hookValue: unknown,
  logPath?: string
): HookProgressEvent {
  const commands = hookCommands(hookValue, createdCtx);
  return {
    hookName,
    worktree: createdCtx,
    commands,
    states: commands.map(() => 'pending'),
    outputs: commands.map(() => ({ stdout: '', stderr: '' })),
    currentIndex: null,
    logPath,
    done: commands.length === 0,
    success: commands.length === 0 ? true : undefined,
  };
}

function gitMaybe(args: string[], cwd: string): string | null {
  try { return git(args, cwd); } catch { return null; }
}

// ─── Main Panel ───────────────────────────────────────

export async function showWorktreePanel(
  _pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  deps: CommandDeps
): Promise<void> {
  if (!ctx.hasUI) {
    notify(ctx, '交互面板仅支持 TUI 模式，使用 /worktree status|list|create|remove|settings', 'info');
    return;
  }

  let active = true;
  while (active) {
    const snap = buildSnapshot(ctx, deps);
    let selected = 0;

    const result = await ctx.ui.custom<PanelAction>((tui, theme, _kb, done) => ({
      render(W: number) {
        if (!snap.isRepo) {
          return [
            borderTop(W, theme),
            borderLine(theme.fg('accent', theme.bold('Worktrees')), W, theme),
            borderMid(W, theme),
            borderLine(theme.fg('warning', 'Not in a git repository.'), W, theme),
            borderLine(theme.fg('dim', 'Open Pi from a git checkout to manage worktrees.'), W, theme),
            borderMid(W, theme),
            borderLine(theme.fg('dim', 'Esc/q 关闭'), W, theme),
            borderBottom(W, theme),
          ];
        }
        return [
          borderTop(W, theme),
          borderLine(theme.fg('accent', theme.bold('Worktrees')), W, theme),
          borderMid(W, theme),
          borderLine(valueLine(theme, 'Project', snap.project), W, theme),
          borderLine(valueLine(theme, 'Current', `${snap.branch} · ${snap.isWorktreeDir ? 'worktree' : 'main repo'}`), W, theme),
          borderLine(valueLine(theme, 'Main', shortPath(snap.mainPath)), W, theme),
          borderLine(valueLine(theme, 'Root', snap.worktreeRoot), W, theme),
          borderLine(valueLine(theme, 'Matched', snap.matchedPattern ?? '**', 'dim'), W, theme),
          borderLine(valueLine(theme, 'Worktrees', `${snap.worktrees.length} total · ${snap.worktrees.filter((w) => w.isCurrent).length} current`), W, theme),
          borderLine(`${theme.fg('muted', 'Hooks'.padEnd(13))} ${hookSummary(theme, snap.settings)}`, W, theme),
          borderMid(W, theme),
          ...MENU_ITEMS.flatMap((item, i) =>
            i === selected
              ? [
                  borderLine(theme.fg('accent', `▸ ${theme.bold(item.label)}`), W, theme),
                  borderLine(theme.fg('muted', `  ${item.desc}`), W, theme),
                ]
              : [borderLine(theme.fg('text', `  ${item.label}`), W, theme)]
          ),
          borderMid(W, theme),
          borderLine(theme.fg('dim', '↑↓ 选择 · Enter 确认 · r 刷新 · c/l/d/s 快捷 · Esc/q 关闭'), W, theme),
          borderBottom(W, theme),
        ];
      },
      invalidate() {},
      handleInput(data: string) {
        if (matchesKey(data, Key.up)) { selected = (selected - 1 + MENU_ITEMS.length) % MENU_ITEMS.length; tui.requestRender(); return; }
        if (matchesKey(data, Key.down)) { selected = (selected + 1) % MENU_ITEMS.length; tui.requestRender(); return; }
        if (matchesKey(data, Key.enter)) { done(MENU_ITEMS[selected].id); return; }
        if (data === 'r' || data === 'R') { done('refresh'); return; }
        if (data === 'c' || data === 'C') { done('create'); return; }
        if (data === 'l' || data === 'L') { done('list'); return; }
        if (data === 'd' || data === 'D') { done('remove'); return; }
        if (data === 's' || data === 'S') { done('settings'); return; }
        if (matchesKey(data, Key.escape) || data === 'q' || data === 'Q') { done('close'); }
      },
    }), WORKTREE_OVERLAY);

    if (result === 'close') active = false;
    else if (result === 'refresh') { await deps.configService.reload(); }
    else if (result === 'create') await showCreateWizard(ctx, deps);
    else if (result === 'list') await showListPanel(ctx, deps);
    else if (result === 'remove') await showRemovePanel(ctx, deps);
    else if (result === 'settings') await showSettingsPanel(ctx, deps);
    else if (result === 'templates') await showTemplatesPanel(ctx, deps);
    else if (result === 'prune') await showPrunePanel(ctx, deps);
    else if (result === 'status') await showStatusPanel(ctx, deps);
  }
}

// ─── List Panel ───────────────────────────────────────

async function showListPanel(ctx: ExtensionCommandContext, deps: CommandDeps): Promise<void> {
  let snap = buildSnapshot(ctx, deps);
  if (!snap.isRepo) { notify(ctx, 'Not in a git repository', 'error'); return; }
  let selected = 0;

  const action = await ctx.ui.custom<'back' | 'path' | 'switch' | 'remove'>((tui, theme, _kb, done) => ({
    render(W: number) {
      const wt = snap.worktrees;
      if (selected >= wt.length) selected = Math.max(0, wt.length - 1);
      const maxRows = Math.min(wt.length, 10);
      const start = Math.max(0, Math.min(selected - 4, Math.max(0, wt.length - maxRows)));
      const target = wt[selected];
      const lines: string[] = [
        borderTop(W, theme),
        borderLine(theme.fg('accent', theme.bold('Worktrees')), W, theme),
        borderMid(W, theme),
        borderLine(`${theme.fg('muted', '  name'.padEnd(28))} ${theme.fg('muted', 'branch'.padEnd(22))} flags`, W, theme),
      ];
      for (let offset = 0; offset < maxRows; offset++) {
        const i = start + offset;
        const w = wt[i];
        const flags = [w.isMain ? 'main' : 'wt', w.isCurrent ? 'cur' : ''].filter(Boolean).join(' ');
        const row = `${i === selected ? '▸' : ' '} ${basename(w.path).padEnd(26)} ${w.branch.padEnd(22)} ${flags}`;
        lines.push(borderLine(i === selected ? theme.fg('accent', row) : row, W, theme));
      }
      if (wt.length === 0) lines.push(borderLine(theme.fg('dim', 'No worktrees found'), W, theme));
      lines.push(borderMid(W, theme));
      if (target) {
        lines.push(borderLine(valueLine(theme, 'Selected', basename(target.path)), W, theme));
        lines.push(borderLine(valueLine(theme, 'Branch', target.branch), W, theme));
        lines.push(borderLine(valueLine(theme, 'Path', shortPath(target.path)), W, theme));
        lines.push(borderLine(valueLine(theme, 'HEAD', target.head.slice(0, 10), 'dim'), W, theme));
        lines.push(borderLine(valueLine(theme, 'onSwitch', snap.settings.onSwitch ? 'configured' : 'not configured', snap.settings.onSwitch ? 'success' : 'dim'), W, theme));
      }
      lines.push(borderMid(W, theme));
      lines.push(borderLine(theme.fg('dim', 'Enter onSwitch/print path · p path · d remove · r refresh · Esc back'), W, theme));
      lines.push(borderBottom(W, theme));
      return lines;
    },
    invalidate() {},
    handleInput(data: string) {
      if (matchesKey(data, Key.up)) { selected = Math.max(0, selected - 1); tui.requestRender(); return; }
      if (matchesKey(data, Key.down)) { selected = Math.min(snap.worktrees.length - 1, selected + 1); tui.requestRender(); return; }
      if (data === 'r' || data === 'R') { snap = buildSnapshot(ctx, deps); tui.requestRender(); return; }
      if (data === 'p' || data === 'P') { done('path'); return; }
      if (data === 'd' || data === 'D') { done('remove'); return; }
      if (matchesKey(data, Key.enter)) { done('switch'); return; }
      if (matchesKey(data, Key.escape) || data === 'q' || data === 'Q') { done('back'); }
    },
  }), WORKTREE_OVERLAY);

  const target = snap.worktrees[selected];
  if (!target || action === 'back') return;
  if (action === 'path') { notify(ctx, `Worktree path: ${target.path}`, 'info'); return; }
  if (action === 'remove') { await cmdRemove(basename(target.path), ctx, deps); return; }
  if (action === 'switch') {
    const current = snap.settings;
    if (!current.onSwitch) { notify(ctx, `Worktree path: ${target.path}`, 'info'); return; }

    const sessionId = sanitizePathPart(ctx.sessionManager?.getSessionId?.() || 'session');
    const safeName = sanitizePathPart(basename(target.path));
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = resolveLogfilePath(current.logfile ?? DefaultLogfileTemplate, { sessionId, name: safeName, timestamp });
    const createdCtx = {
      path: target.path,
      name: basename(target.path),
      branch: target.branch,
      project: current.project,
      mainWorktree: current.mainWorktree,
    };
    const stopBusy = deps.statusService.busy(ctx, `Running onSwitch for ${target.branch}...`);
    try {
      const hookResult = await withHookProgressPanel(
        ctx,
        initialHookEvent('onSwitch', createdCtx, current.onSwitch, logPath),
        (onProgress) => runHook(createdCtx, current.onSwitch, 'onSwitch', ctx.ui.notify.bind(ctx.ui), {
          logPath,
          displayOutputMaxLines: current.onCreateDisplayOutputMaxLines,
          cmdDisplayPending: current.onCreateCmdDisplayPending,
          cmdDisplaySuccess: current.onCreateCmdDisplaySuccess,
          cmdDisplayError: current.onCreateCmdDisplayError,
          cmdDisplayPendingColor: current.onCreateCmdDisplayPendingColor,
          cmdDisplaySuccessColor: current.onCreateCmdDisplaySuccessColor,
          cmdDisplayErrorColor: current.onCreateCmdDisplayErrorColor,
          onProgress,
        })
      );
      stopBusy();
      if (hookResult.success) deps.statusService.positive(ctx, `onSwitch complete: ${target.branch}`);
      else deps.statusService.critical(ctx, 'onSwitch failed');
    } catch (error) {
      stopBusy();
      deps.statusService.critical(ctx, 'onSwitch failed');
      notify(ctx, `onSwitch failed: ${(error as Error).message}`, 'error');
    }
  }
}

// ─── Create Panel ─────────────────────────────────────

export async function showCreateWizard(ctx: ExtensionCommandContext, deps: CommandDeps): Promise<void> {
  const snap = buildSnapshot(ctx, deps);
  if (!snap.isRepo) { notify(ctx, 'Not in a git repository', 'error'); return; }

  let branch = 'feature/';
  let explicitName = '';
  let focus: 0 | 1 = 0;
  let cursor = branch.length;
  let preflightError = '';

  const deriveName = () => {
    const raw = explicitName.trim() || branch.trim().split('/').filter(Boolean).pop() || branch.trim();
    return raw.replace(/[^\w.-]/g, '-');
  };
  const curVal = () => (focus === 0 ? branch : explicitName);
  const setVal = (v: string) => { if (focus === 0) branch = v; else explicitName = v; };

  const form = await ctx.ui.custom<{ branch: string; name: string } | null>((tui, theme, _kb, done) => ({
    render(W: number) {
      const worktreeName = deriveName();
      const path = join(snap.parentDir, worktreeName);
      const renderInput = (label: string, value: string, active: boolean) => {
        const prefix = active ? '▸' : ' ';
        if (!active) return `${prefix} ${label.padEnd(8)} ${value || theme.fg('dim', '(auto)')}`;
        const before = value.slice(0, cursor);
        const at = value.slice(cursor, cursor + 1) || ' ';
        const after = value.slice(cursor + 1);
        return `${prefix} ${label.padEnd(8)} ${before}\x1b[7m${at}\x1b[27m${after}`;
      };
      const lines = [
        borderTop(W, theme),
        borderLine(theme.fg('accent', theme.bold('Create Worktree')), W, theme),
        borderMid(W, theme),
        borderLine(renderInput('Branch', branch, focus === 0), W, theme),
        borderLine(renderInput('Name', explicitName, focus === 1), W, theme),
        borderMid(W, theme),
        borderLine(valueLine(theme, 'Resolved', worktreeName || '(empty)'), W, theme),
        borderLine(valueLine(theme, 'Path', shortPath(path)), W, theme),
        borderLine(valueLine(theme, 'Hook', snap.settings.onCreate ? String(snap.settings.onCreate) : 'not configured', snap.settings.onCreate ? 'success' : 'dim'), W, theme),
      ];
      if (preflightError) {
        lines.push(borderMid(W, theme));
        lines.push(borderLine(theme.fg('error', `⚠ ${preflightError}`), W, theme));
      }
      lines.push(borderMid(W, theme));
      lines.push(borderLine(theme.fg('dim', '↑↓ field · ←→ cursor · Enter create · Backspace edit · Esc back'), W, theme));
      lines.push(borderBottom(W, theme));
      return lines;
    },
    invalidate() {},
    handleInput(data: string) {
      if (matchesKey(data, Key.escape)) { done(null); return; }
      if (matchesKey(data, Key.up)) { focus = 0; cursor = Math.min(cursor, curVal().length); tui.requestRender(); return; }
      if (matchesKey(data, Key.down)) { focus = 1; cursor = Math.min(cursor, curVal().length); tui.requestRender(); return; }
      if (matchesKey(data, Key.enter)) {
        const worktreeName = deriveName();
        const path = join(snap.parentDir, worktreeName);
        const exists = snap.worktrees.some((w) => w.path === path || basename(w.path) === worktreeName || w.branch === branch.trim());
        const branchExists = branch.trim() ? gitMaybe(['rev-parse', '--verify', branch.trim()], ctx.cwd) !== null : false;
        if (!branch.trim() || !worktreeName) { preflightError = 'Branch and name cannot be empty'; tui.requestRender(); return; }
        if (exists) { preflightError = 'Path or branch already exists'; tui.requestRender(); return; }
        if (branchExists) { preflightError = `Branch '${branch.trim()}' already exists`; tui.requestRender(); return; }
        done({ branch: branch.trim(), name: worktreeName });
        return;
      }
      preflightError = '';
      let value = curVal();
      if (data === '\x7f' || data === '\x08') {
        if (cursor > 0) { value = value.slice(0, cursor - 1) + value.slice(cursor); cursor--; setVal(value); tui.requestRender(); }
        return;
      }
      if (data.startsWith('\x1b[')) {
        const code = data.slice(2);
        if (code === 'D') cursor = Math.max(0, cursor - 1);
        else if (code === 'C') cursor = Math.min(value.length, cursor + 1);
        else if (code === 'H' || code === '1~') cursor = 0;
        else if (code === 'F' || code === '4~') cursor = value.length;
        else if (code === '3~' && cursor < value.length) { value = value.slice(0, cursor) + value.slice(cursor + 1); setVal(value); }
        tui.requestRender();
        return;
      }
      if (data.length === 1 && data.charCodeAt(0) >= 32) {
        value = value.slice(0, cursor) + data + value.slice(cursor);
        cursor++;
        setVal(value);
        tui.requestRender();
      }
    },
  }), WORKTREE_OVERLAY);

  if (!form) return;
  const worktreePath = join(snap.parentDir, form.name);
  ensureExcluded(ctx.cwd, snap.parentDir);
  const stopBusy = deps.statusService.busy(ctx, `Creating worktree: ${form.name}...`);
  try {
    git(['worktree', 'add', '-b', form.branch, worktreePath], snap.settings.mainWorktree);
    stopBusy();
    deps.statusService.positive(ctx, `Created: ${form.name}`);
  } catch (err) {
    stopBusy();
    deps.statusService.critical(ctx, 'Failed to create worktree');
    notify(ctx, `Failed to create worktree: ${(err as Error).message}`, 'error');
    return;
  }

  const createdCtx = {
    path: worktreePath, name: form.name, branch: form.branch,
    project: snap.settings.project, mainWorktree: snap.settings.mainWorktree,
  };
  const sessionId = sanitizePathPart(ctx.sessionManager?.getSessionId?.() || 'session');
  const safeName = sanitizePathPart(form.name);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = resolveLogfilePath(snap.settings.logfile ?? DefaultLogfileTemplate, { sessionId, name: safeName, timestamp });

  await withHookProgressPanel(
    ctx,
    initialHookEvent('onCreate', createdCtx, snap.settings.onCreate, logPath),
    (onProgress) => runOnCreateHook(createdCtx, snap.settings, ctx.ui.notify.bind(ctx.ui), {
      logPath,
      displayOutputMaxLines: snap.settings.onCreateDisplayOutputMaxLines,
      cmdDisplayPending: snap.settings.onCreateCmdDisplayPending,
      cmdDisplaySuccess: snap.settings.onCreateCmdDisplaySuccess,
      cmdDisplayError: snap.settings.onCreateCmdDisplayError,
      cmdDisplayPendingColor: snap.settings.onCreateCmdDisplayPendingColor,
      cmdDisplaySuccessColor: snap.settings.onCreateCmdDisplaySuccessColor,
      cmdDisplayErrorColor: snap.settings.onCreateCmdDisplayErrorColor,
      onProgress,
    })
  );
}

// ─── Remove Panel ─────────────────────────────────────

async function showRemovePanel(ctx: ExtensionCommandContext, deps: CommandDeps): Promise<void> {
  let snap = buildRemoveSnapshot(ctx, deps);
  if (!snap.isRepo) { notify(ctx, 'Not in a git repository', 'error'); return; }
  let selected = Math.max(0, snap.worktrees.findIndex((w) => !w.isMain && !w.isCurrent));

  const result = await ctx.ui.custom<'back' | 'remove'>((tui, theme, _kb, done) => ({
    render(W: number) {
      const lines: string[] = [
        borderTop(W, theme),
        borderLine(theme.fg('accent', theme.bold('Remove Worktree')), W, theme),
        borderMid(W, theme),
        borderLine(`${theme.fg('muted', '  name'.padEnd(28))} ${theme.fg('muted', 'branch'.padEnd(20))} status`, W, theme),
      ];
      for (let i = 0; i < Math.min(snap.worktrees.length, 10); i++) {
        const wt = snap.worktrees[i];
        const locked = wt.isMain || wt.isCurrent;
        const state = locked ? 'locked' : (snap.dirtyMap.get(wt.path) ?? 'unknown');
        const row = `${i === selected ? '▸' : ' '} ${basename(wt.path).padEnd(26)} ${wt.branch.padEnd(20)} ${state}`;
        lines.push(borderLine(locked ? theme.fg('dim', row) : i === selected ? theme.fg('accent', row) : row, W, theme));
      }
      const target = snap.worktrees[selected];
      lines.push(borderMid(W, theme));
      if (target) {
        lines.push(borderLine(valueLine(theme, 'Selected', basename(target.path)), W, theme));
        lines.push(borderLine(valueLine(theme, 'Path', shortPath(target.path)), W, theme));
        lines.push(borderLine(valueLine(theme, 'Safety', target.isMain || target.isCurrent ? 'locked: main/current cannot be removed' : 'branch will NOT be deleted', target.isMain || target.isCurrent ? 'warning' : 'success'), W, theme));
      }
      lines.push(borderMid(W, theme));
      lines.push(borderLine(theme.fg('dim', '↑↓ 选择 · Enter confirm · r refresh · Esc back'), W, theme));
      lines.push(borderBottom(W, theme));
      return lines;
    },
    invalidate() {},
    handleInput(data: string) {
      if (matchesKey(data, Key.up)) { selected = Math.max(0, selected - 1); tui.requestRender(); return; }
      if (matchesKey(data, Key.down)) { selected = Math.min(snap.worktrees.length - 1, selected + 1); tui.requestRender(); return; }
      if (data === 'r' || data === 'R') { snap = buildRemoveSnapshot(ctx, deps); tui.requestRender(); return; }
      if (matchesKey(data, Key.enter)) done('remove');
      else if (matchesKey(data, Key.escape) || data === 'q' || data === 'Q') done('back');
    },
  }), WORKTREE_OVERLAY);

  const target = snap.worktrees[selected];
  if (result !== 'remove' || !target) return;
  if (target.isMain || target.isCurrent) { notify(ctx, 'Cannot remove main/current worktree', 'warning'); return; }
  await cmdRemove(basename(target.path), ctx, deps);
}

// ─── Settings Panel ───────────────────────────────────

async function saveCurrentWorktreeSetting(ctx: ExtensionCommandContext, deps: CommandDeps, patch: WorktreeSettingsConfig): Promise<void> {
  const resolvedCurrent = deps.configService.current(ctx) as { matchedPattern?: string | null };
  const matchedPattern = resolvedCurrent.matchedPattern ?? '**';
  const configuredWorktrees = deps.configService.config.worktrees ?? {};
  const newSettings = { ...(configuredWorktrees[matchedPattern] ?? {}), ...patch };
  await deps.configService.save({ worktrees: { ...configuredWorktrees, [matchedPattern]: newSettings } });
  await deps.configService.reload();
}

async function showSettingsPanel(ctx: ExtensionCommandContext, deps: CommandDeps): Promise<void> {
  const snap = buildSnapshot(ctx, deps);
  if (!snap.isRepo) { await cmdInit('', ctx, deps); return; }
  const items = [
    { id: 'root', label: 'Worktree Root', desc: '配置 worktreeRoot 模板' },
    { id: 'onCreate', label: 'onCreate', desc: '创建后运行的 hook' },
    { id: 'onSwitch', label: 'onSwitch', desc: '选择已有 worktree 后运行的 hook' },
    { id: 'onBeforeRemove', label: 'onBeforeRemove', desc: '删除前运行的保护 hook' },
    { id: 'generator', label: 'Branch Generator', desc: '配置 --generate 命令' },
    { id: 'strategy', label: 'Matching Strategy', desc: 'fail-on-tie / first-wins / last-wins' },
  ] as const;
  let selected = 0;

  const result = await ctx.ui.custom<string>((tui, theme, _kb, done) => ({
    render(W: number) {
      const s = snap.settings;
      return [
        borderTop(W, theme),
        borderLine(theme.fg('accent', theme.bold('Worktree Settings')), W, theme),
        borderMid(W, theme),
        borderLine(valueLine(theme, 'Matched', snap.matchedPattern ?? '**', 'dim'), W, theme),
        borderLine(valueLine(theme, 'Root', snap.worktreeRoot), W, theme),
        borderLine(valueLine(theme, 'Strategy', deps.configService.config.matchingStrategy ?? 'fail-on-tie'), W, theme),
        borderLine(`${theme.fg('muted', 'Hooks'.padEnd(13))} ${hookSummary(theme, s)}`, W, theme),
        borderLine(valueLine(theme, 'Generator', s.branchNameGenerator ? 'configured' : 'not configured', s.branchNameGenerator ? 'success' : 'dim'), W, theme),
        borderMid(W, theme),
        ...items.map((item, i) =>
          borderLine(i === selected ? theme.fg('accent', `▸ ${theme.bold(item.label)} — ${item.desc}`) : `  ${item.label}`, W, theme)
        ),
        borderMid(W, theme),
        borderLine(theme.fg('dim', 'Enter edit · t templates · Esc back'), W, theme),
        borderBottom(W, theme),
      ];
    },
    invalidate() {},
    handleInput(data: string) {
      if (matchesKey(data, Key.up)) { selected = Math.max(0, selected - 1); tui.requestRender(); return; }
      if (matchesKey(data, Key.down)) { selected = Math.min(items.length - 1, selected + 1); tui.requestRender(); return; }
      if (data === 't' || data === 'T') { done('templates'); return; }
      if (matchesKey(data, Key.enter)) { done(items[selected].id); return; }
      if (matchesKey(data, Key.escape) || data === 'q' || data === 'Q') done('back');
    },
  }), WORKTREE_OVERLAY);

  if (!result || result === 'back') return;
  if (result === 'templates') { await showTemplatesPanel(ctx, deps); return; }
  if (result === 'strategy') {
    const choice = await ctx.ui.select('Matching strategy', ['fail-on-tie', 'first-wins', 'last-wins']);
    if (choice) await deps.configService.save({ matchingStrategy: choice as MatchingStrategy });
    await deps.configService.reload();
    return;
  }
  const keyMap: Record<string, keyof WorktreeSettingsConfig> = {
    root: 'worktreeRoot', onCreate: 'onCreate', onSwitch: 'onSwitch', onBeforeRemove: 'onBeforeRemove', generator: 'branchNameGenerator',
  };
  const key = keyMap[result];
  const existing = key ? snap.settings[key] : undefined;
  const value = await ctx.ui.input(`Set ${key} (empty to clear)`, Array.isArray(existing) ? existing.join(' && ') : (existing ?? ''));
  if (value === undefined || !key) return;
  await saveCurrentWorktreeSetting(ctx, deps, { [key]: value.trim() || undefined } as WorktreeSettingsConfig);
  notify(ctx, value.trim() ? `✓ Set ${key}` : `✓ Cleared ${key}`, 'success');
}

// ─── Templates Panel ──────────────────────────────────

async function showTemplatesPanel(ctx: ExtensionCommandContext, deps: CommandDeps): Promise<void> {
  if (!ctx.hasUI) { await cmdTemplates('', ctx, deps); return; }
  const snap = buildSnapshot(ctx, deps);
  if (!snap.isRepo) { notify(ctx, 'Not in a git repository', 'error'); return; }

  await ctx.ui.custom<void>((_tui, theme, _kb, done) => ({
    render(W: number) {
      const sample = 'sample-feature';
      const path = join(snap.parentDir, sample);
      const rootPreview = expandTemplate(snap.worktreeRoot, { path: '', name: '', branch: '', project: snap.project, mainWorktree: snap.mainPath });
      return [
        borderTop(W, theme),
        borderLine(theme.fg('accent', theme.bold('Template Variables')), W, theme),
        borderMid(W, theme),
        borderLine(valueLine(theme, '{{path}}', shortPath(path)), W, theme),
        borderLine(valueLine(theme, '{{name}}', sample), W, theme),
        borderLine(valueLine(theme, '{{branch}}', `feature/${sample}`), W, theme),
        borderLine(valueLine(theme, '{{project}}', snap.project), W, theme),
        borderLine(valueLine(theme, '{{mainWorktree}}', shortPath(snap.mainPath)), W, theme),
        borderMid(W, theme),
        borderLine(valueLine(theme, 'Root', snap.worktreeRoot), W, theme),
        borderLine(valueLine(theme, 'Preview', shortPath(rootPreview)), W, theme),
        borderLine(valueLine(theme, 'Current', snap.branch), W, theme),
        borderMid(W, theme),
        borderLine(theme.fg('dim', 'Esc/q back'), W, theme),
        borderBottom(W, theme),
      ];
    },
    invalidate() {},
    handleInput(data: string) { if (matchesKey(data, Key.escape) || data === 'q' || data === 'Q' || matchesKey(data, Key.enter)) done(); },
  }), WORKTREE_OVERLAY);
}

// ─── Prune Panel ──────────────────────────────────────

async function showPrunePanel(ctx: ExtensionCommandContext, deps: CommandDeps): Promise<void> {
  const snap = buildSnapshot(ctx, deps);
  if (!snap.isRepo) { notify(ctx, 'Not in a git repository', 'error'); return; }
  const dry = gitMaybe(['worktree', 'prune', '--dry-run'], ctx.cwd) ?? '';
  const staleLines = dry.trim().split('\n').filter(Boolean);

  const confirmed = await ctx.ui.custom<boolean>((_tui, theme, _kb, done) => ({
    render(W: number) {
      const lines = [
        borderTop(W, theme),
        borderLine(theme.fg('accent', theme.bold('Prune Stale Worktrees')), W, theme),
        borderMid(W, theme),
        borderLine(valueLine(theme, 'Stale refs', String(staleLines.length), staleLines.length ? 'warning' : 'success'), W, theme),
        borderLine('', W, theme),
      ];
      for (const line of staleLines.slice(0, 8)) lines.push(borderLine(theme.fg('dim', line), W, theme));
      if (staleLines.length === 0) lines.push(borderLine(theme.fg('success', 'No stale worktree references to prune'), W, theme));
      lines.push(borderMid(W, theme));
      lines.push(borderLine(theme.fg('dim', staleLines.length ? 'Enter prune · Esc back' : 'Esc back'), W, theme));
      lines.push(borderBottom(W, theme));
      return lines;
    },
    invalidate() {},
    handleInput(data: string) { if (matchesKey(data, Key.enter) && dry.trim()) done(true); else if (matchesKey(data, Key.escape) || data === 'q' || data === 'Q') done(false); },
  }), WORKTREE_OVERLAY);

  if (confirmed) await cmdPrune('', ctx, deps);
}

// ─── Status Panel ─────────────────────────────────────

async function showStatusPanel(ctx: ExtensionCommandContext, deps: CommandDeps): Promise<void> {
  const snap = buildSnapshot(ctx, deps);

  await ctx.ui.custom<void>((_tui, theme, _kb, done) => ({
    render(W: number) {
      const lines: string[] = [
        borderTop(W, theme),
        borderLine(theme.fg('accent', theme.bold('Worktree Status')), W, theme),
        borderMid(W, theme),
        borderLine(valueLine(theme, 'Plugin', 'pi-worktrees source extension'), W, theme),
        borderLine(valueLine(theme, 'Upstream', 'zenobi-us/pi-worktrees'), W, theme),
        borderLine(valueLine(theme, 'Config', '~/.pi/agent/pi-worktrees.config.json', 'dim'), W, theme),
        borderLine(valueLine(theme, 'CWD', shortPath(ctx.cwd)), W, theme),
        borderLine(valueLine(theme, 'Git repo', snap.isRepo ? 'yes' : 'no', snap.isRepo ? 'success' : 'warning'), W, theme),
      ];
      if (snap.isRepo) {
        lines.push(borderLine(valueLine(theme, 'Current', snap.branch), W, theme));
        lines.push(borderLine(valueLine(theme, 'Main', shortPath(snap.mainPath)), W, theme));
        lines.push(borderLine(valueLine(theme, 'Root', shortPath(snap.parentDir)), W, theme));
        lines.push(borderLine(valueLine(theme, 'Matched', snap.matchedPattern ?? '**', 'dim'), W, theme));
      }
      lines.push(borderMid(W, theme));
      lines.push(borderLine(theme.fg('dim', 'Esc/q back'), W, theme));
      lines.push(borderBottom(W, theme));
      return lines;
    },
    invalidate() {},
    handleInput(data: string) { if (matchesKey(data, Key.escape) || data === 'q' || data === 'Q' || matchesKey(data, Key.enter)) done(); },
  }), WORKTREE_OVERLAY);
}
