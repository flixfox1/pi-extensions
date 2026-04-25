# GitHub PR Watcher Extension

A global Pi extension that watches GitHub pull requests through the local `gh` CLI and delivers PR changes into each Pi session independently.

This version is **session-local**:

- every Pi session can choose whether to run `/gh-pr start`
- sessions do **not** compete for a global repo lease
- if multiple Pi sessions enable the watcher, they each receive the same detected PR changes
- this works well with session-specific custom agents such as `/agent`

No webhook, relay server, tunnel, or public endpoint is required.

---

## Installed locations

- Extension: `~/.pi/agent/extensions/github-pr/index.ts`
- Optional config example: `~/.pi/agent/extensions/github-pr/.env.example`

The old `github-pr-relay.mjs` file may still exist from the webhook-based version, but it is no longer needed for normal local usage.

---

## Architecture

```text
Pi session
  -> /gh-pr start
  -> session-local polling timer
  -> gh pr list --json ...
  -> snapshot diff
  -> event-action filter
  -> notify / auto-turn
```

This is a **state-diff watcher**, not a webhook push system.
It periodically fetches recent pull requests via `gh`, compares them with the previous snapshot for the current session, and emits events when PR state changes are detected.

---

## Requirements

### 1. Install GitHub CLI

```bash
gh --version
```

### 2. Authenticate `gh`

```bash
gh auth login
```

Verify:

```bash
gh auth status
```

If `gh` is not installed or not authenticated, `/gh-pr start` will fail and Pi will show the error in `/gh-pr status`.

---

## Quick start

### 1. Configure env

Create one of these:

- project-local: `<your-repo>/.env.local`
- user-local: `~/.pi/agent/extensions/github-pr/.env`
- or point to any file with `PI_GH_PR_ENV_FILE=/absolute/path/to/file.env`

Example values:

```bash
PI_GH_PR_REPO=flixfox1/Matelink
PI_GH_PR_MODE=notify-only
PI_GH_PR_EVENT_ACTIONS=merged,closed,ready_for_review
PI_GH_PR_POLL_INTERVAL_MS=10000
PI_GH_PR_FETCH_LIMIT=100
PI_GH_PR_COMMAND_TIMEOUT_MS=20000
PI_GH_PR_GH_BIN=gh
```

### 2. Reload Pi

```text
/reload
```

### 3. Start watching in Pi

```text
/gh-pr start
```

### 4. Configure visible event types

```text
/gh-pr events
```

### 5. Test local delivery

```text
/gh-pr test
```

---

## Commands

### `/gh-pr start`
Starts a session-local watcher for the configured repo.

Behavior:

- runs an initial `gh pr list` snapshot
- starts a polling timer
- on later polls, diffs snapshots and emits detected PR changes into this Pi session

If you reopen the same Pi session later, the extension restores the watcher state automatically.

### `/gh-pr stop`
Stops the polling timer for the current Pi session.

### `/gh-pr status`
Shows current runtime state:

- source (`gh-cli`)
- repo
- gh binary path/name
- active state
- mode
- enabled event types
- poll interval
- fetch limit
- command timeout
- tracked PR count
- last poll time
- last event
- last error

### `/gh-pr test`
Injects a local fake PR event directly into the extension.

Use it to verify:

- command wiring
- UI notify behavior
- mode behavior
- event-action filter behavior

It does **not** test `gh` authentication or polling.

The test event uses the first currently enabled event action. If all actions are filtered out, the command warns instead of emitting anything.

### `/gh-pr mode notify-only`
Only shows a notification. No message is added to the chat transcript and no model turn is triggered.

### `/gh-pr mode auto-turn`
Adds a GitHub PR event message and triggers the model to respond automatically.

Use `auto-turn` carefully: it can consume tokens and interrupt your current session flow.

### `/gh-pr fields`
Opens a session-local selector for PR message fields.

This controls **which PR fields are included in the message** sent to the agent (or displayed in notifications).
The filter applies to both:

- `notify-only` notifications
- `auto-turn` summary injection + automatic model response

Available fields:

| Field | Description |
|-------|-------------|
| `repo` | Repository name |
| `event` | Detected action type |
| `pr` | Pull request number |
| `title` | PR title |
| `author` | PR author login |
| `state` | OPEN / CLOSED / MERGED |
| `draft` | Draft status |
| `baseHead` | Base ← Head branches |
| `updated` | Last updated timestamp |
| `url` | GitHub PR URL |

### `/gh-pr fields all`
Include all PR message fields (default).

### `/gh-pr fields none`
Exclude all fields (header `[GitHub PR watcher]` is always included).

### `/gh-pr fields repo,event,pr,title,...`
Set an explicit list of fields to include.

Example:

```text
/gh-pr fields pr,title,author,url
```

### `/gh-pr instruction`
Opens a dialog to set, view, or clear a custom instruction.

When set, the instruction is **appended after the PR event info** (separated by `---`) every time a PR event is delivered in `auto-turn` mode.
This lets you tell the agent what to do with the PR information (e.g., "review this PR", "summarize the changes", etc.).

The instruction is also included in `notify-only` mode for reference in `/gh-pr status`.

### `/gh-pr instruction <text>`
Set the custom instruction directly from the command line.

