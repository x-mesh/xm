import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');

function runSync(cwd) {
  const result = spawnSync('bash', ['scripts/sync-bundle.sh', '--check'], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function copyTrackedRepo() {
  const tmp = mkdtempSync(join(tmpdir(), 'xm-sync-check-'));
  const files = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: REPO, encoding: 'utf8' })
    .stdout
    .trim()
    .split('\n')
    .filter(Boolean);
  for (const rel of files) {
    mkdirSync(dirname(join(tmp, rel)), { recursive: true });
    copyFileSync(join(REPO, rel), join(tmp, rel));
  }
  return tmp;
}

describe('sync-bundle.sh --check', () => {
  test('passes on the current working tree bundle state', () => {
    const r = runSync(REPO);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Bundle check passed.');
  });

  test('detects bundle drift without rewriting files', () => {
    const tmp = copyTrackedRepo();
    try {
      const bundleFile = join(tmp, 'xm', 'lib', 'x-build', 'tasks.mjs');
      const before = readFileSync(bundleFile, 'utf8');
      const drifted = `${before}\n// intentional drift for sync-bundle --check test\n`;
      writeFileSync(bundleFile, drifted);

      const r = runSync(tmp);
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}\n${r.stderr}`).toContain('DIVERGED');
      expect(readFileSync(bundleFile, 'utf8')).toBe(drifted);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('detects drift in the standalone dashboard precision module', () => {
    const tmp = copyTrackedRepo();
    try {
      const packagedFile = join(tmp, 'x-dashboard', 'lib', 'x-build', 'review-precision.mjs');
      const before = readFileSync(packagedFile, 'utf8');
      const drifted = `${before}\n// intentional standalone package drift\n`;
      writeFileSync(packagedFile, drifted);

      const r = runSync(tmp);
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}\n${r.stderr}`).toContain('DIVERGED x-dashboard/lib/x-build/review-precision.mjs');
      expect(readFileSync(packagedFile, 'utf8')).toBe(drifted);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('detects a stale bundle-only review lens', () => {
    // Deleting an orphan is the ONLY behavioral difference between
    // mirror_md_tree and mirror_md_dir, and the lenses directory was switched to
    // mirror_md_tree precisely so a renamed lens (performance.md -> perf.md)
    // stops shipping. Without this case, reverting that line survives the suite.
    const tmp = copyTrackedRepo();
    try {
      const orphan = join(tmp, 'xm', 'skills', 'review', 'lenses', 'performance.md');
      writeFileSync(orphan, '# Lens: performance\n\nstale bundle-only copy\n');

      const r = runSync(tmp);
      expect(r.status).not.toBe(0);
      const out = `${r.stdout}\n${r.stderr}`;
      expect(out).toContain('OBSOLETE');
      expect(out).toContain('xm/skills/review/lenses/performance.md');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('detects a missing nested x-build reference', () => {
    const tmp = copyTrackedRepo();
    try {
      const sourceFile = join(
        tmp,
        'x-build',
        'skills',
        'build',
        'references',
        'future',
        'nested-reference.md',
      );
      mkdirSync(dirname(sourceFile), { recursive: true });
      writeFileSync(sourceFile, '# Nested reference\n');

      const r = runSync(tmp);
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}\n${r.stderr}`).toContain('MISSING');
      expect(`${r.stdout}\n${r.stderr}`).toContain('nested-reference.md');
      expect(readFileSync(sourceFile, 'utf8')).toBe('# Nested reference\n');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('detects a stale bundle-only x-eval module', () => {
    const tmp = copyTrackedRepo();
    try {
      const staleFile = join(tmp, 'xm', 'lib', 'x-eval', 'obsolete.mjs');
      writeFileSync(staleFile, 'export const obsolete = true;\n');

      const r = runSync(tmp);
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}\n${r.stderr}`).toContain('OBSOLETE xm/lib/x-eval/obsolete.mjs');
      expect(readFileSync(staleFile, 'utf8')).toBe('export const obsolete = true;\n');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
