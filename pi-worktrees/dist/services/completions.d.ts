import type { RegisteredCommand } from '@mariozechner/pi-coding-agent';
type CommandMap = Record<string, unknown>;
export declare function createCompletionFactory(commands: CommandMap): NonNullable<RegisteredCommand['getArgumentCompletions']>;
export {};