Example:

```text
/gh-pr instruction Please review this PR and summarize the key changes. Focus on potential risks.
```

### `/gh-pr instruction clear`
Clear the custom instruction.

### `/gh-pr events`
Opens a session-local selector for PR event types.

This controls **which PR event types are allowed to surface** in this session.
The filter applies to both:

- `notify-only` notifications
- `auto-turn` summary injection + automatic model response

### `/gh-pr events all`
Enable all PR event types.

### `/gh-pr events none`
Disable all PR event types.

### `/gh-pr events opened,merged,...`
Set an explicit allowlist of PR event types from the command line.

Example:

```text
/gh-pr events merged closed ready_for_review
```

or

```text
/gh-pr events merged,closed,ready_for_review
```

---

## Environment variables

### Core

#### `PI_GH_PR_REPO`
The repo to watch, for example:

```bash
PI_GH_PR_REPO=owner/repo
```

#### `PI_GH_PR_MODE`
Default delivery mode on startup.

Values:

- `notify-only`
- `auto-turn`

> Legacy `inject-message` mode was removed. If older config still uses it, the extension falls back to `notify-only`.

#### `PI_GH_PR_EVENT_ACTIONS`
Optional comma-separated allowlist of PR event types shown in this session before any session-local override is restored.

Examples:

```bash
PI_GH_PR_EVENT_ACTIONS=merged,closed,ready_for_review
PI_GH_PR_EVENT_ACTIONS=all
PI_GH_PR_EVENT_ACTIONS=none
```

#### `PI_GH_PR_MESSAGE_FIELDS`
Optional comma-separated allowlist of PR message fields included in the event message.
Defaults to all fields.

Examples:

```bash
PI_GH_PR_MESSAGE_FIELDS=pr,title,author,url
PI_GH_PR_MESSAGE_FIELDS=all
PI_GH_PR_MESSAGE_FIELDS=none
```

#### `PI_GH_PR_INSTRUCTION`
Optional custom instruction text appended to PR event messages in `auto-turn` mode.
When set, the instruction appears after the PR fields (separated by `---`).

Example:

```bash
PI_GH_PR_INSTRUCTION=Please review this PR. Summarize key changes and identify potential risks.
```

### Polling

#### `PI_GH_PR_POLL_INTERVAL_MS`
Polling interval for `gh pr list`.
Default: `10000`

#### `PI_GH_PR_FETCH_LIMIT`
How many PRs to fetch on each poll.
Default: `100`

Use a larger value if you want fewer misses in busy repositories.

#### `PI_GH_PR_COMMAND_TIMEOUT_MS`
Timeout for each `gh` invocation.
Default: `20000`

### Binary selection

#### `PI_GH_PR_GH_BIN`
Which executable to run.
Default:

```text
gh
```

Useful if `gh` is not on PATH for the Pi process.

Example:

```bash
PI_GH_PR_GH_BIN=/opt/homebrew/bin/gh
```

### Explicit env file

#### `PI_GH_PR_ENV_FILE`
Absolute path to an env file to load before falling back to `.env.local`, `.env`, or `~/.pi/agent/extensions/github-pr/.env`.

---

## Detected event types

Because this extension uses **snapshot diffing** instead of webhooks, the detected actions are inferred from state changes.

Common emitted actions include:

- `opened`
- `reopened`
- `ready_for_review`
- `converted_to_draft`
- `retargeted`
- `synchronize`
- `retitled`
- `updated`
- `closed`
- `merged`
- `discovered`
- `state_changed`

The exact action depends on what changed between two consecutive `gh` snapshots.

---

## Important behavior notes

### Session-local isolation

This is intentional.

If you open multiple Pi sessions and run `/gh-pr start` in each one:

- each session maintains its own polling timer
- each session keeps its own previous snapshot in memory
- each session receives detected PR changes independently
- each session can keep a different event-action filter and mode

That means one session can run a custom agent and react automatically, while another session can stay in `notify-only` mode and only surface merged PRs.

### First poll is baseline only

When the watcher starts, the first successful `gh pr list` becomes the session baseline.
It does not emit historical PR events from that initial snapshot.
Only later changes are delivered.

### Snapshot-based, not event-perfect

This extension sees **current PR state**, not GitHub’s native webhook event stream.
So it may infer `updated` or `state_changed` where a webhook system would have emitted a more specific event.

For local personal usage, this is usually the right trade-off.

### No webhook/tunnel setup

You do **not** need:

- ngrok
- cloudflared
- GitHub webhook settings
- relay tokens
- webhook secrets
- public ingress

---

## Sharing with others

Because this extension is global, the easiest way to share it is to distribute these files:

- `github-pr/index.ts`
- `github-pr/README.md`
- `github-pr/.env.example`

Recipients can place them into:

- `~/.pi/agent/extensions/github-pr/`

Then run `/reload` in Pi.

---

## Legacy env compatibility

For easier migration, this build still accepts older env names where sensible:

- `MATELINK_GH_RELAY_REPO`
- `MATELINK_GH_PR_MODE`
- `MATELINK_GH_PR_POLL_INTERVAL_MS`
- `MATELINK_GH_PR_ENV_FILE`

New setups should prefer the `PI_GH_PR_*` names.
