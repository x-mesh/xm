// @ts-check
//
// x-trace-cli — isolated contract tests for the x-trace CLI.
//
// HOST-REPO POLLUTION IS FORBIDDEN. Precedent: gitAutoCommit tests once committed
// unstaged changes back into the host x-kit repo on every `bun test` run
// (x-build/lib/x-build/core.mjs). To avoid a repeat, every test here:
//   - creates its own git repo under os.tmpdir() with mkdtempSync (never the repo)
//   - spawns the CLI as a real subprocess with cwd=<temp repo> and
//     XM_ROOT=<temp repo>/.xm, so BOTH the ledger writes and every internal
//     `git`/gitSnapshot call target the temp repo, not the checked-out x-kit tree
//   - rm -rf's every temp dir in afterAll
// No test may git-init, commit, or write inside the checked-out x-kit tree, and
// nothing mutates process.cwd()/env of the test runner (isolation lives in the
// subprocess env), so tests are order-independent and parallel-safe.

import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const CLI = fileURLToPath(new URL('../x-trace/lib/x-trace-cli.mjs', import.meta.url));

/** @type {string[]} */
const tmpdirs = [];

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'xm-trace-cli-'));
  tmpdirs.push(dir);
  const git = (c) => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', shell: '/bin/bash' });
  git('init -q');
  git('config user.email t@t.com');
  git('config user.name T');
  git('commit -q --allow-empty -m c1');
  const head = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
  return { dir, head };
}

function emptyCommit(dir, msg) {
  execSync(`git commit -q --allow-empty -m ${msg}`, { cwd: dir, stdio: 'pipe' });
  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
}

