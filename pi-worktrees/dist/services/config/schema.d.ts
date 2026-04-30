import { Static } from 'typebox';
declare const WorktreeSettingsSchema: import("typebox").TObject<{
    worktreeRoot: import("typebox").TOptional<import("typebox").TString>;
    parentDir: import("typebox").TOptional<import("typebox").TString>;
    onCreate: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TArray<import("typebox").TString>]>>;
    onSwitch: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TArray<import("typebox").TString>]>>;
    onBeforeRemove: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TArray<import("typebox").TString>]>>;
    branchNameGenerator: import("typebox").TOptional<import("typebox").TString>;
}>;
declare const MatchingStrategySchema: import("typebox").TUnion<[import("typebox").TLiteral<"fail-on-tie">, import("typebox").TLiteral<"first-wins">, import("typebox").TLiteral<"last-wins">]>;
declare const MatchStrategyResultSchema: import("typebox").TUnion<[import("typebox").TLiteral<"exact">, import("typebox").TLiteral<"unmatched">]>;
export declare const PiWorktreeConfigSchema: import("typebox").TObject<{
    worktrees: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TObject<{
        worktreeRoot: import("typebox").TOptional<import("typebox").TString>;
        parentDir: import("typebox").TOptional<import("typebox").TString>;
        onCreate: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TArray<import("typebox").TString>]>>;
        onSwitch: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TArray<import("typebox").TString>]>>;
        onBeforeRemove: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TArray<import("typebox").TString>]>>;
        branchNameGenerator: import("typebox").TOptional<import("typebox").TString>;
    }>>>;
    matchingStrategy: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"fail-on-tie">, import("typebox").TLiteral<"first-wins">, import("typebox").TLiteral<"last-wins">]>>;
    logfile: import("typebox").TOptional<import("typebox").TString>;
    onCreateDisplayOutputMaxLines: import("typebox").TOptional<import("typebox").TInteger>;
    onCreateCmdDisplayPending: import("typebox").TOptional<import("typebox").TString>;
    onCreateCmdDisplaySuccess: import("typebox").TOptional<import("typebox").TString>;
    onCreateCmdDisplayError: import("typebox").TOptional<import("typebox").TString>;
    onCreateCmdDisplayPendingColor: import("typebox").TOptional<import("typebox").TString>;
    onCreateCmdDisplaySuccessColor: import("typebox").TOptional<import("typebox").TString>;
    onCreateCmdDisplayErrorColor: import("typebox").TOptional<import("typebox").TString>;
}>;
export type WorktreeSettingsConfig = Static<typeof WorktreeSettingsSchema>;
export type MatchingStrategy = Static<typeof MatchingStrategySchema>;
export type MatchingStrategyResult = Static<typeof MatchStrategyResultSchema>;
export type PiWorktreeConfig = Static<typeof PiWorktreeConfigSchema>;
export type PiWorktreeRecord = NonNullable<PiWorktreeConfig['worktrees']>;
export type PiWorktreeLogTemplate = NonNullable<PiWorktreeConfig['logfile']>;
export declare function getConfiguredWorktreeRoot(settings: WorktreeSettingsConfig): string | undefined;
export {};
