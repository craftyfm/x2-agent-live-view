'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { lineDifference, normalizePath, safeFilePath, isInsideWorkspace, shellQuote, isAllowedByFilePatterns } = require('./helpers');

let output;
let statusBar;
let decoration;
let running = true;
let previousLayout = null;
const disposables = [];
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
let resetOnNextEdit = false;
let lastClaudeActivity = 0;
let layoutColumns = 1;
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
function updateStatus() {
  statusBar.text = `$(eye) Live View: ${running ? 'ON' : 'OFF'}`;
  statusBar.tooltip = `Agent Live View: ${agentColumns.size} agent(s), last file ${lastFileChanged || 'none'}. Click to toggle.`;
}
function eventPath(folder) {
  const id = crypto.createHash('sha256').update(normalizePath(folder.uri.fsPath)).digest('hex').slice(0,24);
  return path.join(os.tmpdir(), 'agent-live-view', id + '.jsonl');
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
  layoutColumns = 1;
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
async function chooseColumn(key) {
  if (agentColumns.has(key)) return agentColumns.get(key);
  const max = setting('maxColumns');
  const num = Math.min(agentColumns.size + 1, max);
  agentColumns.set(key, num);
  if (num > layoutColumns && num > 1) {
    try {
      if (!previousLayout) previousLayout = await vscode.commands.executeCommand('vscode.getEditorLayout');
      await vscode.commands.executeCommand('vscode.setEditorLayout', {
        orientation: 0,
        groups: Array.from({ length: num }, () => ({}))
      });
      layoutColumns = num;
      log(`Editor layout expanded to ${num} columns.`);
    } catch(e) { log('Could not change editor layout: ' + e.message); }
  }
  return num;
}
function gitRange(folder, file) {
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
  // Skip active editor's dirty changes when no recent Claude tool activity, to avoid following user's typing.
  const active = vscode.window.activeTextEditor;
  const userEditing = active && active.document.uri.toString() === documentEvent.document.uri.toString()
    && documentEvent.document.isDirty && Date.now()-lastClaudeActivity > 3000;
  if (!userEditing) schedule(documentEvent.document.uri, 'text');
}
function schedule(uri, from) {
  if (!running || !setting('enabled') || ignored(uri)) return;
  const key = normalizePath(uri.fsPath);
  if (pending.has(key)) clearTimeout(pending.get(key));
  const ms = setting('debounceMs') + (eventLogState.size ? 140 : 0);
  pending.set(key, setTimeout(() => {
    pending.delete(key);
    // A second write updates the existing queue item without pushing this file
    // to the end of the queue, so a build's rapid writes cannot monopolise focus.
    queuedChanges.set(key, {uri,from,agentKey:getAgentKey(uri.fsPath)});
    requestDrain();
  }, ms));
}
function requestDrain(delay = 0) {
  if (draining || !running || !setting('enabled')) return;
  if (displayTimer) clearTimeout(displayTimer);
  displayTimer = setTimeout(() => {
    displayTimer = null;
    drainQueue().catch(e => log('Display queue error: ' + e.message));
  }, delay);
}
async function drainQueue() {
  if (draining || !running || !setting('enabled')) return;
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
      const opened = await openChangedFile(item.uri, item.from, column, item.agentKey);
      if (opened) {
        if (!isSameFile) lastShownAtByColumn.set(column, Date.now());
        currentFileByColumn.set(column, file);
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
  if (!running || ignored(uri)) return false;
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.File || stat.size > setting('maxFileSizeKb')*1024) return false;
    // File changes not confidently attributable still appear in a shared column.
    const folder = workspaceFor(uri.fsPath);
    if (key === 'unattributed' && setting('ignoreUnattributedWhenHooksActive') && eventLogState.size) return false;
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
    const sel = new vscode.Range(range.start,0,range.start,0);
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: column, preview: false, preserveFocus: true, selection: sel
    });
    editor.revealRange(new vscode.Range(range.start, 0, range.end, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    if (!wasOpen) ownedFiles.add(uri.toString());
    snapshots.set(normalized, text);
    highlight(editor, range);
    lastFileChanged = path.relative(folder.uri.fsPath, uri.fsPath);
    updateStatus();
    log(`Opened ${lastFileChanged} in column ${column} (${key}, source: ${from}).`);
    return true;
  } catch(e) { lastFileError = `${uri.fsPath}: ${e.message}`; log('Skipped ' + lastFileError); return false; }
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
    if (!state) { state = { offset: 0, remainder: '' }; eventLogState.set(file,state); }
    try {
      const stat = await fs.promises.stat(file);
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
async function installHooks() {
  if (!vscode.workspace.isTrusted) return vscode.window.showWarningMessage('Trust this workspace before installing Claude Code hooks.');
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) return vscode.window.showWarningMessage('Open a workspace folder first.');
  const selected = folders.length === 1 ? folders[0] : await vscode.window.showQuickPick(folders.map(f => ({label:f.name, folder:f})), {placeHolder:'Choose Claude Code project'}).then(x=>x?.folder);
  if (!selected) return;
  const config = path.join(selected.uri.fsPath,'.claude','settings.local.json');
  let settings = {};
  try { settings = JSON.parse(await fs.promises.readFile(config,'utf8')); }
  catch(e) { if (e.code !== 'ENOENT') return vscode.window.showErrorMessage(`Cannot read ${config}: ${e.message}`); }
  if (!settings || Array.isArray(settings) || typeof settings !== 'object') return vscode.window.showErrorMessage('Existing Claude settings are not a JSON object.');
  const command = 'node ' + shellQuote(path.join(__dirname,'hook.js')) + ' ' + shellQuote(eventPath(selected));
  const events = ['UserPromptSubmit','PreToolUse','PostToolUse','SubagentStart','SubagentStop','Stop'];
  if (!settings.hooks) settings.hooks = {};
  for (const event of events) {
    const group = { hooks: [{ type: 'command', command, timeout: 5 }] };
    if (event === 'PreToolUse' || event === 'PostToolUse') group.matcher = '.*';
    const current = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    settings.hooks[event] = current.filter(g =>
      !Array.isArray(g.hooks) || !g.hooks.some(h => typeof h.command === 'string' && h.command.includes('agent-live-view') && h.command.includes('hook.js')));
    settings.hooks[event].push(group);
  }
  try {
    await fs.promises.mkdir(path.dirname(config),{recursive:true});
    if (fs.existsSync(config)) await fs.promises.copyFile(config, config + '.agent-live-view.bak');
    await fs.promises.writeFile(config, JSON.stringify(settings,null,2)+'\n', 'utf8');
    log('Installed hooks in '+config);
    vscode.window.showInformationMessage('Agent Live View hooks installed for this project. Restart the Claude Code conversation/session to load them.');
  } catch(e) { vscode.window.showErrorMessage('Hook installation failed: '+e.message); }
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
  log(`Watching: ${running && setting('enabled')}; editor columns: ${layoutColumns}`);
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
  // Apply changed glob settings immediately, including to already queued edits.
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
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
  log('Watching allowed source files. Use Manage Included Patterns to opt specific JSON files into the live view.');
}
function deactivate() {
  for (const t of pending.values()) clearTimeout(t);
  if (displayTimer) clearTimeout(displayTimer);
  for (const t of decorationTimers.values()) clearTimeout(t);
}
module.exports = {activate,deactivate};
