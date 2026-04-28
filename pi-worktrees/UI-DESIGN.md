# pi-worktrees Compact Panel UI Design

以 `compact-panel` 为原型，为 `@zenobius/pi-worktrees` 设计一套完整 Pi TUI。目标不是做 Web UI，而是在 Pi 交互界面内提供一个统一的 `/worktree` 面板入口，用 `ctx.ui.custom()` overlay、手写 `render(width)`、完整边框、状态区 + 菜单区 + 子面板回退的方式管理 Git worktree。

---

## 1. 设计目标

1. **单入口**：`/worktree` 在 TUI 模式下打开主面板；非 TUI 模式继续显示 help。
2. **命令兼容**：保留现有子命令：`init/create/list/remove/status/cd/prune/settings/templates`。
3. **安全优先**：所有破坏性动作必须有确认；main/current worktree 不允许删除；force remove 必须二次确认。
4. **状态先行**：主面板顶部始终显示当前 repo、branch、main worktree、worktreeRoot、hook 状态。
5. **Esc 回退**：子面板 Esc 返回主菜单；主菜单 Esc/q 关闭。
6. **不假装切 cwd**：Pi extension 不能直接改变父 shell cwd，所以 `cd` 类操作只能展示/打印路径，或运行 `onSwitch` hook。
7. **可渐进实现**：第一版可复用现有 command 逻辑，后续再抽出 service 层实现更复杂 wizard。

---

## 2. 与 compact-panel 对齐的 UI 规范

从 `compact-tailor/index.ts` 继承以下模式：

```ts
const OVERLAY = {
  overlay: true,
  overlayOptions: {
    width: "56%",
    minWidth: 56,
    maxHeight: "70%",
    anchor: "center",
  },
} as const;
```

统一组件要求：

- 使用 `ctx.ui.custom()`。
- 所有 panel 自绘：`┌ ┐ ├ ┤ └ ┘ │`。
- 每行必须恰好适配 `width`，用 `truncateToWidth()` 控制溢出。
- 状态区在上，操作区在下，底部是 key hints。
- 高亮当前选中行：`▸` + `theme.fg("accent", theme.bold(...))`。
- 成功/启用：`success`；警告：`warning`；不可用/禁用：`dim`；路径/commit：`muted`。

建议抽出公共文件：

```text
src/ui/panelStyle.ts
src/ui/worktreePanel.ts
src/ui/createWizard.ts
src/ui/settingsPanel.ts
src/ui/removePanel.ts
src/ui/hookLogPanel.ts
```

---

## 3. 顶层命令设计

### 当前命令保持

```text
/worktree init
/worktree create <branch> [--name <name>]
/worktree create --generate [--name <name>] <prompt>
/worktree list
/worktree remove <name>
/worktree status
/worktree cd <name>
/worktree prune
/worktree settings [key] [value]
/worktree templates
```

### 新交互入口

```text
/worktree              TUI 模式打开 Worktree Panel；非 TUI 显示 help
/worktree panel        显式打开 Worktree Panel
/worktree create       无参数时打开 Create Wizard
/worktree remove       无参数时打开 Remove Panel
/worktree settings     无参数时打开 Settings Panel
```

> 兼容原则：有明确参数时走原命令；无参数且 `ctx.hasUI` 时走 panel。

---

## 4. 主面板：Worktree Dashboard

### 信息架构

主面板分三块：

1. **Header**：标题和 repo 摘要。
2. **Status**：当前状态。
3. **Actions**：菜单项。

### 菜单项

```ts
const MENU_ITEMS = [
  { id: "create", label: "Create Worktree", desc: "创建新 branch-first worktree" },
  { id: "list", label: "Worktrees", desc: "查看全部 worktree，运行 onSwitch 或打印路径" },
  { id: "remove", label: "Remove", desc: "安全删除非 main/current worktree" },
  { id: "settings", label: "Settings", desc: "配置 worktreeRoot、匹配规则和 hook" },
  { id: "templates", label: "Templates", desc: "预览 {{path}}/{{name}}/{{branch}} 等变量" },
  { id: "prune", label: "Prune", desc: "清理 stale git worktree metadata" },
  { id: "status", label: "Status", desc: "查看 repo / branch / config 详情" },
] as const;
```

