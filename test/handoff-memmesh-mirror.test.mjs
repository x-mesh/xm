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
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
  memory_refs: [
    { id: '837fbc8a-9834-4a4a-8506-c6998ba62e65', reason: 'Latest remote handoff to compare during restore' },
  ],
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
  expect(m.payload.content).toContain('## Referenced mem-mesh memories');
  expect(m.payload.content).toContain('837fbc8a-9834-4a4a-8506-c6998ba62e65');
  expect(m.payload.content).toContain('Stopped: testing dual-write');

  // Anchors are client-collected — the server has no git access.
  expect(m.payload.anchors.commit_hash).toMatch(/^[0-9a-fA-F]{7,64}$/);
});

test('keeps at most five valid, unique memory references', () => {
  const refs = Array.from({ length: 7 }, (_, i) => ({
    id: `memoryref-${String(i).padStart(8, '0')}`,
    reason: `Needed for restore ${i}`,
  }));
  refs.push({ id: 'bad id', reason: 'invalid' }, { id: refs[0].id, reason: 'duplicate' });
  const narrative = JSON.stringify({
    intent: 'Preserve selected memory context', open_questions: [],
    rejected_alternatives: [], next_session_should_know: [], memory_refs: refs,
  });
  cli('handoff', '--full', '--narrative-json', narrative, 'refs');

  const state = JSON.parse(cli('handon', '--json'));
  expect(state.narrative.memory_refs).toHaveLength(5);
  expect(state.narrative.memory_refs.map(ref => ref.id)).toEqual(refs.slice(0, 5).map(ref => ref.id));
  expect(mirror().payload.content).not.toContain(refs[5].id);
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

// The `none` contract: no mirror file at all must be distinguishable from a
// mirror that exists in some state. Both the CLI and handon depend on it.
test('with no mirror file, status is none on both paths', () => {
  cli('handoff', '--full', 'bare');   // no narrative → no mirror written
  expect(mirror()).toBeNull();

  expect(JSON.parse(cli('handoff', '--mirror-status')).status).toBe('none');
  expect(JSON.parse(cli('handon', '--json')).memmesh_mirror.status).toBe('none');
  expect(cli('handon')).not.toContain('Mem-mesh mirror:');
});

test('handon default is a delta-first briefing without emoji or commit replay', () => {
  cli('handoff', '--full', '--narrative-json', FULL_NARRATIVE, 'briefing');
  const out = cli('handon');

  expect(out).toContain('Session Restore');
  expect(out).toContain('State:');
  expect(out).toContain('Carry forward:');
  expect(out).toContain('Attention:');
  expect(out).not.toContain('📋');
  expect(out).not.toContain('✅ Done');
  expect(out).not.toContain('📚');
});

test('--mirror-done rejects a missing memory id', () => {
  cli('handoff', '--full', '--narrative-json', FULL_NARRATIVE, 'reason');

  const r = spawnSync('node', [CLI, 'handoff', '--mirror-done'], { cwd: repo, encoding: 'utf8' });
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain('Usage:');
  // The mirror must be untouched by a rejected call.
  expect(mirror().status).toBe('pending');
});

test('--mirror-done rejects a flag where the id should be', () => {
  cli('handoff', '--full', '--narrative-json', FULL_NARRATIVE, 'reason');

  const r = spawnSync('node', [CLI, 'handoff', '--mirror-done', '--json'], { cwd: repo, encoding: 'utf8' });
  expect(r.status).not.toBe(0);
  expect(mirror().status).toBe('pending');
});

test('--mirror-done fails loudly when there is no payload to record', () => {
  cli('handoff', '--full', 'bare');   // no mirror file

  const r = spawnSync('node', [CLI, 'handoff', '--mirror-done', 'mem_x'], { cwd: repo, encoding: 'utf8' });
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain('No mirror payload found');
});

test('--mirror-done accepts the --flag=value form', () => {
  cli('handoff', '--full', '--narrative-json', FULL_NARRATIVE, 'reason');
  cli('handoff', '--mirror-done=mem_equals_form');

  expect(mirror().status).toBe('mirrored');
  expect(mirror().memory_id).toBe('mem_equals_form');
});

// File-only setups can opt out permanently instead of dismissing every handoff.
test('memmesh.mirror=false disables the mirror entirely', () => {
  mkdirSync(join(repo, '.xm'), { recursive: true });
  writeFileSync(join(repo, '.xm', 'config.json'), JSON.stringify({ memmesh: { mirror: false } }), 'utf8');

  const out = cli('handoff', '--full', '--narrative-json', FULL_NARRATIVE, 'reason');
  expect(out).toContain('disabled (memmesh.mirror=false)');
  expect(mirror()).toBeNull();
  // No mirror file → nothing nags on restore.
  expect(cli('handon')).not.toContain('mirror PENDING');
});

test('--mirror-skip on a repo with no mirror says so instead of failing', () => {
  cli('handoff', '--full', 'bare');
  expect(cli('handoff', '--mirror-skip')).toContain('No mirror payload to skip');
});

test('project_id is sanitized to the schema pattern', () => {
  // mem-mesh requires ^[a-zA-Z0-9_-]{1,100}$. A repo directory can contain dots
  // and spaces, so assert against a name that would actually violate it — the
  // earlier assertion only ever saw tmpdir names that were already safe.
  const dirty = mkdtempSync(join(tmpdir(), 'xkit mirror.dots-'));
  try {
    execFileSync('git', ['init', '-q', '.'], { cwd: dirty });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dirty });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dirty });
    writeFileSync(join(dirty, 'a.mjs'), 'hello\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: dirty });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dirty });
    execFileSync('node', [CLI, 'handoff', '--full', '--narrative-json', FULL_NARRATIVE, 'reason'],
      { cwd: dirty, encoding: 'utf8' });

    const m = JSON.parse(readFileSync(join(dirty, '.xm', 'build', 'memmesh-mirror.json'), 'utf8'));
    expect(m.payload.project_id).toMatch(/^[a-zA-Z0-9_-]{1,100}$/);
    expect(m.payload.project_id).not.toContain('.');
    expect(m.payload.project_id).not.toContain(' ');
  } finally {
    rmSync(dirty, { recursive: true, force: true });
  }
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
  expect(cli('handon')).toContain('mem-mesh mirror is pending');

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
  expect(cli('handon')).not.toContain('mem-mesh mirror is pending');
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
  expect(pretty).toContain('mem-mesh mirror is pending');
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
// Regression: a new handoff overwrote an unrepaired mirror in total silence,
// destroying the only copy of a session that never reached mem-mesh.
test('overwriting a PENDING mirror warns before it is lost', () => {
  cli('handoff', '--full', '--narrative-json', FULL_NARRATIVE, 'first');
  // No --mirror-done: still pending.

  const r = spawnSync('node', [CLI, 'handoff', '--full', '--narrative-json', FULL_NARRATIVE, 'second'],
    { cwd: repo, encoding: 'utf8' });
  expect(r.status).toBe(0);
  expect(r.stderr).toContain('Overwriting a PENDING mem-mesh mirror');
});

// Regression: an empty-but-present narrative was blamed on the 100-char floor,
// a limit that branch never reaches.
test('an empty narrative is reported as empty, not "too thin"', () => {
  const empty = JSON.stringify({
    intent: '', open_questions: [], rejected_alternatives: [], next_session_should_know: [],
  });
  const out = cli('handoff', '--full', '--narrative-json', empty, 'reason');
  expect(out).toContain('narrative present but empty');
  expect(out).not.toContain('too thin');
});

// Regression: `skipped` aged into `stale`, which reads as "already mirrored" —
// the opposite of what the user chose.
test('a dismissed mirror stays skipped across later handoffs', () => {
  cli('handoff', '--full', '--narrative-json', FULL_NARRATIVE, 'first');
  cli('handoff', '--mirror-skip');
  cli('handoff', '--full', 'second');   // narrative-less: mirror file untouched

  const status = JSON.parse(cli('handoff', '--mirror-status'));
  expect(status.status).toBe('skipped');
  expect(JSON.parse(cli('handon', '--json')).memmesh_mirror.status).toBe('skipped');
});

test('--mirror-skip refuses to downgrade an already-mirrored record', () => {
  cli('handoff', '--full', '--narrative-json', FULL_NARRATIVE, 'reason');
  cli('handoff', '--mirror-done', 'mem_real');

  expect(() => cli('handoff', '--mirror-skip')).toThrow();
  expect(mirror().status).toBe('mirrored');
  expect(mirror().memory_id).toBe('mem_real');
});

// Regression: --mirror-status reported the raw stored status, calling a previous
// session's record `mirrored` while handon called the same record `stale`.
test('--mirror-status ages a record the same way handon does', () => {
  cli('handoff', '--full', '--narrative-json', FULL_NARRATIVE, 'first');
  cli('handoff', '--mirror-done', 'mem_old');
  cli('handoff', '--full', 'second');   // bumps saved_at, leaves the mirror behind

  expect(JSON.parse(cli('handoff', '--mirror-status')).status).toBe('stale');
  expect(JSON.parse(cli('handon', '--json')).memmesh_mirror.status).toBe('stale');
});

test('a corrupt mirror file reports unreadable, never none', () => {
  cli('handoff', '--full', '--narrative-json', FULL_NARRATIVE, 'reason');
  writeFileSync(join(repo, '.xm', 'build', 'memmesh-mirror.json'), '{ this is not json', 'utf8');

  expect(JSON.parse(cli('handoff', '--mirror-status')).status).toBe('unreadable');
  expect(JSON.parse(cli('handon', '--json')).memmesh_mirror.status).toBe('unreadable');
  expect(cli('handon')).toContain('mem-mesh mirror is unreadable');
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
  expect(cli('handon')).not.toContain('mem-mesh mirror is pending');
});
