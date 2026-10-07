import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// `xm setup --codex-md` owns one marker block in the user's ~/.codex/AGENTS.md.
// It follows the same opt-in and backup rules as `--claude-md`, and the two
// blocks live in separate files and never touch each other.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SETUP = join(REPO, 'xm', 'scripts', 'setup-global.mjs');
const CODEX_TEMPLATE = join(REPO, 'xm', 'templates', 'codex-routing.md');
const CLAUDE_TEMPLATE = join(REPO, 'xm', 'templates', 'claude-routing.md');
const SKILLS_DIR = join(REPO, 'xm', 'skills');
const BEGIN = '<!-- xm:routing:begin';
const END = '<!-- xm:routing:end -->';

const { XM_LIB: _xmLib, X_KIT_LIB: _xKitLib, ...BASE_ENV } = process.env;

let home;
let agentsMd;
let claudeMd;

function setup(...args) {
  return spawnSync('node', [SETUP, ...args], {
    cwd: REPO,
    env: { ...BASE_ENV, HOME: home, XM_BIN_DIR: join(home, 'bin') },
    encoding: 'utf8',
  });
}

const backups = () => readdirSync(join(home, '.codex')).filter((f) => f.startsWith('AGENTS.md.backup-'));
const blockBody = (text) => text.slice(text.indexOf('\n', text.indexOf(BEGIN)) + 1, text.indexOf(END));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'xm-setup-codex-md-'));
  agentsMd = join(home, '.codex', 'AGENTS.md');
  claudeMd = join(home, '.claude', 'CLAUDE.md');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('xm setup --codex-md', () => {
  test('a bare install never adds the block', () => {
    expect(setup('install', '--no-hooks').status).toBe(0);
    expect(existsSync(agentsMd)).toBe(false);

    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(agentsMd, '# Mine\n');
    expect(setup('install', '--no-hooks').status).toBe(0);
    expect(readFileSync(agentsMd, 'utf8')).toBe('# Mine\n');
    expect(backups()).toEqual([]);
  });

  test('opting in creates ~/.codex/AGENTS.md when it is missing', () => {
    const r = setup('--codex-md', '--no-hooks');
    expect(r.status).toBe(0);
    expect(blockBody(readFileSync(agentsMd, 'utf8')).trimEnd()).toBe(readFileSync(CODEX_TEMPLATE, 'utf8').trimEnd());
    expect(existsSync(claudeMd)).toBe(false);
  });

  test('opting in appends the template and keeps the user text', () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(agentsMd, '# Mine\n\nkeep me\n');
    expect(setup('--codex-md', '--no-hooks').status).toBe(0);
    const text = readFileSync(agentsMd, 'utf8');
    expect(text.startsWith('# Mine\n\nkeep me\n')).toBe(true);
    expect(blockBody(text).trimEnd()).toBe(readFileSync(CODEX_TEMPLATE, 'utf8').trimEnd());
    expect(backups().length).toBe(1);
  });

  test('re-running leaves the file and the backups alone', () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(agentsMd, '# Mine\n');
    setup('--codex-md', '--no-hooks');
    const once = readFileSync(agentsMd, 'utf8');
    setup('install', '--no-hooks', '--codex-md');
    setup('install', '--no-hooks');
    expect(readFileSync(agentsMd, 'utf8')).toBe(once);
    expect(backups().length).toBe(1);
  });

  test('a bare install replaces an outdated block body', () => {
    setup('--codex-md', '--no-hooks');
    const fresh = readFileSync(agentsMd, 'utf8');
    writeFileSync(agentsMd, fresh.replace('### Shared rules', '### Old rules'));
    expect(setup('install', '--no-hooks').status).toBe(0);
    expect(readFileSync(agentsMd, 'utf8')).toBe(fresh);
  });

  test('a half-deleted block fails visibly and leaves the file alone', () => {
    setup('--codex-md', '--no-hooks');
    const broken = readFileSync(agentsMd, 'utf8').replace(END, '');
    writeFileSync(agentsMd, broken);
    const r = setup('install', '--no-hooks');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('marker mismatch');
    expect(readFileSync(agentsMd, 'utf8')).toBe(broken);
  });

  test('both flags write both files with their own template', () => {
    expect(setup('--claude-md', '--codex-md', '--no-hooks').status).toBe(0);
    expect(blockBody(readFileSync(claudeMd, 'utf8')).trimEnd()).toBe(readFileSync(CLAUDE_TEMPLATE, 'utf8').trimEnd());
    expect(blockBody(readFileSync(agentsMd, 'utf8')).trimEnd()).toBe(readFileSync(CODEX_TEMPLATE, 'utf8').trimEnd());
  });

  test('uninstall removes only the block', () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(agentsMd, '# Mine\n\nkeep me\n');
    setup('--codex-md', '--no-hooks');
    expect(setup('uninstall').status).toBe(0);
    const text = readFileSync(agentsMd, 'utf8');
    expect(text).not.toContain(BEGIN);
    expect(text.trimEnd()).toBe('# Mine\n\nkeep me');
  });

  test('a hand-written routing section outside the block is reported', () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(agentsMd, '# Mine\n\n## xm routing (proactive triggers)\nold\n');
    const r = setup('--codex-md', '--no-hooks');
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('hand-written "## xm routing" section');
  });

  test('status reports the block without failing on its absence', () => {
    expect(setup('status').stdout).toContain('AGENTS.md routing: (not enabled');
    setup('--codex-md', '--no-hooks');
    expect(setup('status').stdout).toContain('AGENTS.md routing: current');
  });
});

describe('routing templates', () => {
  const skillsIn = (file) => new Set([...readFileSync(file, 'utf8').matchAll(/xm:([a-z][a-z-]*)/g)].map((m) => m[1]));
  const bundled = readdirSync(SKILLS_DIR).filter((n) => existsSync(join(SKILLS_DIR, n, 'SKILL.md')));

  // These are invoked by name or described well enough for native discovery, so
  // routing them would only lengthen the global instructions. A new skill must
  // be routed or listed here, which forces the decision.
  const NOT_ROUTED = [
    'batch', 'build', 'dashboard', 'gate', 'handoff', 'handon', 'humanize', 'inbox', 'kit', 'later',
    'local-fix', 'mutate', 'panel', 'plan', 'relay', 'remote', 'ship', 'sync', 'toss', 'trace', 'wt',
  ];

  test('every xm:<skill> the Codex template names exists in the bundle', () => {
    const names = [...skillsIn(CODEX_TEMPLATE)];
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => !bundled.includes(n))).toEqual([]);
  });

  test('the Codex and Claude templates route the same skills', () => {
    expect([...skillsIn(CODEX_TEMPLATE)].sort()).toEqual([...skillsIn(CLAUDE_TEMPLATE)].sort());
  });

  test('every bundled skill is routed or listed as not routed', () => {
    const routed = skillsIn(CODEX_TEMPLATE);
    const undecided = bundled.filter((n) => !routed.has(n) && !NOT_ROUTED.includes(n));
    expect(undecided).toEqual([]);
  });

  test('a skill is not both routed and listed as not routed', () => {
    const routed = skillsIn(CODEX_TEMPLATE);
    expect(NOT_ROUTED.filter((n) => routed.has(n))).toEqual([]);
  });

  test('the Codex template names no Claude-only tool', () => {
    const text = readFileSync(CODEX_TEMPLATE, 'utf8');
    expect(text).not.toMatch(/Skill tool|AskUserQuestion|\/xm:/);
  });
});
