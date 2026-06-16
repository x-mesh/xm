import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');

describe('release state checks', () => {
  test('verify-release-state passes current repo as JSON', () => {
    const result = spawnSync('node', [join(REPO, 'scripts', 'verify-release-state.mjs'), '--json'], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 120000,
    });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.results.map((check) => check.name)).toEqual(
      expect.arrayContaining(['version-consistency', 'bundle-sync', 'skills-checksum']),
    );
  });

  test('release bump is wired to the release-state gate before tests', () => {
    const source = readFileSync(join(REPO, 'x-build/lib/x-build/release.mjs'), 'utf8');
    const checksumIndex = source.indexOf('skills-checksum.mjs');
    const gateIndex = source.indexOf('runReleaseStateCheck(cwd);');
    const testIndex = source.indexOf("console.log('\\n🧪 Running tests...');");

    expect(source).toContain('verify-release-state.mjs');
    expect(gateIndex).toBeGreaterThan(checksumIndex);
    expect(testIndex).toBeGreaterThan(gateIndex);
  });

  test('xm doctor exposes release-state status and remains valid bash', () => {
    const xmScript = join(REPO, 'xm/scripts/xm');
    const source = readFileSync(xmScript, 'utf8');
    const syntax = spawnSync('bash', ['-n', xmScript], {
      cwd: REPO,
      encoding: 'utf8',
    });

    expect(source).toContain('## Bundle / release state');
    expect(source).toContain('verify-release-state.mjs');
    expect(syntax.status).toBe(0);
  });
});
