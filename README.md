# Agent Live View (experimental v0.4.0)

Automatically open the actual files being changed while Claude Code works in the **VS Code chat panel**. Does **not** require running Claude Code in a CLI terminal. Normal VS Code editors are used, so you see source code with syntax highlighting, not tool-call logs.

## What works in this prototype

- Watches real on-disk file changes, including files written by shell scripts and Python.
- Also listens for live VS Code text-document changes.
- Opens changed source files as persistent tabs without deliberately stealing keyboard focus.
- **Viewing pace**: each changed file stays as the front tab for at least 4 seconds (configurable) before another file replaces it in the same column. Different agent columns advance independently.
- **Source allowlist**: shows only specified file types (`.tsx`, `.ts`, `.php`, `.twig`, etc.) by default. JSON is hidden unless you explicitly allow certain JSON paths. Existing scratch, cache, trace and version-file exclusions still apply.
- Coalesces repeated writes to the same file, so rapid save storms do not endlessly jump around.
- Scrolls near the modified lines, showing a short green whole-line highlight.
- Uses a known live VS Code text change or a previous snapshot to locate edits. For a file seen for the first time it tries `git diff` to locate changed lines and otherwise falls back to the last line.
- Optional Claude Code hooks add agent IDs and editing-round boundaries, enabling up to three editor columns and closing only extension-owned tabs at the start of the *next editing round*.
- Explicit commands to pause watching, install hooks and show diagnostics.

## Install

Option A: Use the experimental `.vsix` supplied with this source. In VS Code open Extensions -> `...` -> **Install from VSIX...**.

Option B: Package the extension yourself with Node.js and `@vscode/vsce`:

```bash
npm install --global @vscode/vsce
cd agent-live-view
vsce package
```

Then install the generated VSIX in VS Code. (VS Code also supports opening this source folder and pressing F5 if you have a suitable extension debug launch configuration.)

## Test the basic file watcher first

1. Open any project folder in VS Code. Make sure the status bar reads `Live View: ON`.
2. Leave Claude chat open on the right.
3. Ask Claude to modify a tracked source file, or edit a source file *externally* via a terminal command.
4. The actual source file should open as a normal editor tab, with a brief green highlight.
5. Run **Agent Live View: Set Viewing Pace** to choose 2, 4, 6 or 10 seconds per file.
6. Check **View > Output > Agent Live View** if nothing opens. The watcher does not need Claude hooks to work.

## Enable agent attribution and editing-round cleanup

In the Command Palette (`Ctrl+Shift+P` on Windows):

**Agent Live View: Install Claude Agent Tracking Hooks**

This merges six minimal hook entries into the chosen project's `.claude/settings.local.json` and backs up existing settings to `.claude/settings.local.json.agent-live-view.bak`. Restart the Claude Code conversation/session so new hook settings load. The hook helper only logs session/agent/file/tool metadata to a JSONL file in the computer's temporary folder. It does **not** log prompts, command text or source contents, and uses no network. Node.js must be on PATH for the hook process.

**After updating from v0.1.0**, rerun **Agent Live View: Install Claude Agent Tracking Hooks** to refresh the hook command path. Restart the Claude Code conversation/session afterwards. Normal file watching still works without hooks.

Run **Agent Live View: Show Diagnostics** to see the exact temporary event path. Agent-specific columns only appear when Claude Code actually emits distinct `agent_id` values. Shell commands without a file path cannot always be attributed uniquely if multiple agents are running simultaneously. Those changes still appear, in a shared Unattributed column.

## Tuning your display

By default, files are held on-screen for **4 seconds**, green changed-line highlighting stays for **6 seconds**, and `version.json` is ignored. To change these, open **Settings (JSON)**:

```json
"agentLiveView.minViewMs": 6000,
"agentLiveView.highlightDurationMs": 8000,
"agentLiveView.excludeFiles": ["**/version.json", "**/package-lock.json", "**/composer.lock"]
```

`excludeFiles` patterns override the allowlist across folders and do **not** interfere with actual file writes, Git, builds or version numbers: they only stop the extension opening those files. If you want to watch `version.json` again, remove it from the list.

The pace is a **minimum screen dwell**, not a throttle on Claude itself. Claude keeps coding at full speed. When many files change rapidly, the viewer catches up through its ordered, coalesced queue and will show the latest saved state of each file rather than a simulated keystroke-by-keystroke animation.

## Include selected source files, plus only the JSON you want

Version 0.4.0 defaults to `agentLiveView.filterMode: "includeOnly"`: changed files **must match** `agentLiveView.includeFiles` to appear. Most `.json` files are not shown by default, but you can add individual JSON filenames or paths.

Copy the following into your project's `.vscode/settings.json` (or merge these entries into your existing settings):

```json
{
  "agentLiveView.filterMode": "includeOnly",
  "agentLiveView.includeFiles": [
    "**/*.tsx", "**/*.ts", "**/*.jsx", "**/*.js",
    "**/*.php", "**/*.twig", "**/*.vue", "**/*.svelte",
    "**/*.css", "**/*.scss", "**/*.sass", "**/*.less",
    "**/*.html", "**/*.htm", "**/*.py", "**/*.sql",
    "**/*.go", "**/*.rs",
    "**/package.json", "**/composer.json", "config/important.json"
  ],
  "agentLiveView.excludeFiles": [
    "**/version.json", "**/scratch*", "**/scratch*/**",
    "**/tmp/**", "**/temp/**", "**/traces/**",
    "**/*.log", "**/*.trace", "**/*.cache"
  ]
}
```

