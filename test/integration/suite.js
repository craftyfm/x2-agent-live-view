'use strict';
const vscode = require('vscode');
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sleep = ms => new Promise(r => setTimeout(r, ms));

exports.run = async () => {
  await vscode.extensions.getExtension('x2network.agent-live-view').activate();
  await sleep(1500);
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const aPath = path.join(ws, 'a.ts');
  const bPath = path.join(ws, 'b.ts');

  // The user types in a file and saves it: nothing should open and the cursor must not move.
  const ed = await vscode.window.showTextDocument(vscode.Uri.file(aPath), { viewColumn: 1 });
  ed.selection = new vscode.Selection(10, 5, 10, 5);
  for (const ch of 'XYZ') { await vscode.commands.executeCommand('type', { text: ch }); await sleep(50); }
  await ed.document.save();
  await sleep(2000);
  let cursor = vscode.window.activeTextEditor.selection.active;
  assert.deepEqual([cursor.line, cursor.character], [10, 8], 'cursor moved after the user saved');
  assert.equal(vscode.window.tabGroups.all.length, 1, 'the user\'s own save opened another column');

  // Another program (an agent) changes a file: it opens in column 2 and the user's editor is untouched.
  const lines = fs.readFileSync(bPath, 'utf8').split('\n');
  lines[25] = 'const changed = true;';
  fs.writeFileSync(bPath, lines.join('\n'));
  await sleep(2500);
  const column2 = vscode.window.tabGroups.all.find(g => g.viewColumn === 2);
  assert.ok(column2?.tabs.some(t => t.input?.uri?.fsPath === bPath), 'agent change did not open in column 2');
  assert.ok(!column2.tabs.some(t => t.input?.uri?.fsPath === aPath), 'the user\'s file was opened in the agent column');

  // A second change to the same file is located from the stored snapshot.
  lines[30] = 'const second = true;';
  fs.writeFileSync(bPath, lines.join('\n'));
  await sleep(2500);
  const bEditor = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === bPath);
  assert.equal(bEditor?.selection.active.line, 30, 'agent editor not moved to the changed line');

  const active = vscode.window.activeTextEditor;
  cursor = active.selection.active;
  assert.equal(active.document.uri.fsPath, aPath, 'focus moved away from the user\'s editor');
  assert.deepEqual([cursor.line, cursor.character], [10, 8], 'cursor moved after an agent change');

  assert.ok(fs.existsSync(path.join(os.homedir(), '.agent-live-view', 'hook.js')), 'hook script not copied');

  // A chat panel in the editor area (here on the right, in column 2) is left on its own:
  // agent files go to a new column instead, even though column 2 was the agent's column before.
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.window.showTextDocument(vscode.Uri.file(aPath), { viewColumn: 1 });
  const chat = vscode.window.createWebviewPanel('claudeVSCodePanel', 'Claude Code', { viewColumn: 2, preserveFocus: true });
  await vscode.window.showTextDocument(vscode.Uri.file(aPath), { viewColumn: 1 });
  await sleep(500);
  lines[5] = 'const third = true;';
  fs.writeFileSync(bPath, lines.join('\n'));
  await sleep(2500);
  const chatGroup = vscode.window.tabGroups.all.find(g => g.tabs.some(t => t.input instanceof vscode.TabInputWebview));
  assert.equal(chatGroup.viewColumn, 2, 'chat panel moved');
  assert.deepEqual(chatGroup.tabs.map(t => t.label), ['Claude Code'], 'a file was opened in the chat column');
  const agentGroup = vscode.window.tabGroups.all.find(g => g.tabs.some(t => t.input?.uri?.fsPath === bPath));
  assert.equal(agentGroup?.viewColumn, 3, 'agent file not opened in a column of its own');
  assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, aPath, 'focus moved away from the user\'s editor');
  chat.dispose();
};
