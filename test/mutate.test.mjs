import { afterEach, expect, test } from 'bun:test';
import { execSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, matchesGlob, resolve } from 'node:path';
import { listMutationTasks, parseDiffChanges, runDiffMutate, runTaskMutate } from '../x-build/lib/x-build/mutate.mjs';
import { ADAPTERS, lineRanges, widenedRoot } from '../x-build/lib/x-build/mutate-adapters.mjs';

const FIXTURES = resolve(import.meta.dir, 'fixtures/mutate');
const CLI = resolve(import.meta.dir, '../x-build/lib/x-build-cli.mjs');
const roots = [];
let worktreeIndex = 0;

const sh = (cwd, command) => execSync(command, { cwd, shell: '/bin/bash', encoding: 'utf8' });
const tempDir = prefix => { const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix))); roots.push(dir); return dir; };
const makeRoot = (prefix = 'mutate-') => { const root = tempDir(prefix); sh(root, 'git init -q -b main && git config user.email test@example.com && git config user.name Test'); return root; };
const write = (root, file, content) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), content); };
const commitAll = (root, message = 'fixture') => sh(root, `git add -A && git commit -qm ${JSON.stringify(message)}`);
const adapter = language => ADAPTERS.find(candidate => candidate.language === language);
const tasks = (state, project, rows) => write(state, `.xm/build/projects/${project}/phases/02-plan/tasks.json`, JSON.stringify({ tasks: rows }));

// A repository with one supported file under a fake manifest, committed on main.
const fakeRepo = prefix => {
  const root = makeRoot(prefix);
  write(root, 'fake.toml', '');
  write(root, 'a.fake', 'one\n');
  commitAll(root, 'base');
  return root;
};

const artifact = (state, task, data = {}, project = 'p') => {
  const branch = `mutate-${++worktreeIndex}`, path = `${state}-wt-${worktreeIndex}`;
  roots.push(path);
  sh(state, `git worktree add -qb ${JSON.stringify(branch)} ${JSON.stringify(path)}`);
  const worktree = realpathSync(path);
  write(state, `.xm/build/projects/${project}/worktrees/${task}/run.json`, JSON.stringify({ task_id: task, branch, worktree, ...data }));
  return worktree;
};

const changeInWorktree = worktree => { write(worktree, 'a.fake', 'one\ntwo\n'); commitAll(worktree, 'task change'); };

