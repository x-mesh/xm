import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const CLI = join(REPO, 'x-build', 'lib', 'x-build-cli.mjs');

// A minimal xm-marketplace git repo: two plugins (xm meta + panel) at known versions, one
// "release:" commit as the baseline. Lets release detect/bump run hermetically off the real repo.
function makeReleaseFixture() {
  const d = mkdtempSync(join(tmpdir(), 'xrel-'));
  for (const p of ['.claude-plugin', 'xm/.claude-plugin', 'xm/scripts', 'x-panel/.claude-plugin', 'test']) {
    mkdirSync(join(d, p), { recursive: true });
  }
  // release bump's step 8 runs `bun test test/core-unit.test.mjs` in cwd — give the fixture a
  // trivial passing one so bump exits cleanly (0), no nested-bun error spam / flakiness.
  writeFileSync(join(d, 'test', 'core-unit.test.mjs'), 'import{test,expect}from"bun:test";test("noop",()=>{expect(1).toBe(1)});\n');
  writeFileSync(join(d, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ plugins: [{ name: 'xm', version: '1.2.3' }, { name: 'panel', version: '0.1.0' }] }, null, 2));
  writeFileSync(join(d, 'xm', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'xm', version: '1.2.3' }));
  writeFileSync(join(d, 'x-panel', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'panel', version: '0.1.0' }));
  writeFileSync(join(d, 'xm', 'scripts', 'xm'), '#!/usr/bin/env bash\n# v1\n');
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'xkit', version: '1.2.3' }));
  spawnSync('bash', ['-c', 'git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm "release: xm@1.2.3"'], { cwd: d });
  return d;
}