### 视觉草图

```text
┌────────────────────────────────────────────────────────────┐
│ Worktrees                                                  │
├────────────────────────────────────────────────────────────┤
│ Project       Matelink                                     │
│ Current       main · main repo                             │
│ Main          /mnt/g/Ai Projects/Matelink                  │
│ Root          {{mainWorktree}}.worktrees                   │
│ Worktrees     3 total · 1 current · 0 stale                │
│ Hooks         onCreate ✓  onSwitch ✗  onBeforeRemove ✗     │
├────────────────────────────────────────────────────────────┤
│ ▸ Create Worktree                                          │
│   创建新 branch-first worktree                             │
│   Worktrees                                                │
│   Remove                                                   │
│   Settings                                                 │
│   Templates                                                │
│   Prune                                                    │
│   Status                                                   │
├────────────────────────────────────────────────────────────┤
│ ↑↓ 选择  Enter 确认  r 刷新  Esc/q 关闭                    │
└────────────────────────────────────────────────────────────┘
```

### 快捷键

| Key | 行为 |
|---|---|
| `↑/↓` | 选择菜单项 |
| `Enter` | 进入子面板 |
| `r` | 重新读取 git/config 状态 |
| `Esc/q` | 关闭 |
| `c` | 直接进入 Create Wizard |
| `l` | 直接进入 Worktrees List |
| `d` | 直接进入 Remove Panel |
| `s` | 直接进入 Settings Panel |

---

## 5. Worktrees List Panel

### 目标

替代当前 `ctx.ui.select('Select worktree to switch to', options)`，提供完整列表 + 详情 + 操作提示。

### 展示字段

- name：`basename(path)`
- branch
- type：`main/current/worktree`
- head：短 commit
- path
- hook status：当前匹配配置下是否有 `onSwitch`

### 视觉草图

```text
┌────────────────────────────────────────────────────────────┐
│ Worktrees                                                  │
├────────────────────────────────────────────────────────────┤
│   name                         branch             flags    │
│ ▸ Matelink                     main               main cur │
│   Matelink.worktrees/auth      feature/auth       wt       │
│   Matelink.worktrees/parser    spike/parser       wt       │
├────────────────────────────────────────────────────────────┤
│ Selected     Matelink.worktrees/auth                       │
│ Branch       feature/auth                                  │
│ Path         /mnt/g/Ai Projects/Matelink.worktrees/auth    │
│ HEAD         abc1234                                       │
│ onSwitch     not configured                               │
├────────────────────────────────────────────────────────────┤
│ Enter run onSwitch/print path · p print path · d remove    │
│ r refresh · Esc back · q close                             │
└────────────────────────────────────────────────────────────┘
```

### 行为

- `Enter`：
  - 如果 `onSwitch` 已配置：运行 `onSwitch` hook，显示 hook progress。
  - 如果没配置：notify/打印 path，与 `/worktree cd <name>` 一致。
- `p`：打印 path。
- `d`：若不是 main/current，进入 Remove Confirm Panel。
- `r`：刷新列表。
- `Esc`：返回主菜单。

---

## 6. Create Worktree Wizard

### 目标

把当前 `/worktree create <branch> [--name]` 做成三步 wizard，减少用户记忆参数负担。

### Step 1：输入 branch

```text
┌────────────────────────────────────────────────────────────┐
│ Create Worktree                                            │
├────────────────────────────────────────────────────────────┤
│ Mode         branch-first                                  │
│ Branch       ▸ feature/auth-refactor                       │
│ Name         auth-refactor                                 │
│ Path         {{mainWorktree}}.worktrees/auth-refactor      │
├────────────────────────────────────────────────────────────┤
│ Enter 下一步 · g 使用 generator · n 编辑 name · Esc 返回   │
└────────────────────────────────────────────────────────────┘
```

### Step 2：预检

预检内容：

- 当前目录是否在 git repo 内。
- branch 是否已经存在。
- worktree path 是否已经存在。
- `worktreeRoot` 是否在 repo 内；若在 repo 内，显示将写入 `.git/info/exclude`。
- `onCreate` 是否配置。

