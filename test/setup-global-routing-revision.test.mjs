import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// The routing block's begin marker carries the template revision. The revision
// lets `status` say what is installed and keeps an older xm from overwriting a
// block that a newer xm wrote. Matching ignores the revision, so a block
// written before revisions existed is replaced instead of followed by a second.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SETUP = join(REPO, 'xm', 'scripts', 'setup-global.mjs');
const END = '<!-- xm:routing:end -->';

// Bump the revision in setup-global.mjs (ROUTING_TARGETS) and update this pin
// whenever a template changes; the test below fails until both move together.
const TARGETS = [
  { label: 'CLAUDE.md', flag: '--claude-md', dir: '.claude', file: 'CLAUDE.md', template: 'claude-routing.md', revision: 1, sha256: '2a2b3419f010efa774b3f618cf330dfc89175e2893c26f18fb69f04178ef1e04' },
  { label: 'AGENTS.md', flag: '--codex-md', dir: '.codex', file: 'AGENTS.md', template: 'codex-routing.md', revision: 1, sha256: '6f911a4e88f276876b5eda66772259d8840f315df0c514bf6858e149728f1ed4' },
];

const { XM_LIB: _xmLib, X_KIT_LIB: _xKitLib, ...BASE_ENV } = process.env;

let home;

function setup(...args) {
  return spawnSync('node', [SETUP, ...args], {
    cwd: REPO,
    env: { ...BASE_ENV, HOME: home, XM_BIN_DIR: join(home, 'bin') },
    encoding: 'utf8',
  });
}

const markerFor = (target, revisionText) => `<!-- xm:routing:begin${revisionText} — managed by \`xm setup ${target.flag}\`; edit outside this block -->`;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'xm-setup-routing-rev-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

for (const target of TARGETS) {
  describe(`${target.label} routing revision`, () => {
    const path = () => join(home, target.dir, target.file);
    const backups = () => readdirSync(join(home, target.dir)).filter((f) => f.startsWith(`${target.file}.backup-`));
    const legacyFile = (extra = '') => {
      const body = readFileSync(join(REPO, 'xm', 'templates', target.template), 'utf8').trimEnd();
      mkdirSync(join(home, target.dir), { recursive: true });
      writeFileSync(path(), `# Mine\n\nkeep me\n${extra}${markerFor(target, '')}\n${body}\n${END}\n`);
    };

    test('the template matches its pinned revision', () => {
      const sha = createHash('sha256').update(readFileSync(join(REPO, 'xm', 'templates', target.template))).digest('hex');
      expect(sha).toBe(target.sha256);
      setup(target.flag, '--no-hooks');
      expect(readFileSync(path(), 'utf8')).toContain(markerFor(target, ` v${target.revision}`));
    });

    test('a block written before revisions existed is replaced once', () => {
      legacyFile();
      const before = readFileSync(path(), 'utf8');
      const r = setup('install', '--no-hooks');
      expect(r.status).toBe(0);
      const after = readFileSync(path(), 'utf8');
      expect(after).not.toBe(before);
      expect(after.startsWith('# Mine\n\nkeep me\n')).toBe(true);
      expect(after.match(/xm:routing:begin/g).length).toBe(1);
      expect(after).toContain(markerFor(target, ` v${target.revision}`));
      expect(backups().length).toBe(1);

      setup('install', '--no-hooks');
      expect(readFileSync(path(), 'utf8')).toBe(after);
      expect(backups().length).toBe(1);
    });

    test('a block with a newer revision is left unchanged', () => {
      legacyFile();
      const newer = readFileSync(path(), 'utf8').replace(markerFor(target, ''), markerFor(target, ' v99'));
      writeFileSync(path(), newer);
      for (const args of [['install', '--no-hooks'], [target.flag, '--no-hooks']]) {
        const r = setup(...args);
        expect(r.status).toBe(0);
        expect(r.stderr).toContain(`block v99, newer than v${target.revision}`);
        expect(readFileSync(path(), 'utf8')).toBe(newer);
      }
      expect(backups()).toEqual([]);
      expect(setup('status').stdout).toContain(`${target.label} routing: newer than this xm (v99 > v${target.revision}`);
    });

    test('status names the revision it found', () => {
      expect(setup('status').stdout).toContain(`${target.label} routing: (not enabled`);
      legacyFile();
      expect(setup('status').stdout).toContain(`${target.label} routing: outdated (v0 → v${target.revision}`);
      setup('install', '--no-hooks');
      expect(setup('status').stdout).toContain(`${target.label} routing: current (v${target.revision},`);
    });

    test('uninstall removes a versioned block and an unversioned one', () => {
      mkdirSync(join(home, target.dir), { recursive: true });
      writeFileSync(path(), '# Mine\n');
      setup(target.flag, '--no-hooks');
      expect(readFileSync(path(), 'utf8')).toContain('xm:routing:begin');
      expect(setup('uninstall').status).toBe(0);
      expect(readFileSync(path(), 'utf8')).not.toContain('xm:routing:begin');

      legacyFile();
      expect(setup('uninstall').status).toBe(0);
      const text = readFileSync(path(), 'utf8');
      expect(text).not.toContain('xm:routing:begin');
      expect(text.trimEnd()).toBe('# Mine\n\nkeep me');
    });
  });
}
