interface CreateCommandArgsBase {
    worktreeName: string;
    explicitName: boolean;
}
export interface CreateCommandBranchArgs extends CreateCommandArgsBase {
    generate: false;
    branch: string;
    showLegacyWarning: boolean;
}
export interface CreateCommandGenerateArgs extends CreateCommandArgsBase {
    generate: true;
    generatorInput: string;
    showLegacyWarning: false;
}
export type CreateCommandArgs = CreateCommandBranchArgs | CreateCommandGenerateArgs;
export interface CreateCommandArgError {
    error: string;
}
export declare function slugifyBranch(branch: string): string;
export declare function parseCreateCommandArgs(args: string): CreateCommandArgs | CreateCommandArgError;
export {};
