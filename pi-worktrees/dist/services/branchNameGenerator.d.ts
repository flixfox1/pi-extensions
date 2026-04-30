export declare const BRANCH_NAME_GENERATOR_TIMEOUT_MS = 5000;
export type BranchNameGeneratorErrorCode = 'missing-config' | 'timeout' | 'non-zero-exit' | 'empty-output' | 'invalid-output' | 'spawn-error';
export interface GenerateBranchNameParams {
    commandTemplate: string | undefined;
    input: string;
    cwd: string;
    timeoutMs?: number;
}
export interface GenerateBranchNameSuccess {
    ok: true;
    branchName: string;
    command: string;
}
export interface GenerateBranchNameFailure {
    ok: false;
    code: BranchNameGeneratorErrorCode;
    message: string;
}
export type GenerateBranchNameResult = GenerateBranchNameSuccess | GenerateBranchNameFailure;
export declare function generateBranchName(params: GenerateBranchNameParams): Promise<GenerateBranchNameResult>;
