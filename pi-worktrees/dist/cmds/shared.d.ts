import type { WorktreeCreatedContext } from '../types.ts';
import { WorktreeSettingsConfig } from '../services/config/schema.ts';
export interface CommandOutput {
    stdout: string;
    stderr: string;
}
export interface OnCreateResult {
    success: boolean;
    executed: string[];
    failed?: {
        command: string;
        code: number;
        error: string;
    };
}
export type CommandState = 'pending' | 'running' | 'success' | 'failed';
export interface HookProgressEvent {
    hookName: 'onCreate' | 'onSwitch' | 'onBeforeRemove';
    worktree: WorktreeCreatedContext;
    commands: string[];
    states: CommandState[];
    outputs: CommandOutput[];
    currentIndex: number | null;
    logPath?: string;
    done: boolean;
    success?: boolean;
    failed?: {
        command: string;
        code: number;
        error: string;
    };
}
export interface OnCreateHookOptions {
    logPath?: string;
    displayOutputMaxLines?: number;
    cmdDisplayPending?: string;
    cmdDisplaySuccess?: string;
    cmdDisplayError?: string;
    cmdDisplayPendingColor?: string;
    cmdDisplaySuccessColor?: string;
    cmdDisplayErrorColor?: string;
    onProgress?: (event: HookProgressEvent) => void;
}
export declare function sanitizePathPart(value: string): string;
export declare function resolveLogfilePath(template: string, values: Record<'sessionId' | 'name' | 'timestamp', string>): string;
/**
 * Runs hook commands sequentially.
 * Stops at first failure and reports the failing command.
 */
export declare function runHook(createdCtx: WorktreeCreatedContext, hookValue: WorktreeSettingsConfig['onCreate'] | undefined, hookName: 'onCreate' | 'onSwitch' | 'onBeforeRemove', notify: (msg: string, type: 'info' | 'error' | 'warning') => void, options?: OnCreateHookOptions): Promise<OnCreateResult>;
export declare function runOnCreateHook(createdCtx: WorktreeCreatedContext, settings: WorktreeSettingsConfig, notify: (msg: string, type: 'info' | 'error' | 'warning') => void, options?: OnCreateHookOptions): Promise<OnCreateResult>;
