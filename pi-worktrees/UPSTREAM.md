# Upstream

Source copied from: https://github.com/zenobi-us/pi-worktrees

This directory is loaded by Pi global extension auto-discovery via `index.ts`,
which re-exports `./src/index.ts` from the upstream source tree.

Runtime dependencies are installed locally under this directory's `node_modules/`.

Local customization:

- `src/ui/panelStyle.ts` adds compact-panel-style border/layout helpers.
- `src/ui/worktreePanel.ts` adds the full `/worktree` dashboard, list, create, remove, settings, templates, prune, and status panels.
- `/worktree panel` explicitly opens the dashboard; `/worktree` opens it in TUI mode.
