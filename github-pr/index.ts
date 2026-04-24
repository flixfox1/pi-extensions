import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { getSettingsListTheme } from '@mariozechner/pi-coding-agent';
import { Container, SettingsList, truncateToWidth, type SettingItem } from '@mariozechner/pi-tui';

type DeliveryMode = 'notify-only' | 'auto-turn';
type PrState = 'OPEN' | 'CLOSED' | 'MERGED' | 'UNKNOWN';

const REMOVED_DELIVERY_MODE = 'inject-message';
const EVENT_ACTIONS = [
    'opened',
    'reopened',
    'ready_for_review',
    'converted_to_draft',
    'retargeted',
    'synchronize',
    'retitled',
    'updated',
    'closed',
    'merged',
    'discovered',
    'state_changed',
] as const;

type EventAction = typeof EVENT_ACTIONS[number];
type EventActionFilter = EventAction[] | null;

type PullRequestSnapshot = {
    number: number;
    title: string;
    author: string;
    url: string;
    baseRef?: string;
    headRef?: string;
    draft: boolean;
    state: PrState;
    updatedAt?: string;
};

type PullRequestEvent = PullRequestSnapshot & {
    id: string;
    repo: string;
    action: string;
    detectedAt: string;
    previousState?: PrState;
    previousUpdatedAt?: string;
};

type PersistedState = {
    active: boolean;
    mode: DeliveryMode;
    repo?: string;
    eventActions?: EventAction[] | null;
    messageFields?: MessageField[] | null;
    instruction?: string;
};

type RestoredState = PersistedState & {
    removedLegacyMode?: boolean;
    messageFields?: MessageFieldFilter;
    instruction?: string;
};

type RawGhPullRequest = {
    number?: number;
    title?: string;
    url?: string;
    updatedAt?: string;
    isDraft?: boolean;
    state?: string;
    baseRefName?: string;
    headRefName?: string;
    author?: {
        login?: string;
    } | null;
};

const DELIVERY_MODES: DeliveryMode[] = ['notify-only', 'auto-turn'];
const COMMANDS = [
    'start', 'stop', 'status', 'test',
    'events', 'events all', 'events none',
    'fields', 'fields all', 'fields none',
    'instruction', 'instruction clear',
    'mode notify-only', 'mode auto-turn',
];
const STATUS_KEY = 'github-pr-cli';
const STATE_ENTRY = 'github-pr-cli-state';
const GH_PR_JSON_FIELDS = 'number,title,url,updatedAt,isDraft,author,baseRefName,headRefName,state';
const MESSAGE_FIELDS = [
    'repo',
    'event',
    'pr',
    'title',
    'author',
    'state',
    'draft',
    'baseHead',
    'updated',
    'url',
] as const;

type MessageField = typeof MESSAGE_FIELDS[number];
type MessageFieldFilter = MessageField[] | null;

const MESSAGE_FIELD_DESCRIPTIONS: Record<MessageField, string> = {
    repo: 'repo — Repository name',
    event: 'event — Detected action type',
    pr: 'pr — Pull request number',
    title: 'title — PR title',
    author: 'author — PR author login',
    state: 'state — OPEN / CLOSED / MERGED',
    draft: 'draft — Draft status',
    baseHead: 'baseHead — Base ← Head branches',
    updated: 'updated — Last updated timestamp',
    url: 'url — GitHub PR URL',
};

const EVENT_ACTION_DESCRIPTIONS: Record<EventAction, string> = {
    opened: 'opened — new open PRs',
    reopened: 'reopened — closed PRs reopened',
    ready_for_review: 'ready_for_review — draft -> ready',
    converted_to_draft: 'converted_to_draft — ready -> draft',
    retargeted: 'retargeted — base branch changed',
    synchronize: 'synchronize — head branch changed',
    retitled: 'retitled — title changed',
    updated: 'updated — timestamp-only updates',
    closed: 'closed — closed without merge',
    merged: 'merged — merged PRs',
    discovered: 'discovered — inferred non-open first sighting',
    state_changed: 'state_changed — fallback state transition',
};

loadEnvFiles([
    getEnv('PI_GH_PR_ENV_FILE', 'MATELINK_GH_PR_ENV_FILE'),
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(process.cwd(), '.env'),
    path.join(homedir(), '.pi', 'agent', 'extensions', 'github-pr', '.env.local'),
    path.join(homedir(), '.pi', 'agent', 'extensions', 'github-pr', '.env'),
]);

function loadEnvFiles(files: Array<string | undefined>): void {
    for (const file of files) {
        if (!file || !existsSync(file)) continue;
        const content = readFileSync(file, 'utf8');
        for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
            if (!match) continue;
            const [, key, rawValue] = match;
            if (process.env[key] !== undefined) continue;
            process.env[key] = parseEnvValue(rawValue);
        }
    }
}

function parseEnvValue(rawValue: string): string {
    const value = rawValue.trim();
    if (!value) return '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        const unwrapped = value.slice(1, -1);
        return value.startsWith('"')
            ? unwrapped.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
            : unwrapped;
    }
    const commentIndex = value.indexOf(' #');
    return commentIndex >= 0 ? value.slice(0, commentIndex).trim() : value;
}

function getEnv(primaryKey: string, legacyKey?: string): string | undefined {
    return process.env[primaryKey] ?? (legacyKey ? process.env[legacyKey] : undefined);
}

