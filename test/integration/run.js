'use strict';
// Starts a real VS Code with the extension loaded and runs suite.js inside it.
// Linux without a display: xvfb-run -a npm run test:integration
const path = require('path');
const fs = require('fs');
const os = require('os');
const { runTests } = require('@vscode/test-electron');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-itest-'));
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, 'a.ts'), Array.from({length: 40}, (_, i) => `const a${i} = ${i};`).join('\n') + '\n');
  fs.writeFileSync(path.join(ws, 'b.ts'), Array.from({length: 40}, (_, i) => `const b${i} = ${i};`).join('\n') + '\n');
  // VS Code's own terminal sets this, which would make the test instance run as plain Node.
  delete process.env.ELECTRON_RUN_AS_NODE;
  try {
    await runTests({
      extensionDevelopmentPath: path.resolve(__dirname, '../..'),
      extensionTestsPath: path.join(__dirname, 'suite.js'),
      launchArgs: [ws, '--disable-extensions', '--disable-workspace-trust', '--user-data-dir', path.join(root, 'user-data')],
      // A separate home folder keeps the hook script and event logs out of the real one.
      extensionTestsEnv: { HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home') }
    });
  } catch (e) {
    console.error('Integration tests failed:', e.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
