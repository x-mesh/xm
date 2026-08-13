#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

// Emit a complete preflight answer immediately, then stay alive. probeProvider must
// accept the first parsed OK sentinel and terminate us instead of waiting for close.
if (process.env.X_PANEL_IGNORE_SIGTERM === '1') {
  process.on('SIGTERM', () => {});
}
if (process.env.X_PANEL_PREFLIGHT_PID_FILE) {
  writeFileSync(process.env.X_PANEL_PREFLIGHT_PID_FILE, String(process.pid));
}
if (process.env.X_PANEL_PREFLIGHT_GRANDCHILD_PID_FILE) {
  const grandchild = spawn(process.execPath, ['-e',
    `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`,
  ], { stdio: 'ignore' });
  grandchild.unref();
  writeFileSync(process.env.X_PANEL_PREFLIGHT_GRANDCHILD_PID_FILE, String(grandchild.pid));
}
process.stdout.write(JSON.stringify({
  type: 'result',
  result: 'OK',
  model: 'stub-preflight-model',
}) + '\n');
setTimeout(() => process.exit(0), 5000);
