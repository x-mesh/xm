/**
 * x-memory CLI integration tests — black-box via spawnSync
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI_PATH = join(import.meta.dirname, '..', 'x-memory', 'lib', 'x-memory-cli.mjs');
let TEST_DIR;

function run(args, opts = {}) {
  return spawnSync('node', [CLI_PATH, ...args], {
    cwd: opts.cwd || TEST_DIR,
    env: { ...process.env, X_MEMORY_ROOT: join(TEST_DIR, '.xm', 'memory'), NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 10000,
  });
}

beforeAll(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'xmem-cli-'));
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── help ─────────────────────────────────────────────────────────────

describe('help', () => {
  test('shows help with no args', () => {
    const r = run([]);
    expect(r.stdout).toContain('x-memory');
    expect(r.stdout).toContain('Commands:');
    expect(r.status).toBe(0);
  });

  test('shows help with --help', () => {
    const r = run(['--help']);
    expect(r.stdout).toContain('save');
    expect(r.status).toBe(0);
  });
});

// ── unknown command ──────────────────────────────────────────────────

describe('unknown command', () => {
  test('exits with error for unknown command', () => {
    const r = run(['foobar']);
    expect(r.stderr).toContain('Unknown command');
    expect(r.status).toBe(1);
  });
});

// ── save ─────────────────────────────────────────────────────────────

describe('save', () => {
  test('saves a decision', () => {
    const r = run(['save', 'JWT Auth Decision', '--type', 'decision', '--why', 'Stateless scaling', '--tags', 'auth,jwt']);
    expect(r.stdout).toContain('Saved: mem-001');
    expect(r.stdout).toContain('JWT Auth Decision');
    expect(r.status).toBe(0);
  });

  test('saves a pattern', () => {
    const r = run(['save', 'Middleware Chain', '--type', 'pattern', '--tags', 'middleware']);
    expect(r.stdout).toContain('Saved: mem-002');
    expect(r.status).toBe(0);
  });

  test('saves a failure', () => {
    const r = run(['save', 'Redis Timeout', '--type', 'failure', '--why', 'Connection pool exhausted']);
    expect(r.stdout).toContain('Saved: mem-003');
    expect(r.status).toBe(0);
  });

  test('fails without --type', () => {
    const r = run(['save', 'No Type']);
    expect(r.stderr).toContain('--type is required');
    expect(r.status).toBe(1);
  });

  test('fails without title', () => {
    const r = run(['save']);
    expect(r.stderr).toContain('Usage');
    expect(r.status).toBe(1);
  });
});

// ── list ─────────────────────────────────────────────────────────────

describe('list', () => {
  test('lists all memories', () => {
    const r = run(['list']);
    expect(r.stdout).toContain('3 memories');
    expect(r.stdout).toContain('mem-001');
    expect(r.stdout).toContain('mem-002');
    expect(r.stdout).toContain('mem-003');
  });

  test('filters by type', () => {
    const r = run(['list', '--type', 'decision']);
    expect(r.stdout).toContain('1 decisions');
    expect(r.stdout).toContain('JWT Auth Decision');
  });

  test('filters by tag', () => {
    const r = run(['list', '--tag', 'auth']);
    expect(r.stdout).toContain('mem-001');
    expect(r.stdout).not.toContain('mem-002');
  });
});

// ── show ─────────────────────────────────────────────────────────────

describe('show', () => {
  test('shows memory content', () => {
    const r = run(['show', 'mem-001']);
    expect(r.stdout).toContain('JWT Auth Decision');
    expect(r.stdout).toContain('decision');
    expect(r.stdout).toContain('auth, jwt');
  });

  test('warns for non-existent ID', () => {
    const r = run(['show', 'mem-999']);
    expect(r.stderr).toContain('not found');
  });
});

// ── recall ───────────────────────────────────────────────────────────

describe('recall', () => {
  test('finds by keyword', () => {
    const r = run(['recall', 'auth']);
    expect(r.stdout).toContain('JWT Auth Decision');
  });

  test('finds by tag keyword', () => {
    const r = run(['recall', 'middleware']);
    expect(r.stdout).toContain('Middleware Chain');
  });

  test('shows no results for non-match', () => {
    const r = run(['recall', 'zzzznonexistent']);
    expect(r.stdout).toContain('0 memories found');
  });
});

// ── forget ───────────────────────────────────────────────────────────

describe('forget', () => {
  test('deletes a memory', () => {
    const r = run(['forget', 'mem-003']);
    expect(r.stdout).toContain('Deleted: mem-003');

    const list = run(['list']);
    expect(list.stdout).toContain('2 memories');
    expect(list.stdout).not.toContain('mem-003');
  });

  test('warns for non-existent ID', () => {
    const r = run(['forget', 'mem-999']);
    expect(r.stderr).toContain('not found');
  });
});

// ── stats ────────────────────────────────────────────────────────────

describe('stats', () => {
  test('shows statistics', () => {
    const r = run(['stats']);
    expect(r.stdout).toContain('Statistics');
    expect(r.stdout).toContain('decision');
    expect(r.stdout).toContain('pattern');
    expect(r.stdout).toContain('Total:');
  });
});

// ── export / import roundtrip ────────────────────────────────────────

describe('export / import', () => {
  test('exports to JSON file', () => {
    const outFile = join(TEST_DIR, 'export.json');
    const r = run(['export', '--format', 'json', '--output', outFile]);
    expect(r.stdout).toContain('Exported');
    expect(existsSync(outFile)).toBe(true);

    const data = JSON.parse(readFileSync(outFile, 'utf8'));
    expect(data.index.length).toBe(2); // mem-001 and mem-002 (mem-003 was forgotten)
  });

  test('exports to md (stdout)', () => {
    const r = run(['export', '--format', 'md']);
    expect(r.stdout).toContain('JWT Auth Decision');
    expect(r.stdout).toContain('Middleware Chain');
  });

  test('imports with dedup', () => {
    const outFile = join(TEST_DIR, 'export.json');
    // Import same data — should skip all as duplicates
    const r = run(['import', outFile]);
    expect(r.stdout).toContain('Skipped (duplicate): 2');
    expect(r.stdout).toContain('Imported: 0');
  });

  test('imports into fresh index', () => {
    // Create a new isolated dir for import test
    const freshDir = mkdtempSync(join(tmpdir(), 'xmem-import-'));
    const outFile = join(TEST_DIR, 'export.json');
    const r = spawnSync('node', [CLI_PATH, 'import', outFile], {
      cwd: freshDir,
      env: { ...process.env, X_MEMORY_ROOT: join(freshDir, '.xm', 'memory'), NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(r.stdout).toContain('Imported: 2');

    // Verify list works
    const list = spawnSync('node', [CLI_PATH, 'list'], {
      cwd: freshDir,
      env: { ...process.env, X_MEMORY_ROOT: join(freshDir, '.xm', 'memory'), NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(list.stdout).toContain('2 memories');
    rmSync(freshDir, { recursive: true, force: true });
  });
});

// ── inject ───────────────────────────────────────────────────────────

describe('inject', () => {
  test('runs without error (may be silent if no matches)', () => {
    const r = run(['inject']);
    expect(r.status).toBe(0);
  });
});

// ── Full flow integration ────────────────────────────────────────────

describe('full flow', () => {
  test('save → list → show → recall → forget → stats', () => {
    const freshDir = mkdtempSync(join(tmpdir(), 'xmem-flow-'));
    const env = { ...process.env, X_MEMORY_ROOT: join(freshDir, '.xm', 'memory'), NO_COLOR: '1' };
    const r = (args) => spawnSync('node', [CLI_PATH, ...args], { cwd: freshDir, env, encoding: 'utf8', timeout: 10000 });

    // Save
    const s1 = r(['save', 'Flow Test', '--type', 'learning', '--tags', 'test,flow', '--why', 'Integration']);
    expect(s1.stdout).toContain('mem-001');

    // List
    const l1 = r(['list']);
    expect(l1.stdout).toContain('1 memories');

    // Show
    const sh1 = r(['show', 'mem-001']);
    expect(sh1.stdout).toContain('Flow Test');

    // Recall
    const rc1 = r(['recall', 'flow']);
    expect(rc1.stdout).toContain('Flow Test');

    // Stats
    const st1 = r(['stats']);
    expect(st1.stdout).toContain('learning');
    expect(st1.stdout).toContain('Total: 1');

    // Forget
    const f1 = r(['forget', 'mem-001']);
    expect(f1.stdout).toContain('Deleted');

    // List after forget
    const l2 = r(['list']);
    expect(l2.stdout).toContain('0 memories');

    rmSync(freshDir, { recursive: true, force: true });
  });
});
