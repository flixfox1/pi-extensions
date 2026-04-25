import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';

loadEnvFiles([
    getEnv('PI_GH_PR_ENV_FILE', 'MATELINK_GH_PR_ENV_FILE'),
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(process.cwd(), '.env'),
    path.join(homedir(), '.pi', 'agent', 'extensions', 'github-pr', '.env.local'),
    path.join(homedir(), '.pi', 'agent', 'extensions', 'github-pr', '.env'),
]);

const internalHost = getEnv('PI_GH_PR_INTERNAL_HOST') ?? '127.0.0.1';
const internalPort = parsePositiveInt(getEnv('PI_GH_PR_INTERNAL_PORT'), 8766);
const publicHost = getEnv('PI_GH_PR_WEBHOOK_HOST') ?? '127.0.0.1';
const publicPort = parsePositiveInt(getEnv('PI_GH_PR_WEBHOOK_PORT'), 8787);
const webhookPath = normalizeWebhookPath(getEnv('PI_GH_PR_WEBHOOK_PATH') ?? '/webhooks/github');
const relayToken = getEnv('PI_GH_PR_RELAY_TOKEN', 'MATELINK_GH_RELAY_TOKEN') ?? '';
const webhookSecret = getEnv('PI_GH_PR_WEBHOOK_SECRET', 'GITHUB_WEBHOOK_SECRET') ?? '';
const leaseTtlMs = parsePositiveInt(getEnv('PI_GH_PR_LEASE_TTL_MS', 'MATELINK_GH_RELAY_LEASE_TTL_MS'), 60_000);
const cleanupIntervalMs = parsePositiveInt(getEnv('PI_GH_PR_CLEANUP_INTERVAL_MS', 'MATELINK_GH_RELAY_CLEANUP_INTERVAL_MS'), 15_000);
const queueRetentionMs = parsePositiveInt(getEnv('PI_GH_PR_QUEUE_RETENTION_MS', 'MATELINK_GH_RELAY_QUEUE_RETENTION_MS'), 10 * 60_000);
const deliveryRetentionMs = parsePositiveInt(getEnv('PI_GH_PR_DELIVERY_RETENTION_MS', 'MATELINK_GH_RELAY_DELIVERY_RETENTION_MS'), 24 * 60 * 60_000);
const maxEventsPerSession = parsePositiveInt(getEnv('PI_GH_PR_MAX_EVENTS_PER_SESSION', 'MATELINK_GH_RELAY_MAX_EVENTS_PER_SESSION'), 100);
const maxBodyBytes = parsePositiveInt(getEnv('PI_GH_PR_MAX_BODY_BYTES', 'MATELINK_GH_RELAY_MAX_BODY_BYTES'), 1_000_000);
const allowedRepos = new Set(splitCsv(getEnv('PI_GH_PR_ALLOWED_REPOS', 'MATELINK_GH_RELAY_ALLOWED_REPOS')));
const allowedActions = new Set(
    splitCsv(getEnv('PI_GH_PR_ALLOWED_PR_ACTIONS', 'MATELINK_GH_RELAY_ALLOWED_PR_ACTIONS')),
);
if (allowedActions.size === 0) {
    ['opened', 'reopened', 'ready_for_review', 'synchronize'].forEach((action) => allowedActions.add(action));
}

const repoOwners = new Map();
const sessionQueues = new Map();
const seenDeliveries = new Map();
let nextSeq = 1;

