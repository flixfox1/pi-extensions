import { PiWorktreeConfig, WorktreeSettingsConfig } from './schema.ts';
export declare function createPiWorktreeConfigService(): Promise<{
    worktrees: Map<string, {
        parentDir?: string | undefined;
        onCreate?: string | string[] | undefined;
        worktreeRoot?: string | undefined;
        onSwitch?: string | string[] | undefined;
        onBeforeRemove?: string | string[] | undefined;
        branchNameGenerator?: string | undefined;
    }>;
    current: (ctx: {
        cwd: string;
    }) => {
        repo: string | null;
        project: string;
        mainWorktree: string;
        parentDir: string;
        logfile: string;
        onCreateDisplayOutputMaxLines: number;
        onCreateCmdDisplayPending: string;
        onCreateCmdDisplaySuccess: string;
        onCreateCmdDisplayError: string;
        onCreateCmdDisplayPendingColor: string;
        onCreateCmdDisplaySuccessColor: string;
        onCreateCmdDisplayErrorColor: string;
        matchedPattern: string | null;
        onCreate?: string | string[] | undefined;
        worktreeRoot?: string | undefined;
        onSwitch?: string | string[] | undefined;
        onBeforeRemove?: string | string[] | undefined;
        branchNameGenerator?: string | undefined;
    };
    save: (data: PiWorktreeConfig) => Promise<void>;
    config: {
        worktrees?: Record<string, {
            parentDir?: string | undefined;
            onCreate?: string | string[] | undefined;
            worktreeRoot?: string | undefined;
            onSwitch?: string | string[] | undefined;
            onBeforeRemove?: string | string[] | undefined;
            branchNameGenerator?: string | undefined;
        }> | undefined;
        logfile?: string | undefined;
        onCreateDisplayOutputMaxLines?: number | undefined;
        onCreateCmdDisplayPending?: string | undefined;
        onCreateCmdDisplaySuccess?: string | undefined;
        onCreateCmdDisplayError?: string | undefined;
        onCreateCmdDisplayPendingColor?: string | undefined;
        onCreateCmdDisplaySuccessColor?: string | undefined;
        onCreateCmdDisplayErrorColor?: string | undefined;
        matchingStrategy?: "fail-on-tie" | "first-wins" | "last-wins" | undefined;
    };
    ready: Promise<void>;
    set(key: string, value: unknown, target?: "home" | "project"): Promise<void>;
    reload(): Promise<void>;
    events: import("@zenobius/pi-extension-config").ConfigEventEmitter<{
        worktrees?: Record<string, {
            parentDir?: string | undefined;
            onCreate?: string | string[] | undefined;
            worktreeRoot?: string | undefined;
            onSwitch?: string | string[] | undefined;
            onBeforeRemove?: string | string[] | undefined;
            branchNameGenerator?: string | undefined;
        }> | undefined;
        logfile?: string | undefined;
        onCreateDisplayOutputMaxLines?: number | undefined;
        onCreateCmdDisplayPending?: string | undefined;
        onCreateCmdDisplaySuccess?: string | undefined;
        onCreateCmdDisplayError?: string | undefined;
        onCreateCmdDisplayPendingColor?: string | undefined;
        onCreateCmdDisplaySuccessColor?: string | undefined;
        onCreateCmdDisplayErrorColor?: string | undefined;
        matchingStrategy?: "fail-on-tie" | "first-wins" | "last-wins" | undefined;
    }>;
}>;
export declare const DefaultWorktreeSettings: WorktreeSettingsConfig;
export declare const DefaultLogfileTemplate = "/tmp/pi-worktree-{sessionId}-{name}.log";
export declare const DefaultOnCreateDisplayOutputMaxLines = 5;
export declare const DefaultOnCreateCmdDisplayPending = "[ ] {{cmd}}";
export declare const DefaultOnCreateCmdDisplaySuccess = "[x] {{cmd}}";
export declare const DefaultOnCreateCmdDisplayError = "[ ] {{cmd}} [ERROR]";
export declare const DefaultOnCreateCmdDisplayPendingColor = "dim";
export declare const DefaultOnCreateCmdDisplaySuccessColor = "success";
export declare const DefaultOnCreateCmdDisplayErrorColor = "error";
export type PiWorktreeConfigService = Awaited<ReturnType<typeof createPiWorktreeConfigService>>;
export type PiWorktreeConfiguredWorktreeMap = PiWorktreeConfigService['worktrees'];
