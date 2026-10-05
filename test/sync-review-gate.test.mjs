import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { digest } from '../x-review/lib/review-budget.mjs';
import { verificationConfig, runVerificationGate } from '../x-review/lib/review-verification.mjs';

const root = join(import.meta.dir, '..');
test('sync gate kills seven named defects through actual clients and SQLite without modifying inputs', async () => {
  const work = mkdtempSync(join(tmpdir(), 'sync-gate-integration-'));
  try {
    const context = JSON.parse(readFileSync(join(root, 'x-sync/review-context.json'), 'utf8'));
    const config = verificationConfig(JSON.parse(readFileSync(join(root, 'x-sync/review-gate.json'), 'utf8')), context);
    const files = {};
    for (const file of config.files) {
      const bytes = readFileSync(join(root, file)); files[file] = bytes.toString('base64');
      mkdirSync(dirname(join(work, file)), { recursive: true }); cpSync(join(root, file), join(work, file));
    }
    expect(spawnSync('git', ['init', '-q'], { cwd: work }).status).toBe(0);
    const runDir = join(work, '.xm/review/run'); mkdirSync(runDir, { recursive: true });
    const bytes = JSON.stringify(config); writeFileSync(join(runDir, 'verification-gate.json'), bytes);
    const manifest = { cwd: work, target_hash: digest('sync-target'), context_hash: digest(JSON.stringify(context)), snapshot: { kind: 'workspace', files }, verification: { config_hash: digest(bytes) } };
    const receipt = await runVerificationGate(runDir, manifest);
    expect(receipt.error).toBe(null); expect(receipt.status).toBe('passed');
    expect(receipt.baseline.tests_run).toBe(7);
    expect(receipt.mutants).toHaveLength(7);
    expect(receipt.mutants.every(item => item.status === 'killed' && item.violation === item.invariant_id)).toBe(true);
    for (const input of receipt.inputs) expect(digest(readFileSync(join(work, input.file)))).toBe(input.sha256);
  } finally { rmSync(work, { recursive: true, force: true }); }
}, 60000);
