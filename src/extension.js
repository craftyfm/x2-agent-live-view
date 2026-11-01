'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const {
  lineDifference, normalizePath, safeFilePath, isInsideWorkspace, shellQuote, isAllowedByFilePatterns, pickAgentColumn,
  addHookEntries, removeHookEntries, ownHookCommands, findExecutable
} = require('./helpers');

// The hook script and event logs live outside the extension folder, because
// that folder is renamed on every update and deleted on uninstall.
const DATA_DIR = path.join(os.homedir(), '.agent-live-view');
const HOOK_SCRIPT = path.join(DATA_DIR, 'hook.js');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const MAX_SNAPSHOTS = 200;
const MAX_QUEUE = 25;
// A watcher event this soon after the user typed in the same file is treated as the user's own save.
const USER_SAVE_WINDOW_MS = 10000;

let output;
let statusBar;
let decoration;
let running = true;
const pending = new Map();
// Coalesce repeat writes to the same file rather than racing through every event.
const queuedChanges = new Map();
const lastShownAtByColumn = new Map();
const currentFileByColumn = new Map();
let displayTimer = null;
let draining = false;
const snapshots = new Map();
const recentTextRanges = new Map();
const ownedFiles = new Set();
const agentColumns = new Map();
const fileHints = new Map();
const activeTools = new Map();
const recentAgents = new Map();
const eventLogState = new Map();
const decorationTimers = new Map();
const userTypedAt = new Map();
let resetOnNextEdit = false;
let lastClaudeActivity = 0;
let lastFileChanged = '';
let lastFileError = '';

