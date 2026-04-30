import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { sanitizeMarketplaces } from '../xm/lib/sanitize-marketplaces.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'xm', 'lib', 'sanitize-marketplaces.mjs');

let workDir;
let knownPath;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'sanitize-mp-'));
  knownPath = join(workDir, 'known_marketplaces.json');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('sanitizeMarketplaces (API)', () => {
  test('absent registry is a no-op', () => {
    const r = sanitizeMarketplaces({ knownPath });
    expect(r.status).toBe('absent');
    expect(r.removed).toEqual([]);
    expect(r.flagged).toEqual([]);
  });

  test('healthy registry is left untouched', () => {
    const reg = {
      'xm:kit': { source: { type: 'github', repo: 'x-mesh/xm' }, installLocation: join(workDir, 'xm') },
    };
    mkdirSync(reg['xm:kit'].installLocation, { recursive: true });
    writeFileSync(join(reg['xm:kit'].installLocation, '.git'), 'gitdir: ...');
    const before = JSON.stringify(reg, null, 2);
    writeFileSync(knownPath, before);

    const r = sanitizeMarketplaces({ knownPath });
    expect(r.status).toBe('clean');
    // File contents unchanged (no trailing newline added)
    expect(readFileSync(knownPath, 'utf8')).toBe(before);
  });

  test('removes broken entry with empty install dir', () => {
    const emptyDir = join(workDir, 'orphan');
    mkdirSync(emptyDir, { recursive: true });
    writeFileSync(knownPath, JSON.stringify({
      'x-kit': { installLocation: emptyDir },
      'xm:kit': { source: { type: 'github' }, installLocation: join(workDir, 'xm') },
    }, null, 2));

    const r = sanitizeMarketplaces({ knownPath });
    expect(r.status).toBe('cleaned');
    expect(r.removed).toEqual(['x-kit']);
    expect(r.flagged).toEqual([]);

    const after = JSON.parse(readFileSync(knownPath, 'utf8'));
    expect(Object.keys(after)).toEqual(['xm:kit']);
    expect(existsSync(emptyDir)).toBe(false);
  });

  test('removes broken entry with non-existent install dir', () => {
    writeFileSync(knownPath, JSON.stringify({
      'xm-kit': { installLocation: join(workDir, 'gone') },
    }, null, 2));

    const r = sanitizeMarketplaces({ knownPath });
    expect(r.status).toBe('cleaned');
    expect(r.removed).toEqual(['xm-kit']);
  });

  test('flags broken entry with non-empty install dir (no delete)', () => {
    const populated = join(workDir, 'populated');
    mkdirSync(populated, { recursive: true });
    writeFileSync(join(populated, 'README.md'), '# user content');

    writeFileSync(knownPath, JSON.stringify({
      'x-kit': { installLocation: populated },
    }, null, 2));

    const r = sanitizeMarketplaces({ knownPath });
    expect(r.status).toBe('flagged');
    expect(r.removed).toEqual([]);
    expect(r.flagged).toEqual([{ name: 'x-kit', loc: populated }]);
    // Registry untouched, dir untouched
    expect(JSON.parse(readFileSync(knownPath, 'utf8'))).toHaveProperty('x-kit');
    expect(existsSync(join(populated, 'README.md'))).toBe(true);
  });

  test('dryRun does not write or delete', () => {
    const emptyDir = join(workDir, 'orphan');
    mkdirSync(emptyDir, { recursive: true });
    const before = JSON.stringify({ 'x-kit': { installLocation: emptyDir } }, null, 2);
    writeFileSync(knownPath, before);

    const r = sanitizeMarketplaces({ knownPath, dryRun: true });
    expect(r.removed).toEqual(['x-kit']);
    expect(readFileSync(knownPath, 'utf8')).toBe(before);
    expect(existsSync(emptyDir)).toBe(true);
  });

  test('throws on JSON parse error', () => {
    writeFileSync(knownPath, '{ not json');
    expect(() => sanitizeMarketplaces({ knownPath })).toThrow(/parse error/);
  });

  test('throws when JSON root is not an object', () => {
    writeFileSync(knownPath, '[]');
    expect(() => sanitizeMarketplaces({ knownPath })).toThrow(/must be a JSON object/);
  });
});

describe('sanitize-marketplaces.mjs (CLI)', () => {
  function run() {
    return spawnSync('node', [SCRIPT], {
      env: { ...process.env, HOME: workDir },
      encoding: 'utf8',
      timeout: 5000,
    });
  }

  test('exit 1 on parse error (does not silently swallow)', () => {
    const claudeDir = join(workDir, '.claude/plugins');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'known_marketplaces.json'), '{ broken');

    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('parse error');
  });

  test('exit 0 + clean message on healthy registry', () => {
    const claudeDir = join(workDir, '.claude/plugins');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'known_marketplaces.json'), JSON.stringify({
      'xm:kit': { source: { type: 'github' } },
    }));

    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('clean');
  });

  test('exit 0 when registry is absent', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('nothing to sanitize');
  });
});
