// gate-panel wrapper — panel verdict → merge-gate exit code.
//
// The real `xm panel` is multi-model and costs money, so it is NEVER invoked
// here: a fake panel script is injected via X_BUILD_PANEL_ARGV. Integration
// scenarios spawn the CLI in a child process (env isolation), pure policy logic
// is tested by direct import.
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  mergePolicy, evaluateVerdict, resolveMainRoots,
  resolvePolicyForPhase, nextRound, applyRoundCap, preGateArgv,
} from '../../x-build/lib/x-build/gate-panel.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', '..', 'x-build', 'lib', 'x-build-cli.mjs');

// ── Fake panel: emits a verdict JSON (or a transient failure) per env mode ──
const FAKE_PANEL = `
import { writeFileSync, readFileSync } from 'node:fs';
const mode = process.env.FAKE_PANEL_MODE || 'clean';
const counter = process.env.FAKE_PANEL_COUNTER;
const captureEnv = process.env.FAKE_PANEL_CAPTURE_ENV;
const captureArgv = process.env.FAKE_PANEL_CAPTURE_ARGV;
if (counter) {
  let n = 0;
  try { n = parseInt(readFileSync(counter, 'utf8'), 10) || 0; } catch {}
  writeFileSync(counter, String(n + 1));
}
if (captureEnv) writeFileSync(captureEnv, process.env.X_PANEL_ROUTED_MODEL_OVERRIDES || '');
if (captureArgv) writeFileSync(captureArgv, JSON.stringify(process.argv.slice(2)));
const out = (v) => process.stdout.write(JSON.stringify(v));
const base = { consensus: [], confirmed: [], contested: [], unreviewed: [] };
if (mode === 'clean') { out({ run: 'fk-clean', counts: {}, ...base }); process.exit(0); }
if (mode === 'confirmed-high') { out({ run: 'fk-ch', counts: {}, ...base, confirmed: [{ owner: 'claude', severity: 'high', file: 'src/auth.ts', line: 42, claim: 'missing authz' }] }); process.exit(0); }
if (mode === 'confirmed-medium') { out({ run: 'fk-cm', counts: {}, ...base, confirmed: [{ owner: 'claude', severity: 'medium', file: 'src/ui.ts', line: 7, claim: 'race on retry' }] }); process.exit(0); }
if (mode === 'contested-critical') { out({ run: 'fk-cc', counts: {}, ...base, contested: [{ owner: 'claude', severity: 'critical', file: 'src/x.ts', line: 1, claim: 'rce' }] }); process.exit(0); }
if (mode === 'confirmed-low') { out({ run: 'fk-cl', counts: {}, ...base, confirmed: [{ owner: 'c', severity: 'low', file: 'a', line: 1, claim: 'nit' }] }); process.exit(0); }
if (mode === 'transient-fail') { process.stderr.write('provider timeout: ETIMEDOUT reaching endpoint\\n'); process.exit(1); }
process.stderr.write('unknown mode\\n');
process.exit(1);
`;

let main;       // main repo root
let wt;         // linked worktree root
let fakePanel;  // fake panel script path
let patchFile;  // dummy patch
let preFail;    // fake pre-gate: exit 1 + findings JSON
let preErr;     // fake pre-gate: exit 2 (infra error)

const PROJECT = 'demo';
const gitq = (cwd, c) => execSync(`git ${c}`, { cwd, stdio: 'pipe', shell: '/bin/bash' });

