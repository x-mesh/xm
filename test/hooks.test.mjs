/**
 * blocking-hooks (빅뱃4) — hook-state unit + scope-guard/stop-gate/CLI integration.
 * Hooks are disk-only + fail-open; these lock the block/allow decisions and the
 * non-destructive, idempotent settings.json merge.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { reviewFixState, isProtectedPath, isAllowed, failedRouteStart } from '../x-build/templates/hooks/hook-state.mjs';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'x-build', 'lib', 'x-build-cli.mjs');
const SCOPE_HOOK = join(ROOT, 'x-build', 'templates', 'hooks', 'xm-build-scope-guard.mjs');
const STOP_HOOK = join(ROOT, 'x-build', 'templates', 'hooks', 'xm-build-stop-gate.mjs');
const LEASE_HOOK = join(ROOT, 'x-build', 'templates', 'hooks', 'xm-build-lease-guard.mjs');

// reviewed_commit mirrors the real artifact: `verify-review-fix --init` always stamps it,
// and an LGTM only releases the guard when last-result.json carries the SAME commit.
const REVIEWED = 'abc123';
const ACTIVE_TRIAGE = {
  reviewed_commit: REVIEWED,
  target_findings: [{ id: 'F1', severity: 'critical', file: 'src/auth.ts', summary: 'SQLi', decision: 'fix_now' }],
  fix_scope: { allowed_files: ['src/auth.ts'] },
};
const LGTM = { verdict: 'LGTM', reviewed_commit: REVIEWED };

let DIR;
beforeEach(() => { DIR = mkdtempSync(join(tmpdir(), 'xb-hooks-')); mkdirSync(join(DIR, '.xm', 'review'), { recursive: true }); });
afterEach(() => rmSync(DIR, { recursive: true, force: true }));

function writeTriage(obj) { writeFileSync(join(DIR, '.xm', 'review', 'triage.json'), JSON.stringify(obj)); }
function writeResult(obj) { writeFileSync(join(DIR, '.xm', 'review', 'last-result.json'), JSON.stringify(obj)); }
function writeLifecycle(obj) { writeFileSync(join(DIR, '.xm', 'review', 'finding-lifecycle.json'), JSON.stringify(obj)); }
function writeGate(obj) { writeFileSync(join(DIR, '.xm', 'review', 'review-fix-gate.json'), JSON.stringify(obj)); }
function writeLifecycleState(triage, lifecycle) {
  const triageDigest = `sha256:${createHash('sha256').update(JSON.stringify(triage)).digest('hex')}`;
  const correlated = { reviewed_commit: triage.reviewed_commit, triage_digest: triageDigest, ...lifecycle };
  writeTriage(triage);
  writeLifecycle(correlated);
  writeGate({
    triage_digest: triageDigest,
    lifecycle_digest: `sha256:${createHash('sha256').update(JSON.stringify(correlated)).digest('hex')}`,
  });
}
function runHook(hook, input, env = {}) {
  return spawnSync('node', [hook], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: DIR, ...env },
  });
}
function runCli(args, env = {}) {
  return spawnSync('node', [CLI, ...args], {
    cwd: DIR, encoding: 'utf8',
    env: { ...process.env, X_BUILD_ROOT: join(DIR, '.xm', 'build'), ...env },
  });
}

describe('hook-state (unit)', () => {
  test('active + unresolved when a fix_now critical exists and verdict is not lgtm', () => {
    writeTriage(ACTIVE_TRIAGE); writeResult({ verdict: 'Request Changes' });
    const s = reviewFixState(DIR);
    expect(s.active).toBe(true);
    expect(s.allowedFiles).toEqual(['src/auth.ts']);
    expect(s.unresolvedBlocking).toHaveLength(1);
    expect(s.unresolvedBlocking[0].severity).toBe('critical');
  });
  test('LGTM ends the review-fix: nothing blocks, and the guard deactivates (F2)', () => {
    writeTriage(ACTIVE_TRIAGE); writeResult(LGTM);
    const s = reviewFixState(DIR);
    expect(s.unresolvedBlocking).toHaveLength(0); // nothing blocks a stop
    expect(s.active).toBe(false);                 // …and the scope-guard releases (was a permanent lock)
  });
  test('LGTM fails closed when lifecycle-aware triage loses its lifecycle file', () => {
    writeTriage({
      ...ACTIVE_TRIAGE,
      schema: 1,
      target_findings: [{ ...ACTIVE_TRIAGE.target_findings[0], finding_id: 'rf_auth' }],
    });
    writeResult(LGTM);
    const s = reviewFixState(DIR);
    expect(s.active).toBe(true);
    expect(s.unresolvedBlocking).toHaveLength(1);
  });
  test('LGTM cannot release a lifecycle-aware fix until every fix_now is reverified/resolved', () => {
    const triage = { ...ACTIVE_TRIAGE, schema: 1, target_findings: [{ ...ACTIVE_TRIAGE.target_findings[0], finding_id: 'rf_auth' }] };
    writeResult(LGTM);
    writeLifecycleState(triage, { schema: 1, findings: [{ id: 'F1', finding_id: 'rf_auth', decision: 'fix_now', state: 'fixed', outcome: null }] });
    expect(reviewFixState(DIR).active).toBe(true);
    expect(reviewFixState(DIR).unresolvedBlocking).toHaveLength(1);

    writeLifecycleState(triage, { schema: 1, findings: [{ id: 'F1', finding_id: 'rf_auth', decision: 'fix_now', state: 'reverified', outcome: 'persistent' }] });
    expect(reviewFixState(DIR).active).toBe(true);

    writeLifecycleState(triage, { schema: 1, findings: [{ id: 'F1', finding_id: 'rf_auth', decision: 'fix_now', state: 'reverified', outcome: 'resolved' }] });
    expect(reviewFixState(DIR).active).toBe(false);
    expect(reviewFixState(DIR).unresolvedBlocking).toHaveLength(0);
  });
  test('lifecycle-aware LGTM rejects stale commits, stripped ids, and triage digest drift', () => {
    const triage = { ...ACTIVE_TRIAGE, schema: 1, target_findings: [{ ...ACTIVE_TRIAGE.target_findings[0], finding_id: 'rf_auth' }] };
    writeResult(LGTM);
    writeLifecycleState(triage, { schema: 1, reviewed_commit: 'older', findings: [{ id: 'F1', finding_id: 'rf_auth', decision: 'fix_now', state: 'reverified', outcome: 'resolved' }] });
    expect(reviewFixState(DIR).active).toBe(true);

    writeLifecycleState(triage, { schema: 1, findings: [{ id: 'F1', finding_id: 'rf_auth', decision: 'fix_now', state: 'reverified', outcome: 'resolved' }] });
    const stripped = { ...triage, target_findings: [{ ...triage.target_findings[0] }] };
    delete stripped.target_findings[0].finding_id;
    writeTriage(stripped);
    expect(reviewFixState(DIR).active).toBe(true);

    writeLifecycleState(triage, { schema: 1, findings: [{ id: 'F1', finding_id: 'rf_auth', decision: 'fix_now', state: 'reverified', outcome: 'resolved' }] });
    writeTriage({ ...triage, note: 'tampered after authorization' });
    expect(reviewFixState(DIR).active).toBe(true);
  });
  test('no triage.json → inactive', () => {
    expect(reviewFixState(DIR).active).toBe(false);
  });
  test('only backlog/low findings → not active (no fix_now)', () => {
    writeTriage({ target_findings: [{ id: 'F1', severity: 'low', decision: 'backlog' }], fix_scope: { allowed_files: [] } });
    expect(reviewFixState(DIR).active).toBe(false);
  });
  test('a medium fix_now is active but NOT blocking (only critical/high block the stop)', () => {
    writeTriage({ target_findings: [{ id: 'F1', severity: 'medium', file: 'a', decision: 'fix_now' }], fix_scope: { allowed_files: ['a'] } });
    writeResult({ verdict: 'Request Changes' });
    const s = reviewFixState(DIR);
    expect(s.active).toBe(true);
    expect(s.unresolvedBlocking).toHaveLength(0);
  });
  test('isProtectedPath: .xm state hard-allowed, but NOT triage.json (F4 + C-a)', () => {
    expect(isProtectedPath('.xm/build/projects/p/later.json')).toBe(true);   // harness state → never self-lock
    expect(isProtectedPath('.xm/review/triage.json')).toBe(false);           // decides the block → not free to edit
    expect(isProtectedPath('.xm/review/finding-lifecycle.json')).toBe(false); // decides lifecycle completion
    expect(isProtectedPath('.xm/review/last-result.json')).toBe(true);       // its LGTM RELEASES the guard → must stay writable
    expect(isProtectedPath('src/auth.ts')).toBe(false);
  });
  test('isAllowed: repo-relative membership', () => {
    expect(isAllowed('src/auth.ts', DIR, ['src/auth.ts'])).toBe(true);
    expect(isAllowed(join(DIR, 'src/auth.ts'), DIR, ['src/auth.ts'])).toBe(true); // absolute input
    expect(isAllowed('src/other.ts', DIR, ['src/auth.ts'])).toBe(false);
  });
});

// ── review-fix regressions (cross-vendor panel F1–F8) ────────────────
// Each test reproduces the exact bypass a vendor found and proves it is now closed.

describe('review-fix regressions', () => {
  test('F1: isAllowed no longer suffix-matches — nested/src/auth.ts is NOT in an src/auth.ts scope', () => {
    expect(isAllowed('nested/src/auth.ts', DIR, ['src/auth.ts'])).toBe(false); // was true (3/3 vendor consensus)
    expect(isAllowed('src/auth.ts', DIR, ['src/auth.ts'])).toBe(true);         // exact still allowed
    expect(isAllowed('src/deep/a.ts', DIR, ['src'])).toBe(true);               // directory entry allows its contents
    expect(isAllowed('srcx/a.ts', DIR, ['src'])).toBe(false);                  // sibling prefix is not "inside src"
  });

  test('F1 (e2e): the guard blocks a suffix-colliding path', () => {
    writeTriage({ target_findings: [{ id: 'F1', severity: 'critical', file: 'src/auth.ts', decision: 'fix_now' }], fix_scope: { allowed_files: ['src/auth.ts'] } });
    writeResult({ verdict: 'Request Changes' });
    expect(runHook(SCOPE_HOOK, { tool_name: 'Edit', tool_input: { file_path: 'nested/src/auth.ts' } }).status).toBe(2);
  });

  test('F2: a finished review-fix (LGTM) deactivates the guard — no permanent lock', () => {
    writeTriage(ACTIVE_TRIAGE);
    writeResult(LGTM);
    expect(reviewFixState(DIR).active).toBe(false); // was true forever → guard blocked every out-of-scope edit
    expect(runHook(SCOPE_HOOK, { tool_name: 'Edit', tool_input: { file_path: 'src/other.ts' } }).status).toBe(0);
  });

  test('F3: NotebookEdit (notebook_path) is scope-checked, not silently allowed', () => {
    writeTriage(ACTIVE_TRIAGE); writeResult({ verdict: 'Request Changes' });
    expect(runHook(SCOPE_HOOK, { tool_name: 'NotebookEdit', tool_input: { notebook_path: 'src/other.ipynb' } }).status).toBe(2);
    expect(runHook(SCOPE_HOOK, { tool_name: 'NotebookEdit', tool_input: { notebook_path: 'src/auth.ts' } }).status).toBe(0);
  });

  // Honest scope (re-review N2): this closes the WRITE-TOOL disarm only. PreToolUse
  // matchers cannot see Bash, so `rm .xm/review/triage.json` still disarms the hooks —
  // the same structural limit as F10. These hooks are a drift guardrail, not a sandbox
  // against a determined agent (which already has the documented XM_BUILD_HOOKS_OFF).
  test('F4: the guard’s own inputs are not hard-allowed (closes the Write-tool disarm)', () => {
    writeTriage(ACTIVE_TRIAGE); writeResult({ verdict: 'Request Changes' });
    // triage.json holds the fix_now decisions → editing it must NOT be free
    // (last-result.json is deliberately still writable — see the C-a regression)
    expect(isProtectedPath('.xm/review/triage.json')).toBe(false);
    expect(runHook(SCOPE_HOOK, { tool_name: 'Write', tool_input: { file_path: '.xm/review/triage.json' } }).status).toBe(2);
    expect(runHook(SCOPE_HOOK, { tool_name: 'Write', tool_input: { file_path: '.xm/review/finding-lifecycle.json' } }).status).toBe(2);
    // …while the rest of .xm/ state stays writable (no self-lock)
    expect(isProtectedPath('.xm/build/projects/p/tasks.json')).toBe(true);
    expect(runHook(SCOPE_HOOK, { tool_name: 'Write', tool_input: { file_path: '.xm/build/projects/p/tasks.json' } }).status).toBe(0);
  });

  test('F5: install refuses to write through a symlink', () => {
    mkdirSync(join(DIR, '.claude', 'hooks'), { recursive: true });
    const outside = join(DIR, 'outside-target.mjs');
    writeFileSync(outside, '// must not be clobbered');
    symlinkSync(outside, join(DIR, '.claude', 'hooks', 'hook-state.mjs'));
    const r = runCli(['hooks', 'install']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('symlink');
    expect(readFileSync(outside, 'utf8')).toBe('// must not be clobbered'); // untouched
  });

  test('N1: a symlinked .claude/hooks DIRECTORY is refused, not written through', () => {
    // The first F5 fix only lstat'd the leaf file, so a symlinked parent dir still
    // escaped the project (re-review, codex: critical).
    const outsideDir = mkdtempSync(join(tmpdir(), 'xb-outside-'));
    const canary = join(outsideDir, 'hook-state.mjs');
    writeFileSync(canary, '// must not be clobbered');
    mkdirSync(join(DIR, '.claude'), { recursive: true });
    symlinkSync(outsideDir, join(DIR, '.claude', 'hooks'));
    try {
      const r = runCli(['hooks', 'install']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('outside the project');
      expect(readFileSync(canary, 'utf8')).toBe('// must not be clobbered');
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('M1: GUARD_INPUTS matching is case-insensitive (macOS writes the same file)', () => {
    expect(isProtectedPath('.xm/review/Triage.json')).toBe(false); // same file on APFS
    expect(isProtectedPath('.xm/review/TRIAGE.JSON')).toBe(false);
  });

  test('C-a: last-result.json stays writable — the LGTM that RELEASES the guard must be recordable', () => {
    writeTriage(ACTIVE_TRIAGE); writeResult({ verdict: 'Request Changes' });
    // Blocking it would mean a re-review could never record the release → permanent lock.
    expect(isProtectedPath('.xm/review/last-result.json')).toBe(true);
    expect(runHook(SCOPE_HOOK, { tool_name: 'Write', tool_input: { file_path: '.xm/review/last-result.json' } }).status).toBe(0);
  });

  test('C-c/R5: the LGTM↔triage commit correlation fails CLOSED', () => {
    // stale LGTM from an older review → guard stays engaged
    writeTriage({ ...ACTIVE_TRIAGE, reviewed_commit: 'bbbb' });
    writeResult({ verdict: 'LGTM', reviewed_commit: 'aaaa' });
    expect(reviewFixState(DIR).active).toBe(true);
    expect(reviewFixState(DIR).unresolvedBlocking).toHaveLength(1);

    // a triage genuinely WITHOUT reviewed_commit must not be disarmed by any leftover
    // LGTM (the one-sided first fix let this through). NOTE: spreading ACTIVE_TRIAGE is
    // not enough — it now carries the field, so the assertion would silently test the
    // mismatch case instead. Delete it explicitly (R6: the test lens caught this).
    const noCommit = { ...ACTIVE_TRIAGE };
    delete noCommit.reviewed_commit;
    writeTriage(noCommit);
    writeResult({ verdict: 'LGTM', reviewed_commit: 'aaaa' });
    expect(reviewFixState(DIR).active).toBe(true);
    writeResult(LGTM); // even a "matching-looking" LGTM cannot release an uncorrelatable triage
    expect(reviewFixState(DIR).active).toBe(true);

    // …and a correlated LGTM does release it
    writeTriage({ ...ACTIVE_TRIAGE, reviewed_commit: 'bbbb' });
    writeResult({ verdict: 'LGTM', reviewed_commit: 'bbbb' });
    expect(reviewFixState(DIR).active).toBe(false);
  });

  test('R5: a symlinked settings.json aborts BEFORE any hook file is written', () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'xb-outside-'));
    writeFileSync(join(outsideDir, 'settings.json'), '{"canary":true}');
    mkdirSync(join(DIR, '.claude'), { recursive: true });
    symlinkSync(join(outsideDir, 'settings.json'), join(DIR, '.claude', 'settings.json'));
    try {
      expect(runCli(['hooks', 'install']).status).toBe(1);
      // no half-install: the hook scripts must NOT have been written
      expect(existsSync(join(DIR, '.claude', 'hooks', 'hook-state.mjs'))).toBe(false);
      expect(readFileSync(join(outsideDir, 'settings.json'), 'utf8')).toBe('{"canary":true}');
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('C-b: an ABSOLUTE allowed_files entry still matches (no total block)', () => {
    expect(isAllowed('src/auth.ts', DIR, [join(DIR, 'src/auth.ts')])).toBe(true);
    expect(isAllowed('src/other.ts', DIR, [join(DIR, 'src/auth.ts')])).toBe(false);
  });

  test('L1/L2: a symlinked LATER hook file aborts before any write (no half-install)', () => {
    mkdirSync(join(DIR, '.claude', 'hooks'), { recursive: true });
    const outside = join(DIR, 'canary.mjs');
    writeFileSync(outside, '// canary');
    // 2nd file in HOOK_FILES is a symlink → must abort BEFORE writing the 1st
    symlinkSync(outside, join(DIR, '.claude', 'hooks', 'xm-build-scope-guard.mjs'));
    const r = runCli(['hooks', 'install']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('symlink');
    expect(readFileSync(outside, 'utf8')).toBe('// canary');                       // untouched
    expect(existsSync(join(DIR, '.claude', 'hooks', 'hook-state.mjs'))).toBe(false); // no partial write
    expect(existsSync(join(DIR, '.claude', 'settings.json'))).toBe(false);           // settings never merged
  });

  test('R4: a symlinked .claude/settings.json is refused (the third write target)', () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'xb-outside-'));
    const canary = join(outsideDir, 'settings.json');
    writeFileSync(canary, '{"canary":true}');
    mkdirSync(join(DIR, '.claude'), { recursive: true });
    symlinkSync(canary, join(DIR, '.claude', 'settings.json'));
    try {
      const r = runCli(['hooks', 'install']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('symlink');
      expect(readFileSync(canary, 'utf8')).toBe('{"canary":true}'); // never written through
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('R4: a DANGLING symlink is a controlled refusal, not a raw ENOENT', () => {
    mkdirSync(join(DIR, '.claude'), { recursive: true });
    symlinkSync(join(DIR, 'nowhere-at-all'), join(DIR, '.claude', 'hooks'));
    const r = runCli(['hooks', 'install']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('broken symlink');
    expect(r.stderr).not.toContain('ENOENT');
  });

  test('F8: XM_BUILD_HOOKS_OFF=0 does NOT disable the hooks', () => {
    writeTriage(ACTIVE_TRIAGE); writeResult({ verdict: 'Request Changes' });
    // "0" is a truthy STRING — the old `!!env` turned the guards off here
    expect(runHook(SCOPE_HOOK, { tool_name: 'Edit', tool_input: { file_path: 'src/other.ts' } }, { XM_BUILD_HOOKS_OFF: '0' }).status).toBe(2);
    const stop = runHook(STOP_HOOK, {}, { XM_BUILD_HOOKS_OFF: 'false' });
    expect(stop.status).toBe(0);
    expect(stop.stderr).toContain('unresolved Critical/High');
    // …and a real opt-out still works
    expect(runHook(SCOPE_HOOK, { tool_name: 'Edit', tool_input: { file_path: 'src/other.ts' } }, { XM_BUILD_HOOKS_OFF: '1' }).status).toBe(0);
  });
});

describe('scope-guard hook', () => {
  beforeEach(() => { writeTriage(ACTIVE_TRIAGE); writeResult({ verdict: 'Request Changes' }); });
  test('blocks an out-of-scope edit (exit 2)', () => {
    const r = runHook(SCOPE_HOOK, { tool_name: 'Edit', tool_input: { file_path: 'src/other.ts' } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('OUTSIDE the review-fix scope');
  });
  test('allows an in-scope edit (exit 0)', () => {
    expect(runHook(SCOPE_HOOK, { tool_name: 'Edit', tool_input: { file_path: 'src/auth.ts' } }).status).toBe(0);
  });
  test('an unreadable triage leaves the guard open, as it always has', () => {
    // The stop gate now warns about this state. The guard must keep failing open:
    // it runs on every tool call, and blocking edits on a corrupt state file would
    // lock the repo with no way to fix the file.
    writeFileSync(join(DIR, '.xm', 'review', 'triage.json'), '{');
    expect(runHook(SCOPE_HOOK, { tool_name: 'Edit', tool_input: { file_path: 'src/other.ts' } }).status).toBe(0);
  });
  test('allows a .xm harness-state edit (protected — never self-lock)', () => {
    // NOTE: the guard's own inputs (.xm/review/triage.json, last-result.json) are
    // deliberately NOT in this set — see the F4 regression above.
    expect(runHook(SCOPE_HOOK, { tool_name: 'Edit', tool_input: { file_path: '.xm/build/projects/p/tasks.json' } }).status).toBe(0);
  });
  test('ignores non-write tools', () => {
    expect(runHook(SCOPE_HOOK, { tool_name: 'Read', tool_input: { file_path: 'src/other.ts' } }).status).toBe(0);
  });
  test('fail-open: XM_BUILD_HOOKS_OFF=1', () => {
    expect(runHook(SCOPE_HOOK, { tool_name: 'Edit', tool_input: { file_path: 'src/other.ts' } }, { XM_BUILD_HOOKS_OFF: '1' }).status).toBe(0);
  });
  test('fail-open: malformed stdin', () => {
    expect(runHook(SCOPE_HOOK, 'not json').status).toBe(0);
  });
  test('fail-open: no active review-fix', () => {
    rmSync(join(DIR, '.xm', 'review', 'triage.json'));
    expect(runHook(SCOPE_HOOK, { tool_name: 'Edit', tool_input: { file_path: 'src/other.ts' } }).status).toBe(0);
  });
});

describe('stop-gate hook', () => {
  test('stays silent and exits 0 when triage.json is absent', () => {
    const r = runHook(STOP_HOOK, {});
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });
  test('warns and exits 0 when triage.json is unreadable', () => {
    writeFileSync(join(DIR, '.xm', 'review', 'triage.json'), '{');
    const r = runHook(STOP_HOOK, {});
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('warning: .xm/review/triage.json');
    expect(r.stderr).toContain('Stopping remains allowed');
  });
  test('reports unresolved Critical fix_now and allows stopping', () => {
    writeTriage(ACTIVE_TRIAGE); writeResult({ verdict: 'Request Changes' });
    const r = runHook(STOP_HOOK, {});
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('unresolved Critical/High');
    expect(r.stderr).not.toContain('until LGTM');
    expect(r.stderr).toContain('Merge remains blocked');
  });
  test('allows once the verdict is LGTM', () => {
    writeTriage(ACTIVE_TRIAGE); writeResult(LGTM);
    expect(runHook(STOP_HOOK, {}).status).toBe(0);
  });
  test('fail-open: XM_BUILD_HOOKS_OFF=1', () => {
    writeTriage(ACTIVE_TRIAGE); writeResult({ verdict: 'Request Changes' });
    expect(runHook(STOP_HOOK, {}, { XM_BUILD_HOOKS_OFF: '1' }).status).toBe(0);
  });
  test('does not re-block when stop_hook_active (no infinite loop)', () => {
    writeTriage(ACTIVE_TRIAGE); writeResult({ verdict: 'Request Changes' });
    expect(runHook(STOP_HOOK, { stop_hook_active: true }).status).toBe(0);
  });
  test('allows when no review-fix is active', () => {
    expect(runHook(STOP_HOOK, {}).status).toBe(0);
  });
});

describe('hooks install/uninstall/status CLI', () => {
  test('install is idempotent + non-destructive; uninstall preserves other hooks', () => {
    mkdirSync(join(DIR, '.claude'), { recursive: true });
    writeFileSync(join(DIR, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'node existing.mjs' }] }] } }));

    expect(runCli(['hooks', 'status']).status).toBe(1); // not installed yet
    expect(runCli(['hooks', 'install']).status).toBe(0);
    expect(existsSync(join(DIR, '.claude', 'hooks', 'hook-state.mjs'))).toBe(true);
    expect(existsSync(join(DIR, '.claude', 'hooks', 'xm-build-scope-guard.mjs'))).toBe(true);
    expect(existsSync(join(DIR, '.claude', 'hooks', 'block-when-over-budget.mjs'))).toBe(true);
    expect(existsSync(join(DIR, '.claude', 'hooks', 'xm-build-lease-guard.mjs'))).toBe(true);
    expect(runCli(['hooks', 'status']).status).toBe(0); // installed
    expect(runCli(['hooks', 'install']).stdout).toContain('0 settings entries added'); // idempotent

    let s = JSON.parse(readFileSync(join(DIR, '.claude', 'settings.json'), 'utf8'));
    expect(s.hooks.PreToolUse.some(e => e.hooks.some(h => h.command === 'node existing.mjs'))).toBe(true); // existing kept
    expect(s.hooks.PreToolUse.some(e => e.hooks.some(h => h.command.includes('scope-guard')))).toBe(true);
    expect(s.hooks.PreToolUse.some(e => e.matcher === 'Agent' && e.hooks.some(h => h.command.includes('block-when-over-budget')))).toBe(true);
    expect(s.hooks.PreToolUse.some(e => e.matcher === 'Agent' && e.hooks.some(h => h.command.includes('xm-build-lease-guard')))).toBe(true);
    expect(s.hooks.Stop.some(e => e.hooks.some(h => h.command.includes('stop-gate')))).toBe(true);

    expect(runCli(['hooks', 'uninstall']).status).toBe(0);
    s = JSON.parse(readFileSync(join(DIR, '.claude', 'settings.json'), 'utf8'));
    expect(s.hooks.PreToolUse.some(e => e.hooks.some(h => h.command === 'node existing.mjs'))).toBe(true); // still kept
    expect(s.hooks.PreToolUse.some(e => e.hooks.some(h => h.command.includes('scope-guard')))).toBe(false); // ours removed
    expect(s.hooks.PreToolUse.some(e => e.hooks.some(h => h.command.includes('xm-build-lease-guard')))).toBe(false);
    expect(s.hooks.Stop).toBeUndefined(); // emptied → removed
  });
  test('status keeps exit 0 for a project installed before the lease guard, and install adds it', () => {
    expect(runCli(['hooks', 'install']).status).toBe(0);
    const file = join(DIR, '.claude', 'settings.json');
    const s = JSON.parse(readFileSync(file, 'utf8'));
    s.hooks.PreToolUse = s.hooks.PreToolUse.filter(e => !e.hooks.some(h => h.command.includes('xm-build-lease-guard')));
    writeFileSync(file, JSON.stringify(s));
    const status = runCli(['hooks', 'status']);
    expect(status.status).toBe(0);
    expect(status.stdout).toMatch(/lease-guard: \S*not installed/);
    expect(runCli(['hooks', 'install']).stdout).toContain('1 settings entry added');
    expect(runCli(['hooks', 'status']).stdout).toMatch(/lease-guard: \S*installed/);
  });
  test('install refuses a malformed settings.json (loud, no clobber)', () => {
    mkdirSync(join(DIR, '.claude'), { recursive: true });
    writeFileSync(join(DIR, '.claude', 'settings.json'), 'not json');
    const r = runCli(['hooks', 'install']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not valid JSON');
    expect(readFileSync(join(DIR, '.claude', 'settings.json'), 'utf8')).toBe('not json'); // untouched
  });
});

describe('scope-guard: x-solver edit guard', () => {
  const NOW = () => new Date().toISOString();
  function writeSolver(name, { state = 'active', updatedAt = NOW(), ...strat }) {
    const dir = join(DIR, '.xm', 'solver', 'problems', name);
    mkdirSync(join(dir, 'phases', '03-solve'), { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ state, strategy: 'iterate', created_at: updatedAt, updated_at: updatedAt }));
    writeFileSync(join(dir, 'phases', '03-solve', 'strategy-state.json'), JSON.stringify({ strategy: 'iterate', updated_at: updatedAt, ...strat }));
  }
  const edit = (file_path) => runHook(SCOPE_HOOK, { tool_name: 'Edit', tool_input: { file_path } });

  test('before resolve, an unregistered file is blocked and the message names the fix', () => {
    writeSolver('p', { current_phase: 'diagnose' });
    const r = edit('src/cache.ts');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('"p" is in the diagnose phase');
    expect(r.stderr).toContain('x-solver instrument add src/cache.ts');
  });

  test('before resolve, a registered file is allowed', () => {
    writeSolver('p', { current_phase: 'test', instruments: [{ path: 'src/cache.ts', sha256: null }] });
    expect(edit('src/cache.ts').status).toBe(0);
  });

  test('in resolve, the Scope Contract files and tests are allowed and nothing else', () => {
    writeSolver('p', { current_phase: 'resolve', scope: { files: ['src/cache.ts'], tests: ['test/cache.test.ts'] } });
    expect(edit('src/cache.ts').status).toBe(0);
    expect(edit('test/cache.test.ts').status).toBe(0);
    const r = edit('src/other.ts');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('x-solver scope expand --files src/other.ts');
  });

  test('in resolve without a Scope Contract the guard stays open', () => {
    writeSolver('p', { current_phase: 'resolve' });
    expect(edit('src/other.ts').status).toBe(0);
  });

  test('a problem idle for more than 24 hours, or no longer active, does not guard', () => {
    writeSolver('old', { current_phase: 'diagnose', updatedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString() });
    expect(edit('src/cache.ts').status).toBe(0);
    writeSolver('done', { state: 'solved', current_phase: 'diagnose' });
    expect(edit('src/cache.ts').status).toBe(0);
  });

  test('the most recently active problem decides', () => {
    writeSolver('older', { current_phase: 'diagnose', updatedAt: new Date(Date.now() - 3600 * 1000).toISOString() });
    writeSolver('newer', { current_phase: 'test', instruments: [{ path: 'src/cache.ts', sha256: null }] });
    expect(edit('src/cache.ts').status).toBe(0);
  });

  test('the solver state files are not hard-allowed while a problem guards', () => {
    writeSolver('p', { current_phase: 'diagnose' });
    expect(edit('.xm/solver/problems/p/phases/03-solve/strategy-state.json').status).toBe(2);
    expect(edit('.xm/solver/problems/p/manifest.json').status).toBe(2);
    expect(edit('.xm/solver/problems/p/phases/03-solve/repro/notes.txt').status).toBe(0);
  });

  test('XM_BUILD_HOOKS_OFF=1 releases it', () => {
    writeSolver('p', { current_phase: 'diagnose' });
    expect(runHook(SCOPE_HOOK, { tool_name: 'Edit', tool_input: { file_path: 'src/cache.ts' } }, { XM_BUILD_HOOKS_OFF: '1' }).status).toBe(0);
  });
});

// The failed-start record is written by the real CLI in every test below: a hand-written
// fixture would not catch a path or field that the CLI and the hook stop agreeing on.
describe('lease-guard hook', () => {
  const SESSION = '11111111-2222-4333-8444-555555555555';
  const GATES = ['--gate-cmd', 'test=test -f src/never.txt', '--gate-cmd', 'boundary=test -s src/a.txt'];
  // The ceiling keeps git from finding a repository above the temporary directory.
  const route = (args, env = {}) => runCli(['route', ...args], { CLAUDE_CODE_SESSION_ID: SESSION, GIT_CEILING_DIRECTORIES: tmpdir(), ...env });
  const start = (id, extra = [], env) => route(['start', '--decision-id', id, '--expected-files', 'src/a.txt', ...extra, '--json'], env);
  const agentCall = (overrides = {}, env) => runHook(LEASE_HOOK, { tool_name: 'Agent', session_id: SESSION, cwd: DIR, tool_input: { prompt: 'T1' }, ...overrides }, env);
  const OTHER = '99999999-2222-4333-8444-555555555555';
  const runsDir = () => join(DIR, '.xm', 'build', 'adaptive-runs');
  const failedFile = (id, session = SESSION) => join(runsDir(), `${id}.start-failed.${session}.json`);
  const failedFiles = () => (existsSync(runsDir()) ? readdirSync(runsDir()).filter(name => name.includes('.start-failed.')) : []);
  function decision({ confirm = true } = {}) {
    const decided = route(['decide', '--kind', 'bugfix', '--scope', 'bounded', '--independent', '--files', 'src/a.txt,src/b.txt', '--risk', 'low', '--failure-modes', '2', '--gates', 'test,boundary', '--json']);
    const { decision_id: id, route: selected } = JSON.parse(decided.stdout);
    expect(selected).toBe('direct');
    if (confirm) expect(route(['confirm', '--decision-id', id, '--host', 'claude', '--session-model', 'unknown', '--source', 'default']).status).toBe(0);
    return id;
  }
  function gitRepo() {
    const git = (...args) => expect(spawnSync('git', args, { cwd: DIR }).status).toBe(0);
    mkdirSync(join(DIR, 'src'));
    writeFileSync(join(DIR, 'src', 'a.txt'), 'v1\n');
    writeFileSync(join(DIR, '.gitignore'), '.xm/\n');
    git('init', '-q');
    git('add', '-A');
    git('-c', 'user.email=p@example.com', '-c', 'user.name=p', 'commit', '-qm', 'fixture');
  }
  // DIR is not a repository here, which is the failure the guard was built for.
  function failedStart() {
    const id = decision();
    const result = start(id, GATES);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is not in a git repository');
    return id;
  }

  test('blocks an Agent dispatch after route start failed in the same session', () => {
    const id = failedStart();
    const blocked = agentCall();
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain(`\`xm build route start\` failed for ${id}`);
    expect(blocked.stderr).toContain('is not in a git repository');
    // Abandon is named as the user's decision, with no ready-to-run line for the agent.
    expect(blocked.stderr).toContain("Giving up this run is the user's decision");
    expect(blocked.stderr).not.toContain('--decision-id');
  });

  test('allows another tool, another session, and a payload or a record with no session id', () => {
    failedStart();
    expect(agentCall({ tool_name: 'Bash' }).status).toBe(0);
    expect(agentCall({ session_id: OTHER }).status).toBe(0);
    expect(agentCall({ session_id: undefined }).status).toBe(0);
    rmSync(runsDir(), { recursive: true });
    const id = decision();
    expect(start(id, GATES, { CLAUDE_CODE_SESSION_ID: '' }).status).toBe(1);
    expect(JSON.parse(readFileSync(failedFile(id, 'no-session'), 'utf8')).session_id).toBeNull();
    expect(agentCall().status).toBe(0);
  });

  test('an error before the lease checks does not arm it', () => {
    const id = decision({ confirm: false });
    const result = start(id, GATES);
    expect(result.stderr).toContain('model routes are not confirmed');
    expect(failedFiles()).toEqual([]);
    expect(agentCall().status).toBe(0);
  });

  test('a retry of the same decision that starts releases it', () => {
    gitRepo();
    const id = decision();
    expect(start(id).stderr).toContain('missing gate commands: test, boundary');
    expect(agentCall().status).toBe(2);
    const retried = start(id, GATES);
    expect(retried.status, retried.stderr).toBe(0);
    expect(agentCall().status).toBe(0);
  });

  test('a later decision that starts releases it', () => {
    gitRepo();
    const first = decision();
    expect(start(first).status).toBe(1);
    expect(agentCall().status).toBe(2);
    const second = decision();
    expect(start(second, GATES).status).toBe(0);
    expect(existsSync(failedFile(first))).toBe(true);
    expect(agentCall().status).toBe(0);
  });

  // One record per decision and session. With one record per decision, the second session's
  // failure replaced the first session's record and released it with nothing fixed.
  test('another session that fails the same decision does not release the first, and abandons only its own', () => {
    gitRepo();
    const id = decision();
    expect(start(id).status).toBe(1);
    expect(start(id, [], { CLAUDE_CODE_SESSION_ID: OTHER }).status).toBe(1);
    expect(failedFiles().sort()).toEqual([`${id}.start-failed.${SESSION}.json`, `${id}.start-failed.${OTHER}.json`].sort());
    expect(agentCall().status).toBe(2);
    expect(agentCall({ session_id: OTHER }).status).toBe(2);
    expect(route(['abandon', '--decision-id', id], { CLAUDE_CODE_SESSION_ID: OTHER }).status).toBe(0);
    expect(agentCall({ session_id: OTHER }).status).toBe(0);
    expect(agentCall().status).toBe(2);
  });

  test('a start that succeeds releases every session that failed before it', () => {
    gitRepo();
    const id = decision();
    expect(start(id).status).toBe(1);
    expect(start(id, [], { CLAUDE_CODE_SESSION_ID: OTHER }).status).toBe(1);
    expect(agentCall().status).toBe(2);
    expect(agentCall({ session_id: OTHER }).status).toBe(2);
    expect(start(id, GATES, { CLAUDE_CODE_SESSION_ID: OTHER }).status).toBe(0);
    expect(agentCall().status).toBe(0);
    expect(agentCall({ session_id: OTHER }).status).toBe(0);
  });

  test('a session id from the environment is reduced to filename-safe characters', () => {
    const id = decision();
    expect(start(id, GATES, { CLAUDE_CODE_SESSION_ID: '../../escape me' }).status).toBe(1);
    expect(failedFiles()).toEqual([`${id}.start-failed.______escape_me.json`]);
    expect(agentCall({ session_id: '../../escape me' }).status).toBe(2);
  });

  test('route abandon drops a failed start that has no lease', () => {
    const id = failedStart();
    const dropped = route(['abandon', '--decision-id', id]);
    expect(dropped.status, dropped.stderr).toBe(0);
    expect(JSON.parse(dropped.stdout)).toMatchObject({ decision_id: id, status: 'start_abandoned' });
    expect(agentCall().status).toBe(0);
    const again = route(['abandon', '--decision-id', id]);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('execution lease not found');
  });

  test('a failed fallback start is released when its lease is abandoned', () => {
    gitRepo();
    const id = decision();
    expect(start(id, GATES).status).toBe(0);
    writeFileSync(join(DIR, 'src', 'a.txt'), 'v2\n');
    expect(route(['verify', '--decision-id', id]).status).toBe(2);
    const fallback = route(['start', '--decision-id', id, '--fallback', '--json']);
    expect(fallback.stderr).toContain('working tree must be clean before route start: src/a.txt');
    expect(agentCall().status).toBe(2);
    writeFileSync(join(DIR, 'src', 'a.txt'), 'v1\n');
    const abandoned = route(['abandon', '--decision-id', id]);
    expect(abandoned.status, abandoned.stderr).toBe(0);
    expect(JSON.parse(abandoned.stdout).status).toBe('abandoned');
    expect(agentCall().status).toBe(0);
  });

  test('a failed start older than a day is ignored', () => {
    const id = failedStart();
    expect(failedRouteStart([DIR], SESSION)).toMatchObject({ decision_id: id });
    expect(failedRouteStart([DIR], SESSION, Date.now() + 23 * 60 * 60 * 1000)).not.toBeNull();
    expect(failedRouteStart([DIR], SESSION, Date.now() + 25 * 60 * 60 * 1000)).toBeNull();
  });

  test('reads the state under the payload cwd when CLAUDE_PROJECT_DIR is another directory', () => {
    failedStart();
    const other = mkdtempSync(join(tmpdir(), 'xb-hooks-other-'));
    try {
      expect(agentCall({}, { CLAUDE_PROJECT_DIR: other }).status).toBe(2);
      expect(agentCall({ cwd: other }, { CLAUDE_PROJECT_DIR: other }).status).toBe(0);
    } finally { rmSync(other, { recursive: true, force: true }); }
  });

  // No X_BUILD_ROOT or XM_ROOT here: the CLI picks the state directory itself, and from a
  // subdirectory it picks the .xm of the git top level.
  test('finds the state the CLI wrote at the git top level when the session runs in a subdirectory', () => {
    gitRepo();
    const sub = join(DIR, 'src');
    const cli = (...args) => spawnSync('node', [CLI, 'route', ...args], {
      cwd: sub, encoding: 'utf8',
      env: { ...process.env, X_BUILD_ROOT: undefined, XM_ROOT: undefined, CLAUDE_CODE_SESSION_ID: SESSION, GIT_CEILING_DIRECTORIES: tmpdir() },
    });
    const id = JSON.parse(cli('decide', '--kind', 'bugfix', '--scope', 'bounded', '--independent', '--files', 'a.txt,b.txt', '--risk', 'low', '--failure-modes', '2', '--gates', 'test,boundary', '--json').stdout).decision_id;
    expect(cli('confirm', '--decision-id', id, '--host', 'claude', '--session-model', 'unknown', '--source', 'default').status).toBe(0);
    expect(cli('start', '--decision-id', id, '--expected-files', 'a.txt').stderr).toContain('missing gate commands');
    expect(existsSync(failedFile(id))).toBe(true);
    expect(existsSync(join(sub, '.xm'))).toBe(false);
    const blocked = agentCall({ cwd: sub }, { CLAUDE_PROJECT_DIR: sub });
    expect(blocked.status, blocked.stderr).toBe(2);
    expect(blocked.stderr).toContain(id);
  });

  test('the copy that hooks install writes blocks too', () => {
    failedStart();
    expect(runCli(['hooks', 'install']).status).toBe(0);
    const installed = runHook(join(DIR, '.claude', 'hooks', 'xm-build-lease-guard.mjs'), { tool_name: 'Agent', session_id: SESSION, cwd: DIR });
    expect(installed.status, installed.stderr).toBe(2);
    expect(installed.stderr).toContain('blocked by xm-build-lease-guard');
  });

  test('fail-open: XM_BUILD_HOOKS_OFF=1 and malformed stdin', () => {
    failedStart();
    expect(agentCall({}, { XM_BUILD_HOOKS_OFF: '1' }).status).toBe(0);
    expect(runHook(LEASE_HOOK, 'not json').status).toBe(0);
  });
});
