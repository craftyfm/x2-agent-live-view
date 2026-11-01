'use strict';
// Run by VS Code (vscode:uninstall) after the extension is removed. Takes this
// extension's hook entries out of every project where they were installed, so
// Claude Code is not left calling a hook script that no longer exists.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { removeHookEntries } = require('./helpers');

const dataDir = path.join(os.homedir(), '.agent-live-view');
let projects = [];
try { projects = JSON.parse(fs.readFileSync(path.join(dataDir, 'projects.json'), 'utf8')); } catch (_) {}
for (const config of Array.isArray(projects) ? projects : []) {
  try {
    const settings = JSON.parse(fs.readFileSync(config, 'utf8'));
    if (removeHookEntries(settings)) fs.writeFileSync(config, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  } catch (_) { /* Project moved or settings unreadable; nothing to clean. */ }
}
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
