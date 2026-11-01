'use strict';
// Minimal, read-only Claude Code hook bridge. Logs metadata, never code, prompts,
// commands, tool responses or transcript contents. Never blocks Claude Code.
const fs = require('fs');
const path = require('path');
const output = process.argv[2];
if (!output) process.exit(0);
let payload = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { if (payload.length < 1024 * 1024) payload += chunk; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(payload);
    const ti = input.tool_input || {};
    const event = {
      at: Date.now(),
      event: input.hook_event_name,
      session: input.session_id || null,
      agent: input.agent_id || null,
      agentType: input.agent_type || null,
      cwd: input.cwd || null,
      tool: input.tool_name || null,
      toolId: input.tool_use_id || null,
      file: ti.file_path || ti.path || input.file_path || null
    };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    try { if (fs.statSync(output).size > 4 * 1024 * 1024) fs.truncateSync(output, 0); } catch (_) {}
    fs.appendFileSync(output, JSON.stringify(event) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (_) { /* Diagnostics are best-effort; never interfere with agent tools. */ }
});