describe('release detect/bump — xm dispatcher handling (l9/l10)', () => {
  test('detect flags an xm/scripts dispatcher change as a releasable xm change (l9)', () => {
    const d = makeReleaseFixture();
    try {
      // a dispatcher-only change AFTER the baseline release
      writeFileSync(join(d, 'xm', 'scripts', 'xm'), '#!/usr/bin/env bash\n# v1\n# v2 dispatcher fix\n');
      spawnSync('bash', ['-c', 'git add -A && git commit -qm "fix(xm): dispatcher"'], { cwd: d });
      const r = spawnSync('node', [CLI, 'release', 'detect'], { cwd: d, encoding: 'utf8', timeout: 30000 });
      const out = JSON.parse(r.stdout);
      // pre-fix: changed_plugins was [] because xm is always filtered; now the dispatcher change surfaces it.
      expect(out.changed_plugins.map((p) => p.name)).toContain('xm');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('a mirror-only xm/lib change does NOT surface xm (only genuine dispatcher files do)', () => {
    const d = makeReleaseFixture();
    try {
      mkdirSync(join(d, 'xm', 'lib'), { recursive: true });
      writeFileSync(join(d, 'xm', 'lib', 'x-panel-cli.mjs'), '// mirror churn\n');
      spawnSync('bash', ['-c', 'git add -A && git commit -qm "chore: sync mirror"'], { cwd: d });
      const r = spawnSync('node', [CLI, 'release', 'detect'], { cwd: d, encoding: 'utf8', timeout: 30000 });
      const out = JSON.parse(r.stdout);
      expect(out.changed_plugins.map((p) => p.name)).not.toContain('xm'); // mirror churn must not trigger an xm release
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('bump --plugins xm bumps xm exactly once, not twice (l10)', () => {
    const d = makeReleaseFixture();
    try {
      // bump writes versions before its sync/checksum/test steps (which no-op / fail-late in the
      // fixture), so the written version is authoritative regardless of the CLI exit code.
      spawnSync('node', [CLI, 'release', 'bump', '--patch', '--plugins', 'xm'], { cwd: d, encoding: 'utf8', timeout: 60000 });
      const mkt = JSON.parse(readFileSync(join(d, '.claude-plugin', 'marketplace.json'), 'utf8'));
      expect(mkt.plugins.find((p) => p.name === 'xm').version).toBe('1.2.4'); // ONE patch, not 1.2.5
      expect(JSON.parse(readFileSync(join(d, 'xm', '.claude-plugin', 'plugin.json'), 'utf8')).version).toBe('1.2.4');
      expect(JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')).version).toBe('1.2.4');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('bump --plugins x-panel still meta-bumps xm once (normal flow unaffected)', () => {
    const d = makeReleaseFixture();
    try {
      spawnSync('node', [CLI, 'release', 'bump', '--patch', '--plugins', 'x-panel'], { cwd: d, encoding: 'utf8', timeout: 60000 });
      const mkt = JSON.parse(readFileSync(join(d, '.claude-plugin', 'marketplace.json'), 'utf8'));
      expect(mkt.plugins.find((p) => p.name === 'panel').version).toBe('0.1.1'); // panel bumped
      expect(mkt.plugins.find((p) => p.name === 'xm').version).toBe('1.2.4');    // xm meta-bumped once
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

// A tag-versioned project (Cargo + a `on: push: tags` workflow) — the shape x-ship used to
// mishandle: it never created a tag, so the release workflow never fired and the ship still
// reported success.
function makeRustFixture() {
  const d = mkdtempSync(join(tmpdir(), 'xrust-'));
  mkdirSync(join(d, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(d, '.xm', 'panel'), { recursive: true }); // xm artifacts: must NOT reach the commit
  writeFileSync(join(d, 'Cargo.toml'), '[package]\nname = "gk"\nversion = "0.5.0"\n');
  writeFileSync(join(d, '.github', 'workflows', 'release.yml'), 'on:\n  push:\n    tags: ["v*"]\n');
  writeFileSync(join(d, '.xm', 'panel', 'leftover.json'), '{}\n');
  writeFileSync(join(d, 'main.rs'), 'fn main(){}\n');
  spawnSync('bash', ['-c', 'git init -q && git config user.email t@t && git config user.name t && git add Cargo.toml .github main.rs && git commit -qm "feat: init" && git tag v0.5.0'], { cwd: d });
  return d;
}

describe('release commit — tag-versioned projects', () => {
  test('bump --standalone reads Cargo.toml and names the tag the release needs', () => {
    const d = makeRustFixture();
    try {
      const r = spawnSync('node', [CLI, 'release', 'bump', '--minor', '--standalone'], { cwd: d, encoding: 'utf8', timeout: 60000 });
      expect(readFileSync(join(d, 'Cargo.toml'), 'utf8')).toContain('version = "0.6.0"');
      expect(r.stdout).toContain('v0.6.0'); // the tag is surfaced, not left for the caller to guess
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('commit --tag creates an ANNOTATED tag on the release commit (CI triggers on tags)', () => {
    const d = makeRustFixture();
    try {
      writeFileSync(join(d, 'main.rs'), 'fn main(){ /* fix */ }\n');
      const r = spawnSync('node', [CLI, 'release', 'commit', '--msg', 'release: gk@0.6.0', '--tag', 'v0.6.0'], { cwd: d, encoding: 'utf8', timeout: 30000 });
      expect(r.stdout).toContain('Tagged: v0.6.0');
      const at = spawnSync('bash', ['-c', 'git tag --points-at HEAD'], { cwd: d, encoding: 'utf8' }).stdout.trim();
      expect(at).toBe('v0.6.0');
      const kind = spawnSync('bash', ['-c', 'git cat-file -t v0.6.0'], { cwd: d, encoding: 'utf8' }).stdout.trim();
      expect(kind).toBe('tag'); // annotated, not lightweight — `git push --follow-tags` only carries these
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('an existing tag is never moved — the release stops instead', () => {
    const d = makeRustFixture();
    try {
      writeFileSync(join(d, 'main.rs'), 'fn main(){ /* fix */ }\n');
      const r = spawnSync('node', [CLI, 'release', 'commit', '--msg', 'release: gk@0.5.0', '--tag', 'v0.5.0'], { cwd: d, encoding: 'utf8', timeout: 30000 });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('already exists');
      const at = spawnSync('bash', ['-c', 'git rev-list -n1 v0.5.0'], { cwd: d, encoding: 'utf8' }).stdout.trim();
      const head = spawnSync('bash', ['-c', 'git rev-parse HEAD'], { cwd: d, encoding: 'utf8' }).stdout.trim();
      expect(at).not.toBe(head); // the old tag still points at the old commit
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('release commit does not sweep .xm/ artifacts into the release', () => {
    const d = makeRustFixture();
    try {
      writeFileSync(join(d, 'main.rs'), 'fn main(){ /* fix */ }\n');
      spawnSync('node', [CLI, 'release', 'commit', '--msg', 'release: gk@0.6.0'], { cwd: d, encoding: 'utf8', timeout: 30000 });
      const files = spawnSync('bash', ['-c', 'git show --name-only --format= HEAD'], { cwd: d, encoding: 'utf8' }).stdout;
      expect(files).toContain('main.rs');
      expect(files).not.toContain('.xm/');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe('release state checks', () => {
  test('verify-release-state passes current repo as JSON', () => {
    const result = spawnSync('node', [join(REPO, 'scripts', 'verify-release-state.mjs'), '--json'], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 120000,
    });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.results.map((check) => check.name)).toEqual(
      expect.arrayContaining(['version-consistency', 'bundle-sync', 'skills-checksum']),
    );
  });

  test('release bump updates README version badges (2회 재발한 수동 치환 제거)', () => {
    const source = readFileSync(join(REPO, 'x-build/lib/x-build/release.mjs'), 'utf8');
    // bump가 배지를 직접 갱신하는 코드가 존재하고, verify-release-state와 동일 배지 패턴을 쓴다.
    expect(source).toContain('img\\.shields\\.io\\/badge\\/version-');
    expect(source).toContain('README.ko.md');
    const badgeIndex = source.indexOf('version badge');
    const syncIndex = source.indexOf('Running sync-bundle');
    expect(badgeIndex).toBeGreaterThan(-1);
    expect(badgeIndex).toBeLessThan(syncIndex); // sync-bundle(미러 복사) 전에 배지 갱신
  });

  test('release bump is wired to the release-state gate before tests', () => {
    const source = readFileSync(join(REPO, 'x-build/lib/x-build/release.mjs'), 'utf8');
    const checksumIndex = source.indexOf('skills-checksum.mjs');
    const gateIndex = source.indexOf('runReleaseStateCheck(cwd);');
    const testIndex = source.indexOf("console.log('\\n🧪 Running tests...');");

    expect(source).toContain('verify-release-state.mjs');
    expect(gateIndex).toBeGreaterThan(checksumIndex);
    expect(testIndex).toBeGreaterThan(gateIndex);
  });

  test('xm doctor exposes release-state status and remains valid bash', () => {
    const xmScript = join(REPO, 'xm/scripts/xm');
    const source = readFileSync(xmScript, 'utf8');
    const syntax = spawnSync('bash', ['-n', xmScript], {
      cwd: REPO,
      encoding: 'utf8',
    });

    expect(source).toContain('## Bundle / release state');
    expect(source).toContain('verify-release-state.mjs');
    expect(syntax.status).toBe(0);
  });
});
