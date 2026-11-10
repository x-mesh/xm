import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