```text
┌────────────────────────────────────────────────────────────┐
│ Create Preview                                             │
├────────────────────────────────────────────────────────────┤
│ Branch       feature/auth-refactor                         │
│ Name         auth-refactor                                 │
│ Path         /.../Matelink.worktrees/auth-refactor         │
│ Hook         onCreate: mise setup                          │
│ Preflight    ✓ repo  ✓ branch free  ✓ path free            │
├────────────────────────────────────────────────────────────┤
│ Enter 创建 · e 编辑 · Esc 返回                             │
└────────────────────────────────────────────────────────────┘
```

### Step 3：执行和 hook log

执行阶段显示：

- `git worktree add -b <branch> <path>`
- `onCreate` 命令列表进度
- 最近 stdout/stderr N 行
- logfile 路径

```text
┌────────────────────────────────────────────────────────────┐
│ Creating auth-refactor                                     │
├────────────────────────────────────────────────────────────┤
│ [x] git worktree add -b feature/auth-refactor              │
│ [ ] mise setup                                             │
│                                                            │
│ stdout                                                     │
│   Installing dependencies...                               │
├────────────────────────────────────────────────────────────┤
│ Esc hide panel; command continues · log /tmp/pi-worktree…  │
└────────────────────────────────────────────────────────────┘
```

### 快捷键

| Key | 行为 |
|---|---|
| `g` | 切换到 `branchNameGenerator` 模式 |
| `n` | 编辑 worktree name |
| `e` | 返回编辑 |
| `Enter` | 下一步/确认创建 |
| `Esc` | 返回主菜单 |

第一版可以先用 `ctx.ui.input()` 收集 branch/name，再使用自绘 preview/confirm；第二版再写 Focusable 输入组件。

---

## 7. Remove Panel

### 目标

比当前 select + confirm 更安全，明确显示保护规则和脏工作区风险。

### 展示

```text
┌────────────────────────────────────────────────────────────┐
│ Remove Worktree                                            │
├────────────────────────────────────────────────────────────┤
│   name                         branch              status  │
│   Matelink                     main                locked  │
│   Matelink.worktrees/auth      feature/auth        clean   │
│ ▸ Matelink.worktrees/parser    spike/parser        dirty?  │
├────────────────────────────────────────────────────────────┤
│ Selected     Matelink.worktrees/parser                     │
│ Path         /.../parser                                   │
│ Branch       spike/parser                                  │
│ Safety       branch will NOT be deleted                    │
│ Hook         onBeforeRemove: bun test                      │
├────────────────────────────────────────────────────────────┤
│ Enter confirm · f force after failure · r refresh · Esc    │
└────────────────────────────────────────────────────────────┘
```

### 规则

- main：显示 `locked`，不能选删除。
- current：显示 `locked`，不能选删除。
- normal：可删除。
- dirty 检测可用 `git -C <path> status --porcelain`，失败时显示 `unknown`。
- 删除失败后再弹 force confirm。
- 如配置 `onBeforeRemove`，先运行 hook；hook 非 0 阻止删除。

---

## 8. Settings Panel

### 目标

把 `init/settings/templates` 统一成可浏览、可编辑的配置中心。

### 一级菜单

```ts
const SETTINGS_ITEMS = [
  { id: "root", label: "Worktree Root", desc: "配置 worktreeRoot 模板" },
  { id: "repo", label: "Repo Match", desc: "查看当前 repo 匹配到的 pattern" },
  { id: "hooks", label: "Hooks", desc: "配置 onCreate/onSwitch/onBeforeRemove" },
  { id: "generator", label: "Branch Generator", desc: "配置 --generate 命令" },
  { id: "logfile", label: "Logfile", desc: "配置 hook 日志路径模板" },
  { id: "display", label: "Display", desc: "配置 hook 输出行数和状态样式" },
  { id: "matching", label: "Matching Strategy", desc: "fail-on-tie / first-wins / last-wins" },
] as const;
```

### 视觉草图

