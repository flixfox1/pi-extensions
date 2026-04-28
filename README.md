# Pi Extensions

My personal pi coding agent extensions, managed via git and symlinked into `~/.pi/agent/extensions/`.

## Extensions

| Extension | Description |
|-----------|-------------|
| `accel-editor/` | Compact-panel-style input editor long-press acceleration |
| `agent-orchestrator/` | Orchestrator role, CLI tools, and monitor UI |
| `agent-run-time/` | Workflow command/runtime helpers |
| `auto-trigger/` | Auto trigger extension |
| `clear-context/` | Clear context panel and automation |
| `compact-tailor/` | Custom compaction management panel |
| `github-pr/` | GitHub PR helper extension |
| `switch-agent/` | Agent switcher extension |
| `todo.ts` | Todo helper extension |

> Note: `subagent/` is a symlink to pi's built-in examples, not tracked here.

## Setup on a New Machine

```bash
# 1. Clone this repo
git clone <this-repo-url> ~/pi-extensions

# 2. Create extensions directory if needed
mkdir -p ~/.pi/agent/extensions

# 3. Symlink extensions
ln -s ~/pi-extensions/agent-switcher ~/.pi/agent/extensions/agent-switcher
ln -s ~/pi-extensions/auto-trigger ~/.pi/agent/extensions/auto-trigger
ln -s ~/pi-extensions/compact.ts ~/.pi/agent/extensions/compact.ts

# 4. Re-create subagent symlinks (from local pi installation)
PI_DIR=$(dirname $(dirname $(which pi)))/lib/node_modules/@mariozechner/pi-coding-agent
ln -s "$PI_DIR/examples/extensions/subagent/index.ts" ~/.pi/agent/extensions/subagent/index.ts
ln -s "$PI_DIR/examples/extensions/subagent/agents.ts" ~/.pi/agent/extensions/subagent/agents.ts
```

## How It Works

- **This repo** holds the source code of custom extensions
- **`~/.pi/agent/extensions/`** contains symlinks pointing here
- Editing files in this repo takes effect immediately (pi hot-reloads)
- Push changes to git to keep them backed up and portable