function setting(key) { return vscode.workspace.getConfiguration('agentLiveView').get(key); }
function log(message) { output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`); }
function workspaceFor(file) {
  return (vscode.workspace.workspaceFolders || []).find(f =>
    normalizePath(file) === normalizePath(f.uri.fsPath) || isInsideWorkspace(file, f.uri.fsPath));
}
function ignored(uri) {
  if (uri.scheme !== 'file') return true;
  const folder = workspaceFor(uri.fsPath);
  if (!folder) return true;
  const parts = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep);
  const exclusions = new Set(setting('excludeFolders') || []);
  const relative = path.relative(folder.uri.fsPath, uri.fsPath);
  return parts.some(p => exclusions.has(p) || p.startsWith('.agent-live-view')) ||
    !isAllowedByFilePatterns(relative, setting('filterMode'), setting('includeFiles'), setting('excludeFiles')) ||
    uri.fsPath.endsWith('.map') || uri.fsPath.endsWith('.min.js');
}
function isWatching() { return running && setting('enabled'); }
function updateStatus() {
  statusBar.text = `$(eye) Live View: ${isWatching() ? 'ON' : 'OFF'}`;
  statusBar.tooltip = !setting('enabled')
    ? 'Agent Live View is turned off in settings (agentLiveView.enabled).'
    : `Agent Live View: ${agentColumns.size} agent(s), last file ${lastFileChanged || 'none'}. Click to toggle.`;
}
function eventPath(folder) {
  const id = crypto.createHash('sha256').update(normalizePath(folder.uri.fsPath)).digest('hex').slice(0,24);
  return path.join(DATA_DIR, 'events', id + '.jsonl');
}
// True once a hook event file has been found for any workspace folder.
function hooksActive() {
  return [...eventLogState.values()].some(s => s.seen);
}
function isOpenAlready(uri) {
  return vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
    tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString()));
}
async function closeOwnedTabs() {
  const tabs = [];
  for (const group of vscode.window.tabGroups.all) for (const tab of group.tabs) {
    if (tab.input instanceof vscode.TabInputText && ownedFiles.has(tab.input.uri.toString()) && !tab.isDirty && !tab.isPinned) {
      tabs.push(tab);
    }
  }
  ownedFiles.clear();
  if (tabs.length) try { await vscode.window.tabGroups.close(tabs, true); } catch(e) { log('Could not close some old tabs: ' + e.message); }
}
async function beginNewRoundIfNecessary() {
  if (!resetOnNextEdit) return;
  resetOnNextEdit = false;
  await closeOwnedTabs();
  agentColumns.clear();
  lastShownAtByColumn.clear();
  currentFileByColumn.clear();
  // Don't collapse the user's editor groups: doing so would rearrange manual tabs.
  log('Editing round started, previous auto-opened tabs closed.');
}
function getAgentKey(file) {
  const now = Date.now();
  const hint = fileHints.get(normalizePath(file));
  if (hint && now - hint.at < 20000) return hint.key;
  const active = [...activeTools.values()].filter(v => now-v.at < 120000);
  const unique = [...new Set(active.map(v => v.key))];
  if (unique.length === 1) return unique[0];
  const recentlyActive = [...recentAgents.entries()].filter(([,v]) => now-v < 1800).map(([k]) => k);
  return recentlyActive.length === 1 ? recentlyActive[0] : 'unattributed';
}
// True for a tab showing an AI chat panel, such as the Claude Code chat opened in the editor area.
function isChatTab(tab) {
  if (!(tab.input instanceof vscode.TabInputWebview)) return false;
  return (setting('chatViewTypes') || []).some(type => type && tab.input.viewType.includes(type));
}
function editorGroups() {
  return vscode.window.tabGroups.all.map(g => ({ column: g.viewColumn, isChat: g.tabs.some(isChatTab) }));
}
// Agents get their own columns, never one holding a chat panel, and after the user's
// column when reserveFirstColumn is on. A column number past the last editor group makes
// VS Code add a group, so the user's existing layout is never rebuilt.
async function chooseColumn(key) {
  const groups = editorGroups();
  const chatColumns = new Set(groups.filter(g => g.isChat).map(g => g.column));
  const current = agentColumns.get(key);
  // The layout may have changed since this agent's column was chosen: the column may be
  // gone, or now hold the chat or the user's editor.
  const userColumn = setting('reserveFirstColumn') ? Math.min(...groups.filter(g => !g.isChat).map(g => g.column)) : 0;
  if (current && groups.some(g => g.column === current) && !chatColumns.has(current) && current !== userColumn) return current;
  let column = pickAgentColumn(groups, {
    reserveFirst: setting('reserveFirstColumn'),
    maxColumns: setting('maxColumns'),
    otherColumns: [...agentColumns].filter(([k]) => k !== key).map(([, c]) => c)
  });
  const last = groups.reduce((max, g) => Math.max(max, g.column), 0);
  if (column > last && chatColumns.size && setting('newColumnPosition') === 'besideChat') {
    column = (await addColumnBesideChat(groups)) || column;
  }
  agentColumns.delete(key);
  agentColumns.set(key, column);
  return column;
}
const FOCUS_GROUP_COMMANDS = ['First','Second','Third','Fourth','Fifth','Sixth','Seventh','Eighth']
  .map(n => `workbench.action.focus${n}EditorGroup`);
// Add an editor group next to the chat, on the side facing the user's editor, and
// return its column. VS Code can only add a group beside the active group, and doing
// so moves keyboard focus, so focus is put back on the group that had it.
async function addColumnBesideChat(groups) {
  const chat = groups.find(g => g.isChat).column;
  const editor = groups.find(g => !g.isChat);
  const left = !editor || editor.column < chat;
  const previous = vscode.window.tabGroups.activeTabGroup.viewColumn;
  try {
    // The group on the editor side of the chat can add the column too, without touching the chat.
    const neighbour = left ? chat - 1 : chat + 1;
    if (previous === neighbour) {
      await vscode.commands.executeCommand(left ? 'workbench.action.newGroupRight' : 'workbench.action.newGroupLeft');
    } else {
      if (previous !== chat) {
        if (chat > FOCUS_GROUP_COMMANDS.length) return 0;
        await vscode.commands.executeCommand(FOCUS_GROUP_COMMANDS[chat - 1]);
      }
      await vscode.commands.executeCommand(left ? 'workbench.action.newGroupLeft' : 'workbench.action.newGroupRight');
    }
    const added = left ? chat : chat + 1;
    // Groups at or after the new column moved one place to the right.
    const shift = c => c >= added ? c + 1 : c;
    for (const [k, c] of agentColumns) agentColumns.set(k, shift(c));
    for (const map of [lastShownAtByColumn, currentFileByColumn]) {
      const entries = [...map].map(([c, v]) => [shift(c), v]);
      map.clear();
      for (const [c, v] of entries) map.set(c, v);
    }
    const restore = shift(previous);
    if (vscode.window.tabGroups.activeTabGroup.viewColumn !== restore && restore <= FOCUS_GROUP_COMMANDS.length) {
      await vscode.commands.executeCommand(FOCUS_GROUP_COMMANDS[restore - 1]);
    }
    log(`Added column ${added} beside the chat.`);
    return added;
  } catch (e) {
    log('Could not add a column beside the chat: ' + e.message);
    return 0;
  }
}
// VS Code adds at most one group for a column past the last one, so the column an
// editor actually opened in can differ from the one asked for.
function recordActualColumn(key, column) {
  if (agentColumns.get(key) === column) return;
  for (const [other, c] of agentColumns) if (other !== key && c === column) agentColumns.delete(other);
  agentColumns.set(key, column);
}
function gitRange(folder, file) {
  // Git can run commands from a repository's own config (e.g. core.fsmonitor),
  // so it is never run in an untrusted workspace.
  if (!vscode.workspace.isTrusted) return Promise.resolve(null);
  const relative = path.relative(folder.uri.fsPath, file);
  return new Promise(resolve => {
    execFile('git', ['-C',folder.uri.fsPath,'diff','--no-ext-diff','--unified=0','--',relative],
      { timeout: 1200, maxBuffer: 256*1024 }, (err,stdout) => {
        if (err || !stdout) return resolve(null);
        const matches = [...stdout.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)];
        if (!matches.length) return resolve(null);
        const m = matches[matches.length-1];
        const start = Math.max(0, Number(m[1])-1);
        resolve({ start, end: start + Math.max(0, Number(m[2] || 1)-1) });
      });
  });
}
function captureRange(documentEvent) {
  if (!documentEvent.contentChanges.length || ignored(documentEvent.document.uri)) return;
  const ranges = documentEvent.contentChanges.map(c => ({
    start: c.range.start.line,
    end: c.range.start.line + (c.text.match(/\n/g) || []).length
  }));
  const start = Math.min(...ranges.map(r=>r.start));
  const end = Math.max(...ranges.map(r=>r.end));
  recentTextRanges.set(normalizePath(documentEvent.document.uri.fsPath), {start,end,at:Date.now()});
  // In-memory edits made by the Claude extension need to be followed too.
  // The user's own typing is filtered out when the debounce timer fires (see userRecentlyTyped).
  schedule(documentEvent.document.uri, 'text');
}
// Keyboard selection changes mark a file as being worked on by the user. Document
// change events can't be used for this: VS Code fires them before the editor is
// marked dirty, and the keyboard selection event follows within milliseconds.
function noteUserSelection(event) {
  if (event.kind !== vscode.TextEditorSelectionChangeKind.Keyboard) return;
  if (event.textEditor.document.uri.scheme !== 'file') return;
  userTypedAt.set(normalizePath(event.textEditor.document.uri.fsPath), Date.now());
}
// Changes to, and saves of (including auto-save), a file the user is typing in are
// not agent activity, unless a Claude Code hook reported a tool call just now.
function userRecentlyTyped(key) {
  const typed = userTypedAt.get(key);
  return Boolean(typed) && Date.now()-typed < USER_SAVE_WINDOW_MS && Date.now()-lastClaudeActivity > 3000;
}
function schedule(uri, from) {
  if (!isWatching() || ignored(uri)) return;
  const key = normalizePath(uri.fsPath);
  if (pending.has(key)) clearTimeout(pending.get(key));
  const ms = setting('debounceMs') + (hooksActive() ? 140 : 0);
  pending.set(key, setTimeout(() => {
    pending.delete(key);
    if (userRecentlyTyped(key)) return;
    // Bulk changes such as a branch checkout would otherwise queue minutes of tab switching.
    if (!queuedChanges.has(key) && queuedChanges.size >= MAX_QUEUE) {
      const oldest = queuedChanges.keys().next().value;
      queuedChanges.delete(oldest);
      log(`Display queue full (${MAX_QUEUE} files); skipped ${oldest}.`);
    }
    // A second write updates the existing queue item without pushing this file
    // to the end of the queue, so a build's rapid writes cannot monopolise focus.
    queuedChanges.set(key, {uri,from,agentKey:getAgentKey(uri.fsPath)});
    requestDrain();
  }, ms));
}
function requestDrain(delay = 0) {
  if (draining || !isWatching()) return;
  if (displayTimer) clearTimeout(displayTimer);
  displayTimer = setTimeout(() => {
    displayTimer = null;
    drainQueue().catch(e => log('Display queue error: ' + e.message));
  }, delay);
}
async function drainQueue() {
  if (draining || !isWatching()) return;
  draining = true;
  let nextDelay = 0;
  try {
    if (!queuedChanges.size) return;
    // A new prompt starts a new round; close only automatically opened tabs.
    await beginNewRoundIfNecessary();
    let soonestWait = Infinity;
    let processed = false;
    for (const [file, item] of queuedChanges) {
      if (ignored(item.uri)) { queuedChanges.delete(file); continue; }
      const column = await chooseColumn(item.agentKey);
      const isSameFile = currentFileByColumn.get(column) === file;
      const wait = (lastShownAtByColumn.get(column) || 0) + setting('minViewMs') - Date.now();
      if (!isSameFile && wait > 0) { soonestWait = Math.min(soonestWait, wait); continue; }
      queuedChanges.delete(file);
      const openedIn = await openChangedFile(item.uri, item.from, column, item.agentKey);
      if (openedIn) {
        recordActualColumn(item.agentKey, openedIn);
        if (!isSameFile || openedIn !== column) lastShownAtByColumn.set(openedIn, Date.now());
        currentFileByColumn.set(openedIn, file);
      }
      processed = true;
      break;
    }
    if (!processed && soonestWait !== Infinity) nextDelay = Math.max(10, Math.ceil(soonestWait));
  } finally {
    draining = false;
    if (queuedChanges.size) requestDrain(nextDelay);
  }
}
async function openChangedFile(uri, from, column, key) {
  if (!running || ignored(uri)) return 0;
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.File || stat.size > setting('maxFileSizeKb')*1024) return 0;
    // File changes not confidently attributable still appear in a shared column.
    const folder = workspaceFor(uri.fsPath);
    if (key === 'unattributed' && setting('ignoreUnattributedWhenHooksActive') && hooksActive()) return 0;
    const wasOpen = isOpenAlready(uri);
    const doc = await vscode.workspace.openTextDocument(uri);
    const normalized = normalizePath(uri.fsPath);
    const text = doc.getText();
    const prev = snapshots.get(normalized);
    const live = recentTextRanges.get(normalized);
    let range = (live && Date.now()-live.at < 2500) ? live : lineDifference(prev, text);
    if (!range && folder) range = await gitRange(folder, uri.fsPath);
    if (!range) range = { start: Math.max(0,doc.lineCount-1), end: Math.max(0,doc.lineCount-1) };
    range.start = Math.max(0, Math.min(range.start, doc.lineCount-1));
    range.end = Math.max(range.start, Math.min(range.end, doc.lineCount-1));
    // Never move the cursor or scroll position of the editor the user is working in.
    const active = vscode.window.activeTextEditor;
    const userIsHere = active && active.document.uri.toString() === uri.toString() && active.viewColumn === column;
    const options = { viewColumn: column, preview: false, preserveFocus: true };
    if (!userIsHere) options.selection = new vscode.Range(range.start,0,range.start,0);
    const editor = await vscode.window.showTextDocument(doc, options);
    if (!userIsHere) editor.revealRange(new vscode.Range(range.start, 0, range.end, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    if (!wasOpen) ownedFiles.add(uri.toString());
    // Keep only the most recently shown files' text, oldest dropped first.
    snapshots.delete(normalized);
    snapshots.set(normalized, text);
    if (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value);
    highlight(editor, range);
    lastFileChanged = path.relative(folder.uri.fsPath, uri.fsPath);
    updateStatus();
    log(`Opened ${lastFileChanged} in column ${editor.viewColumn} (${key}, source: ${from}).`);
    return editor.viewColumn || column;
  } catch(e) { lastFileError = `${uri.fsPath}: ${e.message}`; log('Skipped ' + lastFileError); return 0; }
}
function highlight(editor, range) {
  const ms = setting('highlightDurationMs');
  if (ms <= 0) return;
  const key = editor.document.uri.toString();
  const old = decorationTimers.get(key);
  if (old) clearTimeout(old);
  editor.setDecorations(decoration, [new vscode.Range(range.start,0,range.end,editor.document.lineAt(range.end).text.length)]);
  decorationTimers.set(key, setTimeout(() => {
    editor.setDecorations(decoration, []);
    decorationTimers.delete(key);
  }, ms));
}
function ingestHookEvent(ev) {
  if (!ev || typeof ev !== 'object' || !ev.event) return;
  const now = Number(ev.at) || Date.now();
  const key = (ev.session || 'unknown-session') + '/' + (ev.agent || 'main');
  if (ev.event === 'UserPromptSubmit' && !ev.agent) {
    resetOnNextEdit = true;
    // Discard delayed file events from the previous prompt, otherwise they can
    // reopen files that belong to the previous editing round.
    for (const t of pending.values()) clearTimeout(t);
    pending.clear();
    queuedChanges.clear();
    fileHints.clear();
    activeTools.clear();
    recentAgents.clear();
  }
  if (ev.event === 'PreToolUse' || ev.event === 'PostToolUse') {
    lastClaudeActivity = Date.now();
    recentAgents.set(key, now);
    if (ev.file && ev.cwd) {
      const p = safeFilePath(ev.file, ev.cwd);
      if (p) fileHints.set(normalizePath(p), { key, at: now });
    }
    const toolId = ev.toolId || (key + '/' + ev.tool);
    if (ev.event === 'PreToolUse') activeTools.set(toolId, {key,at:now});
    else activeTools.delete(toolId);
  }
  if (ev.event === 'SubagentStop' || ev.event === 'Stop') {
    for (const [k,v] of activeTools) if (v.key === key) activeTools.delete(k);
  }
}
async function pollHookEvents() {
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const file = eventPath(folder);
    let state = eventLogState.get(file);
    if (!state) { state = { offset: 0, remainder: '', seen: false }; eventLogState.set(file,state); }
    try {
      const stat = await fs.promises.stat(file);
      state.seen = true;
      if (stat.size < state.offset) { state.offset = 0; state.remainder = ''; }
      if (stat.size === state.offset) continue;
      const toRead = Math.min(stat.size-state.offset, 512*1024);
      const fd = await fs.promises.open(file,'r');
      const buf = Buffer.alloc(toRead);
      let result;
      try { result = await fd.read(buf,0,toRead,state.offset); } finally { await fd.close(); }
      state.offset += result.bytesRead;
      const items = (state.remainder + buf.subarray(0,result.bytesRead).toString('utf8')).split('\n');
      state.remainder = items.pop();
      for (const line of items) try { ingestHookEvent(JSON.parse(line)); } catch (_) {}
    } catch(e) { if (e.code !== 'ENOENT') log('Hook bridge error: '+e.message); }
  }
}
// Copy the hook script to a fixed location so installed hooks keep working after updates.
function ensureHookScript() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const source = fs.readFileSync(path.join(__dirname, 'hook.js'));
  let current = null;
  try { current = fs.readFileSync(HOOK_SCRIPT); } catch (_) {}
  if (!current || !current.equals(source)) fs.writeFileSync(HOOK_SCRIPT, source, { mode: 0o600 });
}
function hookCommand(folder) {
  return shellQuote(findExecutable('node') || 'node') + ' ' + shellQuote(HOOK_SCRIPT) + ' ' + shellQuote(eventPath(folder));
}
function claudeSettingsPath(folder) {
  return path.join(folder.uri.fsPath, '.claude', 'settings.local.json');
}
async function readClaudeSettings(config) {
  let settings = {};
  try { settings = JSON.parse(await fs.promises.readFile(config, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error(`Cannot read ${config}: ${e.message}`); }
  if (!settings || Array.isArray(settings) || typeof settings !== 'object') throw new Error(`${config} is not a JSON object.`);
  return settings;
}
// Projects with hooks installed are recorded so the uninstall script can remove them.
async function recordProject(config, installed) {
  let projects = [];
  try { projects = JSON.parse(await fs.promises.readFile(PROJECTS_FILE, 'utf8')); } catch (_) {}
  if (!Array.isArray(projects)) projects = [];
  projects = projects.filter(p => p !== config);
  if (installed) projects.push(config);
  await fs.promises.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(PROJECTS_FILE, JSON.stringify(projects, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
}
async function pickFolder(placeHolder) {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) { vscode.window.showWarningMessage('Open a workspace folder first.'); return null; }
  if (folders.length === 1) return folders[0];
  const picked = await vscode.window.showQuickPick(folders.map(f => ({label:f.name, folder:f})), {placeHolder});
  return picked?.folder || null;
}
async function installHooks() {
  if (!vscode.workspace.isTrusted) return vscode.window.showWarningMessage('Trust this workspace before installing Claude Code hooks.');
  const selected = await pickFolder('Choose Claude Code project');
  if (!selected) return;
  const config = claudeSettingsPath(selected);
  try {
    const settings = await readClaudeSettings(config);
    ensureHookScript();
    addHookEntries(settings, hookCommand(selected));
    await fs.promises.mkdir(path.dirname(config),{recursive:true});
    // Keep the first backup: later installs would otherwise overwrite the user's original settings.
    const backup = config + '.agent-live-view.bak';
    if (fs.existsSync(config) && !fs.existsSync(backup)) await fs.promises.copyFile(config, backup);
    await fs.promises.writeFile(config, JSON.stringify(settings,null,2)+'\n', 'utf8');
    await recordProject(config, true);
    log('Installed hooks in '+config);
    vscode.window.showInformationMessage('Agent Live View hooks installed for this project. Restart the Claude Code conversation/session to load them.');
  } catch(e) { vscode.window.showErrorMessage('Hook installation failed: '+e.message); }
}
async function removeHooks() {
  const selected = await pickFolder('Choose the project to remove hooks from');
  if (!selected) return;
  const config = claudeSettingsPath(selected);
  try {
    const settings = await readClaudeSettings(config);
    if (!removeHookEntries(settings)) return vscode.window.showInformationMessage('No Agent Live View hooks are installed in this project.');
    await fs.promises.writeFile(config, JSON.stringify(settings,null,2)+'\n', 'utf8');
    await recordProject(config, false);
    log('Removed hooks from '+config);
    vscode.window.showInformationMessage('Agent Live View hooks removed. Restart the Claude Code conversation/session to apply.');
  } catch(e) { vscode.window.showErrorMessage('Hook removal failed: '+e.message); }
}
// Hooks installed by an older version point at a script or event file that no longer
// exists. Rewrite them to the current locations so Claude Code doesn't report hook errors.
async function repairHooks() {
  if (!vscode.workspace.isTrusted) return;
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const config = claudeSettingsPath(folder);
    try {
      const settings = await readClaudeSettings(config);
      const commands = ownHookCommands(settings);
      if (!commands.length || commands.every(c => c.includes(HOOK_SCRIPT) && c.includes(eventPath(folder)))) continue;
      addHookEntries(settings, hookCommand(folder));
      await fs.promises.writeFile(config, JSON.stringify(settings,null,2)+'\n', 'utf8');
      await recordProject(config, true);
      log('Updated outdated hook paths in '+config);
    } catch(e) { log('Could not check hooks in '+config+': '+e.message); }
  }
}
// Edit the same glob list that is available in Settings (JSON). No extra config file
// or restart is needed. Workspace-level overrides keep per-project ignores separate.
async function manageExclusions() {
  const selection = await vscode.window.showQuickPick([
    { label: '$(add) Add an excluded pattern', action: 'add', description: 'e.g. **/*.log, **/traces/**, **/scratch*' },
    { label: '$(remove) Remove an excluded pattern', action: 'remove', description: 'Allow a previously ignored pattern again' },
    { label: '$(settings-gear) Open extension settings', action: 'settings', description: 'Edit agentLiveView.excludeFiles in Settings (JSON) or the Settings UI' }
  ], { placeHolder: 'Which file patterns should Agent Live View ignore?' });
  if (!selection) return;
  if (selection.action === 'settings') {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'agentLiveView.excludeFiles');
    return;
  }
  const config = vscode.workspace.getConfiguration('agentLiveView');
  const current = config.get('excludeFiles', []);
  let updated;
  if (selection.action === 'add') {
    const value = await vscode.window.showInputBox({
      prompt: 'Workspace-relative glob pattern (forward slashes, supports *, ** and ?)',
      placeHolder: '**/*.log or **/scratch*/**',
      validateInput(value) {
        if (!value.trim()) return 'Enter a glob pattern';
        if (/[\r\n\x00]/.test(value)) return 'Pattern must be on one line';
        return null;
      }
    });
    if (value === undefined) return;
    const pattern = value.trim();
    if (current.includes(pattern)) {
      vscode.window.showInformationMessage(`Already excluded: ${pattern}`);
      return;
    }
    updated = [...current, pattern];
  } else {
    if (!current.length) return vscode.window.showInformationMessage('No excluded file patterns configured.');
    const selected = await vscode.window.showQuickPick(current, {
      placeHolder: 'Select a pattern to allow again'
    });
    if (selected === undefined) return;
    updated = current.filter(pattern => pattern !== selected);
  }
  try {
    await config.update('excludeFiles', updated, vscode.ConfigurationTarget.Workspace);
    log(`Updated excluded patterns for this workspace: ${JSON.stringify(updated)}`);
    vscode.window.showInformationMessage('Agent Live View exclusions updated. No restart needed.');
  } catch (e) {
    vscode.window.showErrorMessage('Could not update exclusion patterns: ' + e.message);
  }
}

// Per-workspace allowlist editor. JSON isn't watched by default; use this
// command to add specific configuration files without allowing all JSON.
async function manageIncludes() {
  const selection = await vscode.window.showQuickPick([
    { label: '$(add) Add an included pattern', action: 'add', description: 'e.g. **/package.json, config/settings.json, **/*.twig' },
    { label: '$(remove) Remove an included pattern', action: 'remove', description: 'Stop showing matching files (unless another include matches)' },
    { label: '$(settings-gear) Open extension settings', action: 'settings', description: 'Edit agentLiveView.includeFiles in Settings UI' }
  ], { placeHolder: 'Which source files should Agent Live View show?' });
  if (!selection) return;
  if (selection.action === 'settings') {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'agentLiveView.includeFiles');
    return;
  }
  const config = vscode.workspace.getConfiguration('agentLiveView');
  const current = config.get('includeFiles', []);
  let updated;
  if (selection.action === 'add') {
    const value = await vscode.window.showInputBox({
      prompt: 'Glob pattern relative to workspace root (use / between folders)',
      placeHolder: '**/package.json or config/important.json',
      validateInput(value) {
        if (!value.trim()) return 'Enter a pattern';
        if (/[\r\n\x00]/.test(value)) return 'Pattern must be on one line';
        return null;
      }
    });
    if (value === undefined) return;
    const pattern = value.trim();
    if (current.includes(pattern)) {
      vscode.window.showInformationMessage(`Already included: ${pattern}`);
      return;
    }
    updated = [...current, pattern];
  } else {
    if (!current.length) return vscode.window.showInformationMessage('No included patterns configured.');
    const selected = await vscode.window.showQuickPick(current, {placeHolder:'Select an included pattern to remove'});
    if (selected === undefined) return;
    updated = current.filter(pattern => pattern !== selected);
  }
  try {
    await config.update('includeFiles', updated, vscode.ConfigurationTarget.Workspace);
    log(`Updated allowlist for this workspace: ${JSON.stringify(updated)}`);
    vscode.window.showInformationMessage('Agent Live View included patterns updated. No restart needed.');
  } catch (e) { vscode.window.showErrorMessage('Could not update included patterns: ' + e.message); }
}

function diagnostics() {
  log(`Watching: ${isWatching()}; editor groups: ${vscode.window.tabGroups.all.length}; first column reserved for you: ${setting('reserveFirstColumn')}`);
  log(`Hook script: ${HOOK_SCRIPT} (${fs.existsSync(HOOK_SCRIPT) ? 'found' : 'not installed'}); hook events received: ${hooksActive()}`);
  log(`Minimum viewing time: ${setting('minViewMs')}ms; queued files: ${queuedChanges.size}; filter mode: ${setting('filterMode')}`);
  log(`Include patterns: ${JSON.stringify(setting('includeFiles'))}; exclude patterns: ${JSON.stringify(setting('excludeFiles'))}`);
  log(`Open tabs owned: ${ownedFiles.size}; agent keys: ${[...agentColumns.keys()].join(', ') || 'none'}`);
  log(`Last file: ${lastFileChanged || 'none'}; last failure: ${lastFileError || 'none'}`);
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const p = eventPath(folder);
    log(`Hook event stream for ${folder.name}: ${p} (${fs.existsSync(p) ? 'found' : 'not created yet'})`);
  }
  output.show(true);
}
function activate(context) {
  output = vscode.window.createOutputChannel('Agent Live View');
  decoration = vscode.window.createTextEditorDecorationType({
    backgroundColor:'rgba(60,179,113,0.22)',isWholeLine:true,
    overviewRulerColor:'rgba(60,179,113,0.8)',overviewRulerLane:vscode.OverviewRulerLane.Right
  });
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 30);
  statusBar.command = 'agentLiveView.toggle';
  updateStatus(); statusBar.show();
  context.subscriptions.push(output,decoration,statusBar);
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  watcher.onDidChange(uri => schedule(uri,'file watcher'),null,context.subscriptions);
  watcher.onDidCreate(uri => schedule(uri,'new file'),null,context.subscriptions);
  context.subscriptions.push(watcher);
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(captureRange));
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(noteUserSelection));
  // Apply changed glob settings immediately, including to already queued edits.
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('agentLiveView.enabled')) updateStatus();
    if (event.affectsConfiguration('agentLiveView.reserveFirstColumn') || event.affectsConfiguration('agentLiveView.maxColumns') ||
        event.affectsConfiguration('agentLiveView.chatViewTypes') || event.affectsConfiguration('agentLiveView.newColumnPosition')) {
      agentColumns.clear();
      lastShownAtByColumn.clear();
      currentFileByColumn.clear();
    }
    if (!event.affectsConfiguration('agentLiveView.excludeFiles') &&
        !event.affectsConfiguration('agentLiveView.excludeFolders') &&
        !event.affectsConfiguration('agentLiveView.includeFiles') &&
        !event.affectsConfiguration('agentLiveView.filterMode')) return;
    for (const [file, timer] of pending) {
      const uri = vscode.Uri.file(file);
      if (ignored(uri)) { clearTimeout(timer); pending.delete(file); }
    }
    for (const [file, item] of queuedChanges) {
      if (ignored(item.uri)) queuedChanges.delete(file);
    }
    log('Updated allowlist/exclusion rules; removed hidden files from the display queue.');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('agentLiveView.toggle',() => {
    running = !running;
    if (!running) {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear(); queuedChanges.clear();
      if (displayTimer) clearTimeout(displayTimer);
      displayTimer = null;
    }
    updateStatus();
    vscode.window.showInformationMessage(`Agent Live View ${running ? 'enabled' : 'paused'}.`);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('agentLiveView.manageExclusions',manageExclusions));
  context.subscriptions.push(vscode.commands.registerCommand('agentLiveView.manageIncludes',manageIncludes));
  context.subscriptions.push(vscode.commands.registerCommand('agentLiveView.installHooks',installHooks));
  context.subscriptions.push(vscode.commands.registerCommand('agentLiveView.removeHooks',removeHooks));
  context.subscriptions.push(vscode.commands.registerCommand('agentLiveView.clear',closeOwnedTabs));
  context.subscriptions.push(vscode.commands.registerCommand('agentLiveView.viewingPace', async () => {
    const choices = [
      {label:'2 seconds',description:'Fast',ms:2000},
      {label:'4 seconds',description:'Balanced (recommended)',ms:4000},
      {label:'6 seconds',description:'More time to read',ms:6000},
      {label:'10 seconds',description:'Slow and deliberate',ms:10000},
      {label:'No minimum',description:'Switch as soon as files change',ms:0}
    ];
    const selected = await vscode.window.showQuickPick(choices, {placeHolder:'Minimum time a file stays in front before switching to another file'});
    if (!selected) return;
    await vscode.workspace.getConfiguration('agentLiveView').update('minViewMs', selected.ms, vscode.ConfigurationTarget.Workspace);
    log(`Minimum viewing time changed to ${selected.ms}ms.`);
    requestDrain();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('agentLiveView.diagnostics',diagnostics));
  const interval = setInterval(() => pollHookEvents().catch(e=>log(e.message)),180);
  context.subscriptions.push({dispose:()=>clearInterval(interval)});
  try { ensureHookScript(); } catch(e) { log('Could not update hook script: '+e.message); }
  repairHooks().catch(e => log('Hook check failed: '+e.message));
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => repairHooks().catch(e => log('Hook check failed: '+e.message))));
  log('Watching allowed source files. Use Manage Included Patterns to opt specific JSON files into the live view.');
}
function deactivate() {
  for (const t of pending.values()) clearTimeout(t);
  if (displayTimer) clearTimeout(displayTimer);
  for (const t of decorationTimers.values()) clearTimeout(t);
}
module.exports = {activate,deactivate};
