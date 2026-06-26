/**
 * x-recall CLI integration tests — black-box via spawnSync.
 *
 * Builds a synthetic .xm/ fixture and exercises list/show/search/handoff-md,
 * with a focus on host-variant dedup (the CRITICAL correctness requirement)
 * and graceful handling of an empty tree.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI_PATH = join(import.meta.dirname, '..', 'x-recall', 'lib', 'x-recall-cli.mjs');
let TEST_DIR;
let XM;

function run(args, opts = {}) {
  return spawnSync('node', [CLI_PATH, ...args], {
    cwd: opts.cwd || TEST_DIR,
    env: { ...process.env, X_RECALL_ROOT: opts.root || XM, NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 10000,
  });
}

function writeJSON(path, obj) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2));
}

function writeText(path, text) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

beforeAll(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'xrecall-cli-'));
  XM = join(TEST_DIR, '.xm');

  // op
  writeJSON(join(XM, 'op', 'council-2026-04-06-redis-vs-postgres.json'), {
    schema_version: 1, strategy: 'council', topic: 'Redis vs Postgres for sessions',
    status: 'completed', created_at: '2026-04-06T10:00:00.000Z',
    outcome: { verdict: 'consensus' }, self_score: { overall: 8.1 },
  });
  // legacy op with no canonical `topic` (uses `question`)
  writeJSON(join(XM, 'op', 'debate-2026-03-01-legacy.json'), {
    strategy: 'debate', question: 'legacy question key', status: 'completed',
    created_at: '2026-03-01T09:00:00.000Z',
  });
  // op whose filename ends in ".local" but is NOT a host variant (no -hash) — F4
  writeJSON(join(XM, 'op', 'notes.local.json'), {
    strategy: 'note', topic: 'local notes', status: 'completed',
    created_at: '2026-02-01T00:00:00.000Z',
  });
  // op that carries only `date` (no created_at) — F1 fallback
  writeJSON(join(XM, 'op', 'refine-legacy-dated.json'), {
    strategy: 'refine', topic: 'dated legacy op', status: 'completed',
    date: '2026-02-15T00:00:00.000Z',
  });

  // review: base + two host variants (must collapse to ONE)
  const review = {
    reviewed_commit: 'abc1234', target: { type: 'diff', ref: 'HEAD~1..HEAD' },
    lenses: ['security'], date: '2026-05-10', verdict: 'lgtm', findings: [],
  };
  writeJSON(join(XM, 'review', 'last-result.json'), review);
  writeJSON(join(XM, 'review', 'last-result.HostA.local-6339.json'), review);
  writeJSON(join(XM, 'review', 'last-result.HostB.local-5135.json'), review);
  // review markdown sibling for `show`
  writeText(join(XM, 'review', 'last-result.md'), '# x-review: HEAD~1..HEAD — LGTM\n\nVerdict: lgtm\n');

  // eval
  writeJSON(join(XM, 'eval', 'results', '20260410-221027-score.json'), {
    type: 'score', timestamp: '2026-04-10T22:12:00Z', rubric: 'code-quality',
    target: 'lib/foo.mjs', overall: 6.9, sigma: 0.44,
  });

  // build project (plan)
  writeJSON(join(XM, 'build', 'projects', 'cost-engine-v2', 'manifest.json'), {
    name: 'cost-engine-v2', display_name: 'cost-engine-v2',
    current_phase: '05-close', created_at: '2026-04-10T12:03:10.739Z',
    updated_at: '2026-04-10T12:55:31.176Z',
  });
  writeText(join(XM, 'build', 'projects', 'cost-engine-v2', 'context', 'PRD.md'),
    '# PRD: cost-engine-v2\n\nGoal: reduce cost.\n');

  // SESSION-STATE for handoff-md
  writeJSON(join(XM, 'build', 'SESSION-STATE.json'), {
    v: 1, saved_at: '2026-04-11T03:44:25.191Z',
    where: { branch: 'develop', last_commits: ['aaa1234 first', 'bbb5678 second'], uncommitted_files: ['x.mjs'] },
    what_done: ['shipped X'],
    what_remains: { active_projects: [{ name: 'p1', phase: 'Plan' }] },
    decisions: [{ what: 'use recall', why: 'cross-session' }],
    narrative: { intent: 'build recall', open_questions: ['naming?'], rejected_alternatives: ['rules-only'], next_session_should_know: ['dedup matters'] },
    why_stopped: 'PRD done',
  });

  // panel verdict (x-panel cross-model review)
  writeJSON(join(XM, 'panel', 'panel-20260601-000000', 'verdict.json'), {
    run: 'panel-20260601-000000', created_at: '2026-06-01T00:00:00.000Z',
    models: ['claude', 'codex'], counts: { unique: 3, confirmed: 5, contested: 1 },
  });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('list', () => {
  test('lists artifacts across types, newest first', () => {
    const r = run(['list']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Redis vs Postgres');
    expect(r.stdout).toContain('cost-engine-v2');
    // council (2026-04) should appear before legacy debate (2026-03)
    expect(r.stdout.indexOf('Redis vs Postgres')).toBeLessThan(r.stdout.indexOf('legacy question key'));
  });

  test('legacy op falls back to question key for title', () => {
    const r = run(['list', '--type', 'op']);
    expect(r.stdout).toContain('legacy question key');
  });

  test('--json emits valid JSON array', () => {
    const r = run(['list', '--json']);
    const parsed = JSON.parse(r.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });

  test('--type filters', () => {
    const r = run(['list', '--type', 'eval', '--json']);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.every(a => a.type === 'eval')).toBe(true);
  });

  test('indexes x-panel verdicts as panel type', () => {
    const r = run(['list', '--type', 'panel', '--json']);
    const arts = JSON.parse(r.stdout);
    const p = arts.find(a => a.id === 'panel:panel-20260601-000000');
    expect(p).toBeTruthy();
    expect(p.meta.models).toEqual(['claude', 'codex']);
  });
});

describe('host-variant dedup', () => {
  test('three review host variants collapse to one review:last entry', () => {
    const r = run(['list', '--type', 'review', '--json']);
    const parsed = JSON.parse(r.stdout);
    const lasts = parsed.filter(a => a.id === 'review:last');
    expect(lasts.length).toBe(1);
    // canonical base file is preferred (no host suffix in path)
    expect(lasts[0].path).toContain('last-result.json');
    expect(lasts[0].path).not.toContain('.local-');
  });

  test('semantic .local filename (no host hash) is NOT treated as a host variant', () => {
    const r = run(['list', '--type', 'op', '--json']);
    const ids = JSON.parse(r.stdout).map(a => a.id);
    expect(ids).toContain('op:notes.local'); // preserved, not collapsed to op:notes
  });

  test('op with only a date field sorts by it, not file mtime', () => {
    const r = run(['list', '--type', 'op', '--json']);
    const dated = JSON.parse(r.stdout).find(a => a.id === 'op:refine-legacy-dated');
    expect(dated.created_at).toBe('2026-02-15T00:00:00.000Z');
  });
});

describe('show', () => {
  test('show review --last prefers the markdown sibling', () => {
    const r = run(['show', 'review', '--last']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('# x-review: HEAD~1..HEAD — LGTM');
  });

  test('show plan project renders PRD.md', () => {
    const r = run(['show', 'plan:cost-engine-v2']);
    expect(r.stdout).toContain('# PRD: cost-engine-v2');
  });

  test('show by exact op id renders raw json with --json', () => {
    const r = run(['show', 'op:council-2026-04-06-redis-vs-postgres', '--json']);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.strategy).toBe('council');
  });

  test('unknown selector exits 1', () => {
    const r = run(['show', 'nope:nothing']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Not found');
  });
});

describe('search', () => {
  test('matches body content', () => {
    const r = run(['search', 'Postgres']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Redis vs Postgres');
  });

  test('respects --type filter', () => {
    const r = run(['search', 'lgtm', '--type', 'review', '--json']);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.every(a => a.type === 'review')).toBe(true);
  });

  test('searches inside project artifact bodies (PRD content)', () => {
    const r = run(['search', 'reduce cost', '--json']);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.some(a => a.type === 'plan' && a.project === 'cost-engine-v2')).toBe(true);
  });
});

describe('handoff-md', () => {
  test('generates tool-neutral HANDOFF.md from SESSION-STATE.json', () => {
    const r = run(['handoff-md']);
    expect(r.status).toBe(0);
    const md = readFileSync(join(XM, 'build', 'HANDOFF.md'), 'utf8');
    expect(md).toContain('# Session Handoff');
    expect(md).toContain('build recall');          // narrative.intent
    expect(md).toContain('naming?');               // open question
    expect(md).toContain('use recall');            // decision
    expect(md).toContain('do not re-litigate');    // rejected alternatives heading
  });
});

describe('empty tree', () => {
  test('list on empty .xm reports no artifacts (exit 0)', () => {
    const empty = mkdtempSync(join(tmpdir(), 'xrecall-empty-'));
    const r = run(['list'], { root: join(empty, '.xm') });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('No artifacts');
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('help', () => {
  test('no args prints help', () => {
    const r = run([]);
    expect(r.stdout).toContain('x-recall');
    expect(r.stdout).toContain('Commands:');
  });

  test('unknown command exits 1', () => {
    const r = run(['frobnicate']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Unknown command');
  });
});
