import { ExtensionCommandContext } from '@mariozechner/pi-coding-agent';
type StatusOptions = {
    busy?: keyof typeof StatusIndicator.busyStyles;
    progress?: keyof typeof StatusIndicator.progressStyles;
};
export declare class StatusIndicator {
    statusKey: string;
    busyStyle: keyof typeof StatusIndicator.busyStyles;
    private busyFrames;
    private progressStyle;
    private progressFrames;
    constructor(statusKey: string, options?: StatusOptions);
    busy(ctx: ExtensionCommandContext, message: string): () => void;
    cautious(ctx: ExtensionCommandContext, message: string): void;
    critical(ctx: ExtensionCommandContext, message: string): void;
    positive(ctx: ExtensionCommandContext, message: string): void;
    informative(ctx: ExtensionCommandContext, message: string): void;
    progress(ctx: ExtensionCommandContext, message: string, percent: number): void;
    static busyStyles: {
        dots: string[];
    };
    static progressStyles: {
        bars: (percent: number) => string;
        pie: (percent: number) => string;
    };
}
export {};
