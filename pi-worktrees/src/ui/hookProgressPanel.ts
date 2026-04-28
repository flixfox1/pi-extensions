import type { ExtensionCommandContext } from '@mariozechner/pi-coding-agent';
import { Key, matchesKey } from '@mariozechner/pi-tui';
import type { HookProgressEvent } from '../cmds/shared.ts';
import { borderBottom, borderLine, borderMid, borderTop, shortPath, valueLine, WORKTREE_OVERLAY } from './panelStyle.ts';

function outputLines(event: HookProgressEvent, maxLines: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < event.outputs.length; i++) {
    const output = event.outputs[i];
    const text = `${output.stdout || ''}${output.stderr || ''}`;
    if (!text.trim()) continue;
    for (const line of text.replace(/\r/g, '').split('\n')) {
      if (line.trim()) chunks.push(line.trimEnd());
    }
  }
  return chunks.slice(-maxLines);
}

function stateMark(state: string): string {
  if (state === 'success') return '[x]';
  if (state === 'running') return '[>]';
  if (state === 'failed') return '[!]';
  return '[ ]';
}

function stateColor(state: string): string {
  if (state === 'success') return 'success';
  if (state === 'running') return 'accent';
  if (state === 'failed') return 'error';
  return 'dim';
}

export async function withHookProgressPanel<T>(
  ctx: ExtensionCommandContext,
  initial: HookProgressEvent,
  run: (onProgress: (event: HookProgressEvent) => void) => Promise<T>
): Promise<T> {
  if (!ctx.hasUI) {
    return run(() => {});
  }

  let snapshot = initial;
  let requestRender: (() => void) | undefined;
  let closePanel: (() => void) | undefined;
  let hidden = false;
  let renderTimer: ReturnType<typeof setTimeout> | undefined;

  const panelDone = new Promise<void>((resolve) => {
    ctx.ui.custom<void>((_tui, theme, _kb, done) => {
      requestRender = () => _tui.requestRender();
      closePanel = () => done();
      return {
        render(W: number) {
          const event = snapshot;
          const lines: string[] = [];
          lines.push(borderTop(W, theme));
          lines.push(borderLine(theme.fg('accent', theme.bold(`Hook: ${event.hookName}`)), W, theme));
          lines.push(borderMid(W, theme));
          lines.push(borderLine(valueLine(theme, 'Worktree', event.worktree.name), W, theme));
          lines.push(borderLine(valueLine(theme, 'Branch', event.worktree.branch), W, theme));
          lines.push(borderLine(valueLine(theme, 'Path', shortPath(event.worktree.path)), W, theme));
          if (event.logPath) lines.push(borderLine(valueLine(theme, 'Log', shortPath(event.logPath), 'dim'), W, theme));
          lines.push(borderMid(W, theme));
          for (let i = 0; i < event.commands.length; i++) {
            const state = event.states[i] ?? 'pending';
            const marker = stateMark(state);
            const command = `${marker} ${event.commands[i]}`;
            lines.push(borderLine(theme.fg(stateColor(state), command), W, theme));
          }
          lines.push(borderMid(W, theme));
          const latest = outputLines(event, 6);
          lines.push(borderLine(theme.fg('muted', 'output'), W, theme));
          if (latest.length === 0) lines.push(borderLine(theme.fg('dim', '  waiting for output...'), W, theme));
          for (const line of latest) lines.push(borderLine(theme.fg('dim', `  ${line}`), W, theme));
          if (event.failed) {
            lines.push(borderMid(W, theme));
            lines.push(borderLine(theme.fg('error', `failed exit ${event.failed.code}: ${event.failed.command}`), W, theme));
          }
          lines.push(borderMid(W, theme));
          const hint = event.done
            ? event.success
              ? 'Done · Enter/Esc close'
              : 'Failed · Enter/Esc close'
            : 'Esc hide panel; hook continues · live progress';
          lines.push(borderLine(theme.fg(event.done && event.success ? 'success' : event.done ? 'error' : 'dim', hint), W, theme));
          lines.push(borderBottom(W, theme));
          return lines;
        },
        invalidate() {},
        handleInput(data: string) {
          if (matchesKey(data, Key.escape) || data === 'q' || data === 'Q') {
            hidden = true;
            done();
            return;
          }
          if (snapshot.done && matchesKey(data, Key.enter)) done();
        },
      };
    }, WORKTREE_OVERLAY).then(() => resolve());
  });

  // Throttled render: max ~12 FPS to avoid overwhelming TUI on chatty hooks
  let renderScheduled = false;
  const scheduleRender = () => {
    if (hidden || renderScheduled) return;
    renderScheduled = true;
    setTimeout(() => {
      renderScheduled = false;
      requestRender?.();
    }, 80);
  };

  const result = await run((event) => {
    snapshot = event;
    if (event.done) {
      // Final state: render immediately
      clearTimeout(renderTimer);
      requestRender?.();
      if (event.success && !hidden) {
        setTimeout(() => closePanel?.(), 600);
      }
    } else {
      scheduleRender();
    }
  });

  if (!hidden && snapshot.done && snapshot.success) closePanel?.();
  await Promise.race([panelDone, new Promise((resolve) => setTimeout(resolve, snapshot.success ? 50 : 500))]);
  return result;
}
