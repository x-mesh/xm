import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'x-build', 'lib', 'x-build-cli.mjs');
const XM = join(ROOT, 'xm', 'scripts', 'xm');
const { orderSealRows } = await import('../x-build/lib/x-build/batch.mjs');

const FAKE_GK = join(ROOT, 'test', 'worktrees', 'fake-gk.mjs');

function run(cwd, args, executable = CLI, extraEnv = {}) {
  const command = executable === XM ? 'bash' : 'node';
  const result = spawnSync(command, [executable, ...args], {
    cwd, env: { ...process.env, XM_LIB: ROOT, X_BUILD_ROOT: join(cwd, '.xm', 'build'), XKIT_SERVER: undefined, ...extraEnv }, encoding: 'utf8',
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function envelope(goal, files) {
  return {
    schema_version: 1, status: 'complete', executable: true, goal,
    requirements: [{ id: 'R1', text: goal, priority: 'must' }], assumptions: [],
    decision: { selected: 'Implement', alternatives: [] },
    tasks: [{ id: 'T1', title: goal, depends_on: [], requirement_refs: ['R1'], expected_files: files, done_criteria: ['The topic works', 'none — no pathological input surface'] }],
    steps: [['T1']], validation: { commands: ['node --test'], requirement_refs: ['R1'] },
    failure_modes: [], disagreements: [], unresolved_questions: [], provenance: { source: 'test' },
  };
}

function setup() { return mkdtempSync(join(tmpdir(), 'xm-batch-')); }
function setupRepo() {
  const cwd = setup();
  for (const args of [['init', '-b', 'develop'], ['config', 'user.email', 'batch@example.com'], ['config', 'user.name', 'Batch Test']]) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  writeFileSync(join(cwd, 'README.md'), '# fixture\n');
  spawnSync('git', ['add', 'README.md'], { cwd });
  spawnSync('git', ['commit', '-m', 'fixture'], { cwd, encoding: 'utf8' });
  return cwd;
}
function addWorktree(cwd, path, branch) {
  const result = spawnSync('git', ['worktree', 'add', '-b', branch, path, 'develop'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}
function completeTopic(cwd, topic) {
  const checked = run(cwd, ['task-check', 't1', '--project', topic, '--json']);
  if (checked.code !== 0) throw new Error(checked.stderr + checked.stdout);
  const completed = run(cwd, ['tasks', 'update', 't1', '--status', 'completed', '--project', topic, '--no-commit']);
  if (completed.code !== 0) throw new Error(completed.stderr + completed.stdout);
}
function fakePublishers(cwd) {
  const log = join(cwd, 'publish-calls.jsonl');
  const state = join(cwd, 'publish-state.json');
  const gk = join(cwd, 'fake-push.mjs');
  const gh = join(cwd, 'fake-gh.mjs');
  writeFileSync(gk, `
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.PUBLISH_LOG, JSON.stringify({ tool: 'gk', argv: process.argv.slice(2), agent: process.env.GK_AGENT }) + '\\n');
process.stdout.write(JSON.stringify({ schema: 1, state: 'ok', ok: true, result: { pushed: true }, error: null }) + '\\n');
`);
  writeFileSync(gh, `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const argv = process.argv.slice(2);
appendFileSync(process.env.PUBLISH_LOG, JSON.stringify({ tool: 'gh', argv }) + '\\n');
if (!['pr', 'api'].includes(argv[0])) process.exit(2);
if (argv[1] === 'merge') {
  const value = JSON.parse(readFileSync(process.env.PUBLISH_STATE, 'utf8'));
  const sealedHead = argv[argv.indexOf('--match-head-commit') + 1];
  if (sealedHead !== value.headRefOid) process.exit(1);
  const merged = spawnSync('git', ['merge', '--no-edit', '--no-ff', sealedHead], { cwd: process.env.PUBLISH_BASE_WORKTREE, encoding: 'utf8' });
  if (merged.status !== 0) process.exit(1);
  value.state = 'MERGED'; value.mergedAt = new Date().toISOString();
  value.mergeCommit = { oid: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: process.env.PUBLISH_BASE_WORKTREE, encoding: 'utf8' }).stdout.trim() };
  writeFileSync(process.env.PUBLISH_STATE, JSON.stringify(value));
  process.exit(0);
}
if (argv[1] === 'create') {
  const take = (name) => argv[argv.indexOf(name) + 1];
  const value = {
    number: 17, url: 'https://example.test/pr/17', state: 'OPEN',
    isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', autoMergeRequest: null, mergeCommit: null, mergedAt: null,
    baseRefName: take('--base'), baseRefOid: process.env.PUBLISH_BASE_OID || 'base-oid', headRefName: take('--head'),
    headRefOid: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    title: take('--title'), body: readFileSync(take('--body-file'), 'utf8'),
  };
  writeFileSync(process.env.PUBLISH_STATE, JSON.stringify(value));
  process.stdout.write(value.url + '\\n');
  process.exit(0);
}
if (argv[1] === 'view') {
  const fields = argv[argv.indexOf('--json') + 1].split(',');
  if (fields.includes('baseRefOid')) { process.stderr.write('Unknown JSON field: "baseRefOid"\\n'); process.exit(1); }
  if (process.env.PUBLISH_VIEW_ERROR) { process.stderr.write(process.env.PUBLISH_VIEW_ERROR + '\\n'); process.exit(1); }
  if (!existsSync(process.env.PUBLISH_STATE)) { process.stderr.write('no pull requests found for branch "' + argv[2] + '"\\n'); process.exit(1); }
  const value = JSON.parse(readFileSync(process.env.PUBLISH_STATE, 'utf8'));
  process.stdout.write(JSON.stringify(Object.fromEntries(fields.map((field) => [field, value[field]]))) + '\\n');
  process.exit(0);
}
if (argv[0] === 'api' && /^repos\\/\\{owner\\}\\/\\{repo\\}\\/pulls\\/\\d+$/.test(argv[1])) {
  if (process.env.PUBLISH_API_ERROR) { process.stderr.write(process.env.PUBLISH_API_ERROR + '\\n'); process.exit(1); }
  const value = JSON.parse(readFileSync(process.env.PUBLISH_STATE, 'utf8'));
  process.stdout.write(JSON.stringify({ number: value.number, base: { ref: value.baseRefName, sha: value.baseRefOid }, head: { sha: value.headRefOid } }) + '\\n');
  process.exit(0);
}
if (argv[0] === 'api') {
  const value = JSON.parse(readFileSync(process.env.PUBLISH_STATE, 'utf8'));
  const ref = value.state === 'MERGED' && value.mergeCommit?.oid ? value.mergeCommit.oid : value.baseRefOid;
  const tree = spawnSync('git', ['rev-parse', ref + '^{tree}'], { cwd: process.env.PUBLISH_BASE_WORKTREE || process.cwd(), encoding: 'utf8' }).stdout.trim();
  process.stdout.write(JSON.stringify({ sha: ref, commit: { tree: { sha: tree } } }) + '\\n');
  process.exit(0);
}
process.exit(2);
`);
  return { log, state, env: { PUBLISH_LOG: log, PUBLISH_STATE: state, X_BUILD_GK_ARGV: JSON.stringify(['node', gk]), X_BUILD_GH_ARGV: JSON.stringify(['node', gh]) } };
}
function fakeIntegrationDriver(cwd, integrationTree) {
  const log = join(cwd, 'integration-calls.jsonl');
  const file = join(cwd, 'fake-integration-gk.mjs');
  writeFileSync(file, `
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const argv = process.argv.slice(2);
appendFileSync(process.env.INTEGRATION_LOG, JSON.stringify(argv) + '\\n');
const emit = (value, code = 0) => { process.stdout.write(JSON.stringify(value) + '\\n'); process.exit(code); };
if (argv[0] === 'worktree' && argv[1] === 'acquire') {
  const branch = argv[2];
  const base = argv[argv.indexOf('--from') + 1];
  const added = spawnSync('git', ['worktree', 'add', '-b', branch, process.env.INTEGRATION_TREE, base], { encoding: 'utf8' });
  if (added.status !== 0) emit({ schema: 1, state: 'error', ok: false, error: { code: 'acquire', message: added.stderr } }, 2);
  emit({ schema: 1, state: 'ok', ok: true, result: { path: process.env.INTEGRATION_TREE, branch } });
}
if (argv[0] === 'merge') {
  const before = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const preflight = argv[1] === before;
  const mode = (process.env.INTEGRATION_FAILURE_PHASE === 'preflight') === preflight ? process.env.INTEGRATION_MERGE_OUTPUT : null;
  if (mode === 'paused') emit({ schema: 1, state: 'paused', ok: false, result: { remedies: [{ command: 'git-kit continue', safety: 'safe' }] }, error: { code: 'conflict', message: 'conflict' } }, 3);
  if (mode === 'nonzero') emit({ schema: 1, state: 'error', ok: false, error: { code: 'merge_failed', message: 'merge refused' } }, 2);
  const merged = spawnSync('git', ['merge', '--no-edit', '--no-ff', argv[1]], { encoding: 'utf8' });
  if (merged.status !== 0) emit({ schema: 1, state: 'paused', ok: false, result: { remedies: [{ command: 'git-kit merge --continue', safety: 'safe' }] }, error: { code: 'conflict', message: merged.stderr } }, 3);
  if (mode === 'no-json') { process.stderr.write('merged successfully'); process.exit(0); }
  if (mode === 'invalid-json') { process.stdout.write('{invalid'); process.exit(0); }
  if (mode === 'invalid-envelope') emit({ message: 'success' });
  emit({ schema: 1, state: 'ok', ok: true, result: { merged: argv[1] } }, mode === 'inconsistent' ? 1 : 0);
}
if (argv[0] === 'diff') {
  const base = argv.at(-2), head = argv.at(-1);
  const diff = spawnSync('git', ['diff', '--binary', base, head], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (diff.status !== 0) emit({ schema: 1, state: 'error', ok: false, error: { code: 'diff', message: diff.stderr } }, 2);
  emit({ schema: 1, state: 'ok', ok: true, result: { patch: diff.stdout } });
}
emit({ schema: 1, state: 'error', ok: false, error: { code: 'unsupported', message: argv.join(' ') } }, 2);
`);
  return { log, env: { X_BUILD_GK_ARGV: JSON.stringify(['node', file]), INTEGRATION_LOG: log, INTEGRATION_TREE: integrationTree } };
}
function manifest(cwd, id = 'release') { return JSON.parse(readFileSync(join(cwd, '.xm', 'batches', id, 'manifest.json'), 'utf8')); }
function addPlan(cwd, batch, topic, files, extra = []) {
  const path = join(cwd, topic + '.json');
  writeFileSync(path, JSON.stringify(envelope(topic, files)));
  return run(cwd, ['batch', 'add', batch, topic, '--plan', path, ...extra, '--json']);
}

describe('xm batch scheduler', () => {
  test('initializes a batch without overwriting an existing manifest', () => {
    const cwd = setup();
    try {
      const created = run(cwd, ['batch', 'init', 'release', '--json']);
      expect(created.code, created.stderr).toBe(0);
      expect(JSON.parse(created.stdout)).toMatchObject({ status: 'created', batch: 'release' });
      expect(manifest(cwd)).toMatchObject({ status: 'collecting', topics: [], schedule: null });
      const before = readFileSync(join(cwd, '.xm', 'batches', 'release', 'manifest.json'), 'utf8');
      expect(run(cwd, ['batch', 'init', 'release', '--json']).code).toBe(2);
      expect(readFileSync(join(cwd, '.xm', 'batches', 'release', 'manifest.json'), 'utf8')).toBe(before);
      expect(run(cwd, ['batch', 'init', '../unsafe', '--json']).code).toBe(2);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('validates and records executable plans, hashes, and topic scope', () => {
    const cwd = setup();
    try {
      run(cwd, ['batch', 'init', 'release', '--json']);
      const added = addPlan(cwd, 'release', 'auth', ['src/auth.mjs', 'test/auth.test.mjs']);
      expect(added.code, added.stderr).toBe(0);
      const topic = manifest(cwd).topics[0];
      expect(topic).toMatchObject({ id: 'auth', goal: 'auth', status: 'pending', expected_files_complete: true, expected_files: ['src/auth.mjs', 'test/auth.test.mjs'] });
      expect(topic.plan.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(run(cwd, ['batch', 'add', 'release', 'auth', '--plan', topic.plan.source, '--json']).code).toBe(2);

      const draftPath = join(cwd, 'draft.json');
      writeFileSync(draftPath, JSON.stringify(envelope('draft', ['draft.mjs']) | 0));
      expect(run(cwd, ['batch', 'add', 'release', 'draft', '--plan', draftPath, '--json']).code).toBe(2);
      expect(manifest(cwd).topics).toHaveLength(1);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('builds dependency frontiers and conflict-free bounded waves', () => {
    const cwd = setup();
    try {
      run(cwd, ['batch', 'init', 'release', '--json']);
      addPlan(cwd, 'release', 'auth', ['src/auth.mjs']);
      addPlan(cwd, 'release', 'search', ['src/search.mjs']);
      addPlan(cwd, 'release', 'docs', ['docs/api.md']);
      addPlan(cwd, 'release', 'ui', ['src/ui.mjs'], ['--depends-on', 'auth']);
      const planned = run(cwd, ['batch', 'plan', 'release', '--max-parallel', '2', '--json']);
      expect(planned.code, planned.stderr).toBe(0);
      const schedule = JSON.parse(planned.stdout).schedule;
      expect(schedule.waves.map((wave) => wave.topics)).toEqual([['auth', 'search'], ['docs'], ['ui']]);
      expect(schedule.waves[0].mode).toBe('parallel');
      expect(manifest(cwd).status).toBe('planned');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('separates file conflicts and unknown scopes, then reports stored status', () => {
    const cwd = setup();
    try {
      run(cwd, ['batch', 'init', 'release', '--json']);
      addPlan(cwd, 'release', 'one', ['shared.mjs']);
      addPlan(cwd, 'release', 'two', ['shared.mjs']);
      addPlan(cwd, 'release', 'unknown', []);
      const planned = JSON.parse(run(cwd, ['batch', 'plan', 'release', '--json']).stdout).schedule;
      expect(planned.waves.map((wave) => wave.topics)).toEqual([['one'], ['two'], ['unknown']]);
      expect(planned.conflict_edges).toEqual([{ tasks: ['one', 'two'], files: ['shared.mjs'] }]);
      expect(planned.sequential_topics).toEqual(['unknown']);
      const status = run(cwd, ['batch', 'status', 'release', '--json']);
      expect(status.code).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({ status: 'planned', topic_count: 3, topic_statuses: { pending: 3 }, execution: null, seal: null, integration: null, merge: null });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('blocks dangling dependencies and cycles without replacing a prior schedule', () => {
    const cwd = setup();
    try {
      run(cwd, ['batch', 'init', 'release', '--json']);
      addPlan(cwd, 'release', 'a', ['a.mjs'], ['--depends-on', 'missing']);
      expect(run(cwd, ['batch', 'plan', 'release', '--json']).code).toBe(2);
      expect(manifest(cwd).schedule).toBeNull();

      const cycle = manifest(cwd);
      cycle.topics[0].depends_on = ['b'];
      const bPath = join(cwd, 'b.json');
      writeFileSync(bPath, JSON.stringify(envelope('b', ['b.mjs'])));
      writeFileSync(join(cwd, '.xm', 'batches', 'release', 'manifest.json'), JSON.stringify(cycle));
      addPlan(cwd, 'release', 'b', ['b.mjs'], ['--depends-on', 'a']);
      expect(run(cwd, ['batch', 'plan', 'release', '--json']).code).toBe(2);
      expect(manifest(cwd).schedule).toBeNull();
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('top-level xm dispatcher routes batch to x-build', () => {
    const cwd = setup();
    try {
      expect(run(cwd, ['batch', 'init', 'dispatch', '--json'], XM).code).toBe(0);
      const status = run(cwd, ['batch', 'status', 'dispatch', '--json'], XM);
      expect(status.code, status.stderr).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({ batch: 'dispatch', status: 'collecting' });
      expect(existsSync(join(cwd, '.xm', 'batches', 'dispatch', 'manifest.json'))).toBe(true);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('lists stored batches newest first and keeps unreadable manifests visible', () => {
    const cwd = setup();
    try {
      for (const id of ['old', 'new']) run(cwd, ['batch', 'init', id, '--json']);
      const batches = join(cwd, '.xm', 'batches');
      const stamp = (id, updatedAt, status) => {
        const value = manifest(cwd, id);
        writeFileSync(join(batches, id, 'manifest.json'), JSON.stringify({ ...value, updated_at: updatedAt, status }));
      };
      stamp('old', '2026-01-01T00:00:00.000Z', 'merged');
      stamp('new', '2026-02-01T00:00:00.000Z', 'collecting');
      mkdirSync(join(batches, 'broken'));
      writeFileSync(join(batches, 'broken', 'manifest.json'), '{');
      mkdirSync(join(batches, 'lock-only'));

      const listed = run(cwd, ['batch', 'list', '--json']);
      expect(listed.code, listed.stderr).toBe(0);
      const rows = JSON.parse(listed.stdout).batches;
      expect(rows.map((row) => row.id)).toEqual(['new', 'old', 'broken']);
      expect(rows[0]).toMatchObject({ status: 'collecting', active: true, topic_count: 0 });
      expect(rows[1]).toMatchObject({ status: 'merged', active: false });
      expect(rows[2]).toMatchObject({ status: 'unreadable', active: false, error: 'manifest is unreadable' });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('candidates lists unregistered executable plans and counts every exclusion', () => {
    const cwd = setup();
    try {
      const plans = join(cwd, '.xm', 'plan');
      const write = (path, value) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); };
      const dated = (goal, files, createdAt, extra = {}) => ({ ...envelope(goal, files), provenance: { source: 'test', created_at: createdAt }, ...extra });
      const alpha = join(plans, '20260101T000000Z-alpha.json');
      const beta = join(plans, '20260102T000000Z-beta', 'envelope.json');
      write(alpha, dated('alpha', ['src/a.mjs'], '2026-01-01T00:00:00.000Z'));
      write(beta, dated('beta', ['src/b.mjs'], '2026-01-02T00:00:00.000Z'));
      write(join(plans, '20260103T000000Z-draft.json'), dated('draft', ['src/d.mjs'], '2026-01-03T00:00:00.000Z', { status: 'incomplete', executable: false }));
      write(join(plans, '20260104T000000Z-held.json'), dated('held', ['src/h.mjs'], '2026-01-04T00:00:00.000Z', { executable: false }));
      write(join(plans, 'broken.json'), 'not json');
      write(join(plans, '.partial.json'), 'ignored');
      mkdirSync(join(plans, '20260105T000000Z-interview'));

      const first = run(cwd, ['batch', 'candidates', '--json']);
      expect(first.code, first.stderr).toBe(0);
      const listed = JSON.parse(first.stdout);
      expect(listed.candidates.map((row) => row.goal)).toEqual(['beta', 'alpha']);
      expect(listed.candidates[0]).toMatchObject({ path: beta, task_count: 1, expected_files_complete: true, expected_files: ['src/b.mjs'] });
      expect(listed.excluded).toEqual({ missing_envelope: 1, invalid: 1, incomplete: 1, not_executable: 1, registered: 0 });

      run(cwd, ['batch', 'init', 'release', '--json']);
      expect(run(cwd, ['batch', 'add', 'release', 'beta', '--plan', beta, '--json']).code).toBe(0);
      const copy = join(cwd, 'alpha-copy.json');
      writeFileSync(copy, readFileSync(alpha));
      expect(run(cwd, ['batch', 'add', 'release', 'alpha', '--plan', copy, '--json']).code).toBe(0);

      const after = JSON.parse(run(cwd, ['batch', 'candidates', '--json']).stdout);
      expect(after.candidates).toEqual([]);
      expect(after.excluded.registered).toBe(2);
      expect(after.warnings).toEqual([]);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('standalone x-build validates and adds a plan without the repository x-plan sibling', () => {
    const cwd = setup();
    try {
      const plugin = join(cwd, 'build-plugin');
      cpSync(join(ROOT, 'x-build'), plugin, { recursive: true });
      const standalone = join(plugin, 'lib', 'x-build-cli.mjs');
      expect(run(cwd, ['batch', 'init', 'standalone', '--json'], standalone).code).toBe(0);
      const plan = join(cwd, 'standalone-plan.json');
      writeFileSync(plan, JSON.stringify(envelope('standalone', ['src/standalone.mjs'])));
      const added = run(cwd, ['batch', 'add', 'standalone', 'topic', '--plan', plan, '--json'], standalone);
      expect(added.code, added.stderr).toBe(0);
      expect(JSON.parse(added.stdout)).toMatchObject({ status: 'added', batch: 'standalone', topic: 'topic' });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('parses value-taking options before the batch id', () => {
    const cwd = setup();
    try {
      run(cwd, ['batch', 'init', 'release', '--json']);
      addPlan(cwd, 'release', 'auth', ['src/auth.mjs']);
      const invalid = run(cwd, ['batch', 'plan', '--max-parallel', '0', 'release', '--json']);
      expect(invalid.code).toBe(2);
      expect(JSON.parse(invalid.stdout).errors).toContain('max_parallel must be a positive integer');
      expect(manifest(cwd).schedule).toBeNull();
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('dry-run fixes a base SHA and leaves the manifest and worktrees unchanged', () => {
    const cwd = setupRepo();
    try {
      run(cwd, ['batch', 'init', 'release', '--json']);
      addPlan(cwd, 'release', 'auth', ['src/auth.mjs']);
      addPlan(cwd, 'release', 'search', ['src/search.mjs']);
      addPlan(cwd, 'release', 'docs', ['docs/api.md']);
      run(cwd, ['batch', 'plan', 'release', '--json']);
      const before = readFileSync(join(cwd, '.xm', 'batches', 'release', 'manifest.json'), 'utf8');
      const result = run(cwd, ['batch', 'run', 'release', '--dry-run', '--max-parallel', '2', '--json']);
      expect(result.code, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output).toMatchObject({ status: 'dry-run', wave: 1 });
      expect(output.topics.map((topic) => topic.id)).toEqual(['auth', 'search']);
      expect(output.base.sha).toMatch(/^[a-f0-9]{40}$/);
      expect(readFileSync(join(cwd, '.xm', 'batches', 'release', 'manifest.json'), 'utf8')).toBe(before);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('prepares isolated topic projects, requires approval, then returns executable handoffs', () => {
    const cwd = setupRepo();
    try {
      run(cwd, ['batch', 'init', 'release', '--json']);
      addPlan(cwd, 'release', 'auth', ['src/auth.mjs']);
      addPlan(cwd, 'release', 'search', ['src/search.mjs']);
      run(cwd, ['batch', 'plan', 'release', '--json']);
      const authTree = join(cwd, 'wt-auth');
      const searchTree = join(cwd, 'wt-search');
      mkdirSync(authTree); mkdirSync(searchTree);
      const env = {
        X_BUILD_GK_ARGV: JSON.stringify(['node', FAKE_GK]),
        FAKE_GK_ACQUIRE_MAP: JSON.stringify({ 'xm/batch-release-auth': authTree, 'xm/batch-release-search': searchTree }),
      };
      const prepared = run(cwd, ['batch', 'run', 'release', '--json'], CLI, env);
      expect(prepared.code, prepared.stderr + prepared.stdout).toBe(0);
      const output = JSON.parse(prepared.stdout);
      expect(output.status).toBe('awaiting_approval');
      expect(output.topics.every((topic) => topic.approval_required)).toBe(true);
      for (const [tree, project, topic] of [[authTree, 'batch-release-auth', 'auth'], [searchTree, 'batch-release-search', 'search']]) {
        const projectRoot = join(tree, '.xm', 'build', 'projects', project);
        expect(existsSync(join(projectRoot, 'manifest.json'))).toBe(true);
        expect(JSON.parse(readFileSync(join(projectRoot, 'phases', '02-plan', 'plan-check.json'))).passed).toBe(true);
        expect(existsSync(join(cwd, '.xm', 'batches', 'release', 'topics', topic, 'plan.json'))).toBe(true);
      }
      const approved = run(cwd, ['batch', 'approve', 'release', '--json']);
      expect(approved.code, approved.stderr).toBe(0);
      expect(JSON.parse(approved.stdout).topics.every((topic) => topic.status === 'prepared' && !topic.approval_required)).toBe(true);
      expect(JSON.parse(run(cwd, ['batch', 'status', 'release', '--json']).stdout).execution).toMatchObject({ base_ref: 'develop', wave: 1 });
      const executable = run(authTree, ['run', '--project', 'batch-release-auth', '--json']);
      expect(executable.code, executable.stderr).toBe(0);
      expect(JSON.parse(executable.stdout).tasks).toHaveLength(1);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('blocks every side effect when any registered plan drifts', () => {
    const cwd = setupRepo();
    try {
      run(cwd, ['batch', 'init', 'release', '--json']);
      addPlan(cwd, 'release', 'auth', ['src/auth.mjs']);
      addPlan(cwd, 'release', 'search', ['src/search.mjs']);
      run(cwd, ['batch', 'plan', 'release', '--json']);
      const state = manifest(cwd);
      writeFileSync(state.topics[1].plan.source, JSON.stringify(envelope('changed', ['src/search.mjs'])));
      const before = readFileSync(join(cwd, '.xm', 'batches', 'release', 'manifest.json'), 'utf8');
      const result = run(cwd, ['batch', 'run', 'release', '--json'], CLI, { X_BUILD_GK_ARGV: JSON.stringify(['does-not-exist']) });
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout).errors[0]).toContain('plan source changed');
      expect(readFileSync(join(cwd, '.xm', 'batches', 'release', 'manifest.json'), 'utf8')).toBe(before);
      expect(existsSync(join(cwd, '.xm', 'batches', 'release', 'topics'))).toBe(false);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('keeps successful worktrees on partial failure and resume retries only blocked topics', () => {
    const cwd = setupRepo();
    try {
      run(cwd, ['batch', 'init', 'release', '--json']);
      addPlan(cwd, 'release', 'auth', ['src/auth.mjs']);
      addPlan(cwd, 'release', 'search', ['src/search.mjs']);
      run(cwd, ['batch', 'plan', 'release', '--json']);
      const authTree = join(cwd, 'wt-auth');
      const searchTree = join(cwd, 'wt-search');
      mkdirSync(authTree); mkdirSync(searchTree);
      const baseEnv = { X_BUILD_GK_ARGV: JSON.stringify(['node', FAKE_GK]) };
      const partial = run(cwd, ['batch', 'run', 'release', '--json'], CLI, {
        ...baseEnv, FAKE_GK_ACQUIRE_MAP: JSON.stringify({ 'xm/batch-release-auth': authTree }),
      });
      expect(partial.code).toBe(2);
      expect(manifest(cwd).topics.map((topic) => topic.status), partial.stderr + partial.stdout).toEqual(['awaiting_approval', 'blocked']);
      const authRuntime = JSON.stringify(manifest(cwd).topics[0].runtime);
      const resumed = run(cwd, ['batch', 'resume', 'release', '--json'], CLI, {
        ...baseEnv, FAKE_GK_ACQUIRE_MAP: JSON.stringify({ 'xm/batch-release-search': searchTree }),
      });
      expect(resumed.code, resumed.stderr).toBe(0);
      expect(JSON.parse(resumed.stdout).topics.map((topic) => topic.status)).toEqual(['awaiting_approval', 'awaiting_approval']);
      expect(JSON.stringify(manifest(cwd).topics[0].runtime)).toBe(authRuntime);
      expect(existsSync(join(searchTree, '.xm', 'build', 'projects', 'batch-release-search', 'manifest.json'))).toBe(true);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('normalizes batch ids for git branches and x-build project names', () => {
    const cwd = setupRepo();
    try {
      run(cwd, ['batch', 'init', 'release.q4', '--json']);
      const path = join(cwd, 'auth.json');
      writeFileSync(path, JSON.stringify(envelope('auth', ['src/auth.mjs'])));
      run(cwd, ['batch', 'add', 'release.q4', 'auth_api', '--plan', path, '--json']);
      run(cwd, ['batch', 'plan', 'release.q4', '--json']);
      const tree = join(cwd, 'wt-auth');
      mkdirSync(tree);
      const result = run(cwd, ['batch', 'run', 'release.q4', '--json'], CLI, {
        X_BUILD_GK_ARGV: JSON.stringify(['node', FAKE_GK]),
        FAKE_GK_ACQUIRE_MAP: JSON.stringify({ 'xm/batch-release-q4-auth-api': tree }),
      });
      expect(result.code, result.stderr + result.stdout).toBe(0);
      expect(JSON.parse(result.stdout).topics[0]).toMatchObject({ branch: 'xm/batch-release-q4-auth-api', project: 'batch-release-q4-auth-api' });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('resume returns prepared handoffs without acquiring another worktree', () => {
    const cwd = setupRepo();
    try {
      run(cwd, ['batch', 'init', 'release', '--json']);
      addPlan(cwd, 'release', 'auth', ['src/auth.mjs']);
      run(cwd, ['batch', 'plan', 'release', '--json']);
      const tree = join(cwd, 'wt-auth');
      mkdirSync(tree);
      const env = { X_BUILD_GK_ARGV: JSON.stringify(['node', FAKE_GK]), FAKE_GK_ACQUIRE_PATH: tree };
      expect(run(cwd, ['batch', 'run', 'release', '--json'], CLI, env).code).toBe(0);
      expect(run(cwd, ['batch', 'approve', 'release', '--json']).code).toBe(0);
      const resumed = run(cwd, ['batch', 'resume', 'release', '--json'], CLI, { X_BUILD_GK_ARGV: JSON.stringify(['missing-git-kit']) });
      expect(resumed.code, resumed.stderr).toBe(0);
      expect(JSON.parse(resumed.stdout).topics[0]).toMatchObject({ id: 'auth', status: 'prepared', approval_required: false });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('rejects missing run option values before resolving a base', () => {
    const cwd = setupRepo();
    try {
      run(cwd, ['batch', 'init', 'release', '--json']);
      addPlan(cwd, 'release', 'auth', ['src/auth.mjs']);
      run(cwd, ['batch', 'plan', 'release', '--json']);
      const result = run(cwd, ['batch', 'run', 'release', '--base', '--json']);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout).errors).toContain('--base requires a value');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('collect blocks incomplete topics without creating a receipt', () => {
    const cwd = setupRepo();
    try {
      run(cwd, ['batch', 'init', 'release', '--json']);
      addPlan(cwd, 'release', 'auth', ['src/auth.mjs']);
      run(cwd, ['batch', 'plan', 'release', '--json']);
      const tree = join(cwd, 'wt-auth');
      addWorktree(cwd, tree, 'xm/batch-release-auth');
      const env = { X_BUILD_GK_ARGV: JSON.stringify(['node', FAKE_GK]), FAKE_GK_ACQUIRE_PATH: tree };
      const prepared = run(cwd, ['batch', 'run', 'release', '--json'], CLI, env);
      expect(prepared.code, prepared.stderr + prepared.stdout).toBe(0);
      const approved = run(cwd, ['batch', 'approve', 'release', '--json']);
      expect(approved.code, approved.stderr + approved.stdout).toBe(0);
      const collected = run(cwd, ['batch', 'collect', 'release', '--json']);
      expect(collected.code).toBe(2);
      expect(JSON.parse(collected.stdout).topics[0].error.code).toBe('topic_not_complete');
      expect(manifest(cwd).topics[0].status).toBe('prepared');
      expect(existsSync(join(cwd, '.xm', 'batches', 'release', 'topics', 'auth', 'verification.json'))).toBe(false);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('collect writes a bound receipt, reuses it, and opens the next dependency wave', () => {
    const cwd = setupRepo();
    try {
      run(cwd, ['batch', 'init', 'release', '--json']);
      addPlan(cwd, 'release', 'auth', ['src/auth.mjs']);
      addPlan(cwd, 'release', 'ui', ['src/ui.mjs'], ['--depends-on', 'auth']);
      run(cwd, ['batch', 'plan', 'release', '--json']);
      const tree = join(cwd, 'wt-auth');
      addWorktree(cwd, tree, 'xm/batch-release-auth');
      const env = { X_BUILD_GK_ARGV: JSON.stringify(['node', FAKE_GK]), FAKE_GK_ACQUIRE_PATH: tree };
      const prepared = run(cwd, ['batch', 'run', 'release', '--json'], CLI, env);
      expect(prepared.code, prepared.stderr + prepared.stdout).toBe(0);
      const approved = run(cwd, ['batch', 'approve', 'release', '--json']);
      expect(approved.code, approved.stderr + approved.stdout).toBe(0);
      completeTopic(tree, 'batch-release-auth');

      const collected = run(cwd, ['batch', 'collect', 'release', '--json']);
      expect(collected.code, collected.stderr + collected.stdout).toBe(0);
      expect(JSON.parse(collected.stdout).topics[0]).toMatchObject({ id: 'auth', status: 'verified', reused: false });
      const receiptPath = join(cwd, '.xm', 'batches', 'release', 'topics', 'auth', 'verification.json');
      const before = readFileSync(receiptPath, 'utf8');
      const receipt = JSON.parse(before);
      expect(receipt.git.worktree_fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(receipt.binding_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(manifest(cwd).topics[0].status).toBe('verified');

      const repeated = run(cwd, ['batch', 'collect', 'release', 'auth', '--json']);
      expect(repeated.code, repeated.stderr + repeated.stdout).toBe(0);
      expect(JSON.parse(repeated.stdout).topics[0].reused).toBe(true);
      expect(readFileSync(receiptPath, 'utf8')).toBe(before);

      const next = run(cwd, ['batch', 'run', 'release', '--dry-run', '--json']);
      expect(next.code, next.stderr + next.stdout).toBe(0);
      expect(JSON.parse(next.stdout)).toMatchObject({ wave: 2, topics: [{ id: 'ui' }] });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('verified receipt drift is preserved and blocks the next wave', () => {
    const cwd = setupRepo();
    try {
      run(cwd, ['batch', 'init', 'release', '--json']);
      addPlan(cwd, 'release', 'auth', ['src/auth.mjs']);
      addPlan(cwd, 'release', 'ui', ['src/ui.mjs'], ['--depends-on', 'auth']);
      run(cwd, ['batch', 'plan', 'release', '--json']);
      const tree = join(cwd, 'wt-auth');
      addWorktree(cwd, tree, 'xm/batch-release-auth');
      const env = { X_BUILD_GK_ARGV: JSON.stringify(['node', FAKE_GK]), FAKE_GK_ACQUIRE_PATH: tree };
      const prepared = run(cwd, ['batch', 'run', 'release', '--json'], CLI, env);
      expect(prepared.code, prepared.stderr + prepared.stdout).toBe(0);
      const approved = run(cwd, ['batch', 'approve', 'release', '--json']);
      expect(approved.code, approved.stderr + approved.stdout).toBe(0);
      completeTopic(tree, 'batch-release-auth');
      run(cwd, ['batch', 'collect', 'release', '--json']);
      const receiptPath = join(cwd, '.xm', 'batches', 'release', 'topics', 'auth', 'verification.json');
      const receipt = readFileSync(receiptPath, 'utf8');
      writeFileSync(join(tree, 'drift.txt'), 'changed\n');
      const blocked = run(cwd, ['batch', 'run', 'release', '--json']);
      expect(blocked.code).toBe(2);
      expect(JSON.parse(blocked.stdout).errors[0]).toContain('verified topic changed');
      expect(manifest(cwd).topics[0]).toMatchObject({ status: 'prepared', runtime: { stage: 'verification_stale' } });
      expect(readFileSync(receiptPath, 'utf8')).toBe(receipt);
      expect(manifest(cwd).topics[1].status).toBe('pending');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('collect and publish reject committed files outside the topic plan scope', () => {
    const cwd = setupRepo();
    try {
      run(cwd, ['batch', 'init', 'release', '--json']);
      addPlan(cwd, 'release', 'auth', ['src/auth.mjs']);
      run(cwd, ['batch', 'plan', 'release', '--json']);
      const tree = join(cwd, 'wt-auth');
      addWorktree(cwd, tree, 'xm/batch-release-auth');
      const worktreeEnv = { X_BUILD_GK_ARGV: JSON.stringify(['node', FAKE_GK]), FAKE_GK_ACQUIRE_PATH: tree };
      expect(run(cwd, ['batch', 'run', 'release', '--json'], CLI, worktreeEnv).code).toBe(0);
      expect(run(cwd, ['batch', 'approve', 'release', '--json']).code).toBe(0);
      mkdirSync(join(tree, 'src'), { recursive: true });
      writeFileSync(join(tree, 'src', 'auth.mjs'), 'export const auth = true;\n');
      writeFileSync(join(tree, 'package-lock.json'), '{}\n');
      spawnSync('git', ['add', 'src/auth.mjs', 'package-lock.json'], { cwd: tree });
      spawnSync('git', ['commit', '-m', 'add auth'], { cwd: tree, encoding: 'utf8' });
      completeTopic(tree, 'batch-release-auth');

      const collected = run(cwd, ['batch', 'collect', 'release', '--json']);
      expect(collected.code).toBe(2);
      const failure = JSON.parse(collected.stdout).topics[0];
      expect(failure).toMatchObject({ id: 'auth', ok: false, error: { code: 'scope_drift', details: { files: ['package-lock.json'] } } });
      expect(manifest(cwd).topics[0].status).toBe('prepared');

      const state = manifest(cwd);
      state.topics[0].status = 'verified';
      writeFileSync(join(cwd, '.xm', 'batches', 'release', 'manifest.json'), JSON.stringify(state));
      const fake = fakePublishers(cwd);
      const preview = run(cwd, ['batch', 'publish', 'release', '--dry-run', '--json'], CLI, fake.env);
      expect(preview.code).toBe(2);
      expect(JSON.parse(preview.stdout).errors.join('\n')).toContain('outside the plan scope: package-lock.json');
      expect(existsSync(fake.log)).toBe(false);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }, 15000);

  test('untracked files from the worktree bootstrap do not block publish, new ones still do', () => {
    const prepare = (extraUntracked) => {
      const cwd = setupRepo();
      run(cwd, ['batch', 'init', 'release', '--json']);
      addPlan(cwd, 'release', 'auth', ['src/auth.mjs']);
      run(cwd, ['batch', 'plan', 'release', '--json']);
      const tree = join(cwd, 'wt-auth');
      addWorktree(cwd, tree, 'xm/batch-release-auth');
      writeFileSync(join(tree, 'package-lock.json'), '{}\n');
      const worktreeEnv = { X_BUILD_GK_ARGV: JSON.stringify(['node', FAKE_GK]), FAKE_GK_ACQUIRE_PATH: tree };
      expect(run(cwd, ['batch', 'run', 'release', '--json'], CLI, worktreeEnv).code).toBe(0);
      expect(manifest(cwd).topics[0].runtime.bootstrap_untracked).toEqual(['package-lock.json']);
      expect(run(cwd, ['batch', 'approve', 'release', '--json']).code).toBe(0);
      mkdirSync(join(tree, 'src'), { recursive: true });
      writeFileSync(join(tree, 'src', 'auth.mjs'), 'export const auth = true;\n');
      spawnSync('git', ['add', 'src/auth.mjs'], { cwd: tree });
      spawnSync('git', ['commit', '-m', 'add auth'], { cwd: tree, encoding: 'utf8' });
      if (extraUntracked) writeFileSync(join(tree, extraUntracked), 'scratch\n');
      completeTopic(tree, 'batch-release-auth');
      const collected = run(cwd, ['batch', 'collect', 'release', '--json']);
      expect(collected.code, collected.stderr + collected.stdout).toBe(0);
      return cwd;
    };
    const clean = prepare(null);
    const dirty = prepare('notes.txt');
    try {
      const allowed = run(clean, ['batch', 'publish', 'release', '--dry-run', '--json'], CLI, fakePublishers(clean).env);
      expect(allowed.code, allowed.stderr + allowed.stdout).toBe(0);
      expect(JSON.parse(allowed.stdout).status).toBe('dry-run');

      const blocked = run(dirty, ['batch', 'publish', 'release', '--dry-run', '--json'], CLI, fakePublishers(dirty).env);
      expect(blocked.code).toBe(2);
      expect(JSON.parse(blocked.stdout).errors.join('\n')).toContain('worktree has uncommitted changes');
    } finally {
      rmSync(clean, { recursive: true, force: true });
      rmSync(dirty, { recursive: true, force: true });
    }
  }, 20000);

  test('publish previews without side effects, requires confirmation, and reuses a checked PR', () => {
    const cwd = setupRepo();
    try {
      run(cwd, ['batch', 'init', 'release', '--json']);
      addPlan(cwd, 'release', 'auth', ['src/auth.mjs']);
      run(cwd, ['batch', 'plan', 'release', '--json']);
      const tree = join(cwd, 'wt-auth');
      addWorktree(cwd, tree, 'xm/batch-release-auth');
      const worktreeEnv = { X_BUILD_GK_ARGV: JSON.stringify(['node', FAKE_GK]), FAKE_GK_ACQUIRE_PATH: tree };
      expect(run(cwd, ['batch', 'run', 'release', '--json'], CLI, worktreeEnv).code).toBe(0);
      expect(run(cwd, ['batch', 'approve', 'release', '--json']).code).toBe(0);
      mkdirSync(join(tree, 'src'), { recursive: true });
      writeFileSync(join(tree, 'src', 'auth.mjs'), 'export const auth = true;\n');
      spawnSync('git', ['add', 'src/auth.mjs'], { cwd: tree });
      spawnSync('git', ['commit', '-m', 'add auth'], { cwd: tree, encoding: 'utf8' });
      completeTopic(tree, 'batch-release-auth');
      expect(run(cwd, ['batch', 'collect', 'release', '--json']).code).toBe(0);

      const fake = fakePublishers(cwd);
      const manifestPath = join(cwd, '.xm', 'batches', 'release', 'manifest.json');
      const before = readFileSync(manifestPath, 'utf8');
      const dryRun = run(cwd, ['batch', 'publish', 'release', '--dry-run', '--json'], CLI, fake.env);
      expect(dryRun.code, dryRun.stderr + dryRun.stdout).toBe(0);
      expect(JSON.parse(dryRun.stdout)).toMatchObject({ status: 'dry-run', topics: [{ id: 'auth', base: 'develop', head: 'xm/batch-release-auth' }] });
      expect(existsSync(fake.log)).toBe(false);
      expect(readFileSync(manifestPath, 'utf8')).toBe(before);

      const waiting = run(cwd, ['batch', 'publish', 'release', '--json'], CLI, fake.env);
      expect(waiting.code).toBe(2);
      expect(JSON.parse(waiting.stdout).status).toBe('awaiting_confirmation');
      expect(existsSync(fake.log)).toBe(false);

      const viewError = run(cwd, ['batch', 'publish', 'release', '--yes', '--json'], CLI, { ...fake.env, PUBLISH_VIEW_ERROR: 'HTTP 502: Bad Gateway' });
      expect(viewError.code).toBe(2);
      expect(JSON.parse(viewError.stdout).topics[0]).toMatchObject({ ok: false, error: { code: 'pr_view_failed', message: 'HTTP 502: Bad Gateway' } });
      expect(readFileSync(fake.log, 'utf8').trim().split('\n').map(JSON.parse).some((call) => call.argv[1] === 'create')).toBe(false);
      writeFileSync(fake.log, '');

      // A PR that already exists but whose REST read fails must not look like a missing PR.
      writeFileSync(fake.state, JSON.stringify({ number: 17, url: 'https://example.test/pr/17', state: 'OPEN', baseRefName: 'develop', headRefName: 'xm/batch-release-auth' }));
      const apiError = run(cwd, ['batch', 'publish', 'release', '--yes', '--json'], CLI, { ...fake.env, PUBLISH_API_ERROR: 'HTTP 502: Bad Gateway' });
      expect(apiError.code).toBe(2);
      expect(JSON.parse(apiError.stdout).topics[0]).toMatchObject({ ok: false, error: { code: 'pr_view_failed', message: 'HTTP 502: Bad Gateway' } });
      expect(readFileSync(fake.log, 'utf8').trim().split('\n').map(JSON.parse).some((call) => call.argv[1] === 'create')).toBe(false);
      rmSync(fake.state);
      writeFileSync(fake.log, '');

      const published = run(cwd, ['batch', 'publish', 'release', '--yes', '--json'], CLI, fake.env);
      expect(published.code, published.stderr + published.stdout).toBe(0);
      expect(JSON.parse(published.stdout).topics[0]).toMatchObject({ ok: true, reused: false, pr_number: 17 });
      const publication = join(cwd, '.xm', 'batches', 'release', 'topics', 'auth', 'publication.json');
      expect(JSON.parse(readFileSync(publication, 'utf8'))).toMatchObject({ topic: 'auth', pr: { number: 17, state: 'OPEN', head_ref_name: 'xm/batch-release-auth' } });
      expect(manifest(cwd).topics[0].status).toBe('published');
      let calls = readFileSync(fake.log, 'utf8').trim().split('\n').map(JSON.parse);
      expect(calls[0]).toMatchObject({ tool: 'gk', agent: '1', argv: ['push', 'origin', 'xm/batch-release-auth', '--from', 'xm/batch-release-auth', '--yes', '--json'] });
      expect(calls.map((call) => `${call.tool}:${call.argv.slice(0, 2).join(' ')}`)).toEqual(['gk:push origin', 'gh:pr view', 'gh:pr create', 'gh:pr view', 'gh:api repos/{owner}/{repo}/pulls/17']);

      writeFileSync(fake.log, '');
      const repeated = run(cwd, ['batch', 'publish', 'release', '--yes', '--json'], CLI, fake.env);
      expect(repeated.code, repeated.stderr + repeated.stdout).toBe(0);
      expect(JSON.parse(repeated.stdout).topics[0]).toMatchObject({ ok: true, reused: true, pr_number: 17 });
      calls = readFileSync(fake.log, 'utf8').trim().split('\n').map(JSON.parse);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ tool: 'gh' });
      expect(calls[0].argv.slice(0, 3)).toEqual(['pr', 'view', '17']);
      expect(calls[1].argv).toEqual(['api', 'repos/{owner}/{repo}/pulls/17']);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }, 15000);

  test('publish rejects dependent topics and dirty verified worktrees before external calls', () => {
    const cwd = setupRepo();
    try {
      run(cwd, ['batch', 'init', 'release', '--json']);
      addPlan(cwd, 'release', 'auth', ['src/auth.mjs']);
      addPlan(cwd, 'release', 'ui', ['src/ui.mjs'], ['--depends-on', 'auth']);
      run(cwd, ['batch', 'plan', 'release', '--json']);
      const fake = fakePublishers(cwd);
      const state = manifest(cwd);
      state.topics[1].status = 'verified';
      writeFileSync(join(cwd, '.xm', 'batches', 'release', 'manifest.json'), JSON.stringify(state));
      const dependent = run(cwd, ['batch', 'publish', 'release', 'ui', '--dry-run', '--json'], CLI, fake.env);
      expect(dependent.code).toBe(2);
      expect(JSON.parse(dependent.stdout).errors[0]).toContain('stacked PR');
      expect(existsSync(fake.log)).toBe(false);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('seal locks current PR identities, reuses the receipt, and preserves it on head drift', () => {
    const cwd = setupRepo();
    try {
      run(cwd, ['batch', 'init', 'release', '--json']);
      addPlan(cwd, 'release', 'auth', ['src/auth.mjs']);
      run(cwd, ['batch', 'plan', 'release', '--json']);
      const tree = join(cwd, 'wt-auth');
      addWorktree(cwd, tree, 'xm/batch-release-auth');
      const worktreeEnv = { X_BUILD_GK_ARGV: JSON.stringify(['node', FAKE_GK]), FAKE_GK_ACQUIRE_PATH: tree };
      run(cwd, ['batch', 'run', 'release', '--json'], CLI, worktreeEnv);
      run(cwd, ['batch', 'approve', 'release', '--json']);
      mkdirSync(join(tree, 'src'), { recursive: true });
      writeFileSync(join(tree, 'src', 'auth.mjs'), 'export const auth = true;\n');
      spawnSync('git', ['add', 'src/auth.mjs'], { cwd: tree });
      spawnSync('git', ['commit', '-m', 'add auth'], { cwd: tree });
      completeTopic(tree, 'batch-release-auth');
      run(cwd, ['batch', 'collect', 'release', '--json']);
      const baseOid = spawnSync('git', ['rev-parse', 'develop'], { cwd, encoding: 'utf8' }).stdout.trim();
      spawnSync('git', ['update-ref', 'refs/remotes/origin/develop', baseOid], { cwd });
      const fake = fakePublishers(cwd);
      fake.env.PUBLISH_BASE_OID = baseOid;
      expect(run(cwd, ['batch', 'publish', 'release', '--yes', '--json'], CLI, fake.env).code).toBe(0);

      writeFileSync(fake.log, '');
      const sealed = run(cwd, ['batch', 'seal', 'release', '--json'], CLI, fake.env);
      expect(sealed.code, sealed.stderr + sealed.stdout).toBe(0);
      const output = JSON.parse(sealed.stdout);
      expect(output).toMatchObject({ status: 'sealed', reused: false, base: { ref: 'develop', oid: baseOid }, merge_order: ['auth'] });
      expect(output.prs[0]).toMatchObject({ topic: 'auth', number: 17, head_ref_name: 'xm/batch-release-auth' });
      const receiptPath = join(cwd, '.xm', 'batches', 'release', 'seal.json');
      const receipt = readFileSync(receiptPath, 'utf8');
      expect(manifest(cwd)).toMatchObject({ status: 'sealed', seal: { valid: true, binding_sha256: output.binding_sha256 } });
      let calls = readFileSync(fake.log, 'utf8').trim().split('\n').map(JSON.parse);
      expect(calls).toHaveLength(2);
      expect(calls[0].argv.slice(0, 3)).toEqual(['pr', 'view', '17']);
      expect(calls[1].argv).toEqual(['api', 'repos/{owner}/{repo}/pulls/17']);

      writeFileSync(fake.log, '');
      const repeated = run(cwd, ['batch', 'seal', 'release', '--json'], CLI, fake.env);
      expect(repeated.code, repeated.stderr + repeated.stdout).toBe(0);
      expect(JSON.parse(repeated.stdout).reused).toBe(true);
      expect(readFileSync(receiptPath, 'utf8')).toBe(receipt);

      const pr = JSON.parse(readFileSync(fake.state, 'utf8'));
      pr.headRefOid = '0000000000000000000000000000000000000000';
      writeFileSync(fake.state, JSON.stringify(pr));
      const drifted = run(cwd, ['batch', 'seal', 'release', '--json'], CLI, fake.env);
      expect(drifted.code).toBe(2);
      expect(readFileSync(receiptPath, 'utf8')).toBe(receipt);
      expect(manifest(cwd)).toMatchObject({ status: 'published', seal: { valid: false } });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }, 15000);

  test('verify merges sealed heads, runs integration gates, and reuses the receipt', () => {
    const cwd = setupRepo();
    const integrationTree = join(cwd, 'wt-integration');
    try {
      run(cwd, ['batch', 'init', 'release', '--json']);
      addPlan(cwd, 'release', 'auth', ['src/auth.mjs']);
      run(cwd, ['batch', 'plan', 'release', '--json']);
      const tree = join(cwd, 'wt-auth');
      addWorktree(cwd, tree, 'xm/batch-release-auth');
      const worktreeEnv = { X_BUILD_GK_ARGV: JSON.stringify(['node', FAKE_GK]), FAKE_GK_ACQUIRE_PATH: tree };
      run(cwd, ['batch', 'run', 'release', '--json'], CLI, worktreeEnv);
      run(cwd, ['batch', 'approve', 'release', '--json']);
      mkdirSync(join(tree, 'src'), { recursive: true });
      writeFileSync(join(tree, 'src', 'auth.mjs'), 'export const auth = true;\n');
      spawnSync('git', ['add', 'src/auth.mjs'], { cwd: tree });
      spawnSync('git', ['commit', '-m', 'add auth'], { cwd: tree });
      completeTopic(tree, 'batch-release-auth');
      run(cwd, ['batch', 'collect', 'release', '--json']);
      const baseOid = spawnSync('git', ['rev-parse', 'develop'], { cwd, encoding: 'utf8' }).stdout.trim();
      spawnSync('git', ['update-ref', 'refs/remotes/origin/develop', baseOid], { cwd });
      const publishers = fakePublishers(cwd);
      publishers.env.PUBLISH_BASE_OID = baseOid;
      const published = run(cwd, ['batch', 'publish', 'release', '--yes', '--json'], CLI, publishers.env);
      expect(published.code, published.stderr + published.stdout).toBe(0);
      const sealed = run(cwd, ['batch', 'seal', 'release', '--json'], CLI, publishers.env);
      expect(sealed.code, sealed.stderr + sealed.stdout).toBe(0);

      const driver = fakeIntegrationDriver(cwd, integrationTree);
      const panel = "process.stdout.write(JSON.stringify({run:'clean',counts:{},consensus:[],confirmed:[],contested:[],unreviewed:[]}))";
      const env = { ...driver.env, X_BUILD_PANEL_ARGV: JSON.stringify(['node', '-e', panel]) };
      const preview = run(cwd, ['batch', 'verify', 'release', '--dry-run', '--json'], CLI, env);
      expect(preview.code, preview.stderr + preview.stdout).toBe(0);
      expect(JSON.parse(preview.stdout)).toMatchObject({ status: 'dry-run', prs: [{ topic: 'auth' }], checks: [{ command: 'node --test', topics: ['auth'] }] });
      expect(existsSync(driver.log)).toBe(false);

      const verified = run(cwd, ['batch', 'verify', 'release', '--json'], CLI, env);
      expect(verified.code, verified.stderr + verified.stdout).toBe(0);
      const output = JSON.parse(verified.stdout);
      expect(output).toMatchObject({ status: 'integration_verified', reused: false, review: { decision: 'pass' } });
      expect(output.result.head_oid).not.toBe(spawnSync('git', ['rev-parse', 'xm/batch-release-auth'], { cwd, encoding: 'utf8' }).stdout.trim());
      expect(output.result.tree_oid).toBe(spawnSync('git', ['rev-parse', 'xm/batch-release-auth^{tree}'], { cwd, encoding: 'utf8' }).stdout.trim());
      const receiptPath = join(cwd, '.xm', 'batches', 'release', 'integration', 'receipt.json');
      const before = readFileSync(receiptPath, 'utf8');
      expect(JSON.parse(before)).toMatchObject({ status: 'passed', seal: { binding_sha256: manifest(cwd).seal.binding_sha256 } });

      writeFileSync(driver.log, '');
      const repeated = run(cwd, ['batch', 'verify', 'release', '--json'], CLI, env);
      expect(repeated.code, repeated.stderr + repeated.stdout).toBe(0);
      expect(JSON.parse(repeated.stdout).reused).toBe(true);
      expect(readFileSync(receiptPath, 'utf8')).toBe(before);
      expect(readFileSync(driver.log, 'utf8')).toBe('');
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', integrationTree], { cwd });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15000);

  test.each([
    ['no-json', 'merge'], ['invalid-json', 'merge'], ['invalid-envelope', 'merge'],
    ['paused', 'merge'], ['nonzero', 'merge'], ['inconsistent', 'merge'], ['no-json', 'preflight'],
  ])('verify stops on %s output during %s and records the exact Git outcome', (mode, phase) => {
    const cwd = setupRepo();
    const integrationTree = join(cwd, 'wt-integration');
    try {
      run(cwd, ['batch', 'init', 'release', '--json']);
      addPlan(cwd, 'release', 'auth', ['src/auth.mjs']);
      run(cwd, ['batch', 'plan', 'release', '--json']);
      const tree = join(cwd, 'wt-auth');
      addWorktree(cwd, tree, 'xm/batch-release-auth');
      const worktreeEnv = { X_BUILD_GK_ARGV: JSON.stringify(['node', FAKE_GK]), FAKE_GK_ACQUIRE_PATH: tree };
      run(cwd, ['batch', 'run', 'release', '--json'], CLI, worktreeEnv);
      run(cwd, ['batch', 'approve', 'release', '--json']);
      mkdirSync(join(tree, 'src'), { recursive: true });
      writeFileSync(join(tree, 'src', 'auth.mjs'), 'export const auth = true;\n');
      spawnSync('git', ['add', 'src/auth.mjs'], { cwd: tree });
      spawnSync('git', ['commit', '-m', 'add auth'], { cwd: tree });
      completeTopic(tree, 'batch-release-auth');
      run(cwd, ['batch', 'collect', 'release', '--json']);
      const baseOid = spawnSync('git', ['rev-parse', 'develop'], { cwd, encoding: 'utf8' }).stdout.trim();
      spawnSync('git', ['update-ref', 'refs/remotes/origin/develop', baseOid], { cwd });
      const publishers = fakePublishers(cwd);
      publishers.env.PUBLISH_BASE_OID = baseOid;
      const published = run(cwd, ['batch', 'publish', 'release', '--yes', '--json'], CLI, publishers.env);
      expect(published.code, published.stderr + published.stdout).toBe(0);
      const sealed = run(cwd, ['batch', 'seal', 'release', '--json'], CLI, publishers.env);
      expect(sealed.code, sealed.stderr + sealed.stdout).toBe(0);

      const driver = fakeIntegrationDriver(cwd, integrationTree);
      const panel = "process.stdout.write(JSON.stringify({run:'clean',counts:{},consensus:[],confirmed:[],contested:[],unreviewed:[]}))";
      const env = { ...driver.env, X_BUILD_PANEL_ARGV: JSON.stringify(['node', '-e', panel]) };
      const preview = run(cwd, ['batch', 'verify', 'release', '--dry-run', '--json'], CLI, env);
      expect(preview.code, preview.stderr + preview.stdout).toBe(0);
      expect(JSON.parse(preview.stdout)).toMatchObject({ status: 'dry-run', prs: [{ topic: 'auth' }], checks: [{ command: 'node --test', topics: ['auth'] }] });
      expect(existsSync(driver.log)).toBe(false);

      const failed = run(cwd, ['batch', 'verify', 'release', '--json'], CLI, {
        ...env, INTEGRATION_MERGE_OUTPUT: mode, INTEGRATION_FAILURE_PHASE: phase,
      });
      expect(failed.code).toBe(mode === 'paused' ? 3 : 2);
      const output = JSON.parse(failed.stdout);
      const protocol = ['no-json', 'invalid-json', 'invalid-envelope'].includes(mode);
      expect(output.error.code).toBe(protocol ? 'integration_merge_protocol_incompatible' : mode === 'paused' ? 'conflict' : mode === 'nonzero' ? 'merge_failed' : 'integration_merge_failed');
      const receiptPath = join(cwd, '.xm', 'batches', 'release', 'integration', 'receipt.json');
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      expect(receipt.checks).toEqual([]);
      expect(receipt.review).toBeNull();
      expect(readFileSync(driver.log, 'utf8')).not.toContain('"diff"');
      const advanced = phase === 'merge' && !['paused', 'nonzero'].includes(mode);
      expect(receipt.integration.head_oid === baseOid).toBe(!advanced);
      if (protocol) {
        expect(output.error.exit_code).toBe(0);
        expect(output.error.before_head_oid).toBe(baseOid);
        expect(output.error.after_head_oid).toBe(receipt.integration.head_oid);
        expect(output.error.head_changed).toBe(advanced);
        expect(output.recover.length).toBeGreaterThan(0);
        expect(output.error.next_action).toContain('git-kit');
      }
      if (phase === 'preflight') {
        expect(receipt.merges).toEqual([]);
        const calls = readFileSync(driver.log, 'utf8').trim().split('\n').map(JSON.parse);
        expect(calls.filter(row => row[0] === 'merge').map(row => row[1])).toEqual([baseOid]);
      }
      if (mode !== 'paused') {
        const head = receipt.integration.head_oid;
        const retried = run(cwd, ['batch', 'verify', 'release', '--json'], CLI, env);
        expect(retried.code, retried.stderr + retried.stdout).toBe(0);
        expect(JSON.parse(retried.stdout).status).toBe('integration_verified');
        if (advanced) expect(JSON.parse(retried.stdout).result.head_oid).toBe(head);
      }
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', integrationTree], { cwd });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15000);

  test('seal keeps PR rows in schedule order when registration order differs', () => {
    const rows = ['c', 'a', 'b'].map((id) => ({ topic: { id }, publication: { pr: { number: id } } }));
    const ordered = orderSealRows(['a', 'c', 'b'], rows);
    expect(ordered.map((row) => row.topic.id)).toEqual(['a', 'c', 'b']);
    expect(ordered.map((row) => row.publication.pr.number)).toEqual(['a', 'c', 'b']);
  });

  test('merge requires confirmation, merges the sealed head, and verifies the final tree', () => {
    const cwd = setupRepo();
    const integrationTree = join(cwd, 'wt-integration');
    const baseTree = join(cwd, 'wt-remote-base');
    try {
      run(cwd, ['batch', 'init', 'release', '--json']);
      addPlan(cwd, 'release', 'auth', ['src/auth.mjs']);
      run(cwd, ['batch', 'plan', 'release', '--json']);
      const tree = join(cwd, 'wt-auth');
      addWorktree(cwd, tree, 'xm/batch-release-auth');
      const worktreeEnv = { X_BUILD_GK_ARGV: JSON.stringify(['node', FAKE_GK]), FAKE_GK_ACQUIRE_PATH: tree };
      run(cwd, ['batch', 'run', 'release', '--json'], CLI, worktreeEnv);
      run(cwd, ['batch', 'approve', 'release', '--json']);
      mkdirSync(join(tree, 'src'), { recursive: true });
      writeFileSync(join(tree, 'src', 'auth.mjs'), 'export const auth = true;\n');
      spawnSync('git', ['add', 'src/auth.mjs'], { cwd: tree });
      spawnSync('git', ['commit', '-m', 'add auth'], { cwd: tree });
      completeTopic(tree, 'batch-release-auth');
      run(cwd, ['batch', 'collect', 'release', '--json']);
      const baseOid = spawnSync('git', ['rev-parse', 'develop'], { cwd, encoding: 'utf8' }).stdout.trim();
      spawnSync('git', ['update-ref', 'refs/remotes/origin/develop', baseOid], { cwd });
      const publishers = fakePublishers(cwd);
      publishers.env.PUBLISH_BASE_OID = baseOid;
      run(cwd, ['batch', 'publish', 'release', '--yes', '--json'], CLI, publishers.env);
      run(cwd, ['batch', 'seal', 'release', '--json'], CLI, publishers.env);
      const driver = fakeIntegrationDriver(cwd, integrationTree);
      const panel = "process.stdout.write(JSON.stringify({run:'clean',counts:{},consensus:[],confirmed:[],contested:[],unreviewed:[]}))";
      const verifyEnv = { ...driver.env, X_BUILD_PANEL_ARGV: JSON.stringify(['node', '-e', panel]) };
      const verified = run(cwd, ['batch', 'verify', 'release', '--json'], CLI, verifyEnv);
      expect(verified.code, verified.stderr + verified.stdout).toBe(0);
      spawnSync('git', ['worktree', 'add', '-b', 'remote-develop', baseTree, baseOid], { cwd });
      const mergeEnv = { ...publishers.env, PUBLISH_BASE_WORKTREE: baseTree };
      writeFileSync(publishers.log, '');

      const preview = run(cwd, ['batch', 'merge', 'release', '--dry-run', '--json'], CLI, mergeEnv);
      expect(preview.code, preview.stderr + preview.stdout).toBe(0);
      expect(JSON.parse(preview.stdout)).toMatchObject({ status: 'dry-run', topics: [{ topic: 'auth', number: 17 }] });
      const waiting = run(cwd, ['batch', 'merge', 'release', '--json'], CLI, mergeEnv);
      expect(waiting.code).toBe(2);
      expect(JSON.parse(waiting.stdout).status).toBe('awaiting_confirmation');
      expect(readFileSync(publishers.log, 'utf8')).toBe('');

      const apiError = run(cwd, ['batch', 'merge', 'release', '--yes', '--json'], CLI, { ...mergeEnv, PUBLISH_API_ERROR: 'HTTP 502: Bad Gateway' });
      expect(apiError.code).toBe(2);
      expect(JSON.parse(apiError.stdout)).toMatchObject({ status: 'merge_blocked', error: { code: 'pr_view_failed', message: 'auth: cannot read GitHub PR: HTTP 502: Bad Gateway' } });
      expect(readFileSync(publishers.log, 'utf8').includes('"merge"')).toBe(false);
      writeFileSync(publishers.log, '');

      const merged = run(cwd, ['batch', 'merge', 'release', '--yes', '--json'], CLI, mergeEnv);
      expect(merged.code, merged.stderr + merged.stdout).toBe(0);
      const output = JSON.parse(merged.stdout);
      expect(output).toMatchObject({ status: 'merged', reused: false, rows: [{ topic: 'auth', number: 17, status: 'merged' }] });
      expect(output.final.tree_oid).toBe(JSON.parse(verified.stdout).result.tree_oid);
      expect(manifest(cwd)).toMatchObject({ status: 'merged', topics: [{ status: 'merged' }] });
      const calls = readFileSync(publishers.log, 'utf8').trim().split('\n').map(JSON.parse);
      const mergeCall = calls.find((call) => call.tool === 'gh' && call.argv[0] === 'pr' && call.argv[1] === 'merge');
      expect(mergeCall.argv).toEqual(['pr', 'merge', '17', '--merge', '--match-head-commit', spawnSync('git', ['rev-parse', 'xm/batch-release-auth'], { cwd, encoding: 'utf8' }).stdout.trim()]);

      writeFileSync(publishers.log, '');
      const repeated = run(cwd, ['batch', 'merge', 'release', '--yes', '--json'], CLI, mergeEnv);
      expect(repeated.code, repeated.stderr + repeated.stdout).toBe(0);
      expect(JSON.parse(repeated.stdout)).toMatchObject({ status: 'merged', reused: true });
      expect(readFileSync(publishers.log, 'utf8').includes('\"merge\"')).toBe(false);
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', integrationTree], { cwd });
      spawnSync('git', ['worktree', 'remove', '--force', baseTree], { cwd });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15000);
});
