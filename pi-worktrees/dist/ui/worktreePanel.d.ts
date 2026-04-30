import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent';
import type { CommandDeps } from '../types.ts';
export declare function showWorktreePanel(_pi: ExtensionAPI, ctx: ExtensionCommandContext, deps: CommandDeps): Promise<void>;
export declare function showCreateWizard(ctx: ExtensionCommandContext, deps: CommandDeps): Promise<void>;