// A stand-in tool: it reports one mutant per changed line plus one on a line
// that did not change, so the core's re-scoping is observable.
function fakeAdapter({ unavailable = null, status = 'survived', argv = null, calls = [] } = {}) {
  return {
    language: 'fake',
    tool: 'fake-tool',
    install: 'install fake-tool',
    manifests: ['fake.toml'],
    claims: path => path.endsWith('.fake'),
    detect: () => (unavailable ? { unavailable } : { version: '1.0.0' }),
    plan(ctx) {
      calls.push(ctx);
      const rows = [...ctx.changed].flatMap(([file, lines]) => [...lines, 999].map(line => ({ file, line, end_line: line, column: 1, mutator: 'Fake', description: 'fake', status })));
      const report = join(ctx.outDir, 'report.json');
      return { argv: argv || [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(report)}, ${JSON.stringify(JSON.stringify(rows))})`] };
    },
    parse(ctx, run) {
      if (run.exitCode !== 0) throw new Error(`fake-tool exited ${run.exitCode}`);
      return { mutants: JSON.parse(readFileSync(join(ctx.outDir, 'report.json'), 'utf8')) };
    },
  };
}

const outDirWith = (fixture = null, target = null) => {
  const dir = tempDir('mutate-out-');
  if (fixture) {
    mkdirSync(dirname(join(dir, target)), { recursive: true });
    copyFileSync(join(FIXTURES, fixture), join(dir, target));
  }
  return dir;
};

const cliEnv = () => {
  const env = { ...process.env };
  delete env.X_BUILD_ROOT;
  delete env.XM_ROOT;
  return env;
};

afterEach(() => {
  for (const root of roots.splice(0)) try { rmSync(root, { recursive: true, force: true }); } catch {}
});

test('diff parsing maps added lines per file and skips deletions and header look-alikes', () => {
  const diff = [
    'diff --git a/src/a.rs b/src/a.rs', 'index 1..2 100644', '--- a/src/a.rs', '+++ b/src/a.rs',
    '@@ -1,0 +2,2 @@', '+fn a() {}', '+++ not a header',
    '@@ -9 +10,0 @@', '-gone',
    'diff --git a/old.go b/new.go', 'rename from old.go', 'rename to new.go', '--- a/old.go', '+++ "b/new.go"', '@@ -3 +3 @@', '-x', '+y', '\\ No newline at end of file',
    'diff --git a/deleted.ts b/deleted.ts', 'deleted file mode 100644', '--- a/deleted.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-z',
  ].join('\n');
  expect([...parseDiffChanges(diff)]).toEqual([['src/a.rs', [2, 3]], ['new.go', [3]]]);
});

test('line ranges merge adjacent lines', () => {
  expect(lineRanges([5, 3, 4, 9, 10, 12])).toEqual([[3, 5], [9, 10], [12, 12]]);
});

test('adapters claim source files and leave tests and manifests alone', () => {
  const claimed = path => ADAPTERS.find(candidate => candidate.claims(path))?.language ?? null;
  expect(['src/lib.rs', 'src/a.ts', 'src/a.tsx', 'lib/a.mjs', 'calc.go', 'Sources/Calc/Calc.swift'].map(claimed)).toEqual(['rust', 'javascript', 'javascript', 'javascript', 'go', 'swift']);
  expect(['src/a.test.ts', 'src/__tests__/a.js', 'types/a.d.ts', 'calc_test.go', 'Tests/CalcTests/CalcTests.swift', 'Package.swift', 'README.md'].map(claimed)).toEqual([null, null, null, null, null, null, null]);
});

test('cargo-mutants outcomes map caught, missed, timeout, and unviable', () => {
  const outDir = outDirWith('cargo-mutants-outcomes.json', 'mutants.out/outcomes.json');
  const { mutants } = adapter('rust').parse({ outDir }, { exitCode: 2 });
  expect(mutants.map(row => [row.line, row.status])).toEqual([[8, 'unviable'], [12, 'killed'], [12, 'survived'], [26, 'timeout']]);
  expect(mutants[2]).toMatchObject({ file: 'src/lib.rs', end_line: 12, mutator: 'BinaryOperator', description: 'replace && with || in discount' });
});

test('cargo-mutants exit codes separate a failing baseline, an empty diff, and a tool failure', () => {
  const rust = adapter('rust'), empty = outDirWith();
  expect(rust.parse({ outDir: empty }, { exitCode: 4 })).toEqual({ mutants: [], baseline_failed: true });
  expect(rust.parse({ outDir: empty }, { exitCode: 0 })).toEqual({ mutants: [] });
  expect(() => rust.parse({ outDir: empty }, { exitCode: 6 })).toThrow(/exited 6/);
  expect(() => rust.parse({ outDir: empty }, { exitCode: 2 })).toThrow(/did not write its report/);
});

test('cargo-mutants receives the root-relative diff as a file', () => {
  const plan = adapter('rust').plan({ diff: 'DIFF', outDir: '/out' });
  expect(plan.argv).toEqual(['cargo', 'mutants', '--in-diff', '/out/change.diff', '--output', '/out']);
  expect(plan.files).toEqual({ '/out/change.diff': 'DIFF' });
});

test('StrykerJS report keeps schema locations and statuses', () => {
  const outDir = outDirWith('stryker-mutation.json', 'mutation.json');
  const { mutants } = adapter('javascript').parse({ outDir }, { exitCode: 0 });
  expect(mutants).toHaveLength(11);
  expect(mutants.filter(row => row.status === 'survived')).toHaveLength(4);
  expect(mutants.filter(row => row.status === 'killed')).toHaveLength(7);
  expect(mutants.every(row => row.file === 'src/calc.ts' && row.line >= 4 && row.end_line <= 14)).toBe(true);
});

test('StrykerJS schema status names map to the shared scale, unknown names to error', () => {
  const outDir = outDirWith(), location = { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } };
  const names = ['CompileError', 'NoCoverage', 'RuntimeError', 'Ignored', 'Pending', 'Timeout', 'Bogus'];
  writeFileSync(join(outDir, 'mutation.json'), JSON.stringify({ files: { 'a.ts': { mutants: names.map((status, id) => ({ id: String(id), mutatorName: 'M', location, status })) } } }));
  expect(adapter('javascript').parse({ outDir }, { exitCode: 0 }).mutants.map(row => row.status)).toEqual(['unviable', 'no_coverage', 'error', 'skipped', 'skipped', 'timeout', 'error']);
  expect(() => adapter('javascript').parse({ outDir: outDirWith() }, { exitCode: 1 })).toThrow(/exited 1 without a report/);
});

test('StrykerJS plan passes changed line ranges and the package test command through a config outside the project', () => {
  const top = tempDir('mutate-js-'), root = join(top, 'pkg'), outDir = outDirWith();
  write(top, 'bun.lock', '');
  write(root, 'package.json', JSON.stringify({ scripts: { test: 'bun test' } }));
  const js = adapter('javascript'), ctx = { root, repoTop: top, changed: new Map([['src/a.ts', [3, 4, 5, 9]]]), outDir };
  const plan = js.plan(ctx, { bin: '/bin/stryker' }), configPath = join(outDir, 'stryker.config.json');
  expect(plan.argv).toEqual(['/bin/stryker', 'run', configPath]);
  expect(JSON.parse(plan.files[configPath])).toMatchObject({ testRunner: 'command', commandRunner: { command: 'bun run test' }, mutate: ['src/a.ts:3-5', 'src/a.ts:9-9'], reporters: ['json'], jsonReporter: { fileName: join(outDir, 'mutation.json') } });
  write(root, 'package.json', JSON.stringify({ scripts: {} }));
  expect(js.plan(ctx, { bin: '/bin/stryker' })).toEqual({ unavailable: 'package.json has no test script for the Stryker command runner' });
});

test('gomutants report maps statuses and spans multi-line originals', () => {
  const outDir = outDirWith('gomutants.json', 'gomutants.json');
  const { mutants } = adapter('go').parse({ outDir }, { exitCode: 0 });
  const counts = {};
  for (const row of mutants) counts[row.status] = (counts[row.status] || 0) + 1;
  expect(counts).toEqual({ survived: 8, killed: 11, no_coverage: 1, timeout: 4 });
  expect(mutants.find(row => row.mutator === 'BRANCH_IF')).toMatchObject({ file: 'calc.go', line: 8, end_line: 10 });
  expect(() => adapter('go').parse({ outDir }, { exitCode: 1 })).toThrow(/gomutants exited 1/);
});

test('gomutants plan scopes to the merge base and keeps its cache out of the module', () => {
  expect(adapter('go').plan({ mergeBase: 'abc123', outDir: '/out' }).argv).toEqual(['gomutants', '-changed-since', 'abc123', '-o', '/out/gomutants.json', '-cache', 'off', '-q']);
});

test('Muter report maps paths from its mutated copy back to the project', () => {
  const outDir = outDirWith('muter.json', 'muter.json');
  const { mutants } = adapter('swift').parse({ root: '/project', outDir }, { exitCode: 0 });
  expect(mutants.map(row => [row.file, row.line, row.status])).toEqual([['Sources/Calc/Calc.swift', 2, 'killed'], ['Sources/Calc/Calc.swift', 6, 'survived'], ['Sources/Calc/Calc.swift', 6, 'killed']]);
  expect(() => adapter('swift').parse({ root: '/elsewhere', outDir }, { exitCode: 0 })).toThrow(/outside \/elsewhere_mutated\//);
});

test('Muter outcome names follow its TestSuiteOutcome enum', () => {
  const outDir = outDirWith(), names = ['runtimeError', 'buildError', 'noCoverage', 'timeout', 'passed', 'failed'];
  const appliedOperators = names.map(testSuiteOutcome => ({ testSuiteOutcome, mutationPoint: { filePath: '/p_mutated/A.swift', mutationOperatorId: 'Op', position: { line: 1, column: 1 } } }));
  writeFileSync(join(outDir, 'muter.json'), JSON.stringify({ fileReports: [{ appliedOperators }] }));
  expect(adapter('swift').parse({ root: '/p', outDir }, { exitCode: 0 }).mutants.map(row => row.status)).toEqual(['killed', 'unviable', 'no_coverage', 'timeout', 'survived', 'killed']);
});

test('a red baseline reaches the report as a tool failure, not a mutation result', () => {
  // Measured: cargo-mutants exits 4, StrykerJS 1, gomutants 1, Muter 255, and only
  // cargo-mutants names the baseline; the others write no report at all.
  const empty = outDirWith();
  expect(adapter('rust').parse({ outDir: empty }, { exitCode: 4 })).toEqual({ mutants: [], baseline_failed: true });
  expect(() => adapter('javascript').parse({ outDir: empty }, { exitCode: 1 })).toThrow(/StrykerJS exited 1 without a report/);
  expect(() => adapter('go').parse({ outDir: empty }, { exitCode: 1 })).toThrow(/gomutants exited 1/);
  expect(() => adapter('swift').parse({ root: '/project', outDir: empty }, { exitCode: 255 })).toThrow(/Muter exited 255/);
});

test('gomutants statuses keep the spacing the tool emits, and an unmapped one stays visible', () => {
  const outDir = outDirWith();
  const mutations = [
    { type: 'INVERT_ASSIGNMENTS', status: 'NOT VIABLE', line: 4, column: 2, original: '+=', replacement: '-=' },
    { type: 'RETURN_ZERO', status: 'NOT COVERED', line: 5, column: 2, original: 'x', replacement: '0' },
    { type: 'LOOP_CONDITION', status: 'TIMED OUT', line: 6, column: 2, original: 'i < n', replacement: 'true' },
    { type: 'BRANCH_IF', status: 'EQUIVALENT', line: 7, column: 2, original: 'a', replacement: 'b' },
  ];
  writeFileSync(join(outDir, 'gomutants.json'), JSON.stringify({ files: [{ file_name: 'calc.go', mutations }] }));
  expect(adapter('go').parse({ outDir }, { exitCode: 0 }).mutants.map(row => row.status)).toEqual(['unviable', 'no_coverage', 'timeout', 'error']);
});

test('Muter plan requires muter.conf.yml and repeats --files-to-mutate per file', () => {
  const root = tempDir('mutate-swift-'), outDir = outDirWith(), swift = adapter('swift');
  const ctx = { root, outDir, changed: new Map([['Sources/A.swift', [1]], ['Sources/B.swift', [2]]]) };
  expect(swift.plan(ctx).unavailable).toMatch(/muter init/);
  write(root, 'muter.conf.yml', 'executable: /usr/bin/swift\n');
  expect(swift.plan(ctx).argv).toEqual(['muter', 'run', '--files-to-mutate', 'Sources/A.swift', '--files-to-mutate', 'Sources/B.swift', '--format', 'json', '--output', join(outDir, 'muter.json'), '--skip-update-check']);
});

test('StrykerJS plan escapes the glob metacharacters that need it and leaves `!` literal', () => {
  const root = tempDir('mutate-js-glob-'), outDir = outDirWith();
  write(root, 'package.json', JSON.stringify({ scripts: { test: 'bun test' } }));
  const changed = new Map([['src/[id]/page.ts', [5, 6]], ['src/a!b.ts', [3]]]);
  const plan = adapter('javascript').plan({ root, repoTop: root, changed, outDir }, { bin: '/bin/stryker' });
  expect(JSON.parse(plan.files[join(outDir, 'stryker.config.json')]).mutate).toEqual(['src/[[]id[]]/page.ts:5-6', 'src/a!b.ts:3-3']);
  // `[!]` opens a negated class that never closes, so escaping `!` loses the file.
  expect(matchesGlob('src/[id]/page.ts', 'src/[[]id[]]/page.ts')).toBe(true);
  expect(matchesGlob('src/a!b.ts', 'src/a!b.ts')).toBe(true);
  expect(matchesGlob('src/a!b.ts', 'src/a[!]b.ts')).toBe(false);
});

test('a widened root is kept only when it contains the crate that changed', () => {
  expect(widenedRoot('/repo', 'crates/a', '/repo')).toBe('.');
  expect(widenedRoot('/repo', 'crates/a', '/repo/crates')).toBe('crates');
  expect(widenedRoot('/repo', 'crates/a', '/repo/crates/a')).toBe('crates/a');
  // Cargo allows `workspace = "../../ws"`, and a sibling root would turn every
  // change-set key into a `../` pathspec that git drops without an error.
  expect(widenedRoot('/repo', 'crates/a', '/repo/ws')).toBe('crates/a');
  expect(widenedRoot('/repo', 'crates/a', '/elsewhere')).toBe('crates/a');
});

test('the widened root is resolved once per crate directory, not once per changed file', async () => {
  const root = makeRoot();
  write(root, 'fake.toml', '');
  write(root, 'member/fake.toml', '');
  for (const name of ['a', 'b', 'c']) write(root, `member/src/${name}.fake`, 'one\n');
  commitAll(root, 'base');
  for (const name of ['a', 'b', 'c']) write(root, `member/src/${name}.fake`, 'one\ntwo\n');
  let rootCalls = 0;
  const widening = { ...fakeAdapter(), root: () => { rootCalls += 1; return '.'; } };
  const report = await runDiffMutate({ cwd: root, base: 'main', adapters: [widening] });
  expect(rootCalls).toBe(1);
  expect(report.mutants.map(row => row.file).sort()).toEqual(['member/src/a.fake', 'member/src/b.fake', 'member/src/c.fake']);
});

test('a repository that renames diff prefixes still resolves its changed paths', async () => {
  const root = fakeRepo();
  sh(root, 'git config diff.mnemonicPrefix true');
  write(root, 'a.fake', 'one\ntwo\n');
  const report = await runDiffMutate({ cwd: root, base: 'main', adapters: [fakeAdapter()] });
  expect(report.languages.map(row => [row.root, row.status])).toEqual([['.', 'ran']]);
  expect(report.mutants.map(row => [row.file, row.line])).toEqual([['a.fake', 2]]);
});

test('an adapter may widen its root, and the change set follows it', async () => {
  const root = makeRoot();
  write(root, 'fake.toml', '');
  write(root, 'member/fake.toml', '');
  write(root, 'member/src/a.fake', 'one\n');
  commitAll(root, 'base');
  write(root, 'member/src/a.fake', 'one\ntwo\n');
  const calls = [], widened = { ...fakeAdapter({ calls }), root: () => '.' };
  const report = await runDiffMutate({ cwd: root, base: 'main', adapters: [widened] });
  expect(report.languages.map(row => [row.root, row.status])).toEqual([['.', 'ran']]);
  expect(calls[0].changed).toEqual(new Map([['member/src/a.fake', [2]]]));
  expect(report.mutants.map(row => row.file)).toEqual(['member/src/a.fake']);
});

test('diff mode groups files by manifest root, includes uncommitted edits, and keeps only changed-line mutants', async () => {
  const root = makeRoot();
  write(root, 'pkg/fake.toml', '');
  write(root, 'pkg/src/a.fake', 'one\n');
  write(root, 'top.fake', 'x\n');
  commitAll(root, 'base');
  sh(root, 'git checkout -qb feature');
  write(root, 'pkg/src/a.fake', 'one\ntwo\n');
  commitAll(root, 'committed change');
  write(root, 'pkg/src/a.fake', 'one\ntwo\nthree\n');
  write(root, 'top.fake', 'x\ny\n');
  write(root, 'README.md', 'not supported\n');
  const calls = [];
  const report = await runDiffMutate({ cwd: join(root, 'pkg'), base: 'main', adapters: [fakeAdapter({ calls })] });
  expect(report.merge_base).toBe(sh(root, 'git rev-parse main').trim());
  expect(report.languages.map(row => [row.root, row.status])).toEqual([['pkg', 'ran'], [null, 'unavailable']]);
  expect(report.languages[1].reason).toBe('no fake.toml found above top.fake');
  expect(calls).toHaveLength(1);
  expect(calls[0].changed).toEqual(new Map([['src/a.fake', [2, 3]]]));
  expect(calls[0].diff).toContain('+++ b/src/a.fake');
  expect(report.mutants.map(row => [row.file, row.line])).toEqual([['pkg/src/a.fake', 2], ['pkg/src/a.fake', 3]]);
  expect(report.counts.survived).toBe(2);
});

test('a tool that is not installed is reported with its install command and never replaced', async () => {
  const root = fakeRepo();
  sh(root, 'git checkout -qb feature');
  write(root, 'a.fake', 'one\ntwo\n');
  const report = await runDiffMutate({ cwd: root, base: 'main', adapters: [fakeAdapter({ unavailable: 'fake-tool is not installed' })] });
  expect(report.languages).toEqual([expect.objectContaining({ status: 'unavailable', reason: 'fake-tool is not installed', install: 'install fake-tool' })]);
  expect(report.mutants).toEqual([]);
});

test('a tool failure keeps its output tail and marks only that language', async () => {
  const root = fakeRepo();
  write(root, 'a.fake', 'one\ntwo\n');
  const argv = [process.execPath, '-e', 'console.error("boom from tool"); process.exit(3)'];
  const [row] = (await runDiffMutate({ cwd: root, base: 'main', adapters: [fakeAdapter({ argv })] })).languages;
  expect(row).toMatchObject({ status: 'error', reason: 'fake-tool exited 3', exit_code: 3 });
  expect(row.output_tail).toContain('boom from tool');
});

test('the run budget stops a stalled tool and kills its background children', async () => {
  const root = fakeRepo(), pidFile = join(root, 'child.pid');
  write(root, 'a.fake', 'one\ntwo\n');
  const argv = ['bash', '-c', `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`];
  const [row] = (await runDiffMutate({ cwd: root, base: 'main', timeoutMs: 500, adapters: [fakeAdapter({ argv })] })).languages;
  expect(row.status).toBe('timeout');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  let alive = true;
  for (let attempt = 0; attempt < 50 && alive; attempt += 1) {
    try { process.kill(pid, 0); await new Promise(done => setTimeout(done, 20)); } catch { alive = false; }
  }
  expect(alive).toBe(false);
});

test('a base that looks like an option or names no ref fails before any tool runs', async () => {
  const root = fakeRepo();
  await expect(runDiffMutate({ cwd: root, base: '--output=/tmp/x', adapters: [] })).rejects.toThrow(/names a git ref/);
  await expect(runDiffMutate({ cwd: root, base: 'no-such-branch', adapters: [] })).rejects.toThrow(/merge base of no-such-branch/);
});

test('CLI diff mode writes the report and exits 1 when a language cannot run', () => {
  const root = makeRoot();
  write(root, 'README.md', 'base\n');
  commitAll(root, 'base');
  sh(root, 'git checkout -qb feature');
  write(root, 'Sources/A.swift', 'let a = 1\n');
  commitAll(root, 'swift change');
  const result = spawnSync('bun', [CLI, 'mutate-diff', '--diff', 'main', '--json'], { cwd: root, encoding: 'utf8', env: cliEnv() });
  expect(result.status).toBe(1);
  const report = JSON.parse(result.stdout);
  expect(report.languages).toEqual([expect.objectContaining({ language: 'swift', status: 'unavailable', reason: 'no muter.conf.yml or Package.swift found above Sources/A.swift' })]);
  const name = `${report.head.slice(0, 12)}-${report.merge_base.slice(0, 12)}`;
  expect(JSON.parse(readFileSync(join(root, `.xm/review/mutate-diff/${name}.json`), 'utf8')).head).toBe(report.head);
});

test('each entry rejects the other entry\'s flags and the removed ones', () => {
  const root = tempDir('mutate-cli-');
  const run = (command, args) => spawnSync('bun', [CLI, command, ...args], { cwd: root, encoding: 'utf8', env: cliEnv() });
  for (const [command, args, message] of [
    // `xm mutate` is diff-only.
    ['mutate-diff', [], /--diff <base> is required/],
    ['mutate-diff', ['--diff', 'main', '--task', 'T1'], /--task belongs to `xm build mutate`/],
    ['mutate-diff', ['--diff', 'main', '--list'], /--list belongs to `xm build mutate`/],
    ['mutate-diff', ['--diff', 'main', '--base', 'x'], /--base belongs to `xm build mutate`/],
    ['mutate-diff', ['--diff', 'main', '--lang', 'cobol'], /--lang accepts rust, javascript, go, swift/],
    ['mutate-diff', ['--diff', 'main', '--timeout-ms', '0'], /--timeout-ms must be an integer between 1 and 2147483647/],
    // Node clamps a delay above 2^31-1 to 1ms, so this would kill every tool at once.
    ['mutate-diff', ['--diff', 'main', '--timeout-ms', '99999999999'], /--timeout-ms must be an integer between 1 and 2147483647/],
    // `xm build mutate` is task-only.
    ['mutate', ['--diff', 'main'], /--diff belongs to `xm mutate --diff <base>`/],
    ['mutate', ['--max-mutants', '3'], /--max-mutants was removed/],
    ['mutate', ['--list', '--task', 'T1'], /--list cannot be combined with --task/],
    ['mutate', ['--base', 'main'], /--task <id> is required/],
    // --base reaches its own guard only with --list, which names no task.
    ['mutate', ['--list', '--base', 'main'], /--base applies to --task/],
  ]) {
    const result = run(command, args);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(message);
  }
});

test('task mode runs in the linked worktree, reports under the project, and queues survivors', async () => {
  const root = fakeRepo(), wt = artifact(root, 'T1', { base: 'main' });
  changeInWorktree(wt);
  const report = await runTaskMutate(root, 'T1', { project: 'p', adapters: [fakeAdapter()] });
  expect(report).toMatchObject({ mode: 'task', project: 'p', task_id: 'T1', counts: { survived: 1 } });
  expect(JSON.parse(readFileSync(join(root, '.xm/review/mutate/p/T1.json'), 'utf8')).mutants).toEqual([expect.objectContaining({ file: 'a.fake', line: 2, status: 'survived' })]);
  const ledger = readFileSync(join(root, '.xm/review/escape-ledger.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(ledger).toEqual([expect.objectContaining({ type: 'surviving_mutant', task_id: 'T1', file: 'a.fake', line: 2, operator: 'Fake', source: 'mutate', artifact: '.xm/review/mutate/p/T1.json' })]);
  expect(readFileSync(join(root, 'a.fake'), 'utf8')).toBe('one\n');
});

test('task mode without a recorded base asks for --base and honours it', async () => {
  const root = fakeRepo(), wt = artifact(root, 'T1');
  changeInWorktree(wt);
  await expect(runTaskMutate(root, 'T1', { adapters: [fakeAdapter()] })).rejects.toThrow(/no base; pass --base <ref>/);
  expect((await runTaskMutate(root, 'T1', { base: 'main', adapters: [fakeAdapter()] })).counts.survived).toBe(1);
});

test('listing reports runnable tasks with changed files and a reason for the rest', () => {
  const root = fakeRepo();
  changeInWorktree(artifact(root, 'T1', { base: 'main' }));
  artifact(root, 'T3');
  artifact(root, 'T4', { base: 'main' });
  tasks(root, 'p', [{ id: 'T1', name: 'Ready', status: 'done' }, { id: 'T2', name: 'No artifact' }, { id: 'T3' }, { id: 'T4' }]);
  const rows = listMutationTasks(root, { adapters: [fakeAdapter()] });
  expect(rows.map(row => [row.id, row.runnable, row.reason])).toEqual([
    ['T1', true, null],
    ['T2', false, 'missing worktree artifact'],
    ['T3', false, 'run.json has no base; pass --base <ref>'],
    ['T4', false, 'no changed files in a supported language'],
  ]);
  expect(rows[0]).toMatchObject({ name: 'Ready', status: 'done', files: ['a.fake'] });
});

test('duplicate task ids require project disambiguation', async () => {
  const root = fakeRepo();
  for (const project of ['alpha', 'beta']) changeInWorktree(artifact(root, 'T1', { base: 'main' }, project));
  await expect(runTaskMutate(root, 'T1', { adapters: [fakeAdapter()] })).rejects.toThrow(/ambiguous/);
  expect((await runTaskMutate(root, 'T1', { project: 'alpha', adapters: [fakeAdapter()] })).project).toBe('alpha');
});

test('project and task traversal are rejected at the engine boundary', async () => {
  const root = makeRoot();
  await expect(runTaskMutate(root, '../task')).rejects.toThrow(/must not contain/);
  await expect(runTaskMutate(root, 'T1', { project: '../project' })).rejects.toThrow(/must not contain/);
});

test('missing, primary, or foreign task worktrees fail closed', async () => {
  const root = fakeRepo(), foreign = fakeRepo('mutate-foreign-'), run = join(root, '.xm/build/projects/p/worktrees/T1/run.json');
  mkdirSync(dirname(run), { recursive: true });
  writeFileSync(run, JSON.stringify({ task_id: 'T1', branch: 'missing', worktree: '', base: 'main' }));
  await expect(runTaskMutate(root, 'T1')).rejects.toThrow(/missing its worktree/);
  writeFileSync(run, JSON.stringify({ task_id: 'T1', branch: 'main', worktree: root, base: 'main' }));
  await expect(runTaskMutate(root, 'T1')).rejects.toThrow(/primary checkout/);
  writeFileSync(run, JSON.stringify({ task_id: 'T1', branch: 'main', worktree: foreign, base: 'main' }));
  await expect(runTaskMutate(root, 'T1')).rejects.toThrow(/different repository/);
});

test('one linked worktree cannot be claimed by two task artifacts', async () => {
  const root = fakeRepo(), wt = artifact(root, 'T2', { base: 'main' });
  const branch = sh(wt, 'git branch --show-current').trim();
  write(root, '.xm/build/projects/p/worktrees/T1/run.json', JSON.stringify({ task_id: 'T1', branch, worktree: wt, base: 'main' }));
  await expect(runTaskMutate(root, 'T1', { project: 'p' })).rejects.toThrow(/claimed by another task/);
});

test('recorded branch must match the registered linked worktree', async () => {
  const root = fakeRepo();
  artifact(root, 'T1', { base: 'main' });
  const run = join(root, '.xm/build/projects/p/worktrees/T1/run.json');
  writeFileSync(run, JSON.stringify({ ...JSON.parse(readFileSync(run, 'utf8')), branch: 'wrong-branch' }));
  await expect(runTaskMutate(root, 'T1', { project: 'p' })).rejects.toThrow(/recorded branch/);
});

test('project and task path segments cannot collide', async () => {
  const root = fakeRepo();
  for (const [project, task] of [['a-b', 'c'], ['a', 'b-c']]) {
    changeInWorktree(artifact(root, task, { base: 'main' }, project));
    await runTaskMutate(root, task, { project, adapters: [fakeAdapter()] });
  }
  expect(existsSync(join(root, '.xm/review/mutate/a-b/c.json'))).toBe(true);
  expect(existsSync(join(root, '.xm/review/mutate/a/b-c.json'))).toBe(true);
});

test('a pre-created temp symlink in the report directory is never followed', async () => {
  const root = fakeRepo(), outside = join(root, 'outside.txt');
  writeFileSync(outside, 'sentinel');
  changeInWorktree(artifact(root, 'T1', { base: 'main' }));
  const dir = join(root, '.xm/review/mutate/p'), planted = join(dir, 'T1.json.tmp');
  mkdirSync(dir, { recursive: true });
  symlinkSync(outside, planted);
  await runTaskMutate(root, 'T1', { adapters: [fakeAdapter()] });
  expect(readFileSync(outside, 'utf8')).toBe('sentinel');
  expect(lstatSync(planted).isSymbolicLink()).toBe(true);
  expect(JSON.parse(readFileSync(join(dir, 'T1.json'), 'utf8'))).toMatchObject({ project: 'p', task_id: 'T1' });
});

test('report publication rejects a group-writable project directory', async () => {
  if (process.platform === 'win32') return;
  const root = fakeRepo('mutate-report-mode-');
  changeInWorktree(artifact(root, 'T1', { base: 'main' }));
  const dir = join(root, '.xm/review/mutate/p');
  mkdirSync(dir, { recursive: true });
  sh(root, `chmod 0777 ${JSON.stringify(dir)}`);
  await expect(runTaskMutate(root, 'T1', { project: 'p', adapters: [fakeAdapter()] })).rejects.toThrow(/report directory is unsafe/);
  expect(existsSync(join(dir, 'T1.json'))).toBe(false);
});

test('build mutation surface has no stale probe command or module references', () => {
  const repo = resolve(import.meta.dir, '..');
  for (const file of ['x-build/lib/x-build-cli.mjs', 'x-build/lib/x-build/mutate.mjs', 'x-build/skills/build/references/commands.md', 'xm/lib/x-build-cli.mjs', 'xm/lib/x-build/mutate.mjs', 'xm/skills/build/references/commands.md']) {
    expect(readFileSync(resolve(repo, file), 'utf8')).not.toMatch(/xm build probe|cmdProbe|runTaskProbe|x-build\/probe\.mjs|source:\s*['"]probe/);
  }
});
