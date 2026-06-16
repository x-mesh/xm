import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import {
  mkdtempSync, mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync,
  existsSync, statSync, unlinkSync, chmodSync, symlinkSync, cpSync, realpathSync,
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
    input: opts.input,
    env: opts.env ?? process.env,
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

const EXPECTED_SKILL_COUNT = readdirSync(SKILLS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(SKILLS, entry.name, 'SKILL.md')))
  .length;
const EXPECTED_REFERENCE_COUNT = readdirSync(SKILLS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(SKILLS, entry.name, 'SKILL.md')))
  .reduce((count, entry) => {
    const refsDir = join(SKILLS, entry.name, 'references');
    if (!existsSync(refsDir)) return count;
    return count + readdirSync(refsDir, { recursive: true })
      .filter((file) => file.endsWith('.md') && statSync(join(refsDir, file)).isFile())
      .length;
  }, 0);
const EXPECTED_CURSOR_RULE_COUNT = EXPECTED_SKILL_COUNT + EXPECTED_REFERENCE_COUNT;
const EXPECTED_KIRO_MANUAL_COUNT = EXPECTED_CURSOR_RULE_COUNT - EXPECTED_SKILL_COUNT;

describe('install-cli — input validation (R-SEC-04)', () => {
  test('help does not advertise reserved --auto-detect', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('--auto-detect');
  });
  test('--auto-detect fails loudly until implemented', () => {
    const r = run(['--auto-detect', '--skills-dir', SKILLS, '--lib-dir', LIB]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/reserved and not implemented/);
  });
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
  test('--list produces 5-target plan, no fs side effects', () => {
    const tmp = seedTmp();
    const r = run(['--list', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/# cursor/);
    expect(r.stdout).toMatch(/# codex/);
    expect(r.stdout).toMatch(/# kiro/);
    expect(r.stdout).toMatch(/# antigravity/);
    expect(r.stdout).toMatch(/# opencode/);
    expect(r.stdout).not.toMatch(/CLI reference\(s\) point to missing files/);
    expect(existsSync(join(tmp, '.cursor'))).toBe(false);
    expect(existsSync(join(tmp, '.codex'))).toBe(false);
    expect(existsSync(join(tmp, '.opencode'))).toBe(false);
  });
  test('--dry-run leaves fs untouched', () => {
    const tmp = seedTmp();
    run(['--dry-run', '--target', 'cursor', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    expect(existsSync(join(tmp, '.cursor'))).toBe(false);
  });
});

describe('install-cli — install + idempotency (SC1, SC5)', () => {
  test('installs cursor rules and hooks.json', () => {
    const tmp = seedTmp();
    const r = run(['--target', 'cursor', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    expect(r.status).toBe(0);
    const rules = readdirSync(join(tmp, '.cursor', 'rules')).filter((f) => f.endsWith('.mdc'));
    expect(rules.length).toBe(EXPECTED_CURSOR_RULE_COUNT);
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
  test('codex AGENTS.md ≤ 16 KiB index + prompts', () => {
    const tmp = seedTmp();
    const r = run(['--target', 'codex', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    expect(statSync(join(tmp, 'AGENTS.md')).size).toBeLessThanOrEqual(16 * 1024);
    expect(readdirSync(join(tmp, '.codex', 'prompts')).length).toBe(EXPECTED_SKILL_COUNT);
    expect(r.stdout).toContain('codex features enable hooks');
    expect(r.stdout).toContain('[features] hooks = true');
    expect(r.stdout).not.toContain('codex config set features.codex_hooks true');
    expect(r.stdout).not.toContain('codex_hooks');
  });
  test('kiro steering inclusion matches skill and reference counts', () => {
    const tmp = seedTmp();
    run(['--target', 'kiro', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    const files = readdirSync(join(tmp, '.kiro', 'steering'));
    expect(files.length).toBe(EXPECTED_CURSOR_RULE_COUNT);
    const counts = files.map((f) => (readFileSync(join(tmp, '.kiro', 'steering', f), 'utf8').match(/^inclusion: (\w+)/m) || [, '?'])[1])
      .reduce((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
    expect(counts.auto).toBe(EXPECTED_SKILL_COUNT);
    expect(counts.manual).toBe(EXPECTED_KIRO_MANUAL_COUNT);
  });
  test('antigravity AGENTS.md shared with codex + .agent/skills', () => {
    const tmp = seedTmp();
    run(['--target', 'codex,antigravity', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    expect(readdirSync(tmp).filter((f) => f === 'AGENTS.md').length).toBe(1);
    expect(readdirSync(join(tmp, '.agent', 'skills')).length).toBe(EXPECTED_SKILL_COUNT);
  });
  test('opencode writes native SKILL.md files with frontmatter', () => {
    const tmp = seedTmp();
    const r = run(['--target', 'opencode', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    expect(r.status).toBe(0);
    const skills = readdirSync(join(tmp, '.opencode', 'skills'));
    expect(skills.length).toBe(EXPECTED_SKILL_COUNT);
    const skillFile = join(tmp, '.opencode', 'skills', 'xm-build', 'SKILL.md');
    expect(readFileSync(skillFile, 'utf8')).toMatch(/^---\nname: "xm-build"\ndescription: /);
    expect(existsSync(join(tmp, '.opencode', 'xm', 'lib', 'x-build-cli.mjs'))).toBe(true);
    expect(existsSync(join(tmp, '.opencode', 'xm', 'manifest.json'))).toBe(true);
  });
});

describe('install-cli — interactive selection', () => {
  test('--interactive prompts for global scope and selected targets', () => {
    const tmp = seedTmp();
    const fakeHome = join(tmp, 'fakehome');
    mkdirSync(fakeHome, { recursive: true });

    const r = run(['--interactive', '--skills-dir', SKILLS, '--lib-dir', LIB], {
      cwd: tmp,
      input: '2\n1,5\n',
      env: { ...process.env, HOME: fakeHome },
    });

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/xm install interactive/);
    expect(r.stdout).toMatch(/Selected: global -> cursor, opencode/);
    expect(r.stdout).toMatch(/# cursor \(global\)/);
    expect(r.stdout).toMatch(/# opencode \(global\)/);
    expect(r.stdout).not.toMatch(/# codex \(global\)/);
    expect(existsSync(join(fakeHome, '.cursor', 'skills', 'xm-build', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(fakeHome, '.config', 'opencode', 'skills', 'xm-build', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(fakeHome, '.config', 'opencode', 'xm', 'lib', 'x-build-cli.mjs'))).toBe(true);
  });

  test('--interactive with empty stdin fails instead of installing defaults', () => {
    const tmp = seedTmp();
    const r = run(['--interactive', '--skills-dir', SKILLS, '--lib-dir', LIB], {
      cwd: tmp,
      input: '',
    });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/requires terminal input/);
    expect(existsSync(join(tmp, '.cursor'))).toBe(false);
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
    run(['--target', 'codex,antigravity,cursor,kiro,opencode', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    const r = run(['--uninstall', '--target', 'codex,antigravity,cursor,kiro,opencode'], { cwd: tmp });
    expect(r.status).toBe(0);
    expect(existsSync(join(tmp, 'AGENTS.md'))).toBe(true);
    expect(readFileSync(join(tmp, 'AGENTS.md'), 'utf8')).toMatch(/user notes/);
    expect(readFileSync(join(tmp, 'AGENTS.md'), 'utf8')).not.toMatch(/xm:BEGIN/);
    const cursorRulesAfter = existsSync(join(tmp, '.cursor', 'rules'))
      ? readdirSync(join(tmp, '.cursor', 'rules')).filter((f) => f.startsWith('xm-')).length
      : 0;
    expect(cursorRulesAfter).toBe(0);
    const opencodeSkillsAfter = existsSync(join(tmp, '.opencode', 'skills'))
      ? readdirSync(join(tmp, '.opencode', 'skills'))
        .filter((f) => f.startsWith('xm-') && existsSync(join(tmp, '.opencode', 'skills', f, 'SKILL.md')))
        .length
      : 0;
    expect(opencodeSkillsAfter).toBe(0);
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

// Layout auto-detection: install-cli must default skills/lib paths correctly
// in BOTH the source-repo layout (HERE/../../..) AND the marketplace plugin
// cache layout (HERE/../..), where the cache inserts a version directory.
// Regression: previously `../../..` jumped one level too high in the cache,
// producing "skillsDir not found: .../xm/xm/skills" when invoked via `xm install`.
describe('install-cli — layout auto-detection', () => {
  test('plugin-cache layout: <root>/lib/install + <root>/skills resolves without --skills-dir', () => {
    // realpathSync collapses macOS /var → /private/var so install-cli's
    // invokedDirectly guard (which compares argv[1] against import.meta.url)
    // matches; otherwise the script imports cleanly and exits silently.
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'xm-cache-layout-')));
    cpSync(join(LIB, 'install'), join(tmp, 'lib', 'install'), { recursive: true });
    cpSync(SKILLS, join(tmp, 'skills'), { recursive: true });
    copyFileSync(join(REPO, 'xm', 'skills.checksums.json'), join(tmp, 'skills.checksums.json'));
    const cli = join(tmp, 'lib', 'install', 'install-cli.mjs');
    const r = spawnSync('node', [cli, '--list'], { encoding: 'utf8', timeout: 30_000 });
    expect(r.stderr).not.toMatch(/skillsDir not found/);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/# cursor/);
  });

  test('source-repo layout: HERE/../../.. with xm/skills still resolves without --skills-dir', () => {
    const r = spawnSync('node', [CLI, '--list'], { encoding: 'utf8', timeout: 30_000 });
    expect(r.stderr).not.toMatch(/skillsDir not found/);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/# cursor/);
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
  test('opencode --global writes Skills layout under ~/.config/opencode with 0o600', () => {
    const tmp = seedTmp();
    const fakeHome = join(tmp, 'fakehome');
    mkdirSync(fakeHome, { recursive: true });
    const result = spawnSync('node', [CLI, '--target', 'opencode', '--global',
      '--skills-dir', SKILLS, '--lib-dir', LIB], {
      cwd: tmp,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, HOME: fakeHome },
    });
    expect(result.status).toBe(0);
    const skillFile = join(fakeHome, '.config', 'opencode', 'skills', 'xm-build', 'SKILL.md');
    expect(existsSync(skillFile)).toBe(true);
    const mode = statSync(skillFile).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(existsSync(join(fakeHome, '.config', 'opencode', 'xm', 'manifest.json'))).toBe(true);
  });
});

// Task 5.1: Kiro hook schema validation (kiro-xm-compatibility)
// Validates: Requirements 8.1, 8.2, 8.3, 8.4
describe('install-cli — Kiro hook schema validation (kiro-xm-compatibility)', () => {
  test('kiro hooks have correct schema: toolTypes array, semver version, no enabled, no when.tool', () => {
    const tmp = seedTmp();
    const r = run(['--target', 'kiro', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    expect(r.status).toBe(0);

    const hooksDir = join(tmp, '.kiro', 'hooks');
    expect(existsSync(hooksDir)).toBe(true);

    const hookFiles = readdirSync(hooksDir).filter(f => f.endsWith('.kiro.hook'));
    expect(hookFiles.length).toBeGreaterThan(0);

    const TOOL_EVENTS = new Set(['preToolUse', 'postToolUse']);
    const FILE_EVENTS = new Set(['fileEdited', 'fileCreated', 'fileDeleted']);

    for (const file of hookFiles) {
      const content = readFileSync(join(hooksDir, file), 'utf8');
      const hook = JSON.parse(content);

      // version is semver
      expect(hook.version).toMatch(/^\d+\.\d+\.\d+$/);
      // no enabled field
      expect(hook).not.toHaveProperty('enabled');
      // no when.tool (old schema)
      expect(hook.when).not.toHaveProperty('tool');

      // Field shape per event category — tool events have toolTypes, file
      // events have patterns, other events have neither.
      const eventType = hook.when.type;
      if (TOOL_EVENTS.has(eventType)) {
        expect(Array.isArray(hook.when.toolTypes)).toBe(true);
        hook.when.toolTypes.forEach(t => expect(typeof t).toBe('string'));
        expect(hook.when.patterns).toBeUndefined();
      } else if (FILE_EVENTS.has(eventType)) {
        expect(Array.isArray(hook.when.patterns)).toBe(true);
        hook.when.patterns.forEach(p => expect(typeof p).toBe('string'));
        expect(hook.when.toolTypes).toBeUndefined();
      } else {
        expect(hook.when.toolTypes).toBeUndefined();
        expect(hook.when.patterns).toBeUndefined();
      }
    }
  });

  // Task 5.2: Kiro steering frontmatter validation
  // Validates: Requirements 8.5
  test('kiro steering frontmatter has no name: field', () => {
    const tmp = seedTmp();
    const r = run(['--target', 'kiro', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    expect(r.status).toBe(0);

    const steeringDir = join(tmp, '.kiro', 'steering');
    const files = readdirSync(steeringDir).filter(f => f.endsWith('.md'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = readFileSync(join(steeringDir, file), 'utf8');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        expect(fmMatch[1]).not.toMatch(/^name:/m);
      }
    }
  });

  // Task 5.3: Trace-session best-effort hook generation validation
  // Validates: Requirements 6.1, 6.2
  test('trace-session Skill matcher hooks are generated as best-effort (not skipped)', () => {
    const tmp = seedTmp();
    const r = run(['--target', 'kiro', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    expect(r.status).toBe(0);

    const hooksDir = join(tmp, '.kiro', 'hooks');
    const hookFiles = readdirSync(hooksDir).filter(f => f.endsWith('.kiro.hook'));

    // Find hooks that contain trace-session in their command
    const traceHooks = hookFiles.filter(f => {
      const content = readFileSync(join(hooksDir, f), 'utf8');
      return content.includes('trace-session');
    });

    // Should have at least one trace-session hook (was previously skipped)
    expect(traceHooks.length).toBeGreaterThan(0);

    // Each trace-session hook should have best-effort in description and
    // explicitly explain why (Skill matcher has no Kiro equivalent).
    for (const file of traceHooks) {
      const hook = JSON.parse(readFileSync(join(hooksDir, file), 'utf8'));
      expect(hook.description).toContain('best-effort');
      expect(hook.description).toContain('Kiro has no Skill matcher');
      expect(hook.description).toContain('Original Claude hook targeted Skill matcher');
      expect(hook.when.toolTypes).toEqual(['*']);
    }
  });
});
