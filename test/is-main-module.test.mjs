import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainModule } from '../x-review/lib/is-main-module.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LINK_ROOT = mkdtempSync(join(tmpdir(), 'xm-main-guard-'));

afterAll(() => rmSync(LINK_ROOT, { recursive: true, force: true }));

const ENTRYPOINTS = [
  'xm/lib/x-relay-cli.mjs',
  'xm/lib/x-review-cli.mjs',
  'x-review/lib/x-review-cli.mjs',
  'xm/skills/review/scripts/retry-target.mjs',
  'xm/skills/review/scripts/plan-review.mjs',
  'xm/skills/review/scripts/validate-reports.mjs',
  'x-review/skills/review/scripts/retry-target.mjs',
  'x-review/skills/review/scripts/plan-review.mjs',
  'x-review/skills/review/scripts/validate-reports.mjs',
];

function run(file) {
  const result = spawnSync('node', [file, '--help'], { cwd: ROOT, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('CLI main guard', () => {
  test.each(ENTRYPOINTS)('%s runs main when invoked through a symlinked directory', relative => {
    const pluginDir = relative.split('/')[0];
    const link = join(LINK_ROOT, pluginDir);
    try { symlinkSync(join(ROOT, pluginDir), link, 'dir'); } catch (error) { if (error.code !== 'EEXIST') throw error; }

    const direct = run(join(ROOT, relative));
    const linked = run(join(LINK_ROOT, relative));

    expect(direct.status === 0 && direct.stdout === '' && direct.stderr === '').toBe(false);
    expect(linked).toEqual(direct);
  });
});

describe('isMainModule', () => {
  const helperUrl = new URL('../x-review/lib/is-main-module.mjs', import.meta.url).href;

  function withEntry(entry, fn) {
    const saved = process.argv[1];
    process.argv[1] = entry;
    try { return fn(); } finally { process.argv[1] = saved; }
  }

  test('returns false when there is no entry script', () => {
    expect(withEntry(undefined, () => isMainModule(helperUrl))).toBe(false);
  });

  test('returns false when the entry path does not exist', () => {
    expect(withEntry(join(LINK_ROOT, 'missing.mjs'), () => isMainModule(helperUrl))).toBe(false);
  });

  test('throws when the entry path cannot be resolved for another reason', () => {
    const throughFile = join(fileURLToPath(helperUrl), 'child.mjs');
    expect(() => withEntry(throughFile, () => isMainModule(helperUrl))).toThrow(expect.objectContaining({ code: 'ENOTDIR' }));
  });
});
