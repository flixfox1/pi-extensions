export declare const WORKTREE_OVERLAY: {
    readonly overlay: true;
    readonly overlayOptions: {
        readonly width: "58%";
        readonly minWidth: 58;
        readonly maxHeight: "72%";
        readonly anchor: "center";
    };
};
export declare function borderTop(w: number, theme: any): string;
export declare function borderBottom(w: number, theme: any): string;
export declare function borderMid(w: number, theme: any): string;
export declare function borderLine(text: string, w: number, theme: any): string;
export declare function visibleLen(text: string): number;
export declare function ellipsis(text: string, maxVisible: number): string;
export declare function valueLine(theme: any, label: string, value: string, color?: string): string;
export declare function boolMark(theme: any, value: unknown): string;
export declare function shortPath(path: string, max?: number): string;