/** Run the CLI as a subprocess pinned to `dir` (cwd + XM_ROOT). Returns {code,stdout,stderr}. */
function runCli(dir, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, XM_ROOT: join(dir, '.xm') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** Same isolated CLI runner, but genuinely concurrent for lock-contract tests. */
function runCliAsync(dir, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: dir,
      env: { ...process.env, XM_ROOT: join(dir, '.xm') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectRun);
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

afterAll(() => {
  for (const dir of tmpdirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  tmpdirs.length = 0;
});

describe('record → last', () => {
  test('record reflects in `last` (human) and `last --json` (schema)', () => {
    const { dir, head } = makeRepo();

    const rec = runCli(dir, ['record', 'review', '--status', 'lgtm', '--note', 'ok']);
    expect(rec.code).toBe(0);
    expect(rec.stdout).toContain('recorded review');

    const human = runCli(dir, ['last', 'review']);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('review:');
    expect(human.stdout).toContain(head.slice(0, 7)); // ref defaulted to current HEAD
    expect(human.stdout).toContain('lgtm');

    const json = runCli(dir, ['last', '--json']);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.review).toBeDefined();
    expect(parsed.review.ref).toBe(head);
    expect(parsed.review.head).toBe(head);
    expect(parsed.review.status).toBe('lgtm');
    expect(parsed.review.note).toBe('ok');
    // base is present in the schema (null on first record for this tool).
    expect('base' in parsed.review).toBe(true);
    expect(parsed.review.base).toBeNull();
  });

  test('explicit --ref overrides the HEAD default', () => {
    const { dir } = makeRepo();
    runCli(dir, ['record', 'build', '--ref', 'v1.2.3', '--status', 'released']);
    const json = JSON.parse(runCli(dir, ['last', '--json', 'build']).stdout);
    expect(json.build.ref).toBe('v1.2.3');
  });
});

describe('status', () => {
  test('reports N commits since the recorded HEAD', () => {
    const { dir } = makeRepo();
    runCli(dir, ['record', 'review', '--status', 'lgtm']);
    emptyCommit(dir, 'c2');
    emptyCommit(dir, 'c3');

    const status = runCli(dir, ['status']);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('review:');
    expect(status.stdout).toContain('2 commits since');

    const json = JSON.parse(runCli(dir, ['status', '--json']).stdout);
    expect(json.review.commits_since).toBe(2);
    expect(json.review.chain_broken).toBe(false);
  });

  test('singular "1 commit" and zero right after record', () => {
    const { dir } = makeRepo();
    runCli(dir, ['record', 'op', '--status', 'done']);
    expect(runCli(dir, ['status']).stdout).toContain('0 commits since');
    emptyCommit(dir, 'c2');
    expect(runCli(dir, ['status']).stdout).toContain('1 commit since');
  });
});

describe('doctor --rebuild (AC3)', () => {
  test('reconstructs last.json from a git-bearing trace, skips legacy traces', () => {
    const { dir, head } = makeRepo();
    const tracesDir = join(dir, '.xm', 'traces');
    mkdirSync(tracesDir, { recursive: true });

    // A t1-shaped trace: session_start carries the skill, session_end carries git.head.
    const good = [
      JSON.stringify({ type: 'session_start', skill: 'review', args: {}, session_id: 'review-20260703-101010-aaaa', ts: '2026-07-03T10:10:10.000Z', v: 1 }),
      JSON.stringify({ type: 'session_end', status: 'success', git: { head, branch: 'main', dirty: false }, session_id: 'review-20260703-101010-aaaa', ts: '2026-07-03T10:10:12.000Z', v: 1 }),
    ].join('\n') + '\n';
    writeFileSync(join(tracesDir, 'review-20260703-101010-aaaa.jsonl'), good);

    // A legacy trace: no git field on session_end → not reconstructable, must be reported.
    const legacy = [
      JSON.stringify({ type: 'session_start', skill: 'op', args: {}, session_id: 'op-20260101-090000-bbbb', ts: '2026-01-01T09:00:00.000Z', v: 1 }),
      JSON.stringify({ type: 'session_end', status: 'success', session_id: 'op-20260101-090000-bbbb', ts: '2026-01-01T09:00:01.000Z', v: 1 }),
    ].join('\n') + '\n';
    writeFileSync(join(tracesDir, 'op-20260101-090000-bbbb.jsonl'), legacy);

    const rebuilt = runCli(dir, ['doctor', '--rebuild']);
    expect(rebuilt.code).toBe(0);
    expect(rebuilt.stdout).toContain('Rebuilt last.json: 1 tool');
    expect(rebuilt.stdout).toMatch(/1 legacy trace/); // op reported as non-reconstructable

    // The rebuilt ledger holds review with the trace's HEAD.
    const json = JSON.parse(runCli(dir, ['last', '--json']).stdout);
    expect(json.review).toBeDefined();
    expect(json.review.head).toBe(head);
    expect(json.review.status).toBe('rebuilt');
    expect(json.op).toBeUndefined();
  });

  test('doctor (no --rebuild) validates and flags nothing on a clean ledger', () => {
    const { dir } = makeRepo();
    runCli(dir, ['record', 'ship', '--status', 'ok']);
    const out = runCli(dir, ['doctor']);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('1 tool');
    expect(out.stdout).toContain('✓ ship');
    expect(out.stdout).toContain('All records valid.');
  });
});

describe('empty-state honesty (A1)', () => {
  test('`last` on an empty ledger explains + notes coverage limits', () => {
    const { dir } = makeRepo();
    const out = runCli(dir, ['last']);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('No tool activity recorded yet.');
    expect(out.stdout).toContain('기록되지 않은 활동이 있을 수 있음');
  });

  test('`status` on an empty ledger notes coverage limits', () => {
    const { dir } = makeRepo();
    const out = runCli(dir, ['status']);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('기록되지 않은 활동이 있을 수 있음');
  });
});

describe('unknown tool (FM4)', () => {
  test('warns once but records anyway, exit 0', () => {
    const { dir } = makeRepo();
    const out = runCli(dir, ['record', 'frobnicate', '--status', 'x']);
    expect(out.code).toBe(0);
    expect(out.stderr).toContain('is not a known tool');
    // Recorded despite the warning.
    const json = JSON.parse(runCli(dir, ['last', '--json', 'frobnicate']).stdout);
    expect(json.frobnicate).toBeDefined();
    expect(json.frobnicate.status).toBe('x');
  });
});

describe('lock contention (FM3)', () => {
  test('record warns and exits 0 when the last-store lock is held', () => {
    const { dir } = makeRepo();
    mkdirSync(join(dir, '.xm'), { recursive: true });
    // Pre-create a FRESH lock on last.json. last-store reclaims a lock only when
    // its mtime > 10s; the 50-attempt/~1s acquire window stays under that, so the
    // write provably throws — exercising the best-effort exit-0 path (FM3).
    const lockPath = join(dir, '.xm', 'last.json.lock');
    writeFileSync(lockPath, String(process.pid));

    const out = runCli(dir, ['record', 'review', '--status', 'lgtm']);
    expect(out.code).toBe(0); // best-effort: never fail the caller over a ledger write
    expect(out.stderr).toContain('best-effort');

    rmSync(lockPath, { force: true });
  });
});

describe('replay artifact (t14)', () => {
  function writeReplayTrace(dir, id = 'replay-fixture') {
    const traceDir = join(dir, '.xm', 'traces');
    mkdirSync(traceDir, { recursive: true });
    const lines = [
      { type: 'session_start', skill: 'build', args: { task: 'fixture' }, session_id: id, ts: '2026-07-23T00:00:00.000Z', v: 1 },
      { type: 'agent_step', id: 'span-a', parent_id: null, role: 'se', model: 'sonnet', correlation_id: 'corr-123', status: 'success', ts: '2026-07-23T00:00:01.000Z', v: 1 },
    ];
    writeFileSync(join(traceDir, `${id}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  }

  test('creates a deterministic manifest and a safe filesystem archive', () => {
    const { dir } = makeRepo();
    writeFileSync(join(dir, 'included.txt'), 'replay me\n');
    execSync('git add included.txt', { cwd: dir, stdio: 'pipe' });
    writeReplayTrace(dir);

    const out = runCli(dir, ['replay', 'replay-fixture', '--span', 'span-a', '--model', 'haiku', '--json']);
    expect(out.code).toBe(0);
    const result = JSON.parse(out.stdout);
    expect(result.replay_of).toBe('replay-fixture');
    expect(result.seed).toMatch(/^[a-f0-9]{64}$/);
    expect(result.warnings).toEqual([]);
    expect(result.diff.output.comparison).toBe('unavailable');
    expect(result.diff.tokens.total).toEqual({ original: null, replay: null, delta: null });
    expect(result.diff.cost).toEqual({ original: null, replay: null, delta: null });
    expect(result.diff.quality.status).toBe('awaiting_x_eval');
    expect(existsSync(result.manifest)).toBe(true);
    expect(existsSync(join(dir, '.xm', 'traces', result.snapshot.archive))).toBe(true);

    const manifest = JSON.parse(readFileSync(result.manifest, 'utf8'));
    expect(manifest.replay_of).toBe('replay-fixture');
    expect(manifest.overrides.model).toBe('haiku');
    expect(manifest.source.span_id).toBe('span-a');
    expect(manifest.deterministic_context.span.id).toBe('span-a');
    const archive = join(dir, '.xm', 'traces', manifest.snapshot.archive);
    const names = execSync(`tar -tzf ${JSON.stringify(archive)}`, { encoding: 'utf8' });
    expect(names).toContain('./included.txt');
    expect(names).not.toContain('.xm/');
  });

  test('emits a metadata-only four-axis diff and atomically promotes an x-eval case', () => {
    const { dir } = makeRepo();
    const originalHash = 'a'.repeat(64);
    const replayHash = 'b'.repeat(64);
    const traceDir = join(dir, '.xm', 'traces');
    mkdirSync(traceDir, { recursive: true });
    writeFileSync(join(traceDir, 'diff-trace.jsonl'), [
      JSON.stringify({ type: 'session_start', skill: 'build', session_id: 'diff-trace', v: 1 }),
      JSON.stringify({ type: 'agent_step', id: 'span-a', role: 'se', model: 'sonnet', output_sha256: originalHash, output_length: 12, tokens_est: { input: 10, output: 20 }, cost_usd: 0.03, quality_score: 7.5, v: 1 }),
    ].join('\n') + '\n');
    writeFileSync(join(dir, 'replay-result.json'), JSON.stringify({
      output_sha256: replayHash, output_bytes: 18, tokens: { input: 12, output: 24 }, cost_usd: 0.05, quality_score: 8.5, rubric: 'general',
    }));

    const first = runCli(dir, ['replay', 'diff-trace', '--span', 'span-a', '--result', 'replay-result.json', '--promote-to-eval', '--json']);
    expect(first.code).toBe(0);
    const parsed = JSON.parse(first.stdout);
    expect(parsed.diff.output.comparison).toBe('changed');
    expect(parsed.diff.tokens.total).toEqual({ original: 30, replay: 36, delta: 6 });
    expect(parsed.diff.cost.original).toBeCloseTo(0.03, 8);
    expect(parsed.diff.cost.replay).toBeCloseTo(0.05, 8);
    expect(parsed.diff.cost.delta).toBeCloseTo(0.02, 8);
    expect(parsed.diff.quality).toMatchObject({ rubric: 'general', status: 'recorded' });
    expect(parsed.eval_case.created).toBe(true);
    expect(existsSync(parsed.eval_case.path)).toBe(true);
    const caseRaw = readFileSync(parsed.eval_case.path, 'utf8');
    expect(caseRaw).not.toContain('replay-result.json');
    expect(caseRaw).not.toContain('sk-'); // raw output is neither accepted nor stored

    const second = runCli(dir, ['replay', 'diff-trace', '--span', 'span-a', '--result', 'replay-result.json', '--promote-to-eval', '--json']);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout).eval_case.created).toBe(false);
  });

  test('rejects raw output in a replay result before an artifact or eval case is created', () => {
    const { dir } = makeRepo();
    writeReplayTrace(dir, 'raw-result-trace');
    const secret = 'sk-THIS_IS_A_TEST_SECRET_ABCDEFGHIJKLMNOP';
    writeFileSync(join(dir, 'unsafe-result.json'), JSON.stringify({ output: secret }));
    const out = runCli(dir, ['replay', 'raw-result-trace', '--span', 'span-a', '--result', 'unsafe-result.json', '--promote-to-eval']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('must not contain output text');
    expect(out.stderr).not.toContain(secret);
    expect(existsSync(join(dir, '.xm', 'traces', 'raw-result-trace', 'forks.json'))).toBe(false);
    expect(existsSync(join(dir, '.xm', 'eval', 'cases'))).toBe(false);
  });

  test('fails closed on invalid x-eval rubric metadata while allowing absent cost and tokens', () => {
    const { dir } = makeRepo();
    writeReplayTrace(dir, 'rubric-trace');
    writeFileSync(join(dir, 'bad-rubric.json'), JSON.stringify({ rubric: '../not-a-rubric', quality_score: 8 }));
    const rejected = runCli(dir, ['replay', 'rubric-trace', '--span', 'span-a', '--result', 'bad-rubric.json']);
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('rubric must be a safe rubric identifier');
    expect(existsSync(join(dir, '.xm', 'traces', 'rubric-trace', 'forks.json'))).toBe(false);

    const accepted = runCli(dir, ['replay', 'rubric-trace', '--span', 'span-a', '--result', 'missing-metrics.json', '--json']);
    expect(accepted.code).toBe(1); // missing result file itself is not silently treated as a result
    writeFileSync(join(dir, 'missing-metrics.json'), JSON.stringify({ rubric: 'general' }));
    const sparse = runCli(dir, ['replay', 'rubric-trace', '--span', 'span-a', '--result', 'missing-metrics.json', '--json']);
    expect(sparse.code).toBe(0);
    expect(JSON.parse(sparse.stdout).diff.tokens.total.replay).toBeNull();
    expect(JSON.parse(sparse.stdout).diff.cost.replay).toBeNull();
  });

  test('redacts untrusted trace payloads and rejects a symlinked trace', () => {
    const { dir } = makeRepo();
    const traceDir = join(dir, '.xm', 'traces');
    mkdirSync(traceDir, { recursive: true });
    const secret = 'sk-THIS_IS_A_TEST_SECRET_ABCDEFGHIJKLMNOP';
    const privatePath = '/Users/alice/private/project';
    const sensitive = [
      { type: 'session_start', skill: 'build', args: { prompt: secret, cwd: privatePath }, session_id: 'sensitive', v: 1 },
      { type: 'agent_step', id: 'span-a', role: 'se', model: 'sonnet', prompt: secret, tool_input: { cwd: privatePath }, v: 1 },
    ];
    writeFileSync(join(traceDir, 'sensitive.jsonl'), sensitive.map((line) => JSON.stringify(line)).join('\n') + '\n');
    const out = runCli(dir, ['replay', 'sensitive', '--span', 'span-a', '--json']);
    expect(out.code).toBe(0);
    const manifestRaw = readFileSync(JSON.parse(out.stdout).manifest, 'utf8');
    expect(manifestRaw).not.toContain(secret);
    expect(manifestRaw).not.toContain(privatePath);
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.deterministic_context.span).toEqual(expect.objectContaining({ id: 'span-a', role: 'se', model: 'sonnet' }));
    expect(manifest.deterministic_context.span.prompt).toBeUndefined();
    expect(manifest.deterministic_context.prior_event_count).toBe(1);

    const outside = join(dir, 'outside.jsonl');
    writeFileSync(outside, sensitive.map((line) => JSON.stringify(line)).join('\n') + '\n');
    symlinkSync(outside, join(traceDir, 'linked.jsonl'));
    const linked = runCli(dir, ['replay', 'linked', '--span', 'span-a']);
    expect(linked.code).toBe(1);
    expect(linked.stderr).toContain('trace must be a regular file inside trace directory');
  });

  test('allows canonical model overrides but rejects secret-shaped arbitrary values', () => {
    const { dir } = makeRepo();
    writeReplayTrace(dir, 'model-trace');
    const valid = runCli(dir, ['replay', 'model-trace', '--span', 'span-a', '--model', 'opus', '--json']);
    expect(valid.code).toBe(0);
    const validManifest = JSON.parse(readFileSync(JSON.parse(valid.stdout).manifest, 'utf8'));
    expect(validManifest.overrides.model).toBe('opus');

    writeReplayTrace(dir, 'model-override-trace');
    const secret = 'sk-THIS_IS_A_TEST_SECRET_ABCDEFGHIJKLMNOP';
    const rejected = runCli(dir, ['replay', 'model-override-trace', '--span', 'span-a', '--model', secret, '--json']);
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('model override must be one of: haiku, sonnet, opus');
    expect(rejected.stderr).not.toContain(secret);
    expect(existsSync(join(dir, '.xm', 'traces', 'model-override-trace', 'forks.json'))).toBe(false);
  });

  test('rejects credential-shaped trace and span identifiers before artifact creation', () => {
    const { dir } = makeRepo();
    const secret = 'sk-THIS_IS_A_TEST_SECRET_ABCDEFGHIJKLMNOP';
    writeReplayTrace(dir, secret);
    const rejectedTrace = runCli(dir, ['replay', secret, '--span', 'span-a', '--json']);
    expect(rejectedTrace.code).toBe(1);
    expect(rejectedTrace.stderr).toContain('trace id must not be credential-shaped');
    expect(rejectedTrace.stderr).not.toContain(secret);
    expect(existsSync(join(dir, '.xm', 'traces', secret, 'forks.json'))).toBe(false);

    writeReplayTrace(dir, 'safe-trace');
    const rejectedSpan = runCli(dir, ['replay', 'safe-trace', '--span', secret, '--json']);
    expect(rejectedSpan.code).toBe(1);
    expect(rejectedSpan.stderr).toContain('span id must not be credential-shaped');
    expect(rejectedSpan.stderr).not.toContain(secret);
    expect(existsSync(join(dir, '.xm', 'traces', 'safe-trace', 'forks.json'))).toBe(false);
  });

  test('validates input, rejects corrupt traces, and atomically caps a trace at three forks', () => {
    const { dir } = makeRepo();
    writeReplayTrace(dir, 'fork-trace');
    expect(runCli(dir, ['replay', '../fork-trace', '--span', 'span-a']).code).toBe(1);
    expect(runCli(dir, ['replay', 'fork-trace', '--span', 'missing']).code).toBe(1);
    for (let index = 0; index < 3; index++) {
      expect(runCli(dir, ['replay', 'fork-trace', '--span', 'span-a']).code).toBe(0);
    }
    const capped = runCli(dir, ['replay', 'fork-trace', '--span', 'span-a']);
    expect(capped.code).toBe(1);
    expect(capped.stderr).toContain('fork point limit reached');

    writeFileSync(join(dir, '.xm', 'traces', 'corrupt.jsonl'), '{not json}\n');
    const corrupt = runCli(dir, ['replay', 'corrupt', '--span', 'span-a']);
    expect(corrupt.code).toBe(1);
    expect(corrupt.stderr).toContain('corrupt trace JSONL');
  });

  test('reports machine-readable preflight and postflight warnings over 10MB', () => {
    const { dir } = makeRepo();
    writeFileSync(join(dir, 'large.bin'), randomBytes(11 * 1024 * 1024));
    execSync('git add large.bin', { cwd: dir, stdio: 'pipe' });
    writeReplayTrace(dir, 'large-trace');
    const out = runCli(dir, ['replay', 'large-trace', '--span', 'span-a', '--json']);
    expect(out.code).toBe(0);
    const warnings = JSON.parse(out.stdout).warnings;
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'snapshot_size_over_10mb', phase: 'preflight' }),
      expect.objectContaining({ code: 'snapshot_size_over_10mb', phase: 'postflight' }),
    ]));
  });

  test('enforces the three-fork limit under concurrent invocations', async () => {
    const { dir } = makeRepo();
    writeReplayTrace(dir, 'concurrent-trace');
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      runCliAsync(dir, ['replay', 'concurrent-trace', '--span', 'span-a']),
    ));
    expect(results.filter((result) => result.code === 0)).toHaveLength(3);
    expect(results.filter((result) => result.code !== 0)).toHaveLength(1);
    expect(results.find((result) => result.code !== 0).stderr).toContain('fork point limit reached');
  });
});

describe('since <ref>', () => {
  test('lists tools recorded after the ref commit; usage error without a ref', () => {
    const { dir } = makeRepo();
    const base = emptyCommit(dir, 'base'); // ref boundary
    runCli(dir, ['record', 'eval', '--status', 'scored']); // recorded after base

    const out = runCli(dir, ['since', base]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('eval');

    const usage = runCli(dir, ['since']);
    expect(usage.code).toBe(1);
    expect(usage.stderr).toContain('Usage: xm trace since');
  });
});
