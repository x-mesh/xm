import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('backfill dry-run is read-only, real backfill persists, and ack removes the item', () => {
  const root = mkdtempSync(join(tmpdir(), 'attention-e2e-'));
  const artifact = join(root, '.xm/build/projects/p/worktrees/T1');
  mkdirSync(artifact, { recursive: true });
  writeFileSync(join(artifact, 'panel-after.json'), JSON.stringify({
    task_id: 'T1', phase: 'after', panel_run: 'p1',
    advisory_findings: [{ kind: 'contested', finding_id: 'f1', severity: 'medium', file: 'src/a.js' }],
  }));
  const cli = resolve('x-build/lib/x-build-cli.mjs');
  const run = args => spawnSync('bun', [cli, 'attention', ...args], { cwd: root, encoding: 'utf8' });
  const dry = JSON.parse(run(['--backfill', '--dry-run', '--json']).stdout);
  expect(dry.items).toHaveLength(1);
  expect(existsSync(join(root, '.xm/review/escape-ledger.jsonl'))).toBe(false);
  const real = JSON.parse(run(['--backfill', '--json']).stdout);
  expect(real.items).toHaveLength(1);
  const id = real.items[0].id;
  expect(readFileSync(join(root, '.xm/review/escape-ledger.jsonl'), 'utf8')).not.toContain('claim');
  expect(run(['--ack', id, '--json']).status).toBe(0);
  expect(JSON.parse(run(['--json']).stdout).items).toHaveLength(0);
});
