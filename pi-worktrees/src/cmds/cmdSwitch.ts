import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ExtensionCommandContext } from '@mariozechner/pi-coding-agent';
import { randomUUID } from 'crypto';
import type { CommandDeps } from '../types.ts';

/**
 * Thrown after a successful session switch to unwind the call stack.
 * The old extension ctx is stale after switchSession(), so we must not
 * return normally (callers would keep using the stale ctx).
 * Instead we throw this sentinel so the top-level handler can silently exit.
 */
export class SessionSwitched {
  constructor(public readonly targetPath: string) {}
}

/**
 * Switch pi's working directory to a target worktree path by creating
 * a new session file with the target cwd and switching to it.
 *
 * IMPORTANT: On success this throws SessionSwitched instead of returning.
 * Callers should NOT catch it — let it propagate to the top-level command
 * handler which recognises it and silently exits.
 */
export async function switchToWorktree(
  targetPath: string,
  ctx: ExtensionCommandContext,
  deps: CommandDeps,
): Promise<never> {
  if (!existsSync(targetPath)) {
    ctx.ui.notify(`Target path does not exist: ${targetPath}`, 'error');
    throw new SessionSwitched(targetPath);
  }

  // Compute session directory for the target cwd (mirrors pi's getDefaultSessionDir)
  const agentDir = process.env.PI_AGENT_DIR || join(process.env.HOME || '~', '.pi', 'agent');
  const safePath = '--' + targetPath.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-') + '--';
  const sessionDir = join(agentDir, 'sessions', safePath);

  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }

  // Create a new session file with the target cwd in its header
  const sessionId = randomUUID();
  const timestamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const filename = `${timestamp}_${sessionId}.jsonl`;
  const sessionFile = join(sessionDir, filename);

  const header = JSON.stringify({
    type: 'session',
    version: 3,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: targetPath,
  });

  writeFileSync(sessionFile, header + '\n');

  deps.statusService.positive(ctx, `Switching to ${targetPath}...`);

  // ctx.switchSession tears down the old session and creates a new one.
  // After it resolves, the captured ctx/deps are stale.
  await ctx.switchSession(sessionFile, {
    withSession: async (newCtx) => {
      newCtx.ui.notify(`Switched worktree → ${targetPath}`, 'info');
    },
  });

  // We reach here only if switchSession resolved without replacing the session
  // (unlikely). Throw anyway to prevent callers from using the stale ctx.
  throw new SessionSwitched(targetPath);
}
