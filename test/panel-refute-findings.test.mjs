/**
 * x-panel --refute-findings: judge a caller-supplied finding list instead of producing one.
 * Stubbed providers. Proves: round 1 is never dispatched, the supplied list is what every
 * model refutes, the supplied owner is counted as an author but never as a reviewer, and
 * an unusable list fails before any model is spawned.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'x-panel', 'lib', 'x-panel-cli.mjs');
const STUB = join(import.meta.dirname, 'fixtures', 'panel-stub-model.mjs');
// Long enough to clear the trivial-target guard (min_target_chars, default 40).
const TARGET = 'diff --git a/x.js b/x.js\n+const skipGate = registryHasKey(name);\n+if (skipGate) return;';

const FINDINGS = [
  { severity: 'high', file: 'install.sh', line: 84, claim: 'skip gate keyed on registry presence only', evidence: 'grep -q on installed_plugins.json' },
  { severity: 'medium', file: 'xm', line: 706, claim: 'version compared without a cache check', evidence: 'e.version !== want' },
];

let DIR;
beforeAll(() => { DIR = mkdtempSync(join(tmpdir(), 'refute-findings-')); });
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

function run(name, args = [], { models = 'claude,codex' } = {}) {
  const sub = join(DIR, name);
  const log = join(DIR, `${name}.session.jsonl`);
  // `panel review` routes to the x-review lifecycle, which requires a target path;
  // --refute-findings is a native-engine contract, so pin the engine.
  const r = spawnSync('node', [CLI, 'review', TARGET, '--models', models, '--engine', 'native', ...args], {
    cwd: DIR,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      X_PANEL_ROOT: join(sub, '.xm'),
      X_PANEL_GLOBAL_ROOT: join(sub, '.xm-g'),
      X_PANEL_CMD_CLAUDE: STUB,
      X_PANEL_CMD_CODEX: STUB,
      X_PANEL_SESSION_LOG: log,
      NO_COLOR: '1',
    },
  });
  const calls = existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const runDir = join(sub, '.xm', 'panel');
  const dir = existsSync(runDir)
    ? (readdirSync(runDir).filter((n) => n.startsWith('panel-')).sort().pop() ?? null)
    : null;
  const verdict = dir && existsSync(join(runDir, dir, 'verdict.json'))
    ? JSON.parse(readFileSync(join(runDir, dir, 'verdict.json'), 'utf8'))
    : null;
  return { r, calls, verdict, runDir, dir };
}

function findingsFile(name, body) {
  const p = join(DIR, `${name}.json`);
  writeFileSync(p, JSON.stringify(body));
  return p;
}

describe('--refute-findings', () => {
  test('skips round 1 and refutes the supplied list', () => {
    const file = findingsFile('supplied', { findings: FINDINGS });
    const { r, calls, verdict } = run('basic', ['--refute-findings', file]);
    expect(r.status).toBe(0);
    // Every spawn is a refutation: the review round was never dispatched.
    expect(calls.length).toBe(2);
    expect(calls.every((c) => c.refute === true)).toBe(true);
    // Both supplied findings reached the verdict, attributed to the supplied owner.
    expect(verdict.models).toContain('supplied');
    expect(verdict.by_model.supplied.raised).toBe(2);
    const owners = [...verdict.confirmed, ...verdict.contested, ...verdict.unreviewed].map((f) => f.owner);
    expect(owners).toEqual(['supplied', 'supplied']);
  });

  test('counts the supplied owner as an author, never as a reviewer', () => {
    const file = findingsFile('reviewers', { findings: FINDINGS });
    const { verdict } = run('reviewers', ['--refute-findings', file]);
    // Two models voted; 'supplied' must not inflate the count to three.
    for (const f of [...verdict.confirmed, ...verdict.contested]) expect(f.reviewers).toBe(2);
    // It cast no verdicts, so it can have no fidelity failures of its own.
    expect(verdict.by_model.supplied.unmatched_refs).toBe(0);
    expect(verdict.by_model.claude.raised).toBe(0);
    expect(verdict.by_model.codex.raised).toBe(0);
  });

  test('runs the refutation round even when --rounds 1 is passed', () => {
    const file = findingsFile('rounds1', { findings: FINDINGS });
    const { r, calls, verdict } = run('rounds1', ['--refute-findings', file, '--rounds', '1']);
    expect(r.status).toBe(0);
    expect(calls.every((c) => c.refute === true)).toBe(true);
    expect(r.stderr).toContain('ignoring --rounds 1');
    // synthesizeRound1 would leave opponents empty; the refutation path fills them.
    const judged = [...verdict.confirmed, ...verdict.contested];
    expect(judged.some((f) => f.opponents.length > 0)).toBe(true);
  });

  test('accepts a bare findings array', () => {
    const file = findingsFile('bare', FINDINGS);
    const { r, verdict } = run('bare', ['--refute-findings', file]);
    expect(r.status).toBe(0);
    expect(verdict.by_model.supplied.raised).toBe(2);
  });

  test('a single model may judge a list it did not author', () => {
    const file = findingsFile('single', { findings: FINDINGS });
    const { r, calls, verdict } = run('single', ['--refute-findings', file], { models: 'claude' });
    expect(r.status).toBe(0);
    // Without the supplied list this would be downgraded to one round (no peer to refute).
    expect(calls.length).toBe(1);
    expect(calls[0].refute).toBe(true);
    expect(verdict.by_model.supplied.raised).toBe(2);
  });

  test('rejects an unreadable file before spawning any model', () => {
    const { r, calls, verdict } = run('missing', ['--refute-findings', join(DIR, 'nope.json')]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('cannot read');
    expect(calls.length).toBe(0);
    expect(verdict).toBe(null);
  });

  test('rejects the flag without a path instead of running a full review', () => {
    // parseFlags stores undefined when no path follows, which a truthy check reads as "absent".
    // The failure mode being guarded is silent: a full two-round review that reports success.
    const { r, calls } = run('novalue', ['--refute-findings', '--grounded']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--refute-findings needs a path');
    expect(calls.length).toBe(0);
    // `--refute-findings=` takes the other parse path and must fail the same way.
    const eq = run('novalue-eq', ['--refute-findings=']);
    expect(eq.r.status).toBe(2);
    expect(eq.calls.length).toBe(0);
  });

  test('keeps the supplied owner out of the per-vendor accuracy ledger', () => {
    const file = findingsFile('ledger', { findings: FINDINGS });
    const { r, runDir } = run('ledger', ['--refute-findings', file]);
    expect(r.status).toBe(0);
    // history.jsonl is the cross-run vendor ledger `xm panel stats` reads; a sentinel row there
    // would report a survival rate for something that never reviewed anything.
    const ledger = join(runDir, 'history.jsonl');
    expect(existsSync(ledger)).toBe(true);
    const models = readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l).model);
    expect(models).not.toContain('supplied');
    expect(models.sort()).toEqual(['claude', 'codex']);
  });

  test('reports judged counts instead of an unreachable unanimity denominator', () => {
    const file = findingsFile('render', { findings: FINDINGS });
    const { r, verdict } = run('render', ['--refute-findings', file]);
    expect(r.status).toBe(0);
    // The sentinel is named in the verdict so readers holding only the record can exclude it.
    expect(verdict.supplied_owner).toBe('supplied');
    // Every finding has one author here, so consensus can never reach models.length and the
    // diversity line would read "0 unanimous" on every run. It is replaced, not recomputed.
    expect(r.stdout).not.toContain('unanimous');
    expect(r.stdout).toMatch(/Judged 2 supplied finding\(s\) with 2 model\(s\)/);
    // The reviewer list drops the sentinel; it judged nothing.
    expect(r.stdout).toMatch(/models: claude, codex/);
  });

  test('leaves the ordinary two-round rendering untouched', () => {
    const { r } = run('normal', ['--rounds', '2']);
    expect(r.status).toBe(0);
    // Without the flag the consensus tag and diversity line must survive unchanged.
    expect(r.stdout).toContain('unanimous');
    expect(r.stdout).toContain('Raised per model:');
    expect(r.stdout).toMatch(/\d\/2 /);
  });

  test('rejects a list with no usable finding', () => {
    const empty = findingsFile('empty', { findings: [] });
    expect(run('empty', ['--refute-findings', empty]).r.status).toBe(2);
    // An entry without a claim is dropped by normalizeFindings, leaving nothing to judge.
    const noClaim = findingsFile('noclaim', [{ severity: 'high', file: 'a.js' }]);
    const { r, calls } = run('noclaim', ['--refute-findings', noClaim]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('no usable findings');
    expect(calls.length).toBe(0);
  });
});