function runGate({ mode, task = 't1', phase = 'before', json = true, project = PROJECT, counter, cwd = wt, extraArgs = [], captureEnv = null, captureArgv = null }) {
  const args = ['gate-panel'];
  if (project !== null) args.push('--project', project);
  if (task !== null) args.push('--task', task);
  if (phase !== null) args.push('--phase', phase);
  args.push('--patch', patchFile);
  if (json) args.push('--json');
  args.push(...extraArgs);

  // Force self-resolution: strip root env so the wrapper must derive main .xm/
  // from git-common-dir.
  const env = { ...process.env };
  delete env.X_BUILD_ROOT;
  delete env.X_PANEL_ROOT;
  delete env.XM_ROOT;
  env.X_BUILD_PANEL_ARGV = JSON.stringify(['node', fakePanel]);
  env.FAKE_PANEL_MODE = mode;
  if (counter) env.FAKE_PANEL_COUNTER = counter;
  if (captureEnv) env.FAKE_PANEL_CAPTURE_ENV = captureEnv;
  if (captureArgv) env.FAKE_PANEL_CAPTURE_ARGV = captureArgv;
  env.NO_COLOR = '1';

  const res = spawnSync('node', [CLI, ...args], { cwd, env, encoding: 'utf8' });
  let parsed = null;
  if (json) { try { parsed = JSON.parse(res.stdout); } catch { /* leave null */ } }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, parsed };
}

beforeAll(() => {
  main = mkdtempSync(join(tmpdir(), 'gp-main-'));
  gitq(main, 'init -q');
  gitq(main, 'config user.email t@t.com');
  gitq(main, 'config user.name T');
  writeFileSync(join(main, 'f.txt'), 'hello\n');
  gitq(main, 'add -A && git commit -q -m c1');

  // Minimal project scaffold so config/task reads resolve (not strictly required —
  // readJSON tolerates missing — but exercises the real path).
  mkdirSync(join(main, '.xm', 'build', 'projects', PROJECT, 'phases', '02-plan'), { recursive: true });

  // Linked worktree — gate runs from HERE, artifacts must land in main .xm/.
  wt = join(main, '..', `gp-wt-${Date.now()}`);
  gitq(main, `worktree add -q -b feat/t1 ${JSON.stringify(wt)}`);

  fakePanel = join(main, 'fake-panel.mjs');
  writeFileSync(fakePanel, FAKE_PANEL);
  patchFile = join(main, 'gate.patch');
  writeFileSync(patchFile, 'diff --git a/f.txt b/f.txt\n');

  // Fake pre-gate scripts (plan §3F): block with structured findings / infra error.
  preFail = join(main, 'pre-fail.mjs');
  writeFileSync(preFail, `
process.stdout.write(JSON.stringify({ findings: [{ severity: 'high', file: 'src/a.ts', line: 3, claim: 'unhandled rejection' }] }));
process.exit(1);
`);
  preErr = join(main, 'pre-err.mjs');
  writeFileSync(preErr, 'process.stderr.write("boom\\n"); process.exit(2);\n');
});

