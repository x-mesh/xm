import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// `xm setup --claude-md` owns one marker block in the user's global CLAUDE.md.
// The file is the user's, so the block is opt-in, refreshed only while it
// exists, and never costs the user an existing backup or line outside it.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SETUP = join(REPO, 'xm', 'scripts', 'setup-global.mjs');
const TEMPLATE = join(REPO, 'xm', 'templates', 'claude-routing.md');
const BEGIN = '<!-- xm:routing:begin';
const END = '<!-- xm:routing:end -->';

const { XM_LIB: _xmLib, X_KIT_LIB: _xKitLib, ...BASE_ENV } = process.env;

let home;
let claudeMd;

function setup(...args) {
  return spawnSync('node', [SETUP, ...args], {
    cwd: REPO,
    env: { ...BASE_ENV, HOME: home, XM_BIN_DIR: join(home, 'bin') },
    encoding: 'utf8',
  });
}

const backups = () => readdirSync(join(home, '.claude')).filter((f) => f.startsWith('CLAUDE.md.backup-'));
const blockBody = (text) => text.slice(text.indexOf('\n', text.indexOf(BEGIN)) + 1, text.indexOf(END));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'xm-setup-claude-md-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  claudeMd = join(home, '.claude', 'CLAUDE.md');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('xm setup --claude-md', () => {
  test('a bare install never adds the block', () => {
    expect(setup('install', '--no-hooks').status).toBe(0);
    expect(existsSync(claudeMd)).toBe(false);

    writeFileSync(claudeMd, '# Mine\n');
    expect(setup('install', '--no-hooks').status).toBe(0);
    expect(readFileSync(claudeMd, 'utf8')).toBe('# Mine\n');
    expect(backups()).toEqual([]);
  });

  test('opting in appends the template and keeps the user text', () => {
    writeFileSync(claudeMd, '# Mine\n\nkeep me\n');
    const r = setup('--claude-md', '--no-hooks');
    expect(r.status).toBe(0);
    const text = readFileSync(claudeMd, 'utf8');
    expect(text.startsWith('# Mine\n\nkeep me\n')).toBe(true);
    expect(blockBody(text).trimEnd()).toBe(readFileSync(TEMPLATE, 'utf8').trimEnd());
    expect(backups().length).toBe(1);
  });

  test('re-running leaves the file and the backups alone', () => {
    writeFileSync(claudeMd, '# Mine\n');
    setup('--claude-md', '--no-hooks');
    const once = readFileSync(claudeMd, 'utf8');
    setup('install', '--no-hooks', '--claude-md');
    setup('install', '--no-hooks');
    expect(readFileSync(claudeMd, 'utf8')).toBe(once);
    expect(backups().length).toBe(1);
  });

  test('a half-deleted block fails visibly and leaves the file alone', () => {
    writeFileSync(claudeMd, '# Mine\n');
    setup('--claude-md', '--no-hooks');
    const broken = readFileSync(claudeMd, 'utf8').replace(END, '');
    writeFileSync(claudeMd, broken);
    const r = setup('install', '--no-hooks');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('marker mismatch');
    expect(readFileSync(claudeMd, 'utf8')).toBe(broken);
  });

  test('a bare install replaces an outdated block body', () => {
    writeFileSync(claudeMd, '# Mine\n');
    setup('--claude-md', '--no-hooks');
    const fresh = readFileSync(claudeMd, 'utf8');
    writeFileSync(claudeMd, fresh.replace('### Shared rules', '### Old rules'));
    expect(setup('install', '--no-hooks').status).toBe(0);
    expect(readFileSync(claudeMd, 'utf8')).toBe(fresh);
  });

  test('a user .bak survives repeated block changes', () => {
    writeFileSync(claudeMd, '# Mine\n');
    writeFileSync(`${claudeMd}.bak`, 'user backup\n');
    setup('--claude-md', '--no-hooks');
    for (let i = 0; i < 4; i += 1) {
      writeFileSync(claudeMd, readFileSync(claudeMd, 'utf8').replace('### Shared rules', `### Old ${i}`));
      setup('install', '--no-hooks');
    }
    expect(readFileSync(`${claudeMd}.bak`, 'utf8')).toBe('user backup\n');
    expect(existsSync(`${claudeMd}.bak.1`)).toBe(false);
  });

  test('uninstall removes only the block', () => {
    writeFileSync(claudeMd, '# Mine\n\nkeep me\n');
    setup('--claude-md', '--no-hooks');
    expect(setup('uninstall').status).toBe(0);
    const text = readFileSync(claudeMd, 'utf8');
    expect(text).not.toContain(BEGIN);
    expect(text.trimEnd()).toBe('# Mine\n\nkeep me');
  });

  test('a hand-written routing section outside the block is reported', () => {
    writeFileSync(claudeMd, '# Mine\n\n## xm routing (proactive triggers)\nold\n');
    const r = setup('--claude-md', '--no-hooks');
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('hand-written "## xm routing" section');
  });

  test('status reports the block without failing on its absence', () => {
    writeFileSync(claudeMd, '# Mine\n');
    expect(setup('status').stdout).toContain('CLAUDE.md routing: (not enabled');
    setup('--claude-md', '--no-hooks');
    expect(setup('status').stdout).toContain('CLAUDE.md routing: current');
  });

  test('an unknown flag alone still fails instead of installing', () => {
    const r = setup('--dry-run');
    expect(r.status).not.toBe(0);
    expect(existsSync(join(home, '.claude', 'commands', 'xm.md'))).toBe(false);
  });
});

describe('claude-routing.md template', () => {
  // Hand-written routing drifted to skill names that no longer existed; the
  // shipped block must only name skills the bundle carries.
  test('every xm:<skill> it names exists in the bundle', () => {
    const names = [...readFileSync(TEMPLATE, 'utf8').matchAll(/xm:([a-z][a-z-]*)/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    const missing = [...new Set(names)].filter((n) => !existsSync(join(REPO, 'xm', 'skills', n, 'SKILL.md')));
    expect(missing).toEqual([]);
  });
});