function parsePositiveInt(rawValue: string | undefined, fallback: number): number {
    if (!rawValue) return fallback;
    const parsed = Number.parseInt(rawValue, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveMode(rawValue: string | undefined, fallback: DeliveryMode): { mode: DeliveryMode; removedLegacyMode: boolean } {
    const normalized = String(rawValue ?? '').trim();
    if (normalized === 'notify-only' || normalized === 'auto-turn') {
        return { mode: normalized, removedLegacyMode: false };
    }
    if (normalized === REMOVED_DELIVERY_MODE) {
        return { mode: 'notify-only', removedLegacyMode: true };
    }
    return { mode: fallback, removedLegacyMode: false };
}

function summarizeError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return typeof error === 'string' ? error : 'Unknown error';
}

function normalizePrState(rawValue: string | undefined): PrState {
    const normalized = String(rawValue ?? '').trim().toUpperCase();
    if (normalized === 'OPEN' || normalized === 'CLOSED' || normalized === 'MERGED') return normalized;
    return 'UNKNOWN';
}

function formatTimestamp(rawValue?: string): string {
    if (!rawValue) return 'n/a';
    const date = new Date(rawValue);
    return Number.isNaN(date.getTime()) ? rawValue : date.toLocaleString();
}

function formatPrEvent(event: PullRequestEvent, fieldFilter: MessageFieldFilter): string {
    const baseHead = event.baseRef && event.headRef ? `${event.baseRef} ← ${event.headRef}` : 'n/a';

    const fieldMap: Record<MessageField, string> = {
        repo: `Repo: ${event.repo}`,
        event: `Event: ${event.action}`,
        pr: `PR: #${event.number}`,
        title: `Title: ${event.title}`,
        author: `Author: @${event.author}`,
        state: `State: ${event.state.toLowerCase()}`,
        draft: `Draft: ${event.draft ? 'yes' : 'no'}`,
        baseHead: `Base/Head: ${baseHead}`,
        updated: `Updated: ${formatTimestamp(event.updatedAt)}`,
        url: `URL: ${event.url}`,
    };

    const selectedFields: MessageField[] = fieldFilter === null
        ? [...MESSAGE_FIELDS]
        : [...fieldFilter];

    const lines: string[] = ['[GitHub PR watcher]'];
    for (const field of selectedFields) {
        lines.push(fieldMap[field]);
    }

    return lines.join('\n');
}

function isMessageField(value: string): value is MessageField {
    return MESSAGE_FIELDS.includes(value as MessageField);
}

function normalizeMessageFieldFilter(rawValues: Array<string | MessageField> | null | undefined): MessageFieldFilter {
    if (rawValues === null || rawValues === undefined) return null;

    const requested = new Set<MessageField>();
    for (const rawValue of rawValues) {
        const normalized = String(rawValue).trim();
        if (isMessageField(normalized)) {
            requested.add(normalized);
        }
    }

    const ordered = MESSAGE_FIELDS.filter((field) => requested.has(field));
    if (ordered.length === MESSAGE_FIELDS.length) return null;
    return ordered;
}

function parseMessageFieldFilter(rawValue: string | undefined): MessageFieldFilter {
    const normalized = String(rawValue ?? '').trim().toLowerCase();
    if (!normalized || normalized === 'all' || normalized === '*') return null;
    if (normalized === 'none') return [];
    return normalizeMessageFieldFilter(normalized.split(/[\s,]+/));
}

function getEnabledMessageFields(filter: MessageFieldFilter): MessageField[] {
    return filter === null ? [...MESSAGE_FIELDS] : [...filter];
}

function formatMessageFieldFilter(filter: MessageFieldFilter): string {
    if (filter === null) return 'all';
    if (filter.length === 0) return 'none';
    return filter.join(',');
}

function formatMessageFieldBadge(filter: MessageFieldFilter): string {
    if (filter === null) return 'fields=all';
    if (filter.length === 0) return 'fields=none';
    return `fields=${filter.length}/${MESSAGE_FIELDS.length}`;
}

function formatStatusLine(parts: string[]): string {
    return parts.filter(Boolean).join(' • ');
}

function snapshotKey(snapshot: PullRequestSnapshot): string {
    return `${snapshot.number}`;
}

function toSnapshotMap(items: PullRequestSnapshot[]): Map<string, PullRequestSnapshot> {
    const map = new Map<string, PullRequestSnapshot>();
    for (const item of items) {
        map.set(snapshotKey(item), item);
    }
    return map;
}

function isEventAction(value: string): value is EventAction {
    return EVENT_ACTIONS.includes(value as EventAction);
}

function normalizeEventActionFilter(rawValues: Array<string | EventAction> | null | undefined): EventActionFilter {
    if (rawValues === null || rawValues === undefined) return null;

    const requested = new Set<EventAction>();
    for (const rawValue of rawValues) {
        const normalized = String(rawValue).trim();
        if (isEventAction(normalized)) {
            requested.add(normalized);
        }
    }

    const ordered = EVENT_ACTIONS.filter((action) => requested.has(action));
    if (ordered.length === EVENT_ACTIONS.length) return null;
    return ordered;
}

function parseEventActionFilter(rawValue: string | undefined): EventActionFilter {
    const normalized = String(rawValue ?? '').trim().toLowerCase();
    if (!normalized || normalized === 'all' || normalized === '*') return null;
    if (normalized === 'none') return [];
    return normalizeEventActionFilter(normalized.split(/[\s,]+/));
}

function getEnabledEventActions(filter: EventActionFilter): EventAction[] {
    return filter === null ? [...EVENT_ACTIONS] : [...filter];
}

function isEventActionEnabled(filter: EventActionFilter, action: string): boolean {
    return filter === null ? true : isEventAction(action) && filter.includes(action);
}

function formatEventActionFilter(filter: EventActionFilter): string {
    if (filter === null) return 'all';
    if (filter.length === 0) return 'none';
    return filter.join(',');
}

function formatEventActionBadge(filter: EventActionFilter): string {
    if (filter === null) return 'events=all';
    if (filter.length === 0) return 'events=none';
    return `events=${filter.length}/${EVENT_ACTIONS.length}`;
}

function parseGhPullRequests(rawOutput: string): PullRequestSnapshot[] {
    const parsed = JSON.parse(rawOutput) as RawGhPullRequest[];
    if (!Array.isArray(parsed)) {
        throw new Error('gh pr list returned non-array JSON payload.');
    }

    return parsed
        .filter((item) => typeof item?.number === 'number')
        .map((item) => ({
            number: item.number ?? 0,
            title: item.title?.trim() || '(untitled PR)',
            author: item.author?.login?.trim() || 'unknown',
            url: item.url?.trim() || '',
            baseRef: item.baseRefName?.trim() || undefined,
            headRef: item.headRefName?.trim() || undefined,
            draft: Boolean(item.isDraft),
            state: normalizePrState(item.state),
            updatedAt: item.updatedAt?.trim() || undefined,
        }))
        .sort((a, b) => a.number - b.number);
}

function detectAction(previous: PullRequestSnapshot | undefined, current: PullRequestSnapshot): string | null {
    if (!previous) {
        if (current.state === 'OPEN') return 'opened';
        if (current.state === 'MERGED') return 'merged';
        if (current.state === 'CLOSED') return 'closed';
        return 'discovered';
    }

    if (previous.state !== current.state) {
        if (previous.state === 'CLOSED' && current.state === 'OPEN') return 'reopened';
        if (current.state === 'MERGED') return 'merged';
        if (current.state === 'CLOSED') return 'closed';
        if (current.state === 'OPEN') return 'opened';
        return 'state_changed';
    }

    if (previous.draft && !current.draft) return 'ready_for_review';
    if (!previous.draft && current.draft) return 'converted_to_draft';
    if (previous.baseRef !== current.baseRef) return 'retargeted';
    if (previous.headRef !== current.headRef) return 'synchronize';
    if (previous.title !== current.title) return 'retitled';
    if (previous.updatedAt !== current.updatedAt) return 'updated';

    return null;
}

function diffSnapshots(repo: string, previous: Map<string, PullRequestSnapshot>, current: Map<string, PullRequestSnapshot>): PullRequestEvent[] {
    const events: PullRequestEvent[] = [];

    for (const [key, currentSnapshot] of current.entries()) {
        const previousSnapshot = previous.get(key);
        const action = detectAction(previousSnapshot, currentSnapshot);
        if (!action) continue;

        events.push({
            ...currentSnapshot,
            id: `gh-cli:${repo}:${currentSnapshot.number}:${action}:${currentSnapshot.updatedAt ?? Date.now()}`,
            repo,
            action,
            detectedAt: new Date().toISOString(),
            previousState: previousSnapshot?.state,
            previousUpdatedAt: previousSnapshot?.updatedAt,
        });
    }

    return events.sort((a, b) => a.number - b.number);
}

function readPersistedState(ctx: ExtensionContext): RestoredState | null {
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i] as any;
        if (entry?.type === 'custom' && entry?.customType === STATE_ENTRY) {
            const data = entry.data as Record<string, unknown> | undefined;
            if (!data) return null;

            const resolvedMode = resolveMode(data.mode as string | undefined, 'notify-only');
            // Read eventActions, fall back to legacy summaryActions key from older sessions
            const rawEventActions = Object.prototype.hasOwnProperty.call(data, 'eventActions')
                ? data.eventActions as Array<string> | null
                : Object.prototype.hasOwnProperty.call(data, 'summaryActions')
                    ? data.summaryActions as Array<string> | null
                    : undefined;
            return {
                active: Boolean(data.active),
                mode: resolvedMode.mode,
                repo: typeof data.repo === 'string' ? data.repo.trim() || undefined : undefined,
                eventActions: rawEventActions !== undefined
                    ? normalizeEventActionFilter(rawEventActions)
                    : undefined,
                messageFields: Object.prototype.hasOwnProperty.call(data, 'messageFields')
                    ? normalizeMessageFieldFilter(data.messageFields)
                    : undefined,
                instruction: typeof data.instruction === 'string' ? data.instruction : undefined,
                removedLegacyMode: resolvedMode.removedLegacyMode,
            };
        }
    }
    return null;
}

