'use strict';
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


// Match workspace-relative paths against simple VS Code-style glob patterns.
// Supports *, ** and ?, with **/ matching zero or more directory levels.
// Patterns without slashes (such as version.json) match a filename anywhere.
function matchesExcludedFile(relativePath, patterns) {
  const file = String(relativePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return (patterns || []).some(raw => {
    if (typeof raw !== 'string' || !raw.trim()) return false;
    let glob = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!glob.includes('/')) glob = '**/' + glob;
    let source = '^';
    for (let i = 0; i < glob.length; i++) {
      const char = glob[i];
      if (char === '*' && glob[i + 1] === '*' && glob[i + 2] === '/') {
        source += '(?:.*/)?'; i += 2;
      } else if (char === '*' && glob[i + 1] === '*') {
        source += '.*'; i++;
      } else if (char === '*') source += '[^/]*';
      else if (char === '?') source += '[^/]';
      else source += /[.*+?^${}()|[\]\\]/.test(char) ? '\\' + char : char;
    }
    const regex = new RegExp(source + '$', process.platform === 'win32' ? 'i' : '');
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

module.exports = { lineDifference, normalizePath, safeFilePath, isInsideWorkspace, shellQuote, matchesExcludedFile, isAllowedByFilePatterns };
