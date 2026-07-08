#!/usr/bin/env node
/**
 * Test stub standing in for the term-mesh `tm-agent` CLI (t8 tm backend).
 * Supports only what x-panel's tm backend uses:
 *   node tm-agent-stub.mjs delegate <agent> <capsule>
 * Parses the prompt/output paths out of the TM-PROTOCOL-v1 capsule, reads the
 * prompt, writes a deterministic panel-shaped JSON answer to the output path
 * (emulating the pane agent doing the work), and exits 0 — so the panel's
 * file-polling wait loop is exercised end to end.
 *
 * Env hooks:
 *   X_PANEL_TM_LOG            append one JSONL line per delegate call
 *   X_PANEL_TM_FAIL_DELEGATE  exit 1 without writing (delegate rejected)
 *   X_PANEL_TM_NO_OUTPUT      accept the delegate but never write the file
 *                             (a hung pane — proves the timeout path)
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const [cmd, agent, capsule = ''] = process.argv.slice(2);
if (cmd !== 'delegate') {
  process.stderr.write(`tm-agent-stub: unsupported command "${cmd}"\n`);
  process.exit(2);
}
if (process.env.X_PANEL_TM_LOG) {
  try { appendFileSync(process.env.X_PANEL_TM_LOG, JSON.stringify({ agent, capsule }) + '\n'); } catch { /* best-effort */ }
}
if (process.env.X_PANEL_TM_FAIL_DELEGATE) {
  process.stderr.write('delegate rejected (stub)\n');
  process.exit(1);
}

const promptPath = /prompt file at (\S+) and follow/.exec(capsule)?.[1];
const outPath = /requests to (\S+) \(no prose/.exec(capsule)?.[1];
if (!promptPath || !outPath) {
  process.stderr.write('tm-agent-stub: capsule did not carry prompt/output paths\n');
  process.exit(2);
}

if (process.env.X_PANEL_TM_NO_OUTPUT) {
  process.stdout.write('delegated (stub, will never answer)\n');
  process.exit(0);
}

const prompt = readFileSync(promptPath, 'utf8');
const isRefute = /verdicts/i.test(prompt);
let payload;
if (isRefute) {
  const refs = [...prompt.matchAll(/\[([^\]]+#\d+)\]/g)].map((m) => m[1]);
  payload = { verdicts: refs.map((ref) => ({ ref, stance: 'concede', reason: 'stub reason (tm)' })) };
} else {
  payload = {
    findings: [
      { severity: 'high', file: 'a.js', line: 1, claim: 'shared issue', evidence: 'ev' },
      { severity: 'low', file: `${agent}.js`, line: 2, claim: `${agent}-only issue`, evidence: 'ev' },
    ],
  };
}
writeFileSync(outPath, JSON.stringify(payload), 'utf8');
process.stdout.write('delegated (stub)\n');