afterAll(() => {
  try { gitq(main, `worktree remove --force ${JSON.stringify(wt)}`); } catch {}
  for (const d of [main, wt]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
});

const artifact = (task, phase) => join(main, '.xm', 'build', 'projects', PROJECT, 'worktrees', task, `panel-${phase}.json`);

describe('gate-panel policy logic (pure)', () => {
  test('mergePolicy layers defaults ← config ← task', () => {
    const p = mergePolicy({
      config: { worktree: { gate_policy: { block_confirmed: ['critical', 'high'] } } },
      task: { gate_policy: { allow_low: false } },
    });
    expect(p.block_confirmed).toEqual(['critical', 'high']); // config override
    expect(p.block_unreviewed).toEqual(['critical', 'high']); // default retained
    expect(p.block_contested).toEqual(['critical']);          // default retained
    expect(p.allow_low).toBe(false);                          // task override
  });

  test('evaluateVerdict blocks confirmed high, passes clean', () => {
    const policy = mergePolicy({});
    expect(evaluateVerdict({ confirmed: [], contested: [], unreviewed: [] }, policy).decision).toBe('pass');
    const fail = evaluateVerdict({ confirmed: [{ severity: 'high', file: 'a', line: 1, claim: 'x' }], contested: [], unreviewed: [] }, policy);
    expect(fail.decision).toBe('fail');
    expect(fail.blocking[0].kind).toBe('confirmed');
  });

  test('allow_low keeps low-severity findings non-blocking', () => {
    const policy = mergePolicy({ task: { gate_policy: { block_confirmed: ['critical', 'high', 'medium', 'low'] } } });
    const r = evaluateVerdict({ confirmed: [{ severity: 'low', file: 'a', line: 1, claim: 'nit' }], contested: [], unreviewed: [] }, policy);
    expect(r.decision).toBe('pass'); // allow_low defaults true → low never blocks
  });

  test('contested critical blocks via block_contested', () => {
    const policy = mergePolicy({});
    const r = evaluateVerdict({ confirmed: [], unreviewed: [], contested: [{ severity: 'critical', file: 'a', line: 1, claim: 'x' }] }, policy);
    expect(r.decision).toBe('fail');
    expect(r.blocking[0].kind).toBe('contested');
  });

  test('resolveMainRoots honors explicit X_BUILD_ROOT over git', () => {
    const prev = process.env.X_BUILD_ROOT;
    process.env.X_BUILD_ROOT = '/tmp/explicit/.xm/build';
    try {
      const { buildRoot } = resolveMainRoots(process.cwd());
      expect(buildRoot).toBe('/tmp/explicit/.xm/build');
    } finally {
      if (prev === undefined) delete process.env.X_BUILD_ROOT; else process.env.X_BUILD_ROOT = prev;
    }
  });

  test('gate-panel passes reviewer routed fallback to panel as a per-run env override', () => {
    const capture = join(main, `env-${Date.now()}.json`);
    const tasksPath = join(main, '.xm', 'build', 'projects', PROJECT, 'phases', '02-plan', 'tasks.json');
    writeFileSync(tasksPath, JSON.stringify({ tasks: [{ id: 'tr', size: 'large' }] }));
    const r = runGate({ mode: 'clean', task: 'tr', captureEnv: capture });
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual({ codex: 'gpt-5.5:high' });
  });
});

describe('gate-panel policy — phase overlays + advisory (plan §3A)', () => {
  test('default per-task (before) policy blocks critical/high only; release overlay re-adds medium', () => {
    const before = mergePolicy({ phase: 'before' });
    expect(before.block_confirmed).toEqual(['critical', 'high']);
    expect(before.release).toBeUndefined(); // resolved policy is FLAT
    const release = mergePolicy({ phase: 'release' });
    expect(release.block_confirmed).toEqual(['critical', 'high', 'medium']);
  });

  test('confirmed medium at before → pass with advisory (never silently dropped)', () => {
    const policy = mergePolicy({ phase: 'before' });
    const r = evaluateVerdict({ confirmed: [{ severity: 'medium', file: 'a', line: 1, claim: 'race' }], contested: [], unreviewed: [] }, policy);
    expect(r.decision).toBe('pass');
    expect(r.advisory).toHaveLength(1);
    expect(r.advisory[0].severity).toBe('medium');
  });

  test('confirmed medium at release → fail (deferred, not dropped)', () => {
    const policy = mergePolicy({ phase: 'release' });
    const r = evaluateVerdict({ confirmed: [{ severity: 'medium', file: 'a', line: 1, claim: 'race' }], contested: [], unreviewed: [] }, policy);
    expect(r.decision).toBe('fail');
  });

  test('config/task overlays override the default overlay wholesale (per-key)', () => {
    const p = mergePolicy({
      config: { worktree: { gate_policy: { release: { block_confirmed: ['critical'] } } } },
      phase: 'release',
    });
    expect(p.block_confirmed).toEqual(['critical']);
  });

  test('resolvePolicyForPhase strips overlay keys and applies the matching one', () => {
    const merged = mergePolicy({});
    const flat = resolvePolicyForPhase(merged, 'after');
    expect(Object.keys(flat).sort()).toEqual(['allow_low', 'block_confirmed', 'block_contested', 'block_unreviewed'].sort());
    expect(flat.block_confirmed).toEqual(['critical', 'high']); // 'after' has no default overlay
  });
});

describe('gate-panel rounds + cap (plan §3E, pure)', () => {
  test('nextRound: no artifact → 1; prior pass → 1 (base-drift re-gate resets)', () => {
    expect(nextRound(null)).toBe(1);
    expect(nextRound({ decision: 'pass', panel_run: 'r1', round: 3 })).toBe(1);
  });

  test('nextRound: panel fail increments; pre-gate fail (panel_run null) holds', () => {
    expect(nextRound({ decision: 'fail', panel_run: 'r1', round: 1 })).toBe(2);
    expect(nextRound({ decision: 'fail', panel_run: null, round: 2 })).toBe(2);
  });

  test('applyRoundCap demotes medium past the cap; critical/high never demote', () => {
    const policy = { block_confirmed: ['critical', 'high', 'medium'], block_unreviewed: ['critical', 'high'], block_contested: ['critical'], allow_low: true };
    const under = applyRoundCap(policy, 2, 2);
    expect(under.demotions).toHaveLength(0);
    expect(under.policy.block_confirmed).toContain('medium');
    const over = applyRoundCap(policy, 3, 2);
    expect(over.demotions).toHaveLength(1);
    expect(over.policy.block_confirmed).toEqual(['critical', 'high']);
    expect(over.policy.block_unreviewed).toEqual(['critical', 'high']); // untouched — no medium there
  });

  test('applyRoundCap: max 0 disables the cap', () => {
    const policy = { block_confirmed: ['medium'], block_unreviewed: [], block_contested: [], allow_low: true };
    expect(applyRoundCap(policy, 99, 0).demotions).toHaveLength(0);
  });
});

describe('pre-gate argv (plan §3F, pure)', () => {
  test('{patch} token substitutes; missing token appends the patch path', () => {
    expect(preGateArgv('xm review --quick {patch}', '/p/x.diff')).toEqual(['xm', 'review', '--quick', '/p/x.diff']);
    expect(preGateArgv('node check.mjs', '/p/x.diff')).toEqual(['node', 'check.mjs', '/p/x.diff']);
    expect(preGateArgv('   ', '/p/x.diff')).toBeNull();
  });
});

describe('gate-panel CLI (integration, fake panel)', () => {
  test('(a) no findings → exit 0, decision pass', () => {
    const r = runGate({ mode: 'clean', task: 'ta' });
    expect(r.status).toBe(0);
    expect(r.parsed.decision).toBe('pass');
    expect(r.parsed.panel_run).toBe('fk-clean');
    expect(existsSync(artifact('ta', 'before'))).toBe(true);
  });

  test('(b) confirmed high → exit 1, decision fail', () => {
    const r = runGate({ mode: 'confirmed-high', task: 'tb' });
    expect(r.status).toBe(1);
    expect(r.parsed.decision).toBe('fail');
    expect(r.parsed.blocking_findings).toHaveLength(1);
    expect(r.parsed.blocking_findings[0].severity).toBe('high');
    const saved = JSON.parse(readFileSync(artifact('tb', 'before'), 'utf8'));
    expect(saved.exit_code).toBe(1);
  });

  test('(c) contested critical → exit 1 (block_contested)', () => {
    const r = runGate({ mode: 'contested-critical', task: 'tc' });
    expect(r.status).toBe(1);
    expect(r.parsed.decision).toBe('fail');
    expect(r.parsed.blocking_findings[0].kind).toBe('contested');
  });

  test('(d) transient panel failure → 1 retry then exit 2, decision error', () => {
    const counter = join(main, 'panel-count.txt');
    const r = runGate({ mode: 'transient-fail', task: 'td', counter });
    expect(r.status).toBe(2);
    expect(r.parsed.decision).toBe('error');
    expect(r.parsed.attempts).toBe(2);
    expect(parseInt(readFileSync(counter, 'utf8'), 10)).toBe(2); // called twice (1 + retry)
    const saved = JSON.parse(readFileSync(artifact('td', 'before'), 'utf8'));
    expect(saved.decision).toBe('error');
  });

  test('worktree cwd → artifact lands in MAIN repo .xm/, not worktree', () => {
    const r = runGate({ mode: 'clean', task: 'twt', phase: 'after' });
    expect(r.status).toBe(0);
    expect(existsSync(artifact('twt', 'after'))).toBe(true);            // main .xm/
    expect(existsSync(join(wt, '.xm', 'build', 'projects', PROJECT, 'worktrees', 'twt', 'panel-after.json'))).toBe(false);
  });

  test('missing --project → exit 2', () => {
    const r = runGate({ mode: 'clean', task: 'tp', project: null, json: false });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--project');
  });

  test('(F3) path-traversal --task → exit 2, refused before any panel run', () => {
    const r = runGate({ mode: 'clean', task: '../evil', json: false });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--task');
  });

  test('(F3) path-traversal --project → exit 2', () => {
    const r = runGate({ mode: 'clean', task: 't1', project: '../evil', json: false });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--project');
  });

  test('(F3) reserved __integration__ task id passes validation', () => {
    const r = runGate({ mode: 'clean', task: '__integration__' });
    expect(r.status).toBe(0);
    expect(r.parsed.decision).toBe('pass');
    expect(existsSync(artifact('__integration__', 'before'))).toBe(true);
  });

  test('task gate_policy override is applied and recorded', () => {
    // Task tov relaxes block_confirmed to critical-only → a high finding passes.
    const tasksPath = join(main, '.xm', 'build', 'projects', PROJECT, 'phases', '02-plan', 'tasks.json');
    writeFileSync(tasksPath, JSON.stringify({ tasks: [{ id: 'tov', gate_policy: { block_confirmed: ['critical'] } }] }));
    const r = runGate({ mode: 'confirmed-high', task: 'tov' });
    expect(r.status).toBe(0);
    expect(r.parsed.decision).toBe('pass');
    expect(r.parsed.policy_overridden).toBe(true);
    expect(r.parsed.policy.block_confirmed).toEqual(['critical']);
  });
});

describe('gate-panel CLI — advisory, rounds, cap, pre-gate (integration, fake panel)', () => {
  const buildCfgPath = () => join(main, '.xm', 'build', 'config.json');
  const writeCfg = (worktree) => writeFileSync(buildCfgPath(), JSON.stringify({ worktree }));
  const clearCfg = () => { try { rmSync(buildCfgPath()); } catch { /* absent is fine */ } };

  test('panel execution defaults to one round and forwards an explicit two-round escalation', () => {
    const onePath = join(main, 'panel-argv-one.json');
    const one = runGate({ mode: 'clean', task: 'round-one', captureArgv: onePath });
    expect(one.status).toBe(0);
    expect(one.parsed.panel_rounds).toBe(1);
    expect(JSON.parse(readFileSync(onePath, 'utf8'))).toContain('--rounds');
    expect(JSON.parse(readFileSync(onePath, 'utf8'))).toContain('1');

    const twoPath = join(main, 'panel-argv-two.json');
    const two = runGate({ mode: 'clean', task: 'round-two', extraArgs: ['--rounds', '2'], captureArgv: twoPath });
    expect(two.status).toBe(0);
    expect(two.parsed.panel_rounds).toBe(2);
    const argv = JSON.parse(readFileSync(twoPath, 'utf8'));
    expect(argv[argv.indexOf('--rounds') + 1]).toBe('2');
  });

  test('confirmed medium → pass with advisory under the default per-task policy (§3A)', () => {
    const r = runGate({ mode: 'confirmed-medium', task: 'adv' });
    expect(r.status).toBe(0);
    expect(r.parsed.decision).toBe('pass');
    expect(r.parsed.advisory_findings).toHaveLength(1);
    expect(r.parsed.advisory_findings[0].severity).toBe('medium');
  });

  test('confirmed medium at release phase → exit 1 (default overlay re-adds medium)', () => {
    const r = runGate({ mode: 'confirmed-medium', task: 'rel', phase: 'release' });
    expect(r.status).toBe(1);
    expect(r.parsed.decision).toBe('fail');
    expect(r.parsed.policy.block_confirmed).toEqual(['critical', 'high', 'medium']);
  });

  test('rounds: consecutive panel fails increment round and preserve the prior artifact (§3E)', () => {
    const r1 = runGate({ mode: 'confirmed-high', task: 'rnd' });
    expect(r1.status).toBe(1);
    expect(r1.parsed.round).toBe(1);
    const r2 = runGate({ mode: 'confirmed-high', task: 'rnd' });
    expect(r2.parsed.round).toBe(2);
    const attempt1 = join(main, '.xm', 'build', 'projects', PROJECT, 'worktrees', 'rnd', 'panel-before.attempt-1.json');
    expect(existsSync(attempt1)).toBe(true);
    expect(JSON.parse(readFileSync(attempt1, 'utf8')).round).toBe(1);
  });

  test('rounds: a pass resets the counter (base-drift re-gate is not a fix round)', () => {
    const f = runGate({ mode: 'confirmed-high', task: 'rst' });
    expect(f.parsed.round).toBe(1);
    const p = runGate({ mode: 'clean', task: 'rst' });
    expect(p.parsed.round).toBe(2);      // the fix attempt that passed IS round 2
    const again = runGate({ mode: 'clean', task: 'rst' });
    expect(again.parsed.round).toBe(1);  // after a pass, a re-gate starts fresh
  });

  test('round cap: past gate_max_rounds a blocking medium demotes to advisory (§3E)', () => {
    writeCfg({ gate_policy: { block_confirmed: ['critical', 'high', 'medium'] }, gate_max_rounds: 1 });
    try {
      const r1 = runGate({ mode: 'confirmed-medium', task: 'cap' });
      expect(r1.status).toBe(1); // round 1: config re-adds medium → blocks
      const r2 = runGate({ mode: 'confirmed-medium', task: 'cap' });
      expect(r2.status).toBe(0); // round 2 > cap 1 → demoted
      expect(r2.parsed.demotions).toHaveLength(1);
      expect(r2.parsed.demotions[0]).toMatchObject({ severity: 'medium', reason: 'round_cap' });
      expect(r2.parsed.advisory_findings).toHaveLength(1); // demoted ≠ dropped
    } finally { clearCfg(); }
  });

  test('pre-gate exit 1 → fail-fast: the panel never runs, findings adopted (§3F)', () => {
    writeCfg({ pre_gate: `node ${preFail} {patch}` });
    try {
      const counter = join(main, 'pg-count.txt');
      const r = runGate({ mode: 'clean', task: 'pgf', counter });
      expect(r.status).toBe(1);
      expect(r.parsed.decision).toBe('fail');
      expect(r.parsed.pre_gate.status).toBe('fail');
      expect(r.parsed.blocking_findings).toHaveLength(1);
      expect(r.parsed.blocking_findings[0].kind).toBe('pre_gate');
      expect(existsSync(counter)).toBe(false); // fake panel was never invoked
    } finally { clearCfg(); }
  });

  test('pre-gate exit 2 (infra error) → loud warn, panel proceeds (§3F)', () => {
    writeCfg({ pre_gate: `node ${preErr}` });
    try {
      const r = runGate({ mode: 'clean', task: 'pge' });
      expect(r.status).toBe(0);
      expect(r.parsed.decision).toBe('pass');
      expect(r.parsed.pre_gate.status).toBe('error');
      expect(r.stderr).toContain('pre-gate');
    } finally { clearCfg(); }
  });
});
