/**
 * blocking-hooks (빅뱃4) — hook-state unit + scope-guard/stop-gate/CLI integration.
 * Hooks are disk-only + fail-open; these lock the block/allow decisions and the
 * non-destructive, idempotent settings.json merge.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reviewFixState, isProtectedPath, isAllowed } from '../x-build/templates/hooks/hook-state.mjs';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'x-build', 'lib', 'x-build-cli.mjs');
const SCOPE_HOOK = join(ROOT, 'x-build', 'templates', 'hooks', 'xm-build-scope-guard.mjs');
const STOP_HOOK = join(ROOT, 'x-build', 'templates', 'hooks', 'xm-build-stop-gate.mjs');

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
    expect(runHook(STOP_HOOK, {}, { XM_BUILD_HOOKS_OFF: 'false' }).status).toBe(2);
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
  test('blocks with an unresolved Critical fix_now (exit 2)', () => {
    writeTriage(ACTIVE_TRIAGE); writeResult({ verdict: 'Request Changes' });
    const r = runHook(STOP_HOOK, {});
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unresolved Critical/High');
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
    expect(runCli(['hooks', 'status']).status).toBe(0); // installed
    expect(runCli(['hooks', 'install']).stdout).toContain('0 settings entries added'); // idempotent

    let s = JSON.parse(readFileSync(join(DIR, '.claude', 'settings.json'), 'utf8'));
    expect(s.hooks.PreToolUse.some(e => e.hooks.some(h => h.command === 'node existing.mjs'))).toBe(true); // existing kept
    expect(s.hooks.PreToolUse.some(e => e.hooks.some(h => h.command.includes('scope-guard')))).toBe(true);
    expect(s.hooks.PreToolUse.some(e => e.matcher === 'Agent' && e.hooks.some(h => h.command.includes('block-when-over-budget')))).toBe(true);
    expect(s.hooks.Stop.some(e => e.hooks.some(h => h.command.includes('stop-gate')))).toBe(true);

    expect(runCli(['hooks', 'uninstall']).status).toBe(0);
    s = JSON.parse(readFileSync(join(DIR, '.claude', 'settings.json'), 'utf8'));
    expect(s.hooks.PreToolUse.some(e => e.hooks.some(h => h.command === 'node existing.mjs'))).toBe(true); // still kept
    expect(s.hooks.PreToolUse.some(e => e.hooks.some(h => h.command.includes('scope-guard')))).toBe(false); // ours removed
    expect(s.hooks.Stop).toBeUndefined(); // emptied → removed
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
