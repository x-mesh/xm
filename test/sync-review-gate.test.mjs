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

test('the sync ownership invariant rejects deletion of every remote row', () => {
  const work = mkdtempSync(join(tmpdir(), 'sync-owner-regression-'));
  try {
    cpSync(join(root, 'x-sync'), join(work, 'x-sync'), { recursive: true });
    mkdirSync(join(work, 'test'));
    cpSync(join(root, 'test/sync-lifecycle-integration.test.mjs'), join(work, 'test/sync-lifecycle-integration.test.mjs'));
    const args = ['test', 'test/sync-lifecycle-integration.test.mjs', '--test-name-pattern', '^remote updates replace tracked copies and never echo through another machine$'];
    const baseline = spawnSync('bun', args, { cwd: work, encoding: 'utf8', timeout: 10000 });
    expect(baseline.status).toBe(0);
    const server = join(work, 'x-sync/lib/x-sync-server.mjs'), source = readFileSync(server, 'utf8');
    const anchor = 'if (full_snapshot === true) {';
    expect(source.split(anchor)).toHaveLength(2);
    const faulty = "if (full_snapshot === true && machine_id === 'B' && files.length === 0) db.query('DELETE FROM sync_files WHERE project_id=?').run(project_id);\n";
    writeFileSync(server, source.replace(anchor, faulty + anchor));
    const mutated = spawnSync('bun', args, { cwd: work, encoding: 'utf8', timeout: 10000 });
    expect(mutated.status).toBe(1);
    expect(mutated.stderr).toContain('error: INVARIANT:SYNC_ORIGIN');
  } finally { rmSync(work, { recursive: true, force: true }); }
}, 25000);