```text
┌────────────────────────────────────────────────────────────┐
│ Worktree Settings                                          │
├────────────────────────────────────────────────────────────┤
│ Matched      **                                            │
│ Root         {{mainWorktree}}.worktrees                    │
│ Strategy     fail-on-tie                                   │
│ Hooks        onCreate ✓  onSwitch ✗  onBeforeRemove ✗      │
│ Generator    not configured                                │
├────────────────────────────────────────────────────────────┤
│ ▸ Worktree Root                                            │
│   Repo Match                                               │
│   Hooks                                                    │
│   Branch Generator                                         │
│   Logfile                                                  │
│   Display                                                  │
│   Matching Strategy                                        │
├────────────────────────────────────────────────────────────┤
│ Enter edit · t templates · Esc back                        │
└────────────────────────────────────────────────────────────┘
```

### 编辑方式

第一版可用内置 dialog：

- `ctx.ui.input()` 编辑字符串。
- `ctx.ui.select()` 选择 preset。
- `ctx.ui.confirm()` 保存。

后续可改成 compact-panel 内联输入框。

### 必须补齐的配置项

当前 `cmdSettings.ts` 只支持：

```ts
worktreeRoot | parentDir | onCreate
```

完整 UI 应补齐：

```text
onSwitch
onBeforeRemove
branchNameGenerator
logfile
matchingStrategy
onCreateDisplayOutputMaxLines
onCreateCmdDisplayPending
onCreateCmdDisplaySuccess
onCreateCmdDisplayError
onCreateCmdDisplayPendingColor
onCreateCmdDisplaySuccessColor
onCreateCmdDisplayErrorColor
```

---

## 9. Templates Panel

保留当前 `cmdTemplates` 的信息，但用 compact panel 风格展示。

```text
┌────────────────────────────────────────────────────────────┐
│ Template Variables                                         │
├────────────────────────────────────────────────────────────┤
│ {{path}}          /.../Matelink.worktrees/example          │
│ {{name}}          example                                  │
│ {{branch}}        feature/example                          │
│ {{project}}       Matelink                                 │
│ {{mainWorktree}}  /mnt/g/Ai Projects/Matelink              │
├────────────────────────────────────────────────────────────┤
│ Root Preview      /.../Matelink.worktrees                  │
│ Log Preview       /tmp/pi-worktree-session-example.log     │
├────────────────────────────────────────────────────────────┤
│ r regenerate sample · Esc back                             │
└────────────────────────────────────────────────────────────┘
```

---

## 10. Prune Panel

```text
┌────────────────────────────────────────────────────────────┐
│ Prune Stale Worktrees                                      │
├────────────────────────────────────────────────────────────┤
│ Stale refs    2                                            │
│                                                            │
│   /tmp/old-worktree-a                                      │
│   /tmp/old-worktree-b                                      │
├────────────────────────────────────────────────────────────┤
│ Enter prune · r refresh · Esc back                         │
└────────────────────────────────────────────────────────────┘
```

行为：

- 先运行 `git worktree prune --dry-run` 或等价检查。
- 无 stale refs：显示 `No stale worktree references`。
- Enter 后二次确认，再运行 `git worktree prune`。

---

## 11. Status / About Panel

用于排障和确认插件来源。

```text
┌────────────────────────────────────────────────────────────┐
│ Worktree Status                                            │
├────────────────────────────────────────────────────────────┤
│ Plugin       pi-worktrees source extension                 │
│ Upstream     zenobi-us/pi-worktrees                        │
│ Commit       3124f2b3                                      │
│ Config       ~/.pi/agent/pi-worktrees.config.json          │
│ CWD          /mnt/g/Ai Projects/Matelink                   │
│ Git repo     yes                                           │
│ Current      main                                          │
│ Main         /mnt/g/Ai Projects/Matelink                   │
│ Root         /mnt/g/Ai Projects/Matelink.worktrees         │
├────────────────────────────────────────────────────────────┤
│ r refresh · Esc back                                       │
└────────────────────────────────────────────────────────────┘
```

---

## 12. Hook Progress Panel

`onCreate` / `onSwitch` / `onBeforeRemove` 都走统一 hook runner UI。

