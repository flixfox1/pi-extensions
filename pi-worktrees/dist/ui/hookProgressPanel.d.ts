import type { ExtensionCommandContext } from '@mariozechner/pi-coding-agent';
import type { HookProgressEvent } from '../cmds/shared.ts';
export declare function withHookProgressPanel<T>(ctx: ExtensionCommandContext, initial: HookProgressEvent, run: (onProgress: (event: HookProgressEvent) => void) => Promise<T>): Promise<T>;