The allowlist is the first gate; **excluded patterns always take precedence**. For example, `**/*.php` allows PHP in any folder, but `**/scratch*/**` excludes scratch PHP files. Because `**/*.json` is *not* allowed, JSON files remain hidden except those individually included. Avoid adding a broad `**/*.json` exclusion if you intend to see individual JSON files, since excludes take precedence.

To change these lists without hand-editing JSON, use **Agent Live View: Manage Included Patterns** and **Agent Live View: Manage Excluded Patterns**. Both take effect immediately. They only affect live viewing, not actual files or Claude.

To revert to the old behaviour of watching everything except excludes, set `"agentLiveView.filterMode": "excludeOnly"`.

## Ignore noisy, generated and scratch files

Open VS Code **Settings (JSON)** for your project and set `agentLiveView.excludeFiles`.
This is a list of workspace-relative **glob patterns** for files *or* folders; it only affects which files Agent Live View opens. Claude continues writing files normally, and all files remain in Explorer and Git.

```json
{
  "agentLiveView.excludeFiles": [
    "**/version.json",
    "**/*.log",
    "**/*.log.*",
    "**/*.trace",
    "**/*.trace.*",
    "**/traces/**",
    "**/logs/**",
    "**/tmp/**",
    "**/temp/**",
    "**/scratch*",
    "**/scratch*/**",
    "**/test-fixtures/generated/**",
    "**/runtime-cache/**"
  ]
}
```

These patterns are **examples**; when you supply your own `excludeFiles` list, it *replaces* the default list, so include `**/version.json` if you still want to hide it. Default patterns also cover `*.tmp`, `*.temp`, `*.swp`, `*.bak`, `*.cache`, `*.pyc`, `*.tsbuildinfo`, and editor backup files. The separate `agentLiveView.excludeFolders` setting ignores exact folder names (such as `.cache`, `__pycache__`, `playwright-report`, and `test-results`) wherever they occur.

- `**/*.log`: all `.log` files anywhere, including the project root
- `**/traces/**`: all files inside any folder named `traces`
- `**/scratch*`: scratch files such as `scratch.txt`, `scratchpad.py`, or `scratch_test.js`
- `**/scratch*/**`: all files inside folders whose names start with `scratch`
- `**/temp/**`: files inside a `temp` folder
- `**/some-generated-file.json`: a single generated file anywhere

Patterns support `*`, `**` and `?`, with forward slash directory separators. Paths are relative to each open VS Code workspace root, and patterns without a slash (such as `*.log`) also match filenames in nested folders. Case matches the underlying operating system (Windows matching is case-insensitive).

**Quick edit:** `Ctrl+Shift+P` → **Agent Live View: Manage Excluded Patterns** → Add / Remove / Open Settings. Changes take effect immediately and also remove newly ignored files from the pending viewing queue. It doesn't automatically close tabs which were already displayed.

**Important:** `test` files, `tests` folders and `*.test.ts` source are **not** excluded by default. If you want to skip disposable experiments, add a targeted pattern such as `**/scratch_tests/**` instead of hiding your whole test suite.

## Important limitations

- **Experimental**: The VSIX has not been run inside an actual VS Code window in this build environment. It passed Node syntax checks and basic helper unit tests, but needs on-device testing with your Claude Code version.
- The first edit of a previously unseen, untracked source file may scroll to the bottom instead of the precise changed line. Later edits use a snapshot to find the difference.
- Without Claude hooks, a file watcher cannot know which application or agent made an edit. It will also show non-Claude source changes, and it cannot recognise new conversation rounds to close older tabs automatically.
- Opening an editor with `preserveFocus` still changes the displayed tab and may expand collapsed editor groups in some VS Code versions. The chat panel should remain in the right sidebar to avoid competing for editor groups.
- When an agent writes in a different git worktree outside the open VS Code workspace, open that worktree as another workspace folder for the file watcher to see it.
- The extension deliberately avoids closing pinned, manually opened and unsaved tabs. It doesn't restore editor-group layout automatically, to avoid destroying the user's chosen layout.
- Current version is intended for desktop VS Code with a local or directly accessible filesystem. Remote workspaces are not yet tested.

## VS Code Commands

- `Agent Live View: Toggle Watching`
- `Agent Live View: Set Viewing Pace`
- `Agent Live View: Manage Included Patterns`
- `Agent Live View: Manage Excluded Patterns`
- `Agent Live View: Install Claude Agent Tracking Hooks`
- `Agent Live View: Close Automatically Opened Tabs`
- `Agent Live View: Show Diagnostics`

## Development

Node 18+; no runtime dependencies beyond the VS Code API. Run `npm test` and `npm run check`. If you want a debug window, open this folder with VS Code and add a launch config with type `extensionHost`, request `launch`, and args `${workspaceFolder}`.

## Author notes

This is a self-contained prototype for X2 Network's requested workflow, not a published Marketplace extension. It does not use or bundle HariTrail.
