import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fullSuiteReport } from '../x-build/lib/x-build/release.mjs';

const CLI = join(import.meta.dir, '..', 'x-build', 'lib', 'x-build-cli.mjs');

// A child that writes its summary where bun writes it: stderr.
function run(stderr, exitCode = 0) {
  const script = `process.stdout.write('bun test v1\\n'); process.stderr.write(${JSON.stringify(stderr)}); process.exit(${exitCode});`;
  return spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

describe('release bump full-suite report', () => {
  test('reads a green summary that only stderr carries', () => {
    const lines = fullSuiteReport(run(' 3715 pass\n 0 fail\nRan 3715 tests across 177 files.\n'), 893);
    expect(lines).toEqual(['✅ Full suite green — 3715 pass / 0 fail  (893s)']);
  });

  test('lists the failing tests of a red run', () => {
    const lines = fullSuiteReport(run('(fail) suite > breaks [1.20ms]\n 41 pass\n 1 fail\n', 1), 12);
    expect(lines[0]).toContain('Full suite is RED');
    expect(lines).toContain('   41 pass / 1 fail  (12s)');
    expect(lines).toContain('     ✗ suite > breaks');
  });

  test('reports a timeout as a timeout, not as a failed command', () => {
    const error = Object.assign(new Error('spawnSync /bin/sh ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const lines = fullSuiteReport({ status: null, signal: 'SIGTERM', error, stdout: '', stderr: ' 12 pass\n' }, 1800);
    expect(lines).toEqual(['   timed out after 1800s (limit 1800s); no result. Run the test command directly.']);
  });

  test('says how a run without a summary ended', () => {
    expect(fullSuiteReport(run('no summary here\n'), 3)).toEqual(['   completed in 3s; no pass/fail summary parsed.']);
    expect(fullSuiteReport(run('no summary here\n', 2), 3)).toEqual(['   command failed (exit 2) in 3s; no pass/fail summary parsed.']);
  });
});

describe('release test', () => {
  // Before the fix a green run's summary was the last stdout lines ("bun test v1"),
  // because the counts bun prints on stderr were dropped on success.
  test('reports the pass/fail counts a green run prints on stderr', () => {
    const home = mkdtempSync(join(tmpdir(), 'xb-release-test-'));
    try {
      const command = `"${process.execPath}" -e "console.log('bun test v1'); console.error(' 2 pass'); console.error(' 0 fail')"`;
      const result = spawnSync('node', [CLI, 'release', 'test', '--command', command],
        { cwd: home, env: { ...process.env, HOME: home }, encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ passed: true, summary: expect.stringContaining('2 pass / 0 fail') });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
