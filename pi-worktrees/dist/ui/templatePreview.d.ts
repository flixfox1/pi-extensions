import type { Theme } from '@mariozechner/pi-coding-agent';
export interface TemplateToken {
    token: string;
    value: string;
    source: string;
}
type TemplatePreviewTheme = Pick<Theme, 'fg' | 'bold'>;
interface TemplatePreviewInput {
    cwd: string;
    currentBranch: string;
    parentDirTemplate: string;
    parentDirPreview: string;
    sampleFeatureName: string;
    tokens: TemplateToken[];
}
export declare function createTemplatePreviewComponent(input: TemplatePreviewInput, theme: TemplatePreviewTheme, done: () => void): {
    render: (width: number) => string[];
    invalidate: () => void;
    handleInput: (data: string) => void;
};
export {};