export default function githubPrCliExtension(pi: ExtensionAPI) {
    const ghBin = getEnv('PI_GH_PR_GH_BIN') ?? 'gh';
    const configuredRepo = getEnv('PI_GH_PR_REPO', 'MATELINK_GH_RELAY_REPO') ?? '';
    const configuredMode = resolveMode(getEnv('PI_GH_PR_MODE', 'MATELINK_GH_PR_MODE'), 'notify-only');
    const configuredEventActions = parseEventActionFilter(getEnv('PI_GH_PR_EVENT_ACTIONS', 'PI_GH_PR_SUMMARY_ACTIONS'));
    const configuredMessageFields = parseMessageFieldFilter(getEnv('PI_GH_PR_MESSAGE_FIELDS'));
    const configuredInstruction = getEnv('PI_GH_PR_INSTRUCTION')?.trim() || '';
    const pollIntervalMs = parsePositiveInt(getEnv('PI_GH_PR_POLL_INTERVAL_MS', 'MATELINK_GH_PR_POLL_INTERVAL_MS'), 10000);
    const fetchLimit = parsePositiveInt(getEnv('PI_GH_PR_FETCH_LIMIT'), 100);
    const commandTimeoutMs = parsePositiveInt(getEnv('PI_GH_PR_COMMAND_TIMEOUT_MS'), 20000);

    let ctxRef: ExtensionContext | undefined;
    let active = false;
    let mode: DeliveryMode = configuredMode.mode;
    let eventActions: EventActionFilter = configuredEventActions;
    let messageFields: MessageFieldFilter = configuredMessageFields;
    let instruction: string = configuredInstruction;
    let repo = configuredRepo;
    let lastEventSummary = 'none';
    let lastError = '';
    let lastPollAt = '';
    let trackedPullRequests = 0;
    let pollingTimer: ReturnType<typeof setInterval> | undefined;
    let pollInFlight = false;
    let snapshotLoaded = false;
    let snapshots = new Map<string, PullRequestSnapshot>();

    function persistState() {
        pi.appendEntry<PersistedState>(STATE_ENTRY, {
            active,
            mode,
            repo: repo || undefined,
            eventActions,
            messageFields,
            instruction: instruction || undefined,
        });
    }

    function colorize(color: 'success' | 'warning' | 'error' | 'dim' | 'accent', text: string): string {
        const theme = ctxRef?.ui?.theme;
        if (!theme?.fg) return text;
        return theme.fg(color, text);
    }

    function notify(message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
        if (ctxRef?.hasUI) {
            ctxRef.ui.notify(message, level);
            return;
        }
        const prefix = level === 'error' ? '[github-pr:error]' : level === 'warning' ? '[github-pr:warn]' : '[github-pr]';
        console.log(`${prefix} ${message}`);
    }

    function updateStatus(): void {
        if (!ctxRef?.hasUI) return;

        const headline = active
            ? colorize('success', 'GH PR on')
            : lastError
                ? colorize('warning', 'GH PR off')
                : colorize('dim', 'GH PR off');

        const details = ['source=gh-cli', repo || 'repo=unset', `mode=${mode}`, formatEventActionBadge(eventActions), formatMessageFieldBadge(messageFields)];
        if (instruction) details.push('instruction=set');
        if (trackedPullRequests > 0) details.push(`tracked=${trackedPullRequests}`);
        if (lastPollAt) details.push(`polled=${lastPollAt}`);
        if (lastEventSummary !== 'none') details.push(lastEventSummary);
        if (lastError) details.push(`err=${lastError}`);

        ctxRef.ui.setStatus(STATUS_KEY, `${headline} ${colorize('dim', formatStatusLine(details))}`);
    }

    function stopTimer(): void {
        if (pollingTimer) clearInterval(pollingTimer);
        pollingTimer = undefined;
    }

    function clearRuntimeState(): void {
        stopTimer();
        pollInFlight = false;
        snapshotLoaded = false;
        snapshots = new Map<string, PullRequestSnapshot>();
        trackedPullRequests = 0;
    }

    function setInactive(clearError = false): void {
        active = false;
        clearRuntimeState();
        if (clearError) lastError = '';
        updateStatus();
    }

    async function loadCurrentSnapshots(): Promise<Map<string, PullRequestSnapshot>> {
        const result = await pi.exec(
            ghBin,
            ['pr', 'list', '--repo', repo, '--state', 'all', '--limit', String(fetchLimit), '--json', GH_PR_JSON_FIELDS],
            { timeout: commandTimeoutMs },
        );

        if (result.code !== 0) {
            const stderr = String(result.stderr ?? '').trim();
            const stdout = String(result.stdout ?? '').trim();
            throw new Error(stderr || stdout || `gh exited with code ${result.code}`);
        }

        return toSnapshotMap(parseGhPullRequests(String(result.stdout ?? '[]')));
    }

    function buildBatchMessageContent(events: PullRequestEvent[]): string {
        const parts: string[] = [];

        if (events.length === 1) {
            parts.push(`[GitHub PR watcher] ${events.length} event detected`);
        } else {
            parts.push(`[GitHub PR watcher] ${events.length} events detected`);
        }

        for (let i = 0; i < events.length; i++) {
            const event = events[i];
            if (events.length > 1) parts.push('');
            if (events.length > 1) parts.push(`── Event ${i + 1}/${events.length} ──`);
            parts.push(formatPrEvent(event, messageFields));
        }

        // Single instruction at the end, protected by generation counter
        const currentInstruction = instruction;
        if (currentInstruction && instructionGeneration === activeInstructionGeneration) {
            parts.push('');
            parts.push('---');
            parts.push(currentInstruction);
        }

        return parts.join('\n');
    }

    let instructionGeneration = 0;
    let activeInstructionGeneration = 0;

    function touchInstructionGeneration(): void {
        instructionGeneration++;
        activeInstructionGeneration = instructionGeneration;
    }

    function queueGitHubMessage(content: string, events: PullRequestEvent[]): void {
        if (!ctxRef || mode !== 'auto-turn') return;

        const message = {
            customType: 'github-pr',
            content,
            display: true,
            details: events.length === 1 ? events[0] : events,
        };

        pi.sendMessage(message, ctxRef.isIdle() ? { triggerTurn: true } : { deliverAs: 'followUp', triggerTurn: true });
    }

    function shouldDisplayEvent(event: PullRequestEvent): boolean {
        return isEventActionEnabled(eventActions, event.action);
    }

    function handleSingleEvent(event: PullRequestEvent): void {
        handleBatchEvents([event]);
    }

    function handleBatchEvents(events: PullRequestEvent[]): void {
        const enabled = events.filter(shouldDisplayEvent);
        if (enabled.length === 0) return;

        // Update status with summary
        if (enabled.length === 1) {
            lastEventSummary = `#${enabled[0].number} ${enabled[0].action}`;
        } else {
            const prNums = enabled.map((e) => `#${e.number}`).join(', ');
            lastEventSummary = `${enabled.length} events: ${prNums}`;
        }
        lastError = '';
        updateStatus();

        // Notify each event individually for the toast
        for (const event of enabled) {
            notify(`PR #${event.number} ${event.action}: ${event.title}`);
        }

        // Send one merged message for all events
        queueGitHubMessage(buildBatchMessageContent(enabled), enabled);
    }

    async function pollOnce(options?: { initial?: boolean; silentErrors?: boolean }): Promise<void> {
        if (!active || pollInFlight) return;

        pollInFlight = true;
        try {
            const currentSnapshots = await loadCurrentSnapshots();
            trackedPullRequests = currentSnapshots.size;
            lastPollAt = new Date().toLocaleTimeString();

            if (!snapshotLoaded || options?.initial) {
                snapshots = currentSnapshots;
                snapshotLoaded = true;
                lastError = '';
                updateStatus();
                return;
            }

            const events = diffSnapshots(repo, snapshots, currentSnapshots);
            snapshots = currentSnapshots;
            lastError = '';
            updateStatus();

            if (events.length > 0) {
                handleBatchEvents(events);
            }
        } catch (error) {
            lastError = summarizeError(error);
            updateStatus();
            if (!options?.silentErrors) {
                notify(`GitHub PR poll failed: ${lastError}`, 'warning');
            }
        } finally {
            pollInFlight = false;
        }
    }

    async function startListening(options?: { silent?: boolean }): Promise<void> {
        if (active) {
            if (!options?.silent) notify('GitHub PR watcher is already running.', 'info');
            return;
        }

        if (!repo) {
            const message = 'Missing PI_GH_PR_REPO. Set it in env, .env.local, or ~/.pi/agent/extensions/github-pr/.env.';
            lastError = message;
            updateStatus();
            if (!options?.silent) notify(message, 'error');
            return;
        }

        clearRuntimeState();
        active = true;
        updateStatus();

        await pollOnce({ initial: true, silentErrors: options?.silent });
        if (!snapshotLoaded) {
            active = false;
            updateStatus();
            return;
        }

        pollingTimer = setInterval(() => {
            void pollOnce();
        }, pollIntervalMs);

        persistState();
        if (!options?.silent) {
            notify(`GitHub PR watcher armed for ${repo} via ${ghBin}.`);
        }
    }

    async function stopListening(options?: { silent?: boolean; persist?: boolean }): Promise<void> {
        const wasActive = active;
        setInactive(true);
        if (options?.persist !== false) persistState();
        if (wasActive && !options?.silent) {
            notify('GitHub PR watcher stopped.');
        }
    }

    async function showStatus(ctx: ExtensionContext): Promise<void> {
        const statusItems: Array<{ label: string; value: string; color?: 'success' | 'warning' | 'error' | 'dim' | 'accent' | 'text' }> = [
            { label: 'source', value: 'gh-cli' },
            { label: 'repo', value: repo || 'unset' },
            { label: 'ghBin', value: ghBin },
            { label: 'active', value: String(active), color: active ? 'success' : 'dim' },
            { label: 'mode', value: mode },
            { label: 'eventActions', value: formatEventActionFilter(eventActions) },
            { label: 'messageFields', value: formatMessageFieldFilter(messageFields) },
            { label: 'instruction', value: instruction ? instruction.slice(0, 60) + (instruction.length > 60 ? '...' : '') : 'none' },
            { label: 'pollIntervalMs', value: String(pollIntervalMs) },
            { label: 'fetchLimit', value: String(fetchLimit) },
            { label: 'commandTimeoutMs', value: String(commandTimeoutMs) },
            { label: 'trackedPullRequests', value: String(trackedPullRequests) },
            { label: 'lastPollAt', value: lastPollAt || 'never' },
            { label: 'lastEvent', value: lastEventSummary },
            { label: 'lastError', value: lastError || 'none', color: lastError ? 'error' : undefined },
        ];

        if (!ctx.hasUI) {
            console.log(statusItems.map(({ label, value }) => `${label}=${value}`).join('\n'));
            return;
        }

        await ctx.ui.custom<void>((tui, theme, kb, done) => {
            return {
                render(width: number) {
                    const maxLabelLen = Math.max(...statusItems.map((item) => item.label.length));
                    const lines: string[] = [];

                    lines.push(truncateToWidth(theme.fg('accent', theme.bold('GitHub PR watcher status')), width));
                    lines.push(truncateToWidth(theme.fg('border', '─'.repeat(width)), width));

                    for (const item of statusItems) {
                        const paddedLabel = theme.fg('muted', item.label.padEnd(maxLabelLen + 1));
                        const colorFn = item.color ? (text: string) => theme.fg(item.color!, text) : (text: string) => text;
                        const line = `  ${paddedLabel} ${colorFn(item.value)}`;
                        lines.push(truncateToWidth(line, width));
                    }

                    lines.push('');
                    lines.push(truncateToWidth(theme.fg('text', theme.bold('Press Esc or Enter to close')), width));

                    return lines;
                },
                invalidate() {},
                handleInput(data: string) {
                    if (kb.matches(data, 'tui.select.cancel') || kb.matches(data, 'tui.select.confirm')) {
                        done(undefined);
                    }
                },
            };
        });
    }

    async function configureEventActions(ctx: ExtensionContext): Promise<void> {
        if (!ctx.hasUI) {
            notify(`Current PR event types: ${formatEventActionFilter(eventActions)}`, 'info');
            notify(`Use /gh-pr events all | none | opened,merged,... Supported: ${EVENT_ACTIONS.join(', ')}`, 'info');
            return;
        }

        const enabledActionSet = new Set(getEnabledEventActions(eventActions));

        await ctx.ui.custom<void>((tui, theme, _kb, done) => {
            const items: SettingItem[] = EVENT_ACTIONS.map((action) => ({
                id: action,
                label: EVENT_ACTION_DESCRIPTIONS[action],
                currentValue: enabledActionSet.has(action) ? 'enabled' : 'disabled',
                values: ['enabled', 'disabled'],
            }));

            const container = new Container();
            container.addChild(
                new (class {
                    render(width: number) {
                        return [
                            truncateToWidth(theme.fg('accent', theme.bold('GitHub PR Event Filter')), width),
                            '',
                            truncateToWidth(theme.fg('muted', 'Choose which PR event types trigger notifications.'), width),
                            truncateToWidth(theme.fg('muted', 'Changes apply immediately.'), width),
                            '',
                        ];
                    }
                    invalidate() {}
                })(),
            );

            const settingsList = new SettingsList(
                items,
                Math.min(items.length + 2, 16),
                getSettingsListTheme(),
                (id, newValue) => {
                    const action = id as EventAction;
                    if (newValue === 'enabled') {
                        enabledActionSet.add(action);
                    } else {
                        enabledActionSet.delete(action);
                    }
                    eventActions = normalizeEventActionFilter(Array.from(enabledActionSet));
                    persistState();
                    updateStatus();
                },
                () => {
                    done(undefined);
                },
            );

            container.addChild(settingsList);

            return {
                render(width: number) {
                    return container.render(width);
                },
                invalidate() {
                    container.invalidate();
                },
                handleInput(data: string) {
                    settingsList.handleInput?.(data);
                    tui.requestRender();
                },
            };
        });
    }

    function applyEventActionCommand(rawValue: string): { ok: boolean; message: string } {
        const normalized = rawValue.trim().toLowerCase();
        if (!normalized) {
            return { ok: false, message: 'Missing event action filter. Use all, none, or a comma-separated action list.' };
        }
        if (normalized === 'all' || normalized === 'reset') {
            eventActions = null;
            persistState();
            updateStatus();
            return { ok: true, message: 'GitHub PR event filter reset to all actions.' };
        }
        if (normalized === 'none') {
            eventActions = [];
            persistState();
            updateStatus();
            return { ok: true, message: 'GitHub PR event filter set to none.' };
        }

        const tokens = normalized.split(/[\s,]+/).filter(Boolean);
        const invalidTokens = tokens.filter((token) => !isEventAction(token));
        if (invalidTokens.length > 0) {
            return {
                ok: false,
                message: `Unknown event actions: ${invalidTokens.join(', ')}. Supported: ${EVENT_ACTIONS.join(', ')}`,
            };
        }

        eventActions = normalizeEventActionFilter(tokens);
        persistState();
        updateStatus();
        return { ok: true, message: `GitHub PR event filter set to ${formatEventActionFilter(eventActions)}.` };
    }

    async function configureMessageFields(ctx: ExtensionContext): Promise<void> {
        if (!ctx.hasUI) {
            notify(`Current PR message fields: ${formatMessageFieldFilter(messageFields)}`, 'info');
            notify(`Use /gh-pr fields all | none | repo,event,pr,title,... Supported: ${MESSAGE_FIELDS.join(', ')}`, 'info');
            return;
        }

        const enabledFieldSet = new Set(getEnabledMessageFields(messageFields));

        await ctx.ui.custom<void>((tui, theme, _kb, done) => {
            const items: SettingItem[] = MESSAGE_FIELDS.map((field) => ({
                id: field,
                label: MESSAGE_FIELD_DESCRIPTIONS[field],
                currentValue: enabledFieldSet.has(field) ? 'enabled' : 'disabled',
                values: ['enabled', 'disabled'],
            }));

            const container = new Container();
            container.addChild(
                new (class {
                    render(width: number) {
                        return [
                            truncateToWidth(theme.fg('accent', theme.bold('GitHub PR Message Fields')), width),
                            '',
                            truncateToWidth(theme.fg('muted', 'Choose which PR fields appear in the event message.'), width),
                            truncateToWidth(theme.fg('muted', 'Changes apply immediately.'), width),
                            '',
                        ];
                    }
                    invalidate() {}
                })(),
            );

            const settingsList = new SettingsList(
                items,
                Math.min(items.length + 2, 16),
                getSettingsListTheme(),
                (id, newValue) => {
                    const field = id as MessageField;
                    if (newValue === 'enabled') {
                        enabledFieldSet.add(field);
                    } else {
                        enabledFieldSet.delete(field);
                    }
                    messageFields = normalizeMessageFieldFilter(Array.from(enabledFieldSet));
                    persistState();
                    updateStatus();
                },
                () => {
                    done(undefined);
                },
            );

            container.addChild(settingsList);

            return {
                render(width: number) {
                    return container.render(width);
                },
                invalidate() {
                    container.invalidate();
                },
                handleInput(data: string) {
                    settingsList.handleInput?.(data);
                    tui.requestRender();
                },
            };
        });
    }

    function applyMessageFieldCommand(rawValue: string): { ok: boolean; message: string } {
        const normalized = rawValue.trim().toLowerCase();
        if (!normalized) {
            return { ok: false, message: 'Missing message field filter. Use all, none, or a comma-separated field list.' };
        }
        if (normalized === 'all' || normalized === 'reset') {
            messageFields = null;
            persistState();
            updateStatus();
            return { ok: true, message: 'GitHub PR message fields reset to all.' };
        }
        if (normalized === 'none') {
            messageFields = [];
            persistState();
            updateStatus();
            return { ok: true, message: 'GitHub PR message fields set to none (header only).' };
        }

        const tokens = normalized.split(/[\s,]+/).filter(Boolean);
        const invalidTokens = tokens.filter((token) => !isMessageField(token));
        if (invalidTokens.length > 0) {
            return {
                ok: false,
                message: `Unknown message fields: ${invalidTokens.join(', ')}. Supported: ${MESSAGE_FIELDS.join(', ')}`,
            };
        }

        messageFields = normalizeMessageFieldFilter(tokens);
        persistState();
        updateStatus();
        return { ok: true, message: `GitHub PR message fields set to ${formatMessageFieldFilter(messageFields)}.` };
    }

    async function configureInstruction(ctx: ExtensionContext, rawValue?: string): Promise<void> {
        if (rawValue !== undefined) {
            const trimmed = rawValue.trim();
            if (trimmed.toLowerCase() === 'clear' || trimmed.toLowerCase() === 'none' || trimmed === '') {
                instruction = '';
                touchInstructionGeneration();
                persistState();
                updateStatus();
                notify('GitHub PR custom instruction cleared.');
                return;
            }
            instruction = trimmed;
            touchInstructionGeneration();
            persistState();
            updateStatus();
            notify('GitHub PR custom instruction set.');
            return;
        }

        if (!ctx.hasUI) {
            notify(`Current instruction: ${instruction || '(none)'}`, 'info');
            notify('Use /gh-pr instruction <text> to set, or /gh-pr instruction clear to remove.', 'info');
            return;
        }

        await ctx.ui.custom<void>((tui, theme, kb, done) => {
            const container = new Container();

            container.addChild(
                new (class {
                    render(width: number) {
                        return [
                            truncateToWidth(theme.fg('accent', theme.bold('GitHub PR Custom Instruction')), width),
                            '',
                            truncateToWidth(theme.fg('muted', instruction || '(no instruction set)'), width),
                            '',
                            truncateToWidth(theme.fg('muted', 'Type below. Enter = confirm, Esc = cancel. Clear text to remove.'), width),
                            '',
                        ];
                    }
                    invalidate() {}
                })(),
            );

            let currentValue = instruction;
            let cursorPos = instruction.length;

            const inputComp = {
                render(width: number) {
                    const prefix = '  > ';
                    const prefixLen = prefix.length;
                    const maxWidth = width - prefixLen - 1;
                    if (maxWidth <= 0) return [prefix];

                    // Keep the cursor visible: show a window around the cursor
                    const totalChars = currentValue.length;
                    let viewStart = 0;
                    let viewEnd = totalChars;
                    if (cursorPos > maxWidth) {
                        viewStart = cursorPos - maxWidth + 1;
                        viewEnd = viewStart + maxWidth;
                    }

                    const before = currentValue.slice(viewStart, cursorPos);
                    const atCursor = currentValue.slice(cursorPos, cursorPos + 1);
                    const after = currentValue.slice(cursorPos, viewEnd);
                    const marker = atCursor || ' ';
                    const line = `${prefix}${before}\x1b[7m${marker}\x1b[27m${after}`;
                    return [truncateToWidth(line, width)];
                },
                invalidate() {},
                handleInput(data: string) {
                    if (kb.matches(data, 'tui.select.cancel')) {
                        done(undefined);
                        return;
                    }
                    if (kb.matches(data, 'tui.select.confirm') || kb.matches(data, 'tui.input.submit')) {
                        const trimmed = currentValue.trim();
                        instruction = trimmed;
                        touchInstructionGeneration();
                        persistState();
                        updateStatus();
                        notify(instruction ? 'GitHub PR custom instruction set.' : 'GitHub PR custom instruction cleared.');
                        done(undefined);
                        return;
                    }
                    if (data === '\x7f' || data === '\x08') {
                        if (cursorPos > 0) {
                            currentValue = currentValue.slice(0, cursorPos - 1) + currentValue.slice(cursorPos);
                            cursorPos--;
                            tui.requestRender();
                        }
                        return;
                    }
                    if (data.startsWith('\x1b[')) {
                        const code = data.slice(2);
                        if (code === 'D') {
                            cursorPos = Math.max(0, cursorPos - 1);
                            tui.requestRender();
                        } else if (code === 'C') {
                            cursorPos = Math.min(currentValue.length, cursorPos + 1);
                            tui.requestRender();
                        } else if (code === '1~' || code === 'H') {
                            cursorPos = 0;
                            tui.requestRender();
                        } else if (code === '4~' || code === 'F') {
                            cursorPos = currentValue.length;
                            tui.requestRender();
                        } else if (code === '3~') {
                            if (cursorPos < currentValue.length) {
                                currentValue = currentValue.slice(0, cursorPos) + currentValue.slice(cursorPos + 1);
                                tui.requestRender();
                            }
                        }
                        return;
                    }
                    if (data.length === 1 && data.charCodeAt(0) >= 32) {
                        currentValue = currentValue.slice(0, cursorPos) + data + currentValue.slice(cursorPos);
                        cursorPos++;
                        tui.requestRender();
                    }
                },
            };

            container.addChild(inputComp);

            return {
                render(width: number) {
                    return container.render(width);
                },
                invalidate() {
                    container.invalidate();
                },
                handleInput(data: string) {
                    inputComp.handleInput(data);
                },
            };
        });
    }

    async function handleCommand(action: string, ctx: ExtensionContext): Promise<void> {
        if (action === 'start') {
            await startListening();
            return;
        }
        if (action === 'stop') {
            await stopListening();
            return;
        }
        if (action === 'status') {
            await showStatus(ctx);
            return;
        }
        if (action === 'events') {
            await configureEventActions(ctx);
            return;
        }
        if (action.startsWith('events ')) {
            const result = applyEventActionCommand(action.slice('events '.length));
            notify(result.message, result.ok ? 'info' : 'warning');
            return;
        }
        if (action === 'fields') {
            await configureMessageFields(ctx);
            return;
        }
        if (action.startsWith('fields ')) {
            const result = applyMessageFieldCommand(action.slice('fields '.length));
            notify(result.message, result.ok ? 'info' : 'warning');
            return;
        }
        if (action === 'instruction') {
            await configureInstruction(ctx);
            return;
        }
        if (action.startsWith('instruction ')) {
            await configureInstruction(ctx, action.slice('instruction '.length));
            return;
        }
        if (action === 'test') {
            const enabledActions = getEnabledEventActions(eventActions);
            if (enabledActions.length === 0) {
                notify('All PR event types are filtered out. Re-enable one via /gh-pr events.', 'warning');
                return;
            }
            const testAction = enabledActions[0] ?? 'opened';
            const demoRepo = repo || 'owner/repo';
            const testEvent: PullRequestEvent = {
                id: `local-test-${Date.now()}`,
                repo: demoRepo,
                action: testAction,
                number: 9999,
                title: 'Local GitHub PR test event',
                author: 'pi-local-test',
                url: `https://github.com/${demoRepo}/pull/9999`,
                baseRef: 'main',
                headRef: 'feature/local-gh-pr-test',
                draft: false,
                state: 'OPEN',
                updatedAt: new Date().toISOString(),
                detectedAt: new Date().toISOString(),
            };

            // Test respects the current delivery mode:
            //   auto-turn   → full message sent to agent
            //   notify-only → preview content in toast, no agent delivery
            lastEventSummary = `#${testEvent.number} ${testEvent.action}`;
            lastError = '';
            updateStatus();

            if (mode === 'auto-turn') {
                const content = buildBatchMessageContent([testEvent]);
                queueGitHubMessage(content, [testEvent]);
            } else {
                const content = buildBatchMessageContent([testEvent]);
                notify(`[test preview] PR #${testEvent.number} ${testEvent.action}: ${testEvent.title}`);
                notify(`notify-only mode — message not delivered to agent. Content preview:\n${content}`);
            }
            return;
        }

        if (action.startsWith('mode ')) {
            const nextMode = action.slice('mode '.length).trim();
            if (nextMode === REMOVED_DELIVERY_MODE) {
                notify('GitHub PR inject-message mode was removed. Use notify-only or auto-turn.', 'warning');
                return;
            }
            const resolvedMode = resolveMode(nextMode, mode);
            if (!DELIVERY_MODES.includes(resolvedMode.mode) || resolvedMode.removedLegacyMode) {
                notify(`Unknown mode: ${nextMode}`, 'warning');
                return;
            }
            mode = resolvedMode.mode;
            lastError = '';
            persistState();
            updateStatus();
            notify(`GitHub PR delivery mode set to ${mode}.`);
            return;
        }

        notify(`Unknown /gh-pr action: ${action}`, 'warning');
    }

    pi.on('session_start', async (_event, ctx) => {
        ctxRef = ctx;
        active = false;
        clearRuntimeState();

        const restoredState = readPersistedState(ctx);
        if (restoredState) {
            mode = restoredState.mode;
            repo = restoredState.repo || configuredRepo;
            eventActions = restoredState.eventActions !== undefined ? restoredState.eventActions : configuredEventActions;
            messageFields = restoredState.messageFields !== undefined ? restoredState.messageFields : configuredMessageFields;
            instruction = restoredState.instruction !== undefined ? restoredState.instruction : configuredInstruction;
        } else {
            mode = configuredMode.mode;
            repo = configuredRepo;
            eventActions = configuredEventActions;
            messageFields = configuredMessageFields;
            instruction = configuredInstruction;
        }

        updateStatus();

        if (configuredMode.removedLegacyMode || restoredState?.removedLegacyMode) {
            notify('GitHub PR inject-message mode was removed. Falling back to notify-only.', 'warning');
        }

        if (restoredState?.active) {
            await startListening({ silent: true });
        }
    });

    pi.on('session_shutdown', async () => {
        await stopListening({ silent: true, persist: false });
    });

    // When the user manually sends a message, bump the instruction generation
    // so any pending batch message that hasn't been delivered yet will skip
    // attaching a stale instruction. The latest instruction text is always
    // the SSOT — generation mismatch means "don't attach".
    pi.on('input', (event) => {
        if (event.source === 'interactive' || event.source === 'rpc') {
            touchInstructionGeneration();
        }
    });

    pi.registerCommand('gh-pr', {
        description: 'GitHub PR watcher via gh CLI (session-local)',
        getArgumentCompletions: (prefix: string) => {
            const items = COMMANDS.filter((item) => item.startsWith(prefix)).map((item) => ({ value: item, label: item }));
            return items.length > 0 ? items : null;
        },
        handler: async (args: string, ctx: ExtensionContext) => {
            const trimmedArgs = args.trim();

            if (!trimmedArgs) {
                if (!ctx.hasUI) {
                    notify('Usage: /gh-pr <start|stop|status|test|events|fields|instruction|mode notify-only|mode auto-turn>', 'warning');
                    return;
                }

                // Main menu loop — keep showing the menu until the user explicitly cancels
                for (;;) {
                    const items = [
                        active ? 'stop' : 'start',
                        'status',
                        'test',
                        'events',
                        'fields',
                        'instruction',
                        ...DELIVERY_MODES.filter((m) => m !== mode).map((m) => `mode ${m}`),
                        'Close',
                    ];

                    const choice = await ctx.ui.select('GitHub PR watcher', items);

                    if (!choice || choice === 'Close') break;
                    await handleCommand(choice, ctx);
                }
                return;
            }

            await handleCommand(trimmedArgs, ctx);
        },
    });
}