function loadEnvFiles(files) {
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

function parseEnvValue(rawValue) {
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

function getEnv(primaryKey, legacyKey) {
    return process.env[primaryKey] ?? (legacyKey ? process.env[legacyKey] : undefined);
}

function parsePositiveInt(rawValue, fallback) {
    if (!rawValue) return fallback;
    const parsed = Number.parseInt(rawValue, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function splitCsv(rawValue) {
    if (!rawValue) return [];
    return rawValue
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

function normalizeWebhookPath(value) {
    if (!value.startsWith('/')) return `/${value}`;
    return value;
}

function json(res, status, payload) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
}

function getBearerToken(req) {
    const headerValue = req.headers.authorization;
    if (!headerValue) return null;
    const match = headerValue.match(/^Bearer\s+(.+)$/i);
    return match?.[1] ?? null;
}

function requireRelayAuth(req, res) {
    const bearerToken = getBearerToken(req);
    if (!relayToken || !bearerToken || bearerToken !== relayToken) {
        json(res, 401, { ok: false, error: 'Unauthorized relay client.' });
        return null;
    }
    return bearerToken;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let totalBytes = 0;

        req.on('data', (chunk) => {
            totalBytes += chunk.length;
            if (totalBytes > maxBodyBytes) {
                reject(new Error(`Request body too large (>${maxBodyBytes} bytes).`));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });

        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

async function readJsonBody(req) {
    const body = await readBody(req);
    if (body.length === 0) return {};
    return JSON.parse(body.toString('utf8'));
}

function isDeliveryMode(value) {
    return value === 'notify-only' || value === 'inject-message' || value === 'auto-turn';
}

function ensureQueue(sessionId) {
    const existing = sessionQueues.get(sessionId);
    if (existing) {
        existing.lastAccessAt = Date.now();
        return existing;
    }

    const queue = {
        events: [],
        lastAccessAt: Date.now(),
    };
    sessionQueues.set(sessionId, queue);
    return queue;
}

function getLeaseBySessionId(sessionId) {
    for (const lease of repoOwners.values()) {
        if (lease.sessionId === sessionId) return lease;
    }
    return undefined;
}

function removeSession(sessionId) {
    const removedRepos = [];
    for (const [repo, lease] of repoOwners) {
        if (lease.sessionId === sessionId) {
            repoOwners.delete(repo);
            removedRepos.push(repo);
        }
    }
    sessionQueues.delete(sessionId);
    return removedRepos;
}

function purgeExpiredState() {
    const now = Date.now();
    const activeSessionIds = new Set();

    for (const [repo, lease] of repoOwners) {
        if (lease.expiresAt <= now) {
            console.log(`[gh-pr-relay] lease expired repo=${repo} session=${lease.sessionId}`);
            repoOwners.delete(repo);
            sessionQueues.delete(lease.sessionId);
            continue;
        }
        activeSessionIds.add(lease.sessionId);
    }

    for (const [sessionId, queue] of sessionQueues) {
        if (!activeSessionIds.has(sessionId) && queue.lastAccessAt + queueRetentionMs <= now) {
            sessionQueues.delete(sessionId);
        }
    }

    for (const [deliveryId, seenAt] of seenDeliveries) {
        if (seenAt + deliveryRetentionMs <= now) {
            seenDeliveries.delete(deliveryId);
        }
    }
}

function verifyGitHubSignature(rawBody, signatureHeader) {
    if (!webhookSecret || !signatureHeader) return false;
    const expectedSignature = `sha256=${createHmac('sha256', webhookSecret).update(rawBody).digest('hex')}`;
    const received = Buffer.from(signatureHeader);
    const expected = Buffer.from(expectedSignature);
    return received.length === expected.length && timingSafeEqual(received, expected);
}

function isRepoAllowedForClaim(repo) {
    return allowedRepos.size === 0 || allowedRepos.has(repo);
}

function isRepoAllowedForWebhook(repo) {
    return (allowedRepos.size > 0 && allowedRepos.has(repo)) || repoOwners.has(repo);
}

async function handleClaim(req, res, token) {
    const body = await readJsonBody(req);
    const sessionId = body.sessionId?.trim();
    const repo = body.repo?.trim();
    const mode = isDeliveryMode(body.mode) ? body.mode : 'notify-only';

    if (!sessionId || !repo) {
        json(res, 400, { ok: false, error: 'sessionId and repo are required.' });
        return;
    }

    if (!isRepoAllowedForClaim(repo)) {
        json(res, 403, { ok: false, error: `Repo not allowed: ${repo}` });
        return;
    }

    purgeExpiredState();

    const previousLease = repoOwners.get(repo);
    if (previousLease && previousLease.sessionId !== sessionId) {
        sessionQueues.delete(previousLease.sessionId);
    }

    const lease = {
        repo,
        sessionId,
        token,
        mode,
        claimedAt: Date.now(),
        lastHeartbeatAt: Date.now(),
        expiresAt: Date.now() + leaseTtlMs,
    };

    repoOwners.set(repo, lease);
    sessionQueues.set(sessionId, {
        events: [],
        lastAccessAt: Date.now(),
    });

    console.log(`[gh-pr-relay] claim repo=${repo} session=${sessionId} mode=${mode}`);
    json(res, 200, {
        ok: true,
        repo,
        sessionId,
        mode,
        cursor: nextSeq - 1,
        leaseTtlMs,
        replacedSessionId: previousLease && previousLease.sessionId !== sessionId ? previousLease.sessionId : undefined,
    });
}

async function handleHeartbeat(req, res, token) {
    const body = await readJsonBody(req);
    const sessionId = body.sessionId?.trim();
    if (!sessionId) {
        json(res, 400, { ok: false, error: 'sessionId is required.' });
        return;
    }

    purgeExpiredState();

    const lease = getLeaseBySessionId(sessionId);
    if (!lease || lease.token !== token) {
        json(res, 409, { ok: false, error: 'Lease not found or already replaced.' });
        return;
    }

    lease.lastHeartbeatAt = Date.now();
    lease.expiresAt = Date.now() + leaseTtlMs;
    ensureQueue(sessionId).lastAccessAt = Date.now();

    json(res, 200, { ok: true, repo: lease.repo, expiresAt: lease.expiresAt });
}

function handlePoll(req, res, token) {
    const requestUrl = new URL(req.url ?? '/', `http://${internalHost}:${internalPort}`);
    const sessionId = requestUrl.searchParams.get('sessionId')?.trim();
    const cursorRaw = requestUrl.searchParams.get('cursor') ?? '0';
    const cursor = Number.parseInt(cursorRaw, 10);

    if (!sessionId) {
        json(res, 400, { ok: false, error: 'sessionId is required.' });
        return;
    }

    purgeExpiredState();

    const lease = getLeaseBySessionId(sessionId);
    if (!lease || lease.token !== token) {
        json(res, 409, { ok: false, error: 'Lease not found or already replaced.' });
        return;
    }

    const queue = ensureQueue(sessionId);
    const safeCursor = Number.isFinite(cursor) ? cursor : 0;
    const events = queue.events.filter((event) => event.seq > safeCursor);
    const nextCursor = events.length > 0 ? events[events.length - 1].seq : safeCursor;

    json(res, 200, {
        ok: true,
        events,
        nextCursor,
    });
}

function handleRelease(req, res, token) {
    const requestUrl = new URL(req.url ?? '/', `http://${internalHost}:${internalPort}`);
    const sessionId = decodeURIComponent(requestUrl.pathname.replace('/subscriptions/', ''));
    if (!sessionId) {
        json(res, 400, { ok: false, error: 'sessionId is required.' });
        return;
    }

    const lease = getLeaseBySessionId(sessionId);
    if (lease && lease.token !== token) {
        json(res, 409, { ok: false, error: 'Lease belongs to a different relay token.' });
        return;
    }

    const removedRepos = removeSession(sessionId);
    if (removedRepos.length > 0) {
        console.log(`[gh-pr-relay] release session=${sessionId} repos=${removedRepos.join(',')}`);
    }

    json(res, 200, {
        ok: true,
        removedRepos,
    });
}

async function handleWebhook(req, res) {
    const rawBody = await readBody(req);
    if (!verifyGitHubSignature(rawBody, req.headers['x-hub-signature-256'])) {
        json(res, 401, { ok: false, error: 'Invalid GitHub signature.' });
        return;
    }

    const eventName = req.headers['x-github-event'];
    if (eventName !== 'pull_request') {
        json(res, 202, { ok: true, ignored: true, reason: `unsupported event ${String(eventName)}` });
        return;
    }

    const deliveryId = String(req.headers['x-github-delivery'] ?? '');
    if (!deliveryId) {
        json(res, 400, { ok: false, error: 'Missing X-GitHub-Delivery header.' });
        return;
    }

    if (seenDeliveries.has(deliveryId)) {
        json(res, 202, { ok: true, duplicate: true });
        return;
    }

    const payload = JSON.parse(rawBody.toString('utf8'));
    const repo = payload.repository?.full_name?.trim();
    const action = payload.action?.trim();
    if (!repo || !action) {
        json(res, 400, { ok: false, error: 'Malformed pull_request payload.' });
        return;
    }

    if (!isRepoAllowedForWebhook(repo)) {
        json(res, 202, { ok: true, ignored: true, reason: `repo not allowed or inactive: ${repo}` });
        return;
    }

    if (!allowedActions.has(action)) {
        json(res, 202, { ok: true, ignored: true, reason: `action not allowed: ${action}` });
        return;
    }

    purgeExpiredState();
    const lease = repoOwners.get(repo);
    if (!lease) {
        seenDeliveries.set(deliveryId, Date.now());
        json(res, 202, { ok: true, queued: false, reason: 'no active session lease' });
        return;
    }

    const pr = payload.pull_request;
    const sessionEvent = {
        seq: nextSeq++,
        id: deliveryId,
        repo,
        action,
        number: pr?.number ?? 0,
        title: pr?.title ?? '(untitled PR)',
        author: pr?.user?.login ?? 'unknown',
        url: pr?.html_url ?? `https://github.com/${repo}/pull/${pr?.number ?? 'unknown'}`,
        baseRef: pr?.base?.ref,
        headRef: pr?.head?.ref,
        draft: pr?.draft,
        merged: pr?.merged,
        updatedAt: pr?.updated_at,
    };

    const queue = ensureQueue(lease.sessionId);
    queue.events.push(sessionEvent);
    if (queue.events.length > maxEventsPerSession) {
        queue.events.splice(0, queue.events.length - maxEventsPerSession);
    }

    seenDeliveries.set(deliveryId, Date.now());

    console.log(`[gh-pr-relay] deliver repo=${repo} action=${action} pr=#${sessionEvent.number} session=${lease.sessionId} seq=${sessionEvent.seq}`);
    json(res, 202, {
        ok: true,
        queued: true,
        sessionId: lease.sessionId,
        seq: sessionEvent.seq,
    });
}

function handleHealthz(res) {
    purgeExpiredState();
    json(res, 200, {
        ok: true,
        internalBaseUrl: `http://${internalHost}:${internalPort}`,
        publicWebhookUrl: `http://${publicHost}:${publicPort}${webhookPath}`,
        activeRepos: [...repoOwners.keys()],
        sessionCount: sessionQueues.size,
        nextSeq,
        repoAllowlist: [...allowedRepos],
        allowedActions: [...allowedActions],
    });
}

const publicServer = createServer(async (req, res) => {
    try {
        const method = req.method ?? 'GET';
        const requestUrl = new URL(req.url ?? '/', `http://${publicHost}:${publicPort}`);

        if (method === 'POST' && requestUrl.pathname === webhookPath) {
            await handleWebhook(req, res);
            return;
        }

        json(res, 404, { ok: false, error: `Not found: ${method} ${requestUrl.pathname}` });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown server error.';
        json(res, 500, { ok: false, error: message });
    }
});

const internalServer = createServer(async (req, res) => {
    try {
        const method = req.method ?? 'GET';
        const requestUrl = new URL(req.url ?? '/', `http://${internalHost}:${internalPort}`);

        if (method === 'GET' && requestUrl.pathname === '/healthz') {
            const token = requireRelayAuth(req, res);
            if (!token) return;
            handleHealthz(res);
            return;
        }

        if (method === 'POST' && requestUrl.pathname === '/subscriptions/claim') {
            const token = requireRelayAuth(req, res);
            if (!token) return;
            await handleClaim(req, res, token);
            return;
        }

        if (method === 'POST' && requestUrl.pathname === '/subscriptions/heartbeat') {
            const token = requireRelayAuth(req, res);
            if (!token) return;
            await handleHeartbeat(req, res, token);
            return;
        }

        if (method === 'GET' && requestUrl.pathname === '/events/poll') {
            const token = requireRelayAuth(req, res);
            if (!token) return;
            handlePoll(req, res, token);
            return;
        }

        if (method === 'DELETE' && requestUrl.pathname.startsWith('/subscriptions/')) {
            const token = requireRelayAuth(req, res);
            if (!token) return;
            handleRelease(req, res, token);
            return;
        }

        json(res, 404, { ok: false, error: `Not found: ${method} ${requestUrl.pathname}` });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown server error.';
        json(res, 500, { ok: false, error: message });
    }
});

if (!relayToken) {
    const generated = randomBytes(24).toString('hex');
    console.error('Missing PI_GH_PR_RELAY_TOKEN.');
    console.error(`Suggested value: ${generated}`);
    process.exit(1);
}

if (!webhookSecret) {
    const generated = randomBytes(24).toString('hex');
    console.error('Missing PI_GH_PR_WEBHOOK_SECRET.');
    console.error(`Suggested value: ${generated}`);
    process.exit(1);
}

setInterval(purgeExpiredState, cleanupIntervalMs).unref();

internalServer.listen(internalPort, internalHost, () => {
    console.log(`[gh-pr-relay] internal API listening on http://${internalHost}:${internalPort}`);
    console.log('[gh-pr-relay] internal endpoints require Authorization: Bearer <PI_GH_PR_RELAY_TOKEN>');
});

publicServer.listen(publicPort, publicHost, () => {
    console.log(`[gh-pr-relay] public webhook listener on http://${publicHost}:${publicPort}${webhookPath}`);
    console.log('[gh-pr-relay] expose only the public webhook listener to GitHub or your tunnel/proxy');
    if (allowedRepos.size > 0) {
        console.log(`[gh-pr-relay] static repo allowlist: ${[...allowedRepos].join(', ')}`);
    } else {
        console.log('[gh-pr-relay] no static repo allowlist configured; active claimed repos are accepted');
    }
    console.log(`[gh-pr-relay] allowed pull_request actions: ${[...allowedActions].join(', ')}`);
});
