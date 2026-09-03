/**
 * Legacy manifests — the ones written before `created_at` existed — must not
 * crash the commands that render them.
 *
 * project.mjs called `created_at.slice(0, 10)` unguarded in four places while a
 * fifth already used `?.`, and readMirrorStatus explicitly handles `!m.created_at`
 * — so a manifest without the field is a state the code already knows about. On
 * such a manifest `cmdList` threw "Cannot read properties of undefined (reading
 * 'slice')" and the command was unusable.
 *
 * Each case runs in its own child process: core.mjs freezes ROOT from
 * X_BUILD_ROOT at first import, so one process cannot exercise two roots.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_MJS = join(ROOT, 'x-build', 'lib', 'x-build', 'project.mjs');

/** Write a manifest; `created_at` is omitted unless supplied in `extra`. */
function plantProject(buildRoot, name, extra = {}) {
  const dir = join(buildRoot, 'projects', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ name, current_phase: 'execute', phases: {}, ...extra }, null, 2),
  );
}

/** Run an exported command in a fresh process against a throwaway build root. */
function runCmd(plant, call = 'm.cmdList()', { mode = null } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'xm-legacy-manifest-'));
  const buildRoot = join(tmp, 'build');
  mkdirSync(buildRoot, { recursive: true });
  try {
    plant(buildRoot);
    // getMode() resolves through config-loader, which reads config.json BESIDE
    // the build root (ROOT/../config.json) rather than under XM_ROOT.
    if (mode) writeFileSync(join(tmp, 'config.json'), JSON.stringify({ mode }));
    const r = spawnSync(
      'node',
      ['-e', `import(${JSON.stringify(PROJECT_MJS)}).then((m) => ${call})`],
      {
        encoding: 'utf8',
        env: { ...process.env, X_BUILD_ROOT: buildRoot },
      },
    );
    return { out: `${r.stdout}${r.stderr}`, status: r.status };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('project list with a manifest predating created_at', () => {
  test('renders instead of throwing', () => {
    const { out, status } = runCmd((root) => plantProject(root, 'legacy'));
    expect(out).not.toContain('Cannot read properties of undefined');
    expect(status).toBe(0);
    expect(out).toContain('legacy');
  });

  test('shows a placeholder where the date would be', () => {
    const { out } = runCmd((root) => plantProject(root, 'legacy'));
    expect(out).toMatch(/legacy.*\(\?\)/);
  });

  test('a manifest that has created_at still shows the date', () => {
    const { out, status } = runCmd((root) =>
      plantProject(root, 'modern', { created_at: '2026-01-15T10:00:00.000Z' }));
    expect(status).toBe(0);
    expect(out).toContain('2026-01-15');
  });

  test('a legacy and a modern manifest render side by side', () => {
    const { out, status } = runCmd((root) => {
      plantProject(root, 'legacy');
      plantProject(root, 'modern', { created_at: '2026-01-15T10:00:00.000Z' });
    });
    expect(status).toBe(0);
    expect(out).toContain('legacy');
    expect(out).toContain('2026-01-15');
  });

  test('project status renders a legacy manifest instead of throwing', () => {
    const { out, status } = runCmd(
      (root) => plantProject(root, 'legacy'),
      'm.cmdStatus(["legacy"])',
    );
    expect(out).not.toContain('Cannot read properties of undefined');
    expect(status).toBe(0);
  });

  test('project status still prints the date when the manifest has one', () => {
    const { out } = runCmd(
      (root) => plantProject(root, 'modern', { created_at: '2026-01-15T10:00:00.000Z' }),
      'm.cmdStatus(["modern"])',
    );
    expect(out).toContain('2026-01-15');
  });

  test('project status in normal mode renders a legacy manifest too', () => {
    // The Korean branch has its own created_at access; the English one above
    // does not exercise it.
    const { out, status } = runCmd(
      (root) => plantProject(root, 'legacy'),
      'm.cmdStatus(["legacy"])',
      { mode: 'normal' },
    );
    expect(out).not.toContain('Cannot read properties of undefined');
    expect(status).toBe(0);
    expect(out).toContain('시작일');
  });
});
