/**
 * handoff mem-mesh mirror (dual-write)
 *
 * The file half of a handoff is CLI-written and always lands; the mem-mesh half
 * used to depend on the skill hand-building an `add` payload and never fired.
 * These tests pin the CLI contract that replaced it: a payload rendered to disk
 * in the exact shape mem-mesh `add` accepts, plus a status the next restore can
 * see.
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = join(import.meta.dir, '..', 'x-build', 'lib', 'x-build-cli.mjs');

let repo;

function git(...args) {
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

function cli(...args) {
  return execFileSync('node', [CLI, ...args], { cwd: repo, encoding: 'utf8' });
}

function mirror() {
  const p = join(repo, '.xm', 'build', 'memmesh-mirror.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

const FULL_NARRATIVE = JSON.stringify({
  intent: 'Close the dual-write gap so mem-mesh receives handoff mirrors',
  open_questions: ['Should the gate try-then-fallback or probe first'],
  rejected_alternatives: ['Leaving the mirror to model discretion — it never fired'],
  next_session_should_know: ['CLI renders the payload deterministically now'],
  session_log: {
    rejected: ['Hand-built payload with a `type` key — the real schema key is `category`'],
    open_forks: ['Whether handon should auto-repair a pending mirror'],
    constraints_prefs: ['Both halves must work, not just the file half'],
    attempts: ['Searched mem-mesh for prior mirrors: zero results, confirming the gap'],
  },
});

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'xkit-mirror-'));
  git('init', '-q', '.');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  execFileSync('sh', ['-c', 'echo hello > a.mjs'], { cwd: repo });
  git('add', '-A');
  git('commit', '-qm', 'init commit');
});

afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

test('renders a mem-mesh payload matching the add schema', () => {
  cli('handoff', '--full', '--narrative-json', FULL_NARRATIVE, 'testing dual-write');

  const m = mirror();
  expect(m).not.toBeNull();
  expect(m.status).toBe('pending');
  expect(m.memory_id).toBeNull();

  // Schema keys mem-mesh `add` actually accepts — `category`, never `type`.
  expect(m.payload.category).toBe('idea');
  expect(m.payload).not.toHaveProperty('type');
  expect(m.payload.project_id).toMatch(/^[a-zA-Z0-9_-]{1,100}$/);

  // `add` rejects content under 100 chars.
  expect(m.payload.content.length).toBeGreaterThanOrEqual(100);

  // Tier-2 detail is what makes the mirror worth storing.
  expect(m.payload.content).toContain('## Rejected (with reasoning)');
  expect(m.payload.content).toContain('## What was tried & why');
  expect(m.payload.content).toContain('Stopped: testing dual-write');

  // Anchors are client-collected — the server has no git access.
  expect(m.payload.anchors.commit_hash).toMatch(/^[0-9a-fA-F]{7,64}$/);
});

test('pads thin sessions past the 100-char content minimum', () => {
  const thin = JSON.stringify({
    intent: 'Quick fix',
    open_questions: [],
    rejected_alternatives: [],
    next_session_should_know: [],
  });
  cli('handoff', '--full', '--narrative-json', thin, 'short');

  const m = mirror();
  expect(m.payload.content.length).toBeGreaterThanOrEqual(100);
  expect(m.payload.content).toContain('## Session facts');
});

test('skips the mirror when there is no narrative to mirror', () => {
  cli('handoff', '--full', 'no narrative');
  expect(mirror()).toBeNull();
});

test('--mirror-done records the memory id', () => {
  cli('handoff', '--full', '--narrative-json', FULL_NARRATIVE, 'reason');
  cli('handoff', '--mirror-done', 'mem_abc123');

  const m = mirror();
  expect(m.status).toBe('mirrored');
  expect(m.memory_id).toBe('mem_abc123');
  expect(m.mirrored_at).toBeTruthy();
});

test('--mirror-status reports the lifecycle', () => {
  cli('handoff', '--full', '--narrative-json', FULL_NARRATIVE, 'reason');
  expect(JSON.parse(cli('handoff', '--mirror-status')).status).toBe('pending');

  cli('handoff', '--mirror-done', 'mem_xyz');
  const done = JSON.parse(cli('handoff', '--mirror-status'));
  expect(done.status).toBe('mirrored');
  expect(done.memory_id).toBe('mem_xyz');
});

test('handon surfaces a pending mirror so a skipped dual-write stays visible', () => {
  cli('handoff', '--full', '--narrative-json', FULL_NARRATIVE, 'reason');

  const pending = JSON.parse(cli('handon', '--json'));
  expect(pending.memmesh_mirror.status).toBe('pending');
  expect(cli('handon')).toContain('mem-mesh: mirror PENDING');

  cli('handoff', '--mirror-done', 'mem_done');
  const mirrored = JSON.parse(cli('handon', '--json'));
  expect(mirrored.memmesh_mirror.status).toBe('mirrored');
  expect(mirrored.memmesh_mirror.memory_id).toBe('mem_done');
});

test('a MIRRORED record from an older handoff reports stale, not pending', () => {
  cli('handoff', '--full', '--narrative-json', FULL_NARRATIVE, 'first');
  cli('handoff', '--mirror-done', 'mem_first');

  // Narrative-less handoff writes new state but no new mirror.
  cli('handoff', '--full', 'second');

  const state = JSON.parse(cli('handon', '--json'));
  expect(state.memmesh_mirror.status).toBe('stale');
  // Already mirrored — nothing left to repair, so no outstanding action.
  expect(cli('handon')).not.toContain('mirror PENDING');
});

// Regression: ageing a PENDING mirror out to `stale` silently dropped the only
// warning that an unrepaired dual-write existed. The payload is still on disk
// and still the sole copy of that session, so it must stay visible.
test('a PENDING mirror survives a later narrative-less handoff', () => {
  cli('handoff', '--full', '--narrative-json', FULL_NARRATIVE, 'first');
  // No --mirror-done: the mem-mesh add failed or was skipped.

  cli('handoff', '--full', 'second');

  const state = JSON.parse(cli('handon', '--json'));
  expect(state.memmesh_mirror.status).toBe('pending');
  expect(state.memmesh_mirror.from_earlier_handoff).toBe(true);

  const pretty = cli('handon');
  expect(pretty).toContain('mirror PENDING');
  expect(pretty).toContain('from an earlier handoff');
});

// Regression: the mirror line was printed only when a payload was written or
// when there was no narrative at all, so a narrative that rendered no payload
// produced total silence — the exact failure this feature removes.
test('written and no-narrative handoffs both print a mirror line', () => {
  const mirrorLine = (out) => out.split('\n').filter(l => l.includes('mem-mesh mirror'));

  // Path 1: payload written → PENDING
  expect(mirrorLine(cli('handoff', '--full', '--narrative-json', FULL_NARRATIVE, 'full'))
    .some(l => l.includes('PENDING'))).toBe(true);

  // Path 2: no narrative at all → skipped
  expect(mirrorLine(cli('handoff', '--full', 'bare'))
    .some(l => l.includes('no narrative to mirror'))).toBe(true);

  // NOT covered here: the "narrative too thin" and "write failed" branches.
  // Inside a git repo the padding (branch + commits + saved_at) always clears
  // the 100-char floor, so the thin path is unreachable from this fixture.
  // Both branches are one-line console.log calls verified by reading, not by test.
});

// Regression: a corrupt mirror file was reported as `none` — indistinguishable
// from "no mirror exists", hiding a pending dual-write behind the same silence
// this feature removes (Lesson L6).
test('a corrupt mirror file reports unreadable, never none', () => {
  cli('handoff', '--full', '--narrative-json', FULL_NARRATIVE, 'reason');
  writeFileSync(join(repo, '.xm', 'build', 'memmesh-mirror.json'), '{ this is not json', 'utf8');

  expect(JSON.parse(cli('handoff', '--mirror-status')).status).toBe('unreadable');
  expect(JSON.parse(cli('handon', '--json')).memmesh_mirror.status).toBe('unreadable');
  expect(cli('handon')).toContain('UNREADABLE');
});

// Regression: only JSON.parse failure counted as unreadable, so `null`, an array,
// or any object without `.payload` became a phantom mirror with payload undefined.
test.each([
  ['null', 'null'],
  ['an array', '[1,2,3]'],
  ['a bare string', '"just a string"'],
  ['an object with no payload', '{"status":"pending"}'],
])('%s parses but is rejected as unreadable', (_desc, contents) => {
  cli('handoff', '--full', '--narrative-json', FULL_NARRATIVE, 'reason');
  writeFileSync(join(repo, '.xm', 'build', 'memmesh-mirror.json'), contents, 'utf8');

  expect(JSON.parse(cli('handoff', '--mirror-status')).status).toBe('unreadable');
  expect(JSON.parse(cli('handon', '--json')).memmesh_mirror.status).toBe('unreadable');
});

test('a corrupt mirror file is never overwritten by --mirror-done or --mirror-skip', () => {
  cli('handoff', '--full', '--narrative-json', FULL_NARRATIVE, 'reason');
  const corrupt = '{ this is not json';
  const p = join(repo, '.xm', 'build', 'memmesh-mirror.json');
  writeFileSync(p, corrupt, 'utf8');

  // Both must refuse — overwriting destroys the only copy of the payload.
  expect(() => cli('handoff', '--mirror-done', 'mem_abc')).toThrow();
  expect(readFileSync(p, 'utf8')).toBe(corrupt);

  expect(() => cli('handoff', '--mirror-skip')).toThrow();
  expect(readFileSync(p, 'utf8')).toBe(corrupt);
});

test('--mirror-skip dismisses a pending mirror without claiming it was saved', () => {
  cli('handoff', '--full', '--narrative-json', FULL_NARRATIVE, 'reason');
  cli('handoff', '--mirror-skip');

  const m = mirror();
  expect(m.status).toBe('skipped');
  expect(m.memory_id).toBeNull();
  expect(m.skipped_at).toBeTruthy();

  // A dismissed mirror stops nagging on restore.
  expect(cli('handon')).not.toContain('mirror PENDING');
});
