import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import {
  mkdtempSync, mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync,
  existsSync, statSync, unlinkSync, chmodSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as merge from '../xm/lib/install/merge.mjs';
import { LOCK_TTL_MS } from '../xm/lib/install/types.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const CLI = join(REPO, 'xm', 'lib', 'install', 'install-cli.mjs');
const SKILLS = join(REPO, 'xm', 'skills');
const LIB = join(REPO, 'xm', 'lib');

function run(args, opts = {}) {
  const result = spawnSync('node', [CLI, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

function seedTmp() {
  const tmp = mkdtempSync(join(tmpdir(), 'xm-install-'));
  mkdirSync(join(tmp, '.claude'), { recursive: true });
  copyFileSync(join(REPO, '.claude', 'settings.json'), join(tmp, '.claude', 'settings.json'));
  return tmp;
}

function hashDir(dir) {
  if (!existsSync(dir)) return '';
  return readdirSync(dir, { recursive: true }).sort().map((f) => {
    const fp = join(dir, f);
    if (!existsSync(fp) || !statSync(fp).isFile()) return '';
    return f + ':' + createHash('sha256').update(readFileSync(fp)).digest('hex').slice(0, 12);
  }).filter(Boolean).join('|');
}

describe('install-cli — input validation (R-SEC-04)', () => {
  test('--target unknown rejected', () => {
    const r = run(['--target', 'evil', '--skills-dir', SKILLS, '--lib-dir', LIB]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unknown target/i);
  });
  test('--target with shell metacharacter rejected', () => {
    const r = run(['--target', 'cursor;rm', '--skills-dir', SKILLS, '--lib-dir', LIB]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/shell metacharacters|forbidden/i);
  });
});

describe('install-cli — --list and --dry-run (no fs writes)', () => {
  test('--list produces 4-target plan, no fs side effects', () => {
    const tmp = seedTmp();
    const r = run(['--list', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/# cursor/);
    expect(r.stdout).toMatch(/# codex/);
    expect(r.stdout).toMatch(/# kiro/);
    expect(r.stdout).toMatch(/# antigravity/);
    expect(existsSync(join(tmp, '.cursor'))).toBe(false);
    expect(existsSync(join(tmp, '.codex'))).toBe(false);
  });
  test('--dry-run leaves fs untouched', () => {
    const tmp = seedTmp();
    run(['--dry-run', '--target', 'cursor', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    expect(existsSync(join(tmp, '.cursor'))).toBe(false);
  });
});

describe('install-cli — install + idempotency (SC1, SC5)', () => {
  test('installs cursor: 39 .mdc + hooks.json', () => {
    const tmp = seedTmp();
    const r = run(['--target', 'cursor', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    expect(r.status).toBe(0);
    const rules = readdirSync(join(tmp, '.cursor', 'rules')).filter((f) => f.endsWith('.mdc'));
    expect(rules.length).toBe(39);
    expect(existsSync(join(tmp, '.cursor', 'hooks.json'))).toBe(true);
  });
  test('idempotent: re-run produces zero diff', () => {
    const tmp = seedTmp();
    run(['--target', 'cursor', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    const before = hashDir(join(tmp, '.cursor', 'rules'));
    const r = run(['--target', 'cursor', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    const after = hashDir(join(tmp, '.cursor', 'rules'));
    expect(after).toBe(before);
    expect(r.stdout).toMatch(/unchanged: \d+/);
  });
  test('codex AGENTS.md ≤ 16 KiB index + 16 prompts', () => {
    const tmp = seedTmp();
    run(['--target', 'codex', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    expect(statSync(join(tmp, 'AGENTS.md')).size).toBeLessThanOrEqual(16 * 1024);
    expect(readdirSync(join(tmp, '.codex', 'prompts')).length).toBe(16);
  });
  test('kiro steering inclusion: 16 auto + 23 manual', () => {
    const tmp = seedTmp();
    run(['--target', 'kiro', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    const files = readdirSync(join(tmp, '.kiro', 'steering'));
    expect(files.length).toBe(39);
    const counts = files.map((f) => (readFileSync(join(tmp, '.kiro', 'steering', f), 'utf8').match(/^inclusion: (\w+)/m) || [, '?'])[1])
      .reduce((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
    expect(counts.auto).toBe(16);
    expect(counts.manual).toBe(23);
  });
  test('antigravity AGENTS.md shared with codex + 16 .agent/skills', () => {
    const tmp = seedTmp();
    run(['--target', 'codex,antigravity', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    expect(readdirSync(tmp).filter((f) => f === 'AGENTS.md').length).toBe(1);
    expect(readdirSync(join(tmp, '.agent', 'skills')).length).toBe(16);
  });
});

describe('install-cli — supply-chain guard (R-SEC-02)', () => {
  test('mismatched checksum aborts install', () => {
    const tmp = seedTmp();
    const fakeSkillsRoot = mkdtempSync(join(tmpdir(), 'xm-fake-skills-'));
    const fakeSkills = join(fakeSkillsRoot, 'skills');
    mkdirSync(join(fakeSkills, 'handoff'), { recursive: true });
    copyFileSync(join(SKILLS, 'handoff', 'SKILL.md'), join(fakeSkills, 'handoff', 'SKILL.md'));
    writeFileSync(join(fakeSkillsRoot, 'skills.checksums.json'), JSON.stringify({
      version: 1,
      skills: [{ plugin: 'handoff', sha256: '0'.repeat(64), bytes: 0 }],
    }));
    const r = run(['--target', 'cursor', '--skills-dir', fakeSkills, '--lib-dir', LIB, '--list'], { cwd: tmp });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/R-SEC-02/);
  });
  test('--allow-unverified bypasses checksum guard', () => {
    const tmp = seedTmp();
    const fakeSkillsRoot = mkdtempSync(join(tmpdir(), 'xm-fake-skills-'));
    const fakeSkills = join(fakeSkillsRoot, 'skills');
    mkdirSync(join(fakeSkills, 'handoff'), { recursive: true });
    copyFileSync(join(SKILLS, 'handoff', 'SKILL.md'), join(fakeSkills, 'handoff', 'SKILL.md'));
    writeFileSync(join(fakeSkillsRoot, 'skills.checksums.json'), JSON.stringify({
      version: 1,
      skills: [{ plugin: 'handoff', sha256: '0'.repeat(64), bytes: 0 }],
    }));
    const r = run(['--target', 'cursor', '--skills-dir', fakeSkills, '--lib-dir', LIB, '--list', '--allow-unverified'], { cwd: tmp });
    expect(r.status).toBe(0);
  });
});

describe('install-cli — verify (SC8/SC17)', () => {
  test('fresh install verifies clean', () => {
    const tmp = seedTmp();
    run(['--target', 'cursor', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    const r = run(['--verify', '--target', 'cursor'], { cwd: tmp });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/selfChecksum: ok/);
  });
  test('tampered file flagged', () => {
    const tmp = seedTmp();
    run(['--target', 'cursor', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    writeFileSync(join(tmp, '.cursor', 'rules', 'xm-build.mdc'), 'tampered\n');
    const r = run(['--verify', '--target', 'cursor'], { cwd: tmp });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/changed/);
  });
  test('missing file flagged', () => {
    const tmp = seedTmp();
    run(['--target', 'cursor', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    unlinkSync(join(tmp, '.cursor', 'rules', 'xm-handoff.mdc'));
    const r = run(['--verify', '--target', 'cursor'], { cwd: tmp });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/missing/);
  });
});

describe('install-cli — uninstall (SC6)', () => {
  test('removes xm files, preserves user content in AGENTS.md', () => {
    const tmp = seedTmp();
    writeFileSync(join(tmp, 'AGENTS.md'), '# my own\n\nuser notes\n');
    run(['--target', 'codex,antigravity,cursor,kiro', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    const r = run(['--uninstall', '--target', 'codex,antigravity,cursor,kiro'], { cwd: tmp });
    expect(r.status).toBe(0);
    expect(existsSync(join(tmp, 'AGENTS.md'))).toBe(true);
    expect(readFileSync(join(tmp, 'AGENTS.md'), 'utf8')).toMatch(/user notes/);
    expect(readFileSync(join(tmp, 'AGENTS.md'), 'utf8')).not.toMatch(/xm:BEGIN/);
    const cursorRulesAfter = existsSync(join(tmp, '.cursor', 'rules'))
      ? readdirSync(join(tmp, '.cursor', 'rules')).filter((f) => f.startsWith('xm-')).length
      : 0;
    expect(cursorRulesAfter).toBe(0);
  });
  test('preserves external .cursor file added after install', () => {
    const tmp = seedTmp();
    run(['--target', 'cursor', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    writeFileSync(join(tmp, '.cursor', 'rules', 'my-personal.mdc'), '# mine\n');
    run(['--uninstall', '--target', 'cursor'], { cwd: tmp });
    expect(existsSync(join(tmp, '.cursor', 'rules', 'my-personal.mdc'))).toBe(true);
  });
});

describe('install-cli — file permissions (R-SEC-08, SC15, t24)', () => {
  test('local install sets 0o644 on rule files', () => {
    const tmp = seedTmp();
    run(['--target', 'cursor', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    const mode = statSync(join(tmp, '.cursor', 'rules', 'xm-build.mdc')).mode & 0o777;
    expect(mode).toBe(0o644);
  });
  test('verify flags chmod-tampered file', () => {
    const tmp = seedTmp();
    run(['--target', 'cursor', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    const f = join(tmp, '.cursor', 'rules', 'xm-handoff.mdc');
    chmodSync(f, 0o666);
    const r = run(['--verify', '--target', 'cursor'], { cwd: tmp });
    expect(r.stdout).toMatch(/mode mismatch/);
  });
});

// H8 (tests review): merge.mjs lock + symlink + bak unit coverage.
describe('merge.mjs — lock and symlink unit (H8)', () => {
  test('acquireLock contention throws then release succeeds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'merge-lock-'));
    const f = join(dir, 'x.txt');
    writeFileSync(f, 'a');
    const release = merge.acquireLock(f);
    expect(() => merge.acquireLock(f)).toThrow(/lock held|lock contention/);
    release();
    expect(existsSync(f + '.lock')).toBe(false);
  });

  test('acquireLock takes over stale lock past TTL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'merge-stale-'));
    const f = join(dir, 'y.txt');
    writeFileSync(f, 'b');
    writeFileSync(f + '.lock', JSON.stringify({ pid: 99999, timestamp: 0, hostname: 'old' }));
    const release = merge.acquireLock(f, { ttlMs: LOCK_TTL_MS, now: LOCK_TTL_MS + 1 });
    release();
  });

  test('rotateBackup refuses symlink (R-SEC-05)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'merge-symlink-'));
    const real = join(dir, 'real.txt');
    const link = join(dir, 'link.txt');
    writeFileSync(real, 'real');
    symlinkSync(real, link);
    expect(() => merge.rotateBackup(link)).toThrow(/symlink/i);
  });
});

// H9 (tests review): manifest selfChecksum tamper + path-traversal entry detection.
describe('manifest — selfChecksum tamper (H9 + H1)', () => {
  test('--verify reports selfChecksum FAIL on hand-edited manifest body', () => {
    const tmp = seedTmp();
    run(['--target', 'cursor', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    const mp = join(tmp, '.cursor', 'xm', 'manifest.json');
    const m = JSON.parse(readFileSync(mp, 'utf8'));
    m.files[0].sha256 = 'a'.repeat(64);
    writeFileSync(mp, JSON.stringify(m, null, 2));
    const r = run(['--verify', '--target', 'cursor'], { cwd: tmp });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/selfChecksum: FAIL/);
    expect(r.stdout).toMatch(/manifest.json may have been edited/);
  });

  test('--verify rejects path-traversal entry in tampered manifest (security H1)', () => {
    const tmp = seedTmp();
    run(['--target', 'cursor', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    const mp = join(tmp, '.cursor', 'xm', 'manifest.json');
    const m = JSON.parse(readFileSync(mp, 'utf8'));
    m.files.push({
      relativePath: '../../../etc/passwd',
      sha256: 'b'.repeat(64),
      bytes: 1,
      mode: 0o644,
      installedAt: Date.now(),
    });
    writeFileSync(mp, JSON.stringify(m, null, 2));
    const r = run(['--verify', '--target', 'cursor'], { cwd: tmp });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/refused/);
    // The refused message echoes the untrusted relativePath (audit trail) but
    // must not include the resolved absolute path that would leak filesystem
    // structure outside installRoot.
    expect(r.stdout).not.toMatch(/^\/etc\/passwd|\s\/etc\/passwd/m);
  });
});

// H10 (tests review): --global scope (Cursor 2.4 Skills layout, mode 0o600).
describe('install-cli — --global scope (H10)', () => {
  test('cursor --global writes Skills layout under HOME with 0o600', () => {
    const tmp = seedTmp();
    const fakeHome = join(tmp, 'fakehome');
    mkdirSync(fakeHome, { recursive: true });
    const result = spawnSync('node', [CLI, '--target', 'cursor', '--global',
      '--skills-dir', SKILLS, '--lib-dir', LIB], {
      cwd: tmp,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, HOME: fakeHome },
    });
    expect(result.status).toBe(0);
    const skillFile = join(fakeHome, '.cursor', 'skills', 'xm-build', 'SKILL.md');
    expect(existsSync(skillFile)).toBe(true);
    const mode = statSync(skillFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
