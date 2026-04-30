import { MatchingStrategy, WorktreeSettingsConfig } from './config/schema.ts';
import { PiWorktreeConfiguredWorktreeMap } from './config/config.ts';
export interface WorktreeInfo {
    path: string;
    branch: string;
    head: string;
    isMain: boolean;
    isCurrent: boolean;
}
/**
 * Execute a git command and return stdout.
 */
export declare function git(args: string[], cwd?: string): string;
/**
 * Get git remote URL for repository.
 */
export declare function getRemoteUrl(cwd: string, remote?: string): string | null;
/**
 * Check if we're in a git repository.
 */
export declare function isGitRepo(cwd: string): boolean;
/**
 * Get the main worktree path (handles both regular repos and worktrees).
 */
export declare function getMainWorktreePath(cwd: string): string;
/**
 * Get the project name from the main worktree path.
 */
export declare function getProjectName(cwd: string): string;
/**
 * Check if current directory is a worktree (not the main repo).
 */
export declare function isWorktree(cwd: string): boolean;
/**
 * Get current branch name.
 */
export declare function getCurrentBranch(cwd: string): string;
/**
 * List all worktrees.
 */
export declare function listWorktrees(cwd: string): WorktreeInfo[];
/**
 * Check if a target path is inside the repository root.
 */
export declare function isPathInsideRepo(repoPath: string, targetPath: string): boolean;
/**
 * Resolve the parent directory used for worktrees.
 *
 * Attempts to match to a configured repo, or defaults to using current git repos main worktree
 */
export declare function getWorktreeParentDir(cwd: string, repos: PiWorktreeConfiguredWorktreeMap, matchStrategy?: MatchingStrategy): string;
/**
 * Ensure worktree dir is excluded from git tracking when it lives inside repo.
 */
export declare function ensureExcluded(cwd: string, worktreeParentDir: string): void;
export interface MatchResult {
    settings: WorktreeSettingsConfig;
    matchedPattern: string | null;
}
export interface TieConflictError {
    patterns: string[];
    url: string;
    message: string;
}
export interface ScoredMatch {
    pattern: string;
    normalizedPattern: string;
    specificity: number;
}
export type Result = ({
    type: 'exact';
} & MatchResult) | ({
    type: 'tie-conflict';
} & TieConflictError) | ({
    type: 'first-wins';
} & MatchResult) | ({
    type: 'last-wins';
} & MatchResult);
export declare function matchRepo(url: string | null, repos: PiWorktreeConfiguredWorktreeMap, matchStrategy?: MatchingStrategy): Result;
