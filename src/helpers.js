'use strict';
const fs = require('fs');
const path = require('path');

function lineDifference(before, after) {
  if (typeof before !== 'string' || typeof after !== 'string' || before === after) return null;
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1, endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  return { start: Math.min(start, Math.max(0,b.length-1)), end: Math.min(Math.max(start,endB), Math.max(0,b.length-1)) };
}

function normalizePath(p) {
  return process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
}

function safeFilePath(value, cwd) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (value.includes('\0')) return null;
  return path.resolve(path.isAbsolute(value) ? value : path.join(cwd || process.cwd(), value));
}

function isInsideWorkspace(file, root) {
  const rel = path.relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function shellQuote(s) {
  // Wrap a local filesystem path for the command hook on Windows/macOS/Linux.
  // This rejects double quotes because Claude's shell command quoting is platform-specific.
  if (s.includes('"')) throw new Error('Cannot create hook command for a path containing double quotes');
  return '"' + s + '"';
}


// Compiled patterns are cached because matching runs on every text change.
const globCache = new Map();
const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';

function globToRegExp(raw, literalBraces = false) {
  let glob = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!glob.includes('/')) glob = '**/' + glob;
  // Repeated **/ segments and very long patterns can make the expression slow to evaluate.
  glob = glob.replace(/(\*\*\/)+/g, '**/');
  glob = glob.replace(/\*{3,}/g, '**');
  if (glob.length > 300) return /(?!)/;
  let source = '^';
  let braceDepth = 0;
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*' && glob[i + 2] === '/') {
      source += '(?:.*/)?'; i += 2;
    } else if (char === '*' && glob[i + 1] === '*') {
      source += '.*'; i++;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else if (char === '{' && !literalBraces) { source += '(?:'; braceDepth++; }
    else if (char === '}' && braceDepth) { source += ')'; braceDepth--; }
    else if (char === ',' && braceDepth) source += '|';
    else source += /[.*+?^${}()|[\]\\]/.test(char) ? '\\' + char : char;
  }
  // An unclosed { is matched literally rather than producing an invalid expression.
  if (braceDepth) return globToRegExp(raw, true);
  return new RegExp(source + '$', caseInsensitive ? 'i' : '');
}

// Match workspace-relative paths against simple VS Code-style glob patterns.
// Supports *, **, ? and {a,b}, with **/ matching zero or more directory levels.
// Patterns without slashes (such as version.json) match a filename anywhere.
function matchesExcludedFile(relativePath, patterns) {
  const file = String(relativePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return (patterns || []).some(raw => {
    if (typeof raw !== 'string' || !raw.trim()) return false;
    let regex = globCache.get(raw);
    if (!regex) {
      regex = globToRegExp(raw);
      if (globCache.size > 500) globCache.clear();
      globCache.set(raw, regex);
    }
    return regex.test(file);
  });
}

// Exclusions take priority; a specific include cannot un-ignore a matching exclude.
// In allowlist mode, nonmatching files (including most JSON) never enter the viewer.
function isAllowedByFilePatterns(relativePath, filterMode, includeFiles, excludeFiles) {
  if (matchesExcludedFile(relativePath, excludeFiles)) return false;
  if (filterMode === 'excludeOnly') return true;
  return matchesExcludedFile(relativePath, includeFiles);
}

// Choose the editor column for an agent that has no column yet.
// groups: [{ column, isChat }] for the current editor groups. Columns holding an AI chat
// panel are never used, and with reserveFirst the first other column is left to the user.
// otherColumns: columns already given to other agents, in the order they were given.
// A column past the last group makes VS Code add a new group.
function pickAgentColumn(groups, { reserveFirst, maxColumns, otherColumns }) {
  const taken = [...new Set(otherColumns)];
  if (taken.length >= maxColumns) return taken[taken.length - 1];
  const usable = groups.filter(g => !g.isChat).map(g => g.column).sort((a, b) => a - b);
  if (reserveFirst) usable.shift();
  const last = groups.reduce((max, g) => Math.max(max, g.column), 0);
  const candidates = [...usable];
  for (let i = 1; i <= maxColumns; i++) candidates.push(last + i);
  return candidates.find(c => !taken.includes(c));
}

// Claude Code hook events used for agent attribution and editing-round boundaries.
const HOOK_EVENTS = ['UserPromptSubmit','PreToolUse','PostToolUse','SubagentStart','SubagentStop','Stop'];

function isOwnHookCommand(command) {
  return typeof command === 'string' && command.includes('agent-live-view') && command.includes('hook.js');
}

// Remove this extension's hook entries from a parsed Claude settings object.
// Returns true when anything was removed. Other hooks are left untouched.
function removeHookEntries(settings) {
  if (!settings || typeof settings.hooks !== 'object' || !settings.hooks) return false;
  let changed = false;
  for (const event of Object.keys(settings.hooks)) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter(g => !Array.isArray(g?.hooks) || !g.hooks.some(h => isOwnHookCommand(h?.command)));
    if (kept.length === groups.length) continue;
    changed = true;
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (changed && !Object.keys(settings.hooks).length) delete settings.hooks;
  return changed;
}

// Replace any previous entries from this extension with one entry per event.
function addHookEntries(settings, command) {
  removeHookEntries(settings);
  if (!settings.hooks) settings.hooks = {};
  for (const event of HOOK_EVENTS) {
    const group = { hooks: [{ type: 'command', command, timeout: 5 }] };
    if (event === 'PreToolUse' || event === 'PostToolUse') group.matcher = '.*';
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
    settings.hooks[event].push(group);
  }
  return settings;
}

// List the hook commands this extension has installed in a parsed settings object.
function ownHookCommands(settings) {
  const commands = [];
  for (const groups of Object.values(settings?.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) for (const h of (Array.isArray(g?.hooks) ? g.hooks : [])) {
      if (isOwnHookCommand(h?.command)) commands.push(h.command);
    }
  }
  return commands;
}

// Find an executable on PATH so hooks do not depend on the PATH of the
// process that later starts Claude Code (e.g. apps launched from the macOS Dock).
function findExecutable(name, env = process.env, platform = process.platform) {
  const dirs = String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = platform === 'win32' ? String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of dirs) for (const ext of exts) {
    const candidate = path.join(dir, name + ext.toLowerCase());
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch (_) {}
  }
  return null;
}

module.exports = {
  lineDifference, normalizePath, safeFilePath, isInsideWorkspace, shellQuote, matchesExcludedFile, isAllowedByFilePatterns,
  pickAgentColumn, HOOK_EVENTS, isOwnHookCommand, removeHookEntries, addHookEntries, ownHookCommands, findExecutable
};
