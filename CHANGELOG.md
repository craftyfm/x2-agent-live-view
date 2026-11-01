# Changelog

## 0.6.0

- Agent files no longer open in the column holding the Claude Code chat when the chat is opened in the editor area. The chat can be on either side; agent files get a column of their own. If the chat is moved later, agents move out of its column.
- New setting `agentLiveView.chatViewTypes` lists the panels whose columns are left alone.

## 0.5.0

First Marketplace release (preview).

- Agent files open in their own columns to the right of your editor. The first column is kept for your own work (`agentLiveView.reserveFirstColumn`), and the editor layout is no longer rebuilt.
- Saving a file you have been typing in no longer opens it or moves your cursor. The cursor and scroll position of the editor you are working in are never changed.
- Claude Code hooks now use a script copied to `~/.agent-live-view/`, so they keep working after extension updates. Hooks installed by earlier versions are updated automatically when the project is opened.
- New command: **Remove Claude Agent Tracking Hooks**. Uninstalling the extension removes the hooks from every project where they were installed.
- Hook events are stored in `~/.agent-live-view/events/` (readable only by your user account) instead of the shared temporary folder.
- `agentLiveView.ignoreUnattributedWhenHooksActive` no longer hides every change when hooks are not installed.
- Glob patterns support `{a,b}`.
- In untrusted workspaces, git is not run and the workspace's own pattern settings are ignored.
- The status bar shows OFF when `agentLiveView.enabled` is false.
- At most 25 files wait to be shown, and the text of at most 200 files is kept for locating changes.
- The original settings backup is no longer overwritten when hooks are installed again.

## 0.4.0

- Include-only filter mode (`agentLiveView.filterMode`) with a source-file allowlist.
- **Manage Included Patterns** command.

## 0.1.0 – 0.3.0

- Prototype releases: file watching, viewing pace, edited-line highlights, exclusion patterns and Claude Code hooks.
