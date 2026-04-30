export interface TemplateContext {
    path: string;
    name: string;
    branch: string;
    project: string;
    mainWorktree: string;
}
export declare function expandTemplate(template: string, ctx: TemplateContext): string;
