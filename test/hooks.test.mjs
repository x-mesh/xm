/**
 * blocking-hooks (빅뱃4) — hook-state unit + scope-guard/stop-gate/CLI integration.
 * Hooks are disk-only + fail-open; these lock the block/allow decisions and the
 * non-destructive, idempotent settings.json merge.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reviewFixState, isProtectedPath, isAllowed } from '../x-build/templates/hooks/hook-state.mjs';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'x-build', 'lib', 'x-build-cli.mjs');
const SCOPE_HOOK = join(ROOT, 'x-build', 'templates', 'hooks', 'xm-build-scope-guard.mjs');
const STOP_HOOK = join(ROOT, 'x-build', 'templates', 'hooks', 'xm-build-stop-gate.mjs');

const ACTIVE_TRIAGE = {
  target_findings: [{ id: 'F1', severity: 'critical', file: 'src/auth.ts', summary: 'SQLi', decision: 'fix_now' }],
  fix_scope: { allowed_files: ['src/auth.ts'] },
};

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
  test('LGTM verdict clears unresolvedBlocking (fix + re-review auto-clears)', () => {
    writeTriage(ACTIVE_TRIAGE); writeResult({ verdict: 'LGTM' });
    const s = reviewFixState(DIR);
    expect(s.active).toBe(true);              // still in progress
    expect(s.unresolvedBlocking).toHaveLength(0); // but nothing blocks a stop
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
  test('isProtectedPath: .xm always protected, source never', () => {
    expect(isProtectedPath('.xm/review/triage.json')).toBe(true);
    expect(isProtectedPath('.xm/build/projects/p/later.json')).toBe(true);
    expect(isProtectedPath('src/auth.ts')).toBe(false);
  });
  test('isAllowed: repo-relative membership', () => {
    expect(isAllowed('src/auth.ts', DIR, ['src/auth.ts'])).toBe(true);
    expect(isAllowed(join(DIR, 'src/auth.ts'), DIR, ['src/auth.ts'])).toBe(true); // absolute input
    expect(isAllowed('src/other.ts', DIR, ['src/auth.ts'])).toBe(false);
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
  test('allows a .xm state edit (protected — never self-lock)', () => {
    expect(runHook(SCOPE_HOOK, { tool_name: 'Edit', tool_input: { file_path: '.xm/review/triage.json' } }).status).toBe(0);
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
    writeTriage(ACTIVE_TRIAGE); writeResult({ verdict: 'LGTM' });
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
    expect(runCli(['hooks', 'status']).status).toBe(0); // installed
    expect(runCli(['hooks', 'install']).stdout).toContain('0 settings entries added'); // idempotent

    let s = JSON.parse(readFileSync(join(DIR, '.claude', 'settings.json'), 'utf8'));
    expect(s.hooks.PreToolUse.some(e => e.hooks.some(h => h.command === 'node existing.mjs'))).toBe(true); // existing kept
    expect(s.hooks.PreToolUse.some(e => e.hooks.some(h => h.command.includes('scope-guard')))).toBe(true);
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