```text
┌────────────────────────────────────────────────────────────┐
│ Hook: onCreate                                             │
├────────────────────────────────────────────────────────────┤
│ Worktree     auth-refactor                                 │
│ Path         /.../auth-refactor                            │
│ Log          /tmp/pi-worktree-session-auth-refactor.log    │
├────────────────────────────────────────────────────────────┤
│ [x] mise trust --yes                                       │
│ [>] mise setup                                             │
│ [ ] bun install                                            │
├────────────────────────────────────────────────────────────┤
│ output                                                     │
│   resolving dependencies...                                │
│   installing packages...                                   │
├────────────────────────────────────────────────────────────┤
│ Esc hide · panel closes automatically on success           │
└────────────────────────────────────────────────────────────┘
```

实现注意：

- 当前 `runHook()` 已经通过 notify 输出进度；要做完整 panel，需要让 `runHook()` 支持 `onUpdate(event)`。
- 第一版可先继续用 status bar + notify；第二版再加 hook log panel。

---

## 13. 状态模型

建议增加统一 snapshot：

```ts
type WorktreePanelSnapshot = {
  ok: boolean;
  error?: string;
  cwd: string;
  project: string;
  currentBranch: string;
  isWorktree: boolean;
  mainWorktree: string;
  worktreeRoot: string;
  matchedPattern: string | null;
  worktrees: Array<{
    name: string;
    path: string;
    branch: string;
    head: string;
    shortHead: string;
    isMain: boolean;
    isCurrent: boolean;
    dirty?: "clean" | "dirty" | "unknown";
  }>;
  hooks: {
    onCreate: boolean;
    onSwitch: boolean;
    onBeforeRemove: boolean;
  };
};
```

对应文件：

```text
src/services/snapshot.ts
```

---

## 14. 建议实现路线

### Phase 1：面板骨架

- 新增 `src/ui/panelStyle.ts`：移植 compact-panel 的 border helpers。
- 新增 `src/ui/worktreePanel.ts`：主菜单 + status。
- 修改 `src/index.ts`：无参数 `/worktree` 打开主面板。

验收：

- `/worktree` 打开主菜单。
- `↑↓/Enter/Esc/r` 可用。
- 非 TUI 模式仍显示 help。

### Phase 2：List / Status / Templates 面板化

- `Worktrees List Panel` 替代 `ctx.ui.select()`。
- `Status Panel` 替代 status notify。
- `Templates Panel` 复用当前 token 逻辑。

验收：

- 可浏览 worktrees。
- Enter 运行 `onSwitch` 或打印 path。
- Esc 返回主菜单。

### Phase 3：Remove / Prune 安全面板

- Remove Panel 支持 locked main/current。
- Remove Confirm Panel。
- Prune Panel。

验收：

- main/current 永远不可删除。
- 删除失败后必须二次确认 force。

### Phase 4：Create Wizard

- branch/name 输入。
- path preview。
- conflict preflight。
- create confirm。

验收：

- 无参数 `/worktree create` 打开 wizard。
- 有参数 `/worktree create feature/x --name x` 保持原行为。

### Phase 5：Settings / Hook Editor

- Settings Panel 补齐当前缺失配置项。
- Hook editor 支持多行/数组命令。
- Branch generator config。

验收：

- 不再依赖手改 JSON 配置。
- 可在 UI 内配置完整工作流。

### Phase 6：Hook Progress Panel

- `runHook()` 增加 progress event。
- onCreate/onSwitch/onBeforeRemove 都显示统一日志面板。

验收：

- 长任务可看到实时状态。
- panel 隐藏后 hook 仍可继续，最终 notify。

---

## 15. 最小可交付版本定义

如果只做一版，建议范围如下：

1. `/worktree` 主菜单。
2. Status 区完整展示。
3. Worktrees List Panel。
4. Remove Panel。
5. Create Wizard 使用 `ctx.ui.input()` + 自绘 preview。
6. Settings 先只支持 `worktreeRoot/onCreate/onSwitch/onBeforeRemove`。

这版已经能显著超过当前 `notify/select/input` 拼装体验，并且保持 compact-panel 风格一致。
