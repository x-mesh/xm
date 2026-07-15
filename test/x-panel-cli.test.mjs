/**
 * x-panel PoC tests.
 * - synth/adapters: pure-function unit tests
 * - CLI: full review flow driven by stub model commands (no real models)
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { normalizeFindings, normalizeVerdicts, synthesize, mergeConsensus, normalizeResponses, followupDelta } from '../x-panel/lib/x-panel/synth.mjs';
import { mergePolicy, evaluateVerdict, DEFAULT_POLICY } from '../x-panel/lib/x-panel/gate.mjs';
import { historyRows, aggregatePanelStats, readPanelHistory } from '../x-panel/lib/x-panel/history.mjs';
import { extractJSON, scanJSONObjects, extractContractJSON, proseOutsideJSON, autodetectModels, knownProviders, invokeProvider, normalizeKiroModel, streamCommand, parseStreamLine, costFromTokens, supportsStream, resolveCommand, providerReady, parseModelIds, buildCodexResumeArgs, promptSpawnOpts, withStderrReason, groundCapable, parseMarkdownFindings, stripAnsi } from '../x-panel/lib/x-panel/adapters.mjs';
import { readEventsLog, formatEventLine, sanitizeEventText, maxSeq } from '../x-panel/lib/x-panel/events-log.mjs';
import { shrinkDiff, splitDiffSections, DIFF_INLINE_MAX_BYTES } from '../x-panel/lib/x-panel/diff-budget.mjs';
import { unwrapEnvelope } from '../x-panel/lib/x-panel/adapters.mjs';

const CLI = join(import.meta.dirname, '..', 'x-panel', 'lib', 'x-panel-cli.mjs');
const STUB = join(import.meta.dirname, 'fixtures', 'panel-stub-model.mjs');
let DIR;

const STUB_ENV = (extra) => ({
  ...process.env,
  X_PANEL_ROOT: join(DIR, '.xm'),
  X_PANEL_GLOBAL_ROOT: join(DIR, '.xm-global'), // hermetic: don't read the real ~/.xm
  X_PANEL_CMD_CLAUDE: STUB,
  X_PANEL_CMD_CODEX: STUB,
  NO_COLOR: '1',
  ...extra,
});

function review(args, env = {}) {
  // default to the two stubbed models so tests never invoke real autodetected CLIs
  const finalArgs = args.includes('--models') ? args : ['--models', 'claude,codex', ...args];
  return spawnSync('node', [CLI, 'review', ...finalArgs], { cwd: DIR, env: STUB_ENV(env), encoding: 'utf8', timeout: 20000 });
}

function panelRaw(args, env = {}) {
  // no implicit 'review' prefix and no implicit --models — exercises shortcut + config
  return spawnSync('node', [CLI, ...args], { cwd: DIR, env: STUB_ENV(env), encoding: 'utf8', timeout: 20000 });
}

function writeProjectConfig(panel) {
  mkdirSync(join(DIR, '.xm'), { recursive: true });
  writeFileSync(join(DIR, '.xm', 'config.json'), JSON.stringify({ panel }, null, 2));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, timeoutMs = 5000, intervalMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = check();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

function latestVerdict() {
  const panelDir = join(DIR, '.xm', 'panel');
  const runs = readdirSync(panelDir).filter(n => n.startsWith('panel-')).sort();
  return JSON.parse(readFileSync(join(panelDir, runs[runs.length - 1], 'verdict.json'), 'utf8'));
}

function latestRunDir() {
  const panelDir = join(DIR, '.xm', 'panel');
  const runs = readdirSync(panelDir).filter(n => n.startsWith('panel-')).sort();
  return join(panelDir, runs[runs.length - 1]);
}

beforeAll(() => { DIR = mkdtempSync(join(tmpdir(), 'xpanel-')); });
afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

// ── panel gate (verdict → merge-gate exit code, 패널7) ──────────────
describe('withStderrReason — surface the real failure cause (stderr surfacing)', () => {
  test('exit-0-but-no-JSON: the stderr TAIL (ANSI-stripped) is appended as the cause', () => {
    const stderr = '\x1b[1G\x1b[0mChatting…\n\x1b[38;5;9mValidationException: input_schema does not support oneOf, allOf, or anyOf\x1b[0m';
    const out = withStderrReason('no findings JSON in output', '', stderr);
    expect(out).toContain('no findings JSON in output — ');
    expect(out).toContain('input_schema does not support oneOf'); // the real kiro cause
    expect(out).not.toContain('\x1b['); // ANSI stripped
  });
  test('empty stdout AND empty stderr → says the CLI produced nothing', () => {
    expect(withStderrReason('no findings JSON in output', '', '')).toContain('empty output — the CLI produced nothing');
  });
  test('non-empty stdout with no usable stderr → base error unchanged', () => {
    expect(withStderrReason('no JSON object in output', 'some prose the parser rejected', '')).toBe('no JSON object in output');
  });
  test('only the tail is kept (long banners do not bury the message)', () => {
    const stderr = 'x'.repeat(1000) + 'THE ACTUAL ERROR AT THE END';
    expect(withStderrReason('base', '', stderr)).toContain('THE ACTUAL ERROR AT THE END');
  });
});

describe('unwrapEnvelope (패널1 — structured usage capture)', () => {
  const ENVELOPE = {
    type: 'result', subtype: 'success', is_error: false,
    result: '{"findings":[{"severity":"high","file":"a.js","line":1,"claim":"x"}]}',
    session_id: '3d77d18b-c06c-4f8d-bf40-244f0b14abdb',
    total_cost_usd: 0.3342975,
    usage: { input_tokens: 2, output_tokens: 4, cache_creation_input_tokens: 32654, cache_read_input_tokens: 15295 },
  };

  test('lifts the answer text out of the envelope (findings must parse from .result)', () => {
    const e = unwrapEnvelope(JSON.stringify(ENVELOPE));
    expect(e.text).toBe(ENVELOPE.result);           // NOT the envelope
    expect(e.error).toBeNull();
    expect(JSON.parse(e.text).findings).toHaveLength(1); // extraction still works downstream
  });

  test('lifts real token counts + the CLI-computed cost in the CANONICAL bucket shape', () => {
    const { usage } = unwrapEnvelope(JSON.stringify(ENVELOPE));
    // must match what the status accumulator sums: {input, output, cached, reasoning}
    expect(usage.input).toBe(2 + 32654);   // fresh input + cache CREATION (billed as input)
    expect(usage.output).toBe(4);
    expect(usage.cached).toBe(15295);      // cache READ = the cheap re-use bucket
    expect(usage.reasoning).toBe(0);
    expect(usage.cost_usd).toBeCloseTo(0.3342975, 6);
  });

  test('a provider-reported failure surfaces as an error, not an empty answer', () => {
    const e = unwrapEnvelope(JSON.stringify({ ...ENVELOPE, is_error: true, subtype: 'error_max_turns' }));
    expect(e.error).toContain('error_max_turns');
  });

  test('non-envelope output passes through untouched (stubs, plain-text vendors)', () => {
    const plain = '{"findings":[]}';
    expect(unwrapEnvelope(plain).text).toBe(plain);
    expect(unwrapEnvelope(plain).usage).toBeNull();
    expect(unwrapEnvelope('just prose').text).toBe('just prose');
    expect(unwrapEnvelope('').text).toBe('');
  });
});

describe('panel history ledger (빅뱃2)', () => {
  const REC = {
    run: 'panel-x', created_at: '2026-07-11T00:00:00Z', models: ['claude', 'codex'],
    by_model: {
      claude: { raised: 5, confirmed: 4, contested: 1, unmatched_refs: 0, r1: 'ok' },
      codex: { raised: 3, confirmed: 1, contested: 2, unmatched_refs: 1, r1: 'ok' },
    },
    usage: { by_model: { claude: { tokens: 12000, cost_usd: 0.08 }, codex: { tokens: 0, cost_usd: 0 } } },
  };

  test('historyRows sums the REAL 4-bucket token object (패널1 shape), not just a scalar', () => {
    const rec = {
      run: 'panel-y', created_at: 't', models: ['claude'],
      by_model: { claude: { raised: 1, confirmed: 1, contested: 0, unmatched_refs: 0, r1: 'ok' } },
      usage: { by_model: { claude: { tokens: { input: 32656, output: 4, cached: 15295, reasoning: 0 }, cost_usd: 0.334 } } },
    };
    const [row] = historyRows(rec);
    expect(row.tokens).toBe(32656 + 4 + 15295); // was null: `typeof {} === 'number'` is false
    expect(row.cost_usd).toBeCloseTo(0.334, 4);
    // an all-zero bucket object is still "unknown", never 0
    const zero = historyRows({ ...rec, usage: { by_model: { claude: { tokens: { input: 0, output: 0, cached: 0, reasoning: 0 }, cost_usd: 0 } } } });
    expect(zero[0].tokens).toBeNull();
    expect(zero[0].cost_usd).toBeNull();
  });

  test('historyRows: one row per model; cost 0 → null (unknown, never 0)', () => {
    const rows = historyRows(REC);
    expect(rows).toHaveLength(2);
    const claude = rows.find(r => r.model === 'claude');
    expect(claude.raised).toBe(5);
    expect(claude.confirmed).toBe(4);
    expect(claude.cost_usd).toBe(0.08);
    const codex = rows.find(r => r.model === 'codex');
    expect(codex.unmatched_refs).toBe(1);
    expect(codex.cost_usd).toBeNull(); // usage 0 → unknown, not 0
    expect(codex.tokens).toBeNull();
  });

  test('aggregatePanelStats: survival = confirmed/raised; cost sums only known runs', () => {
    const rows = [
      { model: 'claude', run: 'r1', raised: 5, confirmed: 4, contested: 1, unmatched_refs: 0, r1: 'ok', cost_usd: null },
      { model: 'claude', run: 'r2', raised: 5, confirmed: 4, contested: 1, unmatched_refs: 0, r1: 'ok', cost_usd: 0.08 },
      { model: 'codex', run: 'r1', raised: 4, confirmed: 1, contested: 3, unmatched_refs: 2, r1: 'ok', cost_usd: null },
    ];
    const stats = aggregatePanelStats(rows);
    const claude = stats.find(s => s.model === 'claude');
    expect(claude.raised).toBe(10);
    expect(claude.confirmed).toBe(8);
    expect(claude.survival_rate).toBeCloseTo(0.8, 5);
    expect(claude.cost_usd).toBeCloseTo(0.08, 5); // only the one run with usage
    expect(claude.cost_per_confirmed).toBeCloseTo(0.08 / 8, 5);
    const codex = stats.find(s => s.model === 'codex');
    expect(codex.cost_usd).toBeNull(); // no run had usage → unknown
    expect(codex.survival_rate).toBeCloseTo(0.25, 5);
    // sorted by survival descending
    expect(stats[0].model).toBe('claude');
  });

  test('a stubbed review appends per-model rows; stats reads them', () => {
    const r = review(['some diff']);
    expect(r.status).toBe(0);
    const rows = readPanelHistory(join(DIR, '.xm', 'panel'));
    expect(rows.length).toBeGreaterThanOrEqual(2); // one per model
    const models = new Set(rows.map(x => x.model));
    expect(models.has('claude')).toBe(true);
    expect(models.has('codex')).toBe(true);
    const statsOut = panelRaw(['stats', '--json']);
    const parsed = JSON.parse(statsOut.stdout);
    expect(parsed.models.length).toBeGreaterThanOrEqual(2);
  });
});

describe('panel gate — verdict evaluation (pure)', () => {
  test('mergePolicy overlays defaults per bucket', () => {
    expect(mergePolicy()).toEqual(DEFAULT_POLICY);
    const p = mergePolicy({ block_confirmed: ['critical'] });
    expect(p.block_confirmed).toEqual(['critical']);
    expect(p.block_unreviewed).toEqual(DEFAULT_POLICY.block_unreviewed); // untouched buckets keep defaults
  });
  test('confirmed high blocks; clean passes', () => {
    const policy = mergePolicy();
    expect(evaluateVerdict({ confirmed: [], contested: [], unreviewed: [] }, policy).decision).toBe('pass');
    const fail = evaluateVerdict({ confirmed: [{ severity: 'high', file: 'a', line: 1, claim: 'x' }], contested: [], unreviewed: [] }, policy);
    expect(fail.decision).toBe('fail');
    expect(fail.blocking[0].kind).toBe('confirmed');
  });
  test('allow_low keeps low findings non-blocking even when listed', () => {
    const policy = mergePolicy({ block_confirmed: ['critical', 'high', 'medium', 'low'] });
    expect(evaluateVerdict({ confirmed: [{ severity: 'low', file: 'a', line: 1, claim: 'nit' }], contested: [], unreviewed: [] }, policy).decision).toBe('pass');
  });
  test('a relaxed policy lets an otherwise-blocking high through', () => {
    const v = { confirmed: [{ severity: 'high', file: 'a', line: 1, claim: 'x' }], contested: [], unreviewed: [] };
    expect(evaluateVerdict(v, mergePolicy()).decision).toBe('fail');
    expect(evaluateVerdict(v, mergePolicy({ block_confirmed: ['critical'] })).decision).toBe('pass');
  });
});

describe('panel gate — CLI', () => {
  function seedRun(name, verdict) {
    const dir = join(DIR, '.xm', 'panel', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'verdict.json'), JSON.stringify(verdict));
    return dir;
  }

  test('blocking verdict → exit 1, writes gate-result.json', () => {
    const dir = seedRun('gate-fail', { confirmed: [{ severity: 'high', file: 'a.js', line: 9, claim: 'SQLi' }], contested: [], unreviewed: [], counts: { unique: 1 } });
    const r = panelRaw(['gate', 'gate-fail', '--json']);
    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBe('fail');
    expect(out.blocking_findings).toHaveLength(1);
    const saved = JSON.parse(readFileSync(join(dir, 'gate-result.json'), 'utf8'));
    expect(saved.exit_code).toBe(1);
  });

  test('clean verdict → exit 0', () => {
    seedRun('gate-pass', { confirmed: [{ severity: 'low', file: 'b.js', line: 2, claim: 'nit' }], contested: [], unreviewed: [], counts: { unique: 1 } });
    const r = panelRaw(['gate', 'gate-pass']);
    expect(r.status).toBe(0);
  });

  test('--policy override relaxes the gate', () => {
    seedRun('gate-relax', { confirmed: [{ severity: 'high', file: 'a', line: 1, claim: 'x' }], contested: [], unreviewed: [] });
    const r = panelRaw(['gate', 'gate-relax', '--policy', '{"block_confirmed":["critical"]}']);
    expect(r.status).toBe(0);
  });

  test('missing run → exit 2', () => {
    expect(panelRaw(['gate', 'no-such-run']).status).toBe(2);
  });

  test('invalid --policy JSON → exit 2', () => {
    seedRun('gate-badpolicy', { confirmed: [], contested: [], unreviewed: [] });
    expect(panelRaw(['gate', 'gate-badpolicy', '--policy', 'not json']).status).toBe(2);
  });

  test('F6: a malformed policy bucket is a controlled error (exit 2), not a TypeError crash', () => {
    seedRun('gate-badbucket', { confirmed: [{ severity: 'high', file: 'a', line: 1, claim: 'x' }], contested: [], unreviewed: [] });
    // string instead of array — used to reach blocksFor and die on `.map`
    const r = panelRaw(['gate', 'gate-badbucket', '--policy', '{"block_confirmed":"critical"}']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('must be an array of severities');
    expect(r.stderr).not.toContain('TypeError');
    // allow_low shape is validated too
    expect(panelRaw(['gate', 'gate-badbucket', '--policy', '{"allow_low":"yes"}']).status).toBe(2);
  });

  test('N3: an unknown severity in a policy bucket is rejected, not silently gate-disabling', () => {
    seedRun('gate-typo', { confirmed: [{ severity: 'critical', file: 'a', line: 1, claim: 'x' }], contested: [], unreviewed: [] });
    // "critcal" matches no finding → the gate would have silently PASSED a critical
    const r = panelRaw(['gate', 'gate-typo', '--policy', '{"block_confirmed":["critcal"]}']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown severity');
    // the correctly-spelled policy still blocks
    expect(panelRaw(['gate', 'gate-typo', '--policy', '{"block_confirmed":["critical"]}']).status).toBe(1);
  });
});

// ── unit: synth ──────────────────────────────────────────────────────

describe('shrinkDiff — inline-diff safety net (B)', () => {
  const fileSection = (path, bodyBytes) =>
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+${'x'.repeat(bodyBytes)}\n`;

  test('under budget returns text verbatim, reduced=false', () => {
    const diff = fileSection('src/a.ts', 100);
    const r = shrinkDiff(diff, 1024);
    expect(r.reduced).toBe(false);
    expect(r.text).toBe(diff);
  });

  test('splitDiffSections keys each file by its diff --git header', () => {
    const diff = fileSection('src/a.ts', 10) + fileSection('src/b.ts', 10);
    const secs = splitDiffSections(diff);
    expect(secs.map((s) => s.file)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  test('drops noise files (lockfiles/generated) first, with an explicit marker', () => {
    const code = fileSection('src/a.ts', 200);
    const lock = fileSection('package-lock.json', 5000);
    // Budget fits the code section but not code+lock: the lockfile must be the one dropped.
    const r = shrinkDiff(code + lock, Buffer.byteLength(code) + 400);
    expect(r.reduced).toBe(true);
    expect(r.droppedNoise).toContain('package-lock.json');
    expect(r.text).toContain('src/a.ts');
    expect(r.text).not.toContain('package-lock.json b/'); // its body is gone
    expect(r.text).toMatch(/diff reduced from \d+ bytes/);
  });

  test('omits overflow real files greedily and names them in the marker', () => {
    const a = fileSection('src/a.ts', 100);
    const b = fileSection('src/b.ts', 100);
    const c = fileSection('src/c.ts', 5000);
    const r = shrinkDiff(a + b + c, Buffer.byteLength(a + b) + 400);
    expect(r.reduced).toBe(true);
    expect(r.omitted).toContain('src/c.ts');
    expect(r.text).toContain('src/a.ts');
    expect(r.text).toContain('src/b.ts');
    expect(r.text).toContain('more changed file(s) omitted');
  });

  test('single huge file is hard-truncated with a marker (never silently)', () => {
    const huge = fileSection('src/big.ts', 10000); // one diff --git section → tail-truncation branch
    const r = shrinkDiff(huge, 2000);
    expect(r.reduced).toBe(true);
    expect(r.truncatedFile).toBe('src/big.ts');
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(2000); // strict: never exceeds the budget
    expect(r.text).toContain('target truncated');
  });

  test('greedy keeps whatever fits and omits the oversized file (order-independent)', () => {
    const big = fileSection('src/big.ts', 10000);   // alone exceeds budget → omitted
    const small = fileSection('src/small.ts', 100);  // fits → kept
    const r = shrinkDiff(big + small, 2000);
    expect(r.reduced).toBe(true);
    expect(r.text).toContain('src/small.ts');
    expect(r.omitted).toContain('src/big.ts');
  });

  test('when NO file fits whole, the first is hard-truncated so output is never empty', () => {
    const a = fileSection('src/a.ts', 10000);
    const b = fileSection('src/b.ts', 10000);
    const r = shrinkDiff(a + b, 2000); // neither fits → truncate first, omit rest
    expect(r.reduced).toBe(true);
    expect(r.text).toContain('src/a.ts');
    expect(r.text).toContain('truncated to fit budget');
    expect(r.omitted).toContain('src/b.ts');
  });

  test('non-diff literal text falls back to tail truncation', () => {
    const blob = 'y'.repeat(5000);
    const r = shrinkDiff(blob, 1000);
    expect(r.reduced).toBe(true);
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(1000); // strict
    expect(r.text).toContain('target truncated');
  });

  test('output never exceeds ARG_MAX-scale default budget', () => {
    // 40 files × ~30KB = ~1.2MB diff → must come back under the 512KiB default.
    const diff = Array.from({ length: 40 }, (_, i) => fileSection(`src/f${i}.ts`, 30000)).join('');
    const r = shrinkDiff(diff);
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(DIFF_INLINE_MAX_BYTES);
    expect(r.reduced).toBe(true);
  });

  test('long-path marker does NOT overflow the budget (marker-size reservation)', () => {
    // Many dropped-noise + omitted files with LONG paths make the trailing marker's file
    // lists run to 1-2KB — the fixed 300B reserve alone would overshoot. Assert the strict
    // ceiling with NO slop: capUtf8 + marker-aware reservation must hold the contract.
    const longNoise = Array.from({ length: 20 }, (_, i) =>
      fileSection(`packages/very/deeply/nested/module-${i}/dist/bundle-${i}.min.js`, 4000));
    const longReal = Array.from({ length: 20 }, (_, i) =>
      fileSection(`packages/very/deeply/nested/module-${i}/src/component-${i}.tsx`, 4000));
    const budget = 6000; // small enough that most files drop/omit → fat marker
    const r = shrinkDiff([...longNoise, ...longReal].join(''), budget);
    expect(r.reduced).toBe(true);
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(budget); // strict — the whole point
    expect(r.text).toMatch(/diff reduced from \d+ bytes/);
  });

  test('multibyte content is truncated on a codepoint boundary (no lone U+FFFD)', () => {
    const blob = '가'.repeat(5000); // 3 bytes each in UTF-8 → byte cut lands mid-codepoint
    const r = shrinkDiff(blob, 1000);
    expect(r.reduced).toBe(true);
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(1000);
    expect(r.text).not.toContain('�'); // no replacement char from a split sequence
  });
});

describe('normalizeFindings', () => {
  test('drops empty claims, defaults severity, keeps idx', () => {
    const out = normalizeFindings({ findings: [
      { severity: 'HIGH', file: 'a', line: 1, claim: 'x', evidence: 'e' },
      { claim: '' },
      { summary: 'fallback claim', severity: 'bogus' },
    ] });
    expect(out.length).toBe(2);
    expect(out[0].severity).toBe('high');
    expect(out[1].claim).toBe('fallback claim');
    expect(out[1].severity).toBe('low'); // bogus → low
    expect(out[0].idx).toBe(0);
  });
});

describe('normalizeVerdicts', () => {
  test('coerces stance + global ref, KEEPS empty refs; unknown stance → abstain (never concede)', () => {
    const out = normalizeVerdicts({ verdicts: [
      { ref: 'codex#0', stance: 'REFUTE', reason: 'r' },
      { ref: 'codex#1', stance: 'maybe' },
      { ref: '', stance: 'refute' },
    ] });
    // Empty refs are kept: they can never match a finding, so synthesize counts them as
    // unmatched_refs — dropping them here hid exactly that fidelity failure.
    expect(out.length).toBe(3);
    expect(out[0].ref).toBe('codex#0');
    expect(out[0].stance).toBe('refute');
    expect(out[0].invalid).toBeUndefined();
    expect(out[1].stance).toBe('abstain'); // unknown → abstain — a broken refuter must not vouch
    expect(out[1].invalid).toBe(true);     // …and the coercion is counted, not lost
    expect(out[2].ref).toBe('');
  });
  test('whitespace-padded stances are trimmed, not coerced to invalid abstain', () => {
    const out = normalizeVerdicts({ verdicts: [
      { ref: 'a#0', stance: ' concede ' },
      { ref: 'a#1', stance: 'REFUTE\n' },
    ] });
    expect(out[0].stance).toBe('concede');
    expect(out[0].invalid).toBeUndefined();
    expect(out[1].stance).toBe('refute');
    expect(out[1].invalid).toBeUndefined();
  });
  test('explicit abstain is recognized (not invalid); an EMPTY stance is invalid abstain', () => {
    const out = normalizeVerdicts({ verdicts: [
      { ref: 'a#0', stance: 'ABSTAIN' },
      { ref: 'a#1' },
    ] });
    expect(out[0].stance).toBe('abstain');
    expect(out[0].invalid).toBeUndefined();
    expect(out[1].stance).toBe('abstain'); // '' used to become a silent concede
    expect(out[1].invalid).toBe(true);
  });

  // 빅뱃3 grounded refutation: verified {checked, observed} passthrough + sanitation.
  test('grounded verdict keeps verified {checked, observed}; a claimed check with no observation is downgraded', () => {
    const out = normalizeVerdicts({ verdicts: [
      { ref: 'a#0', stance: 'refute', verified: { checked: true, observed: 'saw the endsWith is gone' } },
      { ref: 'a#1', stance: 'concede', verified: { checked: true, observed: '' } }, // claims checked but no proof
      { ref: 'a#2', stance: 'refute', verified: { checked: false, observed: 'file missing' } },
    ] });
    expect(out[0].verified).toEqual({ checked: true, observed: 'saw the endsWith is gone' });
    expect(out[1].verified).toEqual({ checked: false, observed: '' }); // no observation ⇒ not really checked
    expect(out[2].verified).toEqual({ checked: false, observed: 'file missing' });
  });
  test('a verdict with no/garbage verified carries no verified field (ungrounded default)', () => {
    const out = normalizeVerdicts({ verdicts: [
      { ref: 'a#0', stance: 'refute' },
      { ref: 'a#1', stance: 'refute', verified: 'nope' },
      { ref: 'a#2', stance: 'refute', verified: null },
    ] });
    for (const v of out) expect('verified' in v).toBe(false);
  });
});

describe('groundCapable (빅뱃3 — only file-readable vendors ground)', () => {
  test('codex is grounded-capable (repo cwd + --sandbox read-only); the rest are not', () => {
    expect(groundCapable('codex')).toBe(true);
    // claude is tmpdir-isolated; cursor/agy/kiro have unconfirmed read tools → text-only.
    for (const n of ['claude', 'cursor', 'agy', 'kiro', 'unknown']) expect(groundCapable(n)).toBe(false);
  });
});

describe('synthesize', () => {
  test('empty and self refs count as unmatched_refs (round-2 fidelity)', () => {
    const round1 = {
      claude: [{ idx: 0, severity: 'high', file: 'a', line: 1, claim: 'c0', evidence: '' }],
      codex: [{ idx: 0, severity: 'low', file: 'b', line: 2, claim: 'x0', evidence: '' }],
    };
    const round2 = {
      claude: normalizeVerdicts({ verdicts: [{ ref: '', stance: 'refute' }] }),       // empty ref — kept, matches nothing
      codex: normalizeVerdicts({ verdicts: [{ ref: 'codex#0', stance: 'refute' }] }), // its OWN finding — never asked to judge it
    };
    const v = synthesize(['claude', 'codex'], round1, round2);
    expect(v.by_model.claude.unmatched_refs).toBe(1);
    expect(v.by_model.codex.unmatched_refs).toBe(1);
    expect(v.counts.confirmed).toBe(0); // neither verdict addressed the OTHER model's finding
  });

  test('refuted finding → contested, others → confirmed', () => {
    const round1 = {
      claude: [{ idx: 0, severity: 'high', file: 'a', line: 1, claim: 'shared', evidence: '' }],
      codex: [{ idx: 0, severity: 'low', file: 'b', line: 2, claim: 'codex-only', evidence: '' }],
    };
    const round2 = {
      claude: [{ ref: 'codex#0', stance: 'concede', reason: '' }], // on codex's finding
      codex: [{ ref: 'claude#0', stance: 'refute', reason: 'nope' }], // on claude's finding
    };
    const v = synthesize(['claude', 'codex'], round1, round2);
    expect(v.counts.contested).toBe(1);
    expect(v.counts.confirmed).toBe(1);
    expect(v.contested[0].owner).toBe('claude');
    expect(v.confirmed[0].owner).toBe('codex');
  });

  // 빅뱃3: a grounded refuter's file-verified stance is tagged on the opponent + counted.
  test('grounded refutation tags the opponent (grounded/observed) and counts per model + run', () => {
    const round1 = {
      claude: [{ idx: 0, severity: 'high', file: 'a', line: 1, claim: 'shared', evidence: '' }],
      codex: [{ idx: 0, severity: 'low', file: 'b', line: 2, claim: 'codex-only', evidence: '' }],
    };
    const round2 = {
      // codex read the file and refuted claude#0; claude judged codex#0 text-only.
      codex: normalizeVerdicts({ verdicts: [{ ref: 'claude#0', stance: 'refute', reason: 'wrong', verified: { checked: true, observed: 'endsWith removed at line 1' } }] }),
      claude: normalizeVerdicts({ verdicts: [{ ref: 'codex#0', stance: 'concede', reason: 'ok' }] }),
    };
    const v = synthesize(['claude', 'codex'], round1, round2, new Set(), {}, new Set(['codex'])); // codex was sent the grounded prompt
    const contested = v.contested.find(f => f.owner === 'claude');
    const opp = contested.opponents.find(o => o.model === 'codex');
    expect(opp.grounded).toBe(true);
    expect(opp.observed).toBe('endsWith removed at line 1');
    expect(v.by_model.codex.grounded_verdicts).toBe(1);
    expect(v.by_model.claude.grounded_verdicts).toBe(0); // text-only refuter
    expect(v.counts.grounded_verdicts).toBe(1);
  });

  // t8: a `verified` field from a model that was NOT sent the grounded prompt is a forgery —
  // it must not tag the opponent or inflate grounded_verdicts.
  test('grounding provenance is gated on groundedModels — a self-reported verified is ignored', () => {
    const round1 = { claude: [{ idx: 0, severity: 'high', file: 'a', line: 1, claim: 'shared', evidence: '' }], codex: [] };
    // codex claims it verified, but it was NOT in groundedModels (never sent the grounded prompt).
    const round2 = { codex: normalizeVerdicts({ verdicts: [{ ref: 'claude#0', stance: 'refute', reason: 'r', verified: { checked: true, observed: 'forged' } }] }), claude: [] };
    const v = synthesize(['claude', 'codex'], round1, round2, new Set(), {}, new Set()); // nobody grounded
    expect(v.contested[0].opponents[0].grounded).toBeUndefined();
    expect(v.by_model.codex.grounded_verdicts).toBe(0);
    expect(v.counts.grounded_verdicts).toBe(0);
  });
  test('an ungrounded run leaves opponents untagged and grounded_verdicts at 0', () => {
    const round1 = { claude: [{ idx: 0, severity: 'high', file: 'a', line: 1, claim: 'x', evidence: '' }], codex: [] };
    const round2 = { codex: [{ ref: 'claude#0', stance: 'refute', reason: 'r' }], claude: [] };
    const v = synthesize(['claude', 'codex'], round1, round2);
    expect(v.contested[0].opponents[0].grounded).toBeUndefined();
    expect(v.counts.grounded_verdicts).toBe(0);
  });
});

describe('followup / debate round (빅뱃5) — normalizeResponses + followupDelta', () => {
  test('normalizeResponses coerces resolution; unknown → hold (never a silent concede), keeps ref', () => {
    const out = normalizeResponses({ responses: [
      { ref: 'claude#0', resolution: 'HOLD', reason: 'stands' },
      { ref: 'claude#1', resolution: 'maybe' },  // unknown → hold (must not drop a real finding)
      { ref: ' codex#2 ', resolution: ' concede ' },
    ] });
    expect(out[0]).toEqual({ ref: 'claude#0', resolution: 'hold', reason: 'stands' });
    expect(out[1].resolution).toBe('hold');
    expect(out[1].invalid).toBe(true);
    expect(out[2].ref).toBe('codex#2');       // trimmed
    expect(out[2].resolution).toBe('concede');
    expect(out[2].invalid).toBeUndefined();
  });

  test('followupDelta buckets each contested finding by its author\'s decision', () => {
    const contested = [
      { owner: 'claude', idx: 0, severity: 'high', file: 'a', line: 1, claim: 'held one' },
      { owner: 'claude', idx: 1, severity: 'medium', file: 'b', line: 2, claim: 'conceded one' },
      { owner: 'codex', idx: 0, severity: 'low', file: 'c', line: 3, claim: 'revised one' },
      { owner: 'codex', idx: 1, severity: 'high', file: 'd', line: 4, claim: 'no answer' },
    ];
    const responsesByModel = {
      claude: normalizeResponses({ responses: [
        { ref: 'claude#0', resolution: 'hold', reason: 'still true' },
        { ref: 'claude#1', resolution: 'concede', reason: 'fair' },
      ] }),
      codex: normalizeResponses({ responses: [
        { ref: 'codex#0', resolution: 'revise', reason: 'narrower' },
        // codex#1 intentionally unanswered → no_response
      ] }),
    };
    const d = followupDelta(contested, responsesByModel);
    expect(d.counts).toEqual({ held: 1, conceded: 1, revised: 1, no_response: 1 });
    expect(d.held[0].ref).toBe('claude#0');
    expect(d.conceded[0].ref).toBe('claude#1');
    expect(d.revised[0].ref).toBe('codex#0');
    expect(d.no_response[0].ref).toBe('codex#1');
  });

  test('a coerced-invalid resolution defaults to HELD, never silently resolving the finding', () => {
    const contested = [{ owner: 'claude', idx: 0, severity: 'high', file: 'a', line: 1, claim: 'x' }];
    const responsesByModel = { claude: normalizeResponses({ responses: [{ ref: 'claude#0', resolution: 'garbage' }] }) };
    const d = followupDelta(contested, responsesByModel);
    expect(d.counts.held).toBe(1);
    expect(d.counts.conceded).toBe(0);
  });
});

describe('mergeConsensus', () => {
  test('merges same file+line across models, keeps highest severity, counts consensus', () => {
    const m = mergeConsensus([
      { owner: 'claude', severity: 'critical', file: 'a.js', line: 7, claim: 'cred en' },
      { owner: 'codex', severity: 'high', file: 'a.js', line: 7, claim: '비밀번호' },
      { owner: 'agy', severity: 'critical', file: 'a.js', line: 8, claim: 'password' }, // line 8, tol 2 → same cluster
      { owner: 'claude', severity: 'low', file: 'b.js', line: 20, claim: 'perf' },
    ]);
    expect(m.length).toBe(2);
    const cred = m[0]; // highest consensus first
    expect(cred.file).toBe('a.js');
    expect(cred.consensus).toBe(3);
    expect(cred.severity).toBe('critical'); // highest of {critical,high,critical}
    expect(cred.models.sort()).toEqual(['agy', 'claude', 'codex']);
    expect(cred.claims.length).toBe(3); // cross-language claims preserved
    expect(m[1].consensus).toBe(1); // b.js single-model
  });

  test('findings beyond line tolerance stay separate', () => {
    const m = mergeConsensus([
      { owner: 'a', severity: 'low', file: 'x.js', line: 1, claim: 'p' },
      { owner: 'b', severity: 'low', file: 'x.js', line: 10, claim: 'q' },
    ]);
    expect(m.length).toBe(2);
  });

  test('does NOT merge findings with null line (no false consensus)', () => {
    const m = mergeConsensus([
      { owner: 'a', severity: 'high', file: 'x.js', line: null, claim: 'issue one' },
      { owner: 'b', severity: 'high', file: 'x.js', line: null, claim: 'issue two' },
    ]);
    expect(m.length).toBe(2);
    expect(m.every(c => c.consensus === 1)).toBe(true);
  });
});

describe('synthesize abstain', () => {
  test('all opponents abstained → unreviewed, not confirmed', () => {
    const round1 = { claude: [{ idx: 0, severity: 'high', file: 'a', line: 1, claim: 'x' }], codex: [] };
    const round2 = { claude: [], codex: [] };
    const v = synthesize(['claude', 'codex'], round1, round2, new Set(['codex']));
    expect(v.counts.unreviewed).toBe(1);
    expect(v.counts.confirmed).toBe(0);
  });
});

describe('synthesize round-2 fidelity (no silent concede)', () => {
  const f = (idx, claim) => ({ idx, severity: 'high', file: 'a.js', line: 1, claim, evidence: '' });

  test('mangled refs count as unmatched_refs; the unaddressed finding is UNREVIEWED, not confirmed', () => {
    const round1 = { claude: [f(0, 'real issue')], codex: [] };
    const round2 = { claude: [], codex: [
      { ref: 'claude#99', stance: 'concede', reason: '' }, // hallucinated index
      { ref: 'bogus#0', stance: 'refute', reason: '' },    // unknown owner
    ] };
    const v = synthesize(['claude', 'codex'], round1, round2);
    expect(v.by_model.codex.unmatched_refs).toBe(2);
    expect(v.by_model.claude.unmatched_refs).toBe(0);
    expect(v.counts.confirmed).toBe(0);   // verdicts that addressed nothing must not vouch
    expect(v.counts.unreviewed).toBe(1);
    expect(v.unreviewed[0].claim).toBe('real issue');
  });

  test('coerced abstain addresses a finding without vouching → unreviewed + invalid_stances counted', () => {
    const round1 = { claude: [f(0, 'x')], codex: [] };
    const round2 = { claude: [], codex: normalizeVerdicts({ verdicts: [{ ref: 'claude#0', stance: 'not-sure' }] }) };
    const v = synthesize(['claude', 'codex'], round1, round2);
    expect(v.by_model.codex.invalid_stances).toBe(1);
    expect(v.by_model.codex.unmatched_refs).toBe(0); // the ref itself was fine
    expect(v.counts.confirmed).toBe(0);
    expect(v.counts.unreviewed).toBe(1);
    expect(v.unreviewed[0].opponents[0].stance).toBe('abstain');
  });

  test('an explicit concede still confirms; clean refuters carry zero fidelity counters', () => {
    const round1 = { claude: [f(0, 'x')], codex: [] };
    const round2 = { claude: [], codex: [{ ref: 'claude#0', stance: 'concede', reason: 'real' }] };
    const v = synthesize(['claude', 'codex'], round1, round2);
    expect(v.counts.confirmed).toBe(1);
    expect(v.by_model.codex.unmatched_refs).toBe(0);
    expect(v.by_model.codex.invalid_stances).toBe(0);
  });
});

describe('synthesize r1Status (mem-mesh ed2ff3e3)', () => {
  test('round-1 failure is visible in by_model and counts, not silent raised:0', () => {
    const round1 = { claude: [{ idx: 0, severity: 'high', file: 'a', line: 1, claim: 'x' }], agy: [] };
    const round2 = { claude: [], agy: [] };
    const v = synthesize(['claude', 'agy'], round1, round2, new Set(),
      { agy: { status: 'failed', error: 'no findings JSON in output' } });
    expect(v.by_model.agy.r1).toBe('failed');
    expect(v.by_model.agy.r1_error).toContain('no findings');
    expect(v.by_model.claude.r1).toBe('ok');
    expect(v.by_model.claude.r1_error).toBeUndefined();
    expect(v.counts.r1_failed).toBe(1);
    expect(v.counts.r1_suspect).toBe(0);
  });
  test('suspect_empty (ok=true, findings=[], prose in raw) is flagged distinctly', () => {
    const v = synthesize(['claude', 'agy'], { claude: [], agy: [] }, { claude: [], agy: [] }, new Set(),
      { agy: { status: 'suspect_empty' } });
    expect(v.by_model.agy.r1).toBe('suspect_empty');
    expect(v.counts.r1_suspect).toBe(1);
    expect(v.counts.r1_failed).toBe(0);
  });
  test('default (no r1Status) marks every model ok — legacy callers unchanged', () => {
    const v = synthesize(['claude', 'codex'], { claude: [], codex: [] }, { claude: [], codex: [] });
    expect(v.by_model.claude.r1).toBe('ok');
    expect(v.counts.r1_failed).toBe(0);
  });
});

describe('extractJSON', () => {
  test('pulls a JSON object out of surrounding noise', () => {
    const obj = extractJSON('blah {"findings":[{"claim":"x"}]} trailing');
    expect(obj.findings[0].claim).toBe('x');
  });
  test('handles braces inside strings', () => {
    const obj = extractJSON('{"reason":"use {curly}"}');
    expect(obj.reason).toBe('use {curly}');
  });
  test('returns null when no JSON', () => {
    expect(extractJSON('no json here')).toBeNull();
  });

  test('provider invocation fails when stdout has no JSON object', () => {
    const prevCmd = process.env.X_PANEL_CMD_NOJSON;
    const prevNoJson = process.env.X_PANEL_NO_JSON_NOJSON;
    process.env.X_PANEL_CMD_NOJSON = STUB;
    process.env.X_PANEL_NO_JSON_NOJSON = '1';
    try {
      const res = invokeProvider('nojson', 'target');
      expect(res.ok).toBe(false);
      expect(res.error).toContain('no JSON');
      expect(res.raw).toContain('plain text');
    } finally {
      if (prevCmd === undefined) delete process.env.X_PANEL_CMD_NOJSON;
      else process.env.X_PANEL_CMD_NOJSON = prevCmd;
      if (prevNoJson === undefined) delete process.env.X_PANEL_NO_JSON_NOJSON;
      else process.env.X_PANEL_NO_JSON_NOJSON = prevNoJson;
    }
  });

  test('ANSI-colorized JSON (kiro shape) is stripped before extraction, findings recovered', () => {
    const prevCmd = process.env.X_PANEL_CMD_ANSI, prevAnsi = process.env.X_PANEL_ANSI_ANSI;
    process.env.X_PANEL_CMD_ANSI = STUB;
    process.env.X_PANEL_ANSI_ANSI = '1';
    try {
      const res = invokeProvider('ansi', 'target', { expectKeys: ['findings'] });
      expect(res.ok).toBe(true);                       // was false: ANSI codes derailed scanJSONObjects
      expect(res.json.findings[0].claim).toBe('ansi-wrapped finding');
    } finally {
      if (prevCmd === undefined) delete process.env.X_PANEL_CMD_ANSI; else process.env.X_PANEL_CMD_ANSI = prevCmd;
      if (prevAnsi === undefined) delete process.env.X_PANEL_ANSI_ANSI; else process.env.X_PANEL_ANSI_ANSI = prevAnsi;
    }
  });
});

describe('stripAnsi', () => {
  test('removes SGR/CSI escapes, preserves the JSON content between them', () => {
    expect(stripAnsi('\x1b[38;5;141m> \x1b[0m{"findings":[]}\x1b[0m')).toBe('> {"findings":[]}');
    expect(stripAnsi('plain text')).toBe('plain text'); // no-op on clean input
    expect(stripAnsi(null)).toBe('');
  });
});

describe('scanJSONObjects', () => {
  test('finds every parseable object, skipping prose braces', () => {
    const text = 'use the {curly} placeholder, then {"a":1} and later {"b":[2]}';
    const objs = scanJSONObjects(text).map(c => c.obj);
    expect(objs).toEqual([{ a: 1 }, { b: [2] }]);
  });
  test('finds a balanced inner object inside an unclosed outer brace', () => {
    const objs = scanJSONObjects('{ broken and never closes... {"findings":[]}').map(c => c.obj);
    expect(objs).toEqual([{ findings: [] }]);
  });
  test('spans cover the exact JSON substring', () => {
    const text = 'pre {"x":1} post';
    const [c] = scanJSONObjects(text);
    expect(text.slice(c.start, c.end)).toBe('{"x":1}');
  });
});

describe('extractContractJSON (mem-mesh ed2ff3e3)', () => {
  test('prompt-echo {"findings":[]} before the real answer does NOT win', () => {
    const text = 'If there are no real issues, return {"findings":[]}. My answer: {"findings":[{"claim":"x"}]}';
    expect(extractContractJSON(text, ['findings']).findings.length).toBe(1);
  });
  test('real answer before a trailing contract echo still wins', () => {
    const text = '{"findings":[{"claim":"x"},{"claim":"y"}]} (as instructed, empty would be {"findings":[]})';
    expect(extractContractJSON(text, ['findings']).findings.length).toBe(2);
  });
  test('prose brace before the answer does not abort extraction (extractJSON regression)', () => {
    const text = 'the {placeholder} syntax… {"findings":[{"claim":"z"}]}';
    expect(extractJSON(text)).toBeNull(); // old behavior: first candidate fails → null
    expect(extractContractJSON(text, ['findings']).findings[0].claim).toBe('z');
  });
  test('JSON without any contract key is a MISS, not a success', () => {
    expect(extractContractJSON('{"reason":"hi"}', ['findings', 'verdicts'])).toBeNull();
  });
  test('genuine empty findings answer is accepted', () => {
    expect(extractContractJSON('{"findings":[]}', ['findings'])).toEqual({ findings: [] });
  });
  test('selects by the requested key (verdicts round ignores findings echoes)', () => {
    const text = '{"findings":[{"claim":"echo"}]} {"verdicts":[{"ref":"a#0","stance":"refute"}]}';
    expect(extractContractJSON(text, ['verdicts']).verdicts[0].ref).toBe('a#0');
  });
});

describe('proseOutsideJSON', () => {
  test('compliant output (fenced JSON only) leaves ~nothing', () => {
    expect(proseOutsideJSON('```json\n{"findings":[]}\n```').length).toBe(0);
  });
  test('a prose review around an empty contract echo is preserved', () => {
    const prose = 'I reviewed the diff. 1) The retry loop never persists. 2) The mtime check races. ';
    const out = proseOutsideJSON(prose + '{"findings":[]}');
    expect(out).toContain('retry loop');
    expect(out.length).toBeGreaterThan(50);
  });
});

describe('parseMarkdownFindings (agy/Gemini prose-review fallback)', () => {
  test('recovers findings from the "### [severity] file:line — title" + Why/Fix lens shape', () => {
    const md = `Here is my review.

### [Medium] src/api/monitors.rs:351 — Webhook target lacks SSRF validation
→ **Why**: put_webhook_settings accepts any url incl. 127.0.0.1.
→ **Fix**: reject private IP ranges after resolving the host.

### [Low] src/api/events.rs:422 — SSE endpoint leaks the session token in the URL
→ **Why**: the access_token rides in the query string, kept in history.
→ **Fix**: use a short-lived one-time ticket.`;
    const out = parseMarkdownFindings(md);
    expect(out.findings.length).toBe(2);
    expect(out.findings[0]).toMatchObject({ severity: 'medium', file: 'src/api/monitors.rs', line: 351 });
    expect(out.findings[0].claim).toContain('SSRF');
    expect(out.findings[0].evidence).toContain('127.0.0.1');
    expect(out.findings[1]).toMatchObject({ severity: 'low', file: 'src/api/events.rs', line: 422 });
  });

  test('handles bold-bullet headings and a heading with no file:line', () => {
    const md = `- **[High]** src/auth/admin.rs:34 — password re-hashed every boot
→ **Why**: save_hash runs on each startup.

#### [critical] Missing auth on the internal metrics route
The /internal/metrics route has no auth middleware.`;
    const out = parseMarkdownFindings(md);
    expect(out.findings.length).toBe(2);
    expect(out.findings[0]).toMatchObject({ severity: 'high', file: 'src/auth/admin.rs', line: 34 });
    expect(out.findings[1].severity).toBe('critical');
    expect(out.findings[1].file).toBeNull();       // no file:line on the heading
    expect(out.findings[1].line).toBeNull();
    expect(out.findings[1].claim).toContain('metrics');
  });

  test('ordinary prose with no severity tag yields null (never false-parses a non-answer)', () => {
    expect(parseMarkdownFindings('I reviewed the change and it looks solid; nothing to flag here.')).toBeNull();
    expect(parseMarkdownFindings('')).toBeNull();
    expect(parseMarkdownFindings('The word [high] appears mid-sentence but is not a heading.')).toBeNull();
  });

  test('a file:line wrapped in backticks or bold is still parsed (t9)', () => {
    const md = '### [medium] `src/x.js:42` — backtick-wrapped location\n### [low] **src/y.js:7** — bold-wrapped location';
    const out = parseMarkdownFindings(md);
    expect(out.findings[0]).toMatchObject({ severity: 'medium', file: 'src/x.js', line: 42 });
    expect(out.findings[0].claim).toContain('backtick-wrapped');
    expect(out.findings[1]).toMatchObject({ severity: 'low', file: 'src/y.js', line: 7 });
    expect(out.findings[1].claim).toContain('bold-wrapped');
  });

  test('end-to-end: a vendor that returns markdown (no JSON) has its findings recovered, r1=ok', () => {
    // claude emits a structured markdown review instead of the JSON contract (the agy shape).
    const r = review(['md target'], { X_PANEL_MD_FINDINGS_CLAUDE: '1' });
    expect(r.status).toBe(0);
    const v = latestVerdict();
    // Recovered from prose → counted as real findings, NOT dropped as "no findings JSON".
    expect(v.by_model.claude.raised).toBe(2);
    expect(v.by_model.claude.r1).toBe('ok');   // not 'failed', not 'suspect_empty'
    expect(r.stdout).not.toContain('claude: round 1 FAILED');
  });
});

describe('Kiro adapter', () => {
  test('normalizes Anthropic-style Claude IDs to Kiro model IDs', () => {
    expect(normalizeKiroModel('claude-opus-4-8')).toBe('claude-opus-4.8');
    expect(normalizeKiroModel('claude-sonnet-4-6')).toBe('claude-sonnet-4.6');
    expect(normalizeKiroModel('auto')).toBe('auto');
  });
});

describe('Kiro no-MCP agent provisioning (Bedrock oneOf/allOf/anyOf workaround)', () => {
  let AGDIR;
  const savedDir = process.env.X_PANEL_KIRO_AGENT_DIR;
  const savedAgent = process.env.X_PANEL_KIRO_AGENT;
  beforeAll(() => { AGDIR = mkdtempSync(join(tmpdir(), 'kiro-ag-')); process.env.X_PANEL_KIRO_AGENT_DIR = AGDIR; });
  afterAll(() => {
    rmSync(AGDIR, { recursive: true, force: true });
    if (savedDir === undefined) delete process.env.X_PANEL_KIRO_AGENT_DIR; else process.env.X_PANEL_KIRO_AGENT_DIR = savedDir;
    if (savedAgent === undefined) delete process.env.X_PANEL_KIRO_AGENT; else process.env.X_PANEL_KIRO_AGENT = savedAgent;
  });
  afterEach(() => { delete process.env.X_PANEL_KIRO_AGENT; });

  test('a real spawn provisions a no-MCP agent and passes --agent xm-panel-review', () => {
    const [bin, args] = resolveCommand('kiro', 'review this diff', null);
    expect(bin).toBe('kiro-cli');
    const i = args.indexOf('--agent');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('xm-panel-review');
    expect(args).toContain('--trust-tools='); // still trusts no tools
    // the provisioned agent must NOT pull in the global mcp.json
    const agent = JSON.parse(readFileSync(join(AGDIR, 'xm-panel-review.json'), 'utf8'));
    expect(agent.includeMcpJson).toBe(false);
    expect(agent.mcpServers).toEqual({});
    expect(agent.tools).toEqual([]);
  });

  test('an availability check (empty prompt) does NOT provision or add --agent', () => {
    const AGDIR2 = mkdtempSync(join(tmpdir(), 'kiro-ag2-'));
    process.env.X_PANEL_KIRO_AGENT_DIR = AGDIR2;
    const [, args] = resolveCommand('kiro', '', null);
    expect(args).not.toContain('--agent');
    expect(existsSync(join(AGDIR2, 'xm-panel-review.json'))).toBe(false); // no file written on a mere probe
    process.env.X_PANEL_KIRO_AGENT_DIR = AGDIR;
    rmSync(AGDIR2, { recursive: true, force: true });
  });

  test('panel.kiro_agent override (X_PANEL_KIRO_AGENT) is used verbatim, no provisioning', () => {
    const AGDIR3 = mkdtempSync(join(tmpdir(), 'kiro-ag3-'));
    process.env.X_PANEL_KIRO_AGENT_DIR = AGDIR3;
    process.env.X_PANEL_KIRO_AGENT = 'my-clean-agent';
    const [, args] = resolveCommand('kiro', 'review', null);
    const i = args.indexOf('--agent');
    expect(args[i + 1]).toBe('my-clean-agent');
    expect(existsSync(join(AGDIR3, 'xm-panel-review.json'))).toBe(false); // user's agent → we don't write ours
    process.env.X_PANEL_KIRO_AGENT_DIR = AGDIR;
    rmSync(AGDIR3, { recursive: true, force: true });
  });

  test('provisioning is idempotent — a second spawn reuses the file, no throw', () => {
    resolveCommand('kiro', 'first', null);
    const [, args] = resolveCommand('kiro', 'second', 'claude-opus-4-8');
    expect(args).toContain('--agent');
    expect(args).toContain('--model');
    expect(args).toContain('claude-opus-4.8'); // model still normalized + threaded
  });

  test('an existing agent that loads MCP is rewritten to no-MCP, not trusted (l5)', () => {
    const AGDIR4 = mkdtempSync(join(tmpdir(), 'kiro-ag4-'));
    process.env.X_PANEL_KIRO_AGENT_DIR = AGDIR4;
    const f = join(AGDIR4, 'xm-panel-review.json');
    // a stale/tampered agent that WOULD reintroduce the Bedrock 400
    writeFileSync(f, JSON.stringify({ name: 'xm-panel-review', includeMcpJson: true, mcpServers: { 'mem-mesh': {} } }));
    const [, args] = resolveCommand('kiro', 'review', null);
    expect(args).toContain('xm-panel-review');
    const rewritten = JSON.parse(readFileSync(f, 'utf8'));
    expect(rewritten.includeMcpJson).toBe(false);   // no longer pulls in global mcp.json
    expect(rewritten.mcpServers).toEqual({});
    process.env.X_PANEL_KIRO_AGENT_DIR = AGDIR;
    rmSync(AGDIR4, { recursive: true, force: true });
  });

  test('an existing no-MCP agent is preserved (custom description survives, not clobbered)', () => {
    const AGDIR5 = mkdtempSync(join(tmpdir(), 'kiro-ag5-'));
    process.env.X_PANEL_KIRO_AGENT_DIR = AGDIR5;
    const f = join(AGDIR5, 'xm-panel-review.json');
    writeFileSync(f, JSON.stringify({ name: 'xm-panel-review', includeMcpJson: false, mcpServers: {}, description: 'my custom safe agent' }));
    resolveCommand('kiro', 'review', null);
    expect(JSON.parse(readFileSync(f, 'utf8')).description).toBe('my custom safe agent'); // untouched
    process.env.X_PANEL_KIRO_AGENT_DIR = AGDIR;
    rmSync(AGDIR5, { recursive: true, force: true });
  });
});

describe('structured streaming (adapters)', () => {
  test('streamCommand passes each provider its real streaming flags', () => {
    const claude = streamCommand('claude', 'p', 'm');
    expect(claude[0]).toBe('claude');
    expect(claude[1]).toContain('stream-json');
    expect(claude[1]).toContain('--verbose');

    const cursor = streamCommand('cursor', 'p');
    expect(cursor[0]).toBe('cursor-agent');
    expect(cursor[1]).toContain('-f');           // bypasses workspace-trust
    expect(cursor[1]).toContain('stream-json');

    const codex = streamCommand('codex', 'p');
    expect(codex[0]).toBe('codex');
    expect(codex[1]).toContain('--json');
    expect(codex[1].join(' ')).toContain('--sandbox read-only'); // edit-safe
    expect(codex[1]).toContain('--skip-git-repo-check');

    expect(streamCommand('kiro')).toBeNull(); // no structured streaming
  });

  test('raw codex command is also --sandbox read-only (cross/review path, matches streaming)', () => {
    const codex = resolveCommand('codex', 'p', null);
    expect(codex[0]).toBe('codex');
    expect(codex[1].join(' ')).toContain('--sandbox read-only'); // invokeProviderText path can't edit the repo
    expect(codex[1]).toContain('--skip-git-repo-check');
  });

  test('agy file handoff (A): --add-dir + skip-permissions only when addDir is set', () => {
    // Default inline path — no addDir → plain -p, model precedes -p (agy consumes the next token).
    const inline = resolveCommand('agy', 'review this', 'gemini-3-pro');
    expect(inline[0]).toBe('agy');
    expect(inline[1]).toEqual(['--model', 'gemini-3-pro', '-p', 'review this']);
    expect(inline[1]).not.toContain('--add-dir');

    // Handoff path — addDir set → grants scoped read access to the diff file. It must NOT
    // pass --dangerously-skip-permissions (that disables every gate; --add-dir alone suffices,
    // verified live) — a security regression guard.
    const handoff = resolveCommand('agy', 'read /run/target.patch', 'gemini-3-pro', { addDir: '/run/dir' });
    expect(handoff[1]).not.toContain('--dangerously-skip-permissions');
    const di = handoff[1].indexOf('--add-dir');
    expect(di).toBeGreaterThanOrEqual(0);
    expect(handoff[1][di + 1]).toBe('/run/dir');
    // --model must still precede -p so agy doesn't eat "--model" as the prompt.
    expect(handoff[1].indexOf('--model')).toBeLessThan(handoff[1].indexOf('-p'));
    expect(handoff[1][handoff[1].length - 1]).toBe('read /run/target.patch');
  });

  test('providerArgs is ignored by providers that do not read it (claude/codex)', () => {
    const claude = resolveCommand('claude', 'p', null, { addDir: '/x' });
    expect(claude[1]).not.toContain('--add-dir');
    const codex = resolveCommand('codex', 'p', null, { addDir: '/x' });
    expect(codex[1]).not.toContain('--add-dir');
  });

  test('supportsStream: structured providers yes, kiro/agy no', () => {
    expect(supportsStream('claude')).toBe(true);
    expect(supportsStream('codex')).toBe(true);
    expect(supportsStream('cursor')).toBe(true);
    expect(supportsStream('kiro')).toBe(false);
    expect(supportsStream('agy')).toBe(false);
  });

  test('parseStreamLine: claude result carries final text + USD + tokens', () => {
    const r = parseStreamLine('claude', { type: 'result', result: '{"findings":[]}', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 10 }, total_cost_usd: 0.5 }, 'claude-opus-4-8');
    expect(r.finalText).toBe('{"findings":[]}');
    expect(r.usage.cost_usd).toBe(0.5);            // claude's own USD used directly
    expect(r.usage.output).toBe(20);
  });

  test('parseStreamLine: codex agent_message is the final text; turn.completed has usage', () => {
    const a = parseStreamLine('codex', { type: 'item.completed', item: { type: 'agent_message', text: '{"findings":[]}' } }, 'gpt-x');
    expect(a.finalText).toBe('{"findings":[]}');
    const u = parseStreamLine('codex', { type: 'turn.completed', usage: { input_tokens: 200, output_tokens: 30, cached_input_tokens: 50, reasoning_output_tokens: 15 } }, 'gpt-x');
    expect(u.usage.reasoning).toBe(15);
    expect(u.usage.cost_usd).toBeGreaterThan(0);   // tokens → USD via inline table
  });

  test('parseStreamLine: cursor result tokens map; thinking emits a phase event', () => {
    const t = parseStreamLine('cursor', { type: 'thinking' }, 'm');
    expect(t.events.some((e) => e.kind === 'thinking')).toBe(true);
    const r = parseStreamLine('cursor', { type: 'result', result: 'x', usage: { inputTokens: 150, outputTokens: 25, cacheReadTokens: 20 } }, 'm');
    expect(r.usage.input).toBe(150);
  });

  test('costFromTokens charges cached tokens at the cheaper rate', () => {
    const full = costFromTokens('default', { input: 1_000_000, output: 0, cached: 0 });
    const cachedHeavy = costFromTokens('default', { input: 1_000_000, output: 0, cached: 1_000_000 });
    expect(cachedHeavy).toBeLessThan(full);
  });

  test('token-level partial flags are passed (claude/cursor)', () => {
    expect(streamCommand('claude')[1]).toContain('--include-partial-messages');
    expect(streamCommand('cursor')[1]).toContain('--stream-partial-output');
  });

  test('partial=false omits the partial flags (structured stream, final-block body)', () => {
    expect(streamCommand('claude', 'p', null, false)[1]).not.toContain('--include-partial-messages');
    expect(streamCommand('cursor', 'p', null, false)[1]).not.toContain('--stream-partial-output');
    // still a valid stream-json command (usage + final text intact)
    expect(streamCommand('claude', 'p', null, false)[1]).toContain('stream-json');
  });

  test('parseStreamLine: claude content_block_delta yields incremental text/thinking', () => {
    const t = parseStreamLine('claude', { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hel' } } }, 'm');
    expect(t.events).toEqual([{ kind: 'text', delta: 'hel' }]);
    const th = parseStreamLine('claude', { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } }, 'm');
    expect(th.events[0].kind).toBe('thinking');
    // signature_delta must be ignored (no event)
    const sig = parseStreamLine('claude', { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'x' } } }, 'm');
    expect(sig.events).toEqual([]);
  });

  test('parseStreamLine: cursor delta text comes from message.content[]; user echo emits nothing', () => {
    const d = parseStreamLine('cursor', { type: 'assistant', message: { content: [{ type: 'text', text: '봄' }] } }, 'm');
    expect(d.events).toEqual([{ kind: 'text', delta: '봄' }]);
    const echo = parseStreamLine('cursor', { type: 'user', message: { content: [{ type: 'text', text: 'PROMPT' }] } }, 'm');
    expect(echo.events).toEqual([]); // user echo must not leak into the response tail
  });
});

describe('codex reasoning-effort spec (model[:effort])', () => {
  // Capture stderr around a builder call so FM2 warnings can be asserted without
  // leaking into the test runner's own output.
  const captureStderr = (fn) => {
    const orig = process.stderr.write;
    const out = [];
    process.stderr.write = (s) => { out.push(String(s)); return true; };
    try { return { value: fn(), stderr: out.join('') }; }
    finally { process.stderr.write = orig; }
  };

  test('raw builder: "gpt-5.5:high" → --model gpt-5.5 + -c model_reasoning_effort=high', () => {
    const [bin, args] = resolveCommand('codex', 'the prompt', 'gpt-5.5:high');
    expect(bin).toBe('codex');
    const mi = args.indexOf('--model');
    // exact contiguous fragment, in the order the CLI expects
    expect(args.slice(mi, mi + 4)).toEqual(['--model', 'gpt-5.5', '-c', 'model_reasoning_effort=high']);
    expect(args).not.toContain('gpt-5.5:high');   // effort must not leak into the model id
    expect(args[args.length - 1]).toBe('the prompt'); // prompt stays the trailing positional
  });

  test('stream builder: "gpt-5.5:high" gets the same --model + -c fragment (plus --json)', () => {
    const [, args] = streamCommand('codex', 'p', 'gpt-5.5:high');
    const mi = args.indexOf('--model');
    expect(args.slice(mi, mi + 4)).toEqual(['--model', 'gpt-5.5', '-c', 'model_reasoning_effort=high']);
    expect(args).toContain('--json'); // streaming profile intact
  });

  test('each valid effort level maps through', () => {
    for (const lvl of ['minimal', 'low', 'medium', 'high', 'xhigh']) {
      const [, args] = resolveCommand('codex', 'p', `gpt-5.5:${lvl}`);
      expect(args.join(' ')).toContain(`-c model_reasoning_effort=${lvl}`);
    }
  });

  test('FM2: typo effort ("hgh") → effort dropped, model kept, warning on stderr', () => {
    const { value, stderr } = captureStderr(() => resolveCommand('codex', 'p', 'gpt-5.5:hgh'));
    const args = value[1];
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-5.5'); // model still used
    expect(args).not.toContain('-c');                          // bad effort dropped, not passed on
    expect(args.join(' ')).not.toContain('model_reasoning_effort');
    expect(stderr).toContain('unknown reasoning effort');      // signal surfaced, not swallowed
    expect(stderr).toContain('hgh');
  });

  test('multiple colons: only the LAST segment is the effort candidate ("a:b:c")', () => {
    const { value, stderr } = captureStderr(() => resolveCommand('codex', 'p', 'a:b:c'));
    const args = value[1];
    expect(args[args.indexOf('--model') + 1]).toBe('a:b'); // model = everything up to the last colon
    expect(args).not.toContain('-c');                      // "c" is not a valid effort → dropped
    expect(stderr).toContain('unknown reasoning effort "c"');
  });

  test('multiple colons with a valid final effort applies it ("org/model:v2:high")', () => {
    const [, args] = resolveCommand('codex', 'p', 'org/model:v2:high');
    expect(args[args.indexOf('--model') + 1]).toBe('org/model:v2');
    expect(args.join(' ')).toContain('-c model_reasoning_effort=high');
  });

  test('empty / null / non-string model is safe: default model, no effort, NO warning', () => {
    // resolveCommand coerces '' → null; the stream builder receives '' verbatim — both must be silent.
    const { value, stderr } = captureStderr(() => [
      resolveCommand('codex', 'p', '')[1],
      resolveCommand('codex', 'p', null)[1],
      streamCommand('codex', 'p', '')[1],
    ]);
    for (const args of value) {
      expect(args).not.toContain('--model');
      expect(args).not.toContain('-c');
      expect(args[args.length - 1]).toBe('p');
    }
    expect(stderr).toBe(''); // legitimate "use CLI default" is NOT a warning
  });
});

describe('buildCodexResumeArgs (exec flags precede the resume subcommand)', () => {
  test('exec-level flags come BEFORE resume; session id + prompt follow', () => {
    const [bin, args] = buildCodexResumeArgs({
      execFlags: ['--sandbox', 'read-only', '--json', '--skip-git-repo-check'],
      sessionId: 'sess-123', prompt: 'continue please',
    });
    expect(bin).toBe('codex');
    expect(args[0]).toBe('exec');
    const ri = args.indexOf('resume');
    expect(ri).toBeGreaterThan(0);
    // the pinned invariant: every exec-level flag must sit before `resume`
    // (codex rejects `resume … --sandbox` with a usage error).
    for (const f of ['--sandbox', '--json', '--skip-git-repo-check']) {
      expect(args.indexOf(f)).toBeGreaterThan(-1);
      expect(args.indexOf(f)).toBeLessThan(ri);
    }
    expect(args[ri + 1]).toBe('sess-123');            // session id immediately follows resume
    expect(args[args.length - 1]).toBe('continue please'); // prompt is the trailing positional
  });

  test('omitted sessionId defaults to --last (matches the Codex Overlay contract)', () => {
    const [, args] = buildCodexResumeArgs({ execFlags: ['--json'], prompt: 'go on' });
    const ri = args.indexOf('resume');
    expect(args[ri + 1]).toBe('--last');       // prompt must NOT be parsed as SESSION_ID
    expect(args[args.length - 1]).toBe('go on');
  });

  test('model:effort is applied and also precedes resume', () => {
    const [, args] = buildCodexResumeArgs({
      execFlags: ['--json'], sessionId: 's1', model: 'gpt-5.5:high', prompt: 'go',
    });
    const ri = args.indexOf('resume');
    const mi = args.indexOf('--model');
    expect(mi).toBeGreaterThan(-1);
    expect(mi).toBeLessThan(ri);                         // --model before resume
    expect(args.slice(mi, mi + 4)).toEqual(['--model', 'gpt-5.5', '-c', 'model_reasoning_effort=high']);
    expect(args.indexOf('-c')).toBeLessThan(ri);         // -c before resume too
  });

  test('defaults are safe: session id only → a valid, minimal resume argv', () => {
    const [bin, args] = buildCodexResumeArgs({ sessionId: 'only-session' });
    expect(bin).toBe('codex');
    expect(args).toEqual(['exec', 'resume', 'only-session']); // no stray flags/prompt
  });
});

describe('cross-vendor engine wiring (prompt injection + detect + namespace)', () => {
  const DEFAULT_R1 = `You are a code reviewer. Review the following change and report only real, evidence-backed issues.

TARGET:
delta tail target

Return ONLY a JSON object, with no prose before or after:
{"findings":[{"severity":"critical|high|medium|low","file":"path or null","line":number_or_null,"claim":"one-line issue","evidence":"why it is real, with a concrete reference"}]}
If there are no real issues, return {"findings":[]}.`;

  test('default round-1 prompt is byte-identical after FINDINGS_CONTRACT extraction', () => {
    const dump = join(DIR, 'r1-default.txt');
    const r = review(['delta tail target'], { X_PANEL_DUMP_R1: dump });
    expect(r.status).toBe(0);
    expect(readFileSync(dump, 'utf8')).toBe(DEFAULT_R1); // no behavior change to the default path
  });

  test('--review-prompt-file injects the override body + forces FINDINGS_CONTRACT', () => {
    const lensFile = join(DIR, 'lens-security.txt');
    writeFileSync(lensFile, 'You are a SECURITY lens. Report SQL injection only. Output as a markdown list.');
    const dump = join(DIR, 'r1-override.txt');
    const r = review(['some diff', '--review-prompt-file', lensFile, '--lens-tag', 'security'], { X_PANEL_DUMP_R1: dump });
    expect(r.status).toBe(0);
    const sent = readFileSync(dump, 'utf8');
    expect(sent).toContain('You are a SECURITY lens'); // override body injected
    expect(sent).not.toContain('You are a code reviewer.'); // default intro replaced
    expect(sent).toContain('Return ONLY a JSON object'); // contract footer FORCED despite "markdown list"
  });

  test('--lens-tag flows to verdict findings and consensus lenses', () => {
    const r = review(['some diff', '--review-prompt', 'Find bugs.', '--lens-tag', 'logic']);
    expect(r.status).toBe(0);
    // injected review mode writes under .xm/review/, not .xm/panel/
    const reviewDir = join(DIR, '.xm', 'review');
    const runs = readdirSync(reviewDir).filter((n) => n.startsWith('panel-')).sort();
    const v = JSON.parse(readFileSync(join(reviewDir, runs[runs.length - 1], 'verdict.json'), 'utf8'));
    const tagged = [...(v.confirmed || []), ...(v.contested || [])];
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged.every((f) => f.lens === 'logic')).toBe(true);
    expect(v.consensus.every((c) => Array.isArray(c.lenses))).toBe(true);
  });

  test('injected review mode writes to .xm/review/, not .xm/panel/', () => {
    const before = existsSync(join(DIR, '.xm', 'panel')) ? readdirSync(join(DIR, '.xm', 'panel')) : [];
    const r = review(['some diff', '--review-prompt', 'Find bugs.', '--lens-tag', 'security']);
    expect(r.status).toBe(0);
    const reviewDir = join(DIR, '.xm', 'review');
    expect(existsSync(reviewDir)).toBe(true);
    const runs = readdirSync(reviewDir);
    expect(runs.length).toBeGreaterThan(0);
    expect(existsSync(join(reviewDir, runs[0], 'verdict.json'))).toBe(true);
    // no NEW panel run was created by the injected review
    const after = existsSync(join(DIR, '.xm', 'panel')) ? readdirSync(join(DIR, '.xm', 'panel')) : [];
    expect(after.length).toBe(before.length);
  });

  test('operator --lens-tag is authoritative; model-supplied lens cannot spoof it', () => {
    // tag supplied → wins over the model's own lens field
    expect(normalizeFindings({ findings: [{ claim: 'x', lens: 'evil' }] }, 'correctness')[0].lens).toBe('correctness');
    // no tag → fall back to model's lens (harmless)
    expect(normalizeFindings({ findings: [{ claim: 'x', lens: 'model' }] }, null)[0].lens).toBe('model');
    // neither → null
    expect(normalizeFindings({ findings: [{ claim: 'x' }] })[0].lens).toBe(null);
  });

  test('empty review-prompt override fails loudly (no instruction-less panel)', () => {
    const r = panelRaw(['review', 'target', '--models', 'claude,codex', '--review-prompt', '']);
    expect(r.status).not.toBe(0); // exits non-zero instead of silently running
  });

  test('--review-prompt-file with no value fails loudly', () => {
    const r = panelRaw(['review', 'target', '--models', 'claude,codex', '--review-prompt-file']);
    expect(r.status).not.toBe(0);
  });

  test('git-diff target_title parses real "diff --git" headers (diffFiles)', () => {
    const gitdir = mkdtempSync(join(tmpdir(), 'xpanel-git-'));
    const g = (...a) => spawnSync('git', a, { cwd: gitdir, encoding: 'utf8' });
    g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    writeFileSync(join(gitdir, 'alpha.js'), 'const a=1;\n');
    g('add', '-A'); g('commit', '-qm', 'init');
    writeFileSync(join(gitdir, 'alpha.js'), 'const a=2;\n'); // modify → real diff header
    const env = { ...process.env, X_PANEL_ROOT: join(gitdir, '.xm'), X_PANEL_GLOBAL_ROOT: join(gitdir, '.xm-g'), X_PANEL_CMD_CLAUDE: STUB, X_PANEL_CMD_CODEX: STUB, NO_COLOR: '1' };
    const r = spawnSync('node', [CLI, 'review', '--models', 'claude,codex'], { cwd: gitdir, env, encoding: 'utf8', timeout: 20000 });
    expect(r.status).toBe(0);
    const pdir = join(gitdir, '.xm', 'panel');
    const runs = readdirSync(pdir).filter((n) => n.startsWith('panel-')).sort();
    const v = JSON.parse(readFileSync(join(pdir, runs[runs.length - 1], 'verdict.json'), 'utf8'));
    expect(v.target_title).toBe('diff: alpha.js'); // diffFiles() parsed the real header
    rmSync(gitdir, { recursive: true, force: true });
  });

  test('cross runs one prompt across vendors and returns raw outputs to .xm/cross/', () => {
    const r = panelRaw(['cross', '--models', 'claude,codex', '--prompt', 'Argue the PRO side.', '--json']);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.results.length).toBe(2);
    expect(out.results.every((x) => x.ok && x.output.length > 0)).toBe(true); // raw text per vendor, no findings parse
    const crossDir = join(DIR, '.xm', 'cross');
    expect(existsSync(crossDir)).toBe(true);
    expect(readdirSync(crossDir).length).toBeGreaterThan(0);
  });

  test('cross agy handoff: oversized prompt → agy reads a file, others stay inline', () => {
    // 600KB: above agy's cap (128KiB → handoff) AND above the 512KiB inline budget (→ ARG_MAX guard).
    const big = 'diff --git a/x b/x\n' + 'x'.repeat(600 * 1024);
    const dump = join(DIR, 'cross-dump');
    const r = panelRaw(['cross', '--models', 'claude,agy', '--prompt', big, '--json'],
      { X_PANEL_CMD_AGY: STUB, X_PANEL_DUMP_CROSS: dump });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    const runDir = join(DIR, '.xm', 'cross', out.run);
    // The whole prompt was written to a file for agy to read, then cleaned up after the run
    // (so no unredacted prompt persists on disk / replicates via x-sync).
    expect(existsSync(join(runDir, 'prompt.txt'))).toBe(false);
    // agy received the tiny wrapper pointing at the file, NOT the huge inline prompt.
    const agySent = readFileSync(`${dump}.AGY`, 'utf8');
    expect(agySent).toContain('prompt.txt');
    expect(agySent).toContain('Read that file');
    expect(agySent.length).toBeLessThan(1000);
    // claude still got the full inline prompt (no handoff for a provider that can't read files here).
    const claudeSent = readFileSync(`${dump}.CLAUDE`, 'utf8');
    expect(claudeSent.length).toBeGreaterThan(600 * 1024);
    // Reductions/handoffs MUST stay loud (Lesson L6) — assert BOTH warnings actually fire.
    expect(r.stderr).toContain('handing agy the whole prompt as a file');
    expect(r.stderr).toContain('exceeds the inline budget'); // ARG_MAX guard for the inline (claude) provider
  });

  test('cross: a small prompt does NOT trigger the agy file handoff', () => {
    const dump = join(DIR, 'cross-small-dump');
    const r = panelRaw(['cross', '--models', 'agy', '--prompt', 'tiny task', '--json'],
      { X_PANEL_CMD_AGY: STUB, X_PANEL_DUMP_CROSS: dump });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(existsSync(join(DIR, '.xm', 'cross', out.run, 'prompt.txt'))).toBe(false);
    expect(readFileSync(`${dump}.AGY`, 'utf8')).toBe('tiny task'); // inlined verbatim
  });

  test('review agy handoff: oversized target → agy reads target.patch in BOTH rounds, claude stays inline', () => {
    const bigTarget = 'diff --git a/x b/x\n' + 'y'.repeat(200 * 1024); // > AGY_INLINE_MAX_BYTES
    const r1 = join(DIR, 'rev-r1'), r2 = join(DIR, 'rev-r2');
    const r = review([bigTarget, '--models', 'claude,agy'],
      { X_PANEL_CMD_AGY: STUB, X_PANEL_DUMP_R1: r1, X_PANEL_DUMP_R2: r2 });
    expect(r.status).toBe(0);
    // The full diff was written for agy to read, then cleaned up once both rounds finished
    // (no unredacted diff persists on disk / replicates via x-sync).
    const runs = readdirSync(join(DIR, '.xm', 'panel')).filter((n) => n.startsWith('panel-')).sort();
    const runDir = join(DIR, '.xm', 'panel', runs[runs.length - 1]);
    expect(existsSync(join(runDir, 'target.patch'))).toBe(false);
    // Round 1: agy got the file ref (small), claude got the full inline diff.
    const agyR1 = readFileSync(`${r1}.AGY`, 'utf8');
    expect(agyR1).toContain('target.patch');
    expect(agyR1.length).toBeLessThan(2000);
    expect(readFileSync(`${r1}.CLAUDE`, 'utf8').length).toBeGreaterThan(200 * 1024);
    // Round 2 (refute): agy has no session, so it MUST be re-pointed at the file, not the inline diff.
    const agyR2 = readFileSync(`${r2}.AGY`, 'utf8');
    expect(agyR2).toContain('target.patch');
    expect(agyR2.length).toBeLessThan(4000);
  });

  test('cross writes events.jsonl (run_start/spawn/model_done/run_done) and --logs reads it', () => {
    const r = panelRaw(['cross', '--models', 'claude,codex', '--prompt', 'events probe', '--json']);
    expect(r.status).toBe(0);
    const run = JSON.parse(r.stdout).run;
    const events = readFileSync(join(DIR, '.xm', 'cross', run, 'events.jsonl'), 'utf8')
      .trim().split(/\r?\n/).map((l) => JSON.parse(l));
    expect(events[0].type).toBe('run_start');
    expect(events.some((ev) => ev.type === 'spawn' && ev.model === 'claude')).toBe(true);
    expect(events.some((ev) => ev.type === 'exit' && ev.model === 'codex')).toBe(true);
    expect(events.some((ev) => ev.type === 'model_done' && ev.ok === true)).toBe(true);
    expect(events[events.length - 1].type).toBe('run_done');

    // cross runs are no longer rejected by --logs — forensics work uniformly
    const logs = panelRaw(['status', run, '--logs'], { NO_COLOR: '1' });
    expect(logs.status).toBe(0);
    expect(logs.stdout).toContain('spawn');
    expect(logs.stdout).toContain('run_done');
  });

  test('--logs on a LEGACY cross run (no events.jsonl) fails loudly with a clear note', () => {
    const d = join(DIR, '.xm', 'cross', 'panel-legacy-cross-fixture');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'result.json'), JSON.stringify({ run: 'panel-legacy-cross-fixture', results: [] }));
    const out = panelRaw(['status', 'panel-legacy-cross-fixture', '--logs'], { NO_COLOR: '1' });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain('no event log');
  });

  test('cross: exit-0 empty output is a loud failure, retried once (no silent blank)', () => {
    // cursor returns success with empty stdout (transient rate-limit) on every call → the guard
    // turns it into ok:false, cross retries once (still empty), and it ends as a surfaced FAILURE
    // instead of a silently blank panel cell — the "can't capture cursor" bug.
    const r = panelRaw(['cross', '--models', 'cursor', '--prompt', 'test', '--json'],
      { X_PANEL_CMD_CURSOR: STUB, X_PANEL_EMPTY_CURSOR: 'rate limited' });
    expect(r.status).not.toBe(0); // single empty vendor → all failed → non-zero exit
    const out = JSON.parse(r.stdout);
    const cursor = out.results.find((x) => x.provider === 'cursor');
    expect(cursor.ok).toBe(false);
    expect(cursor.output).toBe('');
    expect(cursor.error).toContain('empty output'); // guard message, not a silent blank
    expect(cursor.error).toContain('rate limited'); // stderr hint forwarded as the reason
    expect(cursor.error).toContain('retried once'); // retry attempt is surfaced
    expect(r.stderr).toContain('retrying once'); // loud warning (L6), not silent
  });

  test('cross: retry recovers a transient exit-0-empty (cursor succeeds on 2nd try)', () => {
    const marker = join(DIR, 'cursor-empty-once.marker');
    if (existsSync(marker)) rmSync(marker);
    const r = panelRaw(['cross', '--models', 'cursor', '--prompt', 'test', '--json'],
      { X_PANEL_CMD_CURSOR: STUB, X_PANEL_EMPTY_ONCE_CURSOR: marker });
    expect(r.status).toBe(0); // first call empty → retry succeeds → overall success
    const out = JSON.parse(r.stdout);
    const cursor = out.results.find((x) => x.provider === 'cursor');
    expect(cursor.ok).toBe(true);
    expect(cursor.output.length).toBeGreaterThan(0); // 2nd-try output captured, not lost
    expect(r.stderr).toContain('retrying once'); // the first failure was still surfaced
  });

  test('cross: a timeout/stall is NOT retried (no doubling the wall-clock on a hung provider)', () => {
    // claude is silent for 3s with a 1s idle window → stalled. Unlike a transient empty/exit-N,
    // a timeout already burned the full window, so retrying would just pay it twice — skip it.
    const r = panelRaw(['cross', '--models', 'claude', '--prompt', 'hi', '--timeout', '1', '--json'],
      { X_PANEL_DELAY_CLAUDE_MS: '3000' });
    expect(r.status).not.toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.results[0].error).toMatch(/stalled/i);
    expect(out.results[0].error).not.toMatch(/retried once/i); // timeout → no second attempt
    expect(r.stderr).not.toContain('retrying once');
  });

  test('cross: exit-0-empty whose stderr mentions "timeout" is STILL retried (flag, not substring)', () => {
    // error text becomes "exit 0 but empty output: request timed out" — it contains "timed out",
    // but this is an exit-0-empty (timedOut flag is false), so the retry MUST still fire. Guards the
    // isTimeout-substring regression the cross-vendor review caught (codex+claude confirmed).
    const r = panelRaw(['cross', '--models', 'cursor', '--prompt', 'test', '--json'],
      { X_PANEL_CMD_CURSOR: STUB, X_PANEL_EMPTY_CURSOR: 'request timed out' });
    expect(r.status).not.toBe(0);
    const cursor = JSON.parse(r.stdout).results.find((x) => x.provider === 'cursor');
    expect(cursor.error).toContain('timed out'); // stderr hint forwarded
    expect(cursor.error).toContain('retried once'); // ← retry DID fire despite the "timed out" substring
    expect(r.stderr).toContain('retrying once');
  });

  test('cross: a real timeout/stall is NOT retried (would just double the wall-clock)', () => {
    // stub stays silent past the 1s idle window → guard kills it with timedOut=true → no retry.
    const r = panelRaw(['cross', '--models', 'cursor', '--prompt', 'test', '--json', '--timeout', '1'],
      { X_PANEL_CMD_CURSOR: STUB, X_PANEL_DELAY_CURSOR_MS: '4000' });
    expect(r.status).not.toBe(0);
    const cursor = JSON.parse(r.stdout).results.find((x) => x.provider === 'cursor');
    expect(cursor.ok).toBe(false);
    expect(r.stderr).not.toContain('retrying once'); // ← timeout did NOT trigger a retry
  });

  test('cross records --source + --title provenance in result.json', () => {
    const r = panelRaw(['cross', '--models', 'claude,codex', '--prompt', 'Argue the PRO side.',
      '--source', 'op:debate', '--title', 'cross-vendor moat', '--json']);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.source).toBe('op:debate'); // calling workflow is identifiable in the dashboard
    expect(out.title).toBe('cross-vendor moat');
  });

  test('cross --title falls back to the prompt first line, --source sanitizes to null when absent', () => {
    const r = panelRaw(['cross', '--models', 'claude', '--prompt', 'First meaningful line\nsecond line', '--json']);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.source).toBe(null);            // no --source → generic; dashboard shows "cross"
    expect(out.title).toBe('First meaningful line'); // human-ish name even without --title
  });

  test('cross --source strips markup/newlines to a short safe tag', () => {
    const r = panelRaw(['cross', '--models', 'claude', '--prompt', 'hi',
      '--source', 'op:<script>alert(1)</script>', '--json']);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.source).not.toMatch(/[<>]/); // no markup can reach the dashboard via the source tag
  });

  test('cross fails loudly without a prompt', () => {
    const r = panelRaw(['cross', '--models', 'claude,codex']);
    expect(r.status).not.toBe(0);
  });

  test('--prompt=<value> accepts a prompt that starts with -- (long-option form)', () => {
    const r = panelRaw(['cross', '--models', 'claude,codex', '--prompt=-- note: argue PRO', '--json']);
    expect(r.status).toBe(0); // the leading -- is part of the value, not treated as a missing prompt
    expect(JSON.parse(r.stdout).results.length).toBe(2);
  });

  test('cross warns (not silent) when a requested vendor is unknown/unavailable', () => {
    const r = panelRaw(['cross', '--models', 'claude,bogusvendor', '--prompt', 'hi', '--json']);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/unknown provider|skipping/i); // dropped vendor is surfaced, not silent
    expect(JSON.parse(r.stdout).results.length).toBe(1); // only the available vendor ran
  });

  test('idle timeout kills a silent (stalled) vendor with a "stalled" error, not a generic timeout', () => {
    // claude is silent for 3s with a 1s idle window → no output → killed as stalled.
    const r = panelRaw(['cross', '--models', 'claude', '--prompt', 'hi', '--timeout', '1', '--json'],
      { X_PANEL_DELAY_CLAUDE_MS: '3000' });
    expect(r.status).not.toBe(0);           // the only vendor failed → non-zero exit
    const out = JSON.parse(r.stdout);
    expect(out.results[0].ok).toBe(false);
    expect(out.results[0].error).toMatch(/stalled/i); // distinguishes hung from working
  });

  test('idle timeout does NOT kill a vendor that keeps emitting output (dynamic extension)', () => {
    // claude stays busy 2.5s but ticks every 400ms < the 1s idle window → never idle → completes.
    const r = panelRaw(['cross', '--models', 'claude', '--prompt', 'hi', '--timeout', '1', '--json'],
      { X_PANEL_DELAY_CLAUDE_MS: '2500', X_PANEL_HB_CLAUDE_MS: '400' });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.results[0].ok).toBe(true);   // activity resets the deadline → survives past base timeout
  });

  test('panel status lists runs and shows a run\'s per-vendor output from disk', () => {
    // seed a cross run, then read it back via the read-only status command (CLI visibility)
    const seed = panelRaw(['cross', '--models', 'claude,codex', '--prompt', 'visibility check',
      '--source', 'op:debate', '--title', 'status-cli test', '--json']);
    expect(seed.status).toBe(0);
    const run = JSON.parse(seed.stdout).run;

    const list = panelRaw(['status', '--json']);
    expect(list.status).toBe(0);
    const rows = JSON.parse(list.stdout);
    const row = rows.find((r) => r.run === run);
    expect(row).toBeTruthy();
    expect(row.source).toBe('op:debate'); // category visible from the CLI list

    const detail = panelRaw(['status', run, '--json']);
    expect(detail.status).toBe(0);
    const got = JSON.parse(detail.stdout);
    expect(got.results.length).toBe(2);
    expect(got.results[0].output.length).toBeGreaterThan(0); // each vendor's stdout readable
  });

  test('cross exits non-zero when every vendor fails', () => {
    const r = panelRaw(['cross', '--models', 'claude,codex', '--prompt', 'hi'],
      { X_PANEL_EXIT1_CLAUDE: '1', X_PANEL_EXIT1_CODEX: '1' });
    expect(r.status).not.toBe(0); // total failure is a non-zero exit, not silent ok
  });

  test('panel detect --json reports available + known providers', () => {
    const r = panelRaw(['detect', '--json']);
    expect(r.status).toBe(0);
    const info = JSON.parse(r.stdout);
    expect(Array.isArray(info.available)).toBe(true);
    expect(Array.isArray(info.known)).toBe(true);
    expect(info.known).toContain('claude');
  });

  test('panel doctor --json reports per-provider readiness; overrides are assumed ready', () => {
    // Override every provider so the check is hermetic (no real auth-status call).
    const allStub = { X_PANEL_CMD_AGY: STUB, X_PANEL_CMD_CURSOR: STUB, X_PANEL_CMD_KIRO: STUB };
    const r = panelRaw(['doctor', '--json'], allStub);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.providers.length).toBe(5);
    for (const p of out.providers) {
      expect(p.installed).toBe(true);
      expect(p.authed).toBe(true); // X_PANEL_CMD override → assumed ready, no model call
    }
  });

  test('panel detect --auth narrows available to authenticated providers', () => {
    // Only claude+codex are stubbed (assumed ready); the rest aren't overridden,
    // so --auth must still surface at least the two ready ones.
    const r = panelRaw(['detect', '--auth', '--json']);
    expect(r.status).toBe(0);
    const info = JSON.parse(r.stdout);
    expect(info.available).toContain('claude');
    expect(info.available).toContain('codex');
  });
});

describe('refute prompts carry evidence (both builders in sync)', () => {
  // The stub dumps the exact round-2 prompt per model via X_PANEL_DUMP_R2.<MODEL>;
  // claude's dump is its verdict prompt over CODEX's findings (and vice versa).
  test('stateless refute prompt includes each finding\'s evidence + the TARGET block', () => {
    const dump = join(DIR, 'r2-full');
    const r = review(['evidence target', '--no-session-reuse'], { X_PANEL_DUMP_R2: dump });
    expect(r.status).toBe(0);
    const sent = readFileSync(`${dump}.CLAUDE`, 'utf8');
    expect(sent).toContain('TARGET:');
    expect(sent).toContain('[codex#0]');
    expect(sent).toContain('evidence: ev'); // refuters no longer judge blind
  });

  test('resumed refute prompt carries the SAME findings list (shared builder — no drift), minus TARGET', () => {
    const full = join(DIR, 'r2-fullsync');
    const resumed = join(DIR, 'r2-resumed');
    expect(review(['evidence target', '--no-session-reuse'], { X_PANEL_DUMP_R2: full }).status).toBe(0);
    expect(review(['evidence target'], { X_PANEL_DUMP_R2: resumed }).status).toBe(0); // session reuse default on
    const fullP = readFileSync(`${full}.CLAUDE`, 'utf8');
    const resP = readFileSync(`${resumed}.CLAUDE`, 'utf8');
    expect(resP).not.toContain('TARGET:');  // the whole point of session reuse
    expect(resP).toContain('evidence: ev'); // evidence travels in BOTH builders
    const section = (p) => p.slice(p.indexOf('FINDINGS (each tagged with a [id]):'));
    expect(section(resP)).toBe(section(fullP)); // byte-identical from the findings list down
  });

  test('huge evidence is truncated per finding with an explicit marker, never silently', () => {
    const dump = join(DIR, 'r2-big');
    const big = 'E'.repeat(2000);
    const r = review(['evidence target', '--no-session-reuse'], { X_PANEL_DUMP_R2: dump, X_PANEL_EVIDENCE_CODEX: big });
    expect(r.status).toBe(0);
    const sent = readFileSync(`${dump}.CLAUDE`, 'utf8'); // claude judged codex's big-evidence findings
    expect(sent).toContain('… [evidence truncated]');    // explicit marker
    expect(sent).not.toContain(big);                     // the full blob never travels
  });
});

describe('grounded refutation (빅뱃3) — only capable vendors get the file-verify contract', () => {
  test('--grounded sends the verify clause to codex ONLY; claude (isolated) stays text-only', () => {
    const dump = join(DIR, 'r2-grounded');
    const r = review(['grounded target', '--grounded', '--no-session-reuse'], { X_PANEL_DUMP_R2: dump });
    expect(r.status).toBe(0);
    const codexP = readFileSync(`${dump}.CODEX`, 'utf8');
    const claudeP = readFileSync(`${dump}.CLAUDE`, 'utf8');
    // codex CAN read the repo → gets the grounding clause + the verified contract.
    expect(codexP).toContain('read-only file access');
    expect(codexP).toContain('"verified"');
    // claude is tmpdir-isolated → must NOT be asked to open files (would fake checked:true).
    expect(claudeP).not.toContain('read-only file access');
    expect(claudeP).not.toContain('"verified"');
  });

  test('grounded run records grounded provenance + per-model verified counts + 🔎 in the report', () => {
    const r = review(['grounded target', '--grounded', '--no-session-reuse']);
    expect(r.status).toBe(0);
    const v = latestVerdict();
    expect(v.grounded).toBe(true);
    expect(v.grounded_models).toEqual(['codex']);          // only the capable vendor
    expect(v.by_model.codex.grounded_verdicts).toBeGreaterThan(0);
    expect(v.by_model.claude.grounded_verdicts).toBe(0);
    expect(v.counts.grounded_verdicts).toBe(v.by_model.codex.grounded_verdicts);
    // codex refutes claude's shared finding after reading the file → 🔎 marks it in CONTESTED.
    expect(r.stdout).toContain('🔎');
    expect(r.stdout).toContain('grounded:');
  });

  test('without --grounded no verify contract is sent and grounded stays false', () => {
    const dump = join(DIR, 'r2-plain');
    const r = review(['grounded target', '--no-session-reuse'], { X_PANEL_DUMP_R2: dump });
    expect(r.status).toBe(0);
    expect(readFileSync(`${dump}.CODEX`, 'utf8')).not.toContain('"verified"');
    const v = latestVerdict();
    expect(v.grounded).toBe(false);
    expect(v.counts.grounded_verdicts).toBe(0);
    expect(r.stdout).not.toContain('🔎');
  });
});

describe('followup / debate round (빅뱃5) — CLI end-to-end', () => {
  function runIdOf(dir) { return dir.split('/').pop(); }
  function followup(runId, args = [], env = {}) {
    return spawnSync('node', [CLI, 'followup', runId, ...args], { cwd: DIR, env: STUB_ENV(env), encoding: 'utf8', timeout: 20000 });
  }

  test('review persists resumable sessions per model (the followup prerequisite)', () => {
    const r = review(['debate target']); // session-reuse on by default
    expect(r.status).toBe(0);
    const v = latestVerdict();
    expect(v.sessions).toBeDefined();
    // claude created its own uuid; codex disclosed a thread id → both resumable.
    expect(v.sessions.claude.resumable).toBe(true);
    expect(v.sessions.claude.id).toBeTruthy();
    expect(v.sessions.codex.resumable).toBe(true);
  });

  test('followup resumes the author of a contested finding and classifies HELD by default', () => {
    const r = review(['debate target']);
    expect(r.status).toBe(0);
    const runId = runIdOf(latestRunDir());
    // stub: codex refuted claude#0 (shared) → one contested finding owned by claude.
    const f = followup(runId);
    expect(f.status).toBe(0);
    expect(f.stdout).toContain('Debate round');
    expect(f.stdout).toContain('HELD'); // default stub resolution holds the finding
    // artifact written additively, verdict.json untouched
    const rec = JSON.parse(readFileSync(join(latestRunDir(), 'followup-1.json'), 'utf8'));
    expect(rec.round).toBe(3);
    expect(rec.delta.counts.held).toBe(1);
    expect(rec.delta.counts.conceded).toBe(0);
    expect(rec.by_model.find(m => m.owner === 'claude').resume).toBe('ok'); // real resume, not fallback
  });

  test('a conceding author resolves the disagreement (CONCEDED bucket)', () => {
    const r = review(['debate target']);
    expect(r.status).toBe(0);
    const runId = runIdOf(latestRunDir());
    const f = followup(runId, [], { X_PANEL_FOLLOWUP_CLAUDE: 'concede' });
    expect(f.status).toBe(0);
    const rec = JSON.parse(readFileSync(join(latestRunDir(), 'followup-1.json'), 'utf8'));
    expect(rec.delta.counts.conceded).toBe(1);
    expect(rec.delta.counts.held).toBe(0);
  });

  test('re-running followup writes an additive followup-2.json, never overwriting', () => {
    const r = review(['debate target']);
    expect(r.status).toBe(0);
    const dir = latestRunDir();
    const runId = runIdOf(dir);
    expect(followup(runId).status).toBe(0);
    expect(followup(runId).status).toBe(0);
    expect(existsSync(join(dir, 'followup-1.json'))).toBe(true);
    expect(existsSync(join(dir, 'followup-2.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'followup-2.json'), 'utf8')).round).toBe(4);
  });

  test('followup on an unknown run exits 2 with guidance', () => {
    const f = followup('panel-nope-0000');
    expect(f.status).toBe(2);
    expect(f.stderr).toContain('run not found');
  });
});

describe('pre-run guard (readiness gate + trivial target)', () => {
  test('a stub provider failing readiness is excluded, reported loudly, and listed in skipped_providers', () => {
    const r = review(['guard target', '--models', 'claude,codex,kiro', '--json'],
      { X_PANEL_CMD_KIRO: STUB, X_PANEL_STUB_UNREADY_KIRO: '1' });
    expect(r.status).toBe(0);                       // panel proceeds with the 2 ready models
    expect(r.stderr).toContain('not ready');
    expect(r.stderr).toContain('xm panel doctor');  // fix hint is loud
    const rec = JSON.parse(r.stdout);
    expect(rec.models).toEqual(['claude', 'codex']); // the dead-on-arrival provider never joined
    expect(rec.skipped_providers.length).toBe(1);
    expect(rec.skipped_providers[0]).toMatchObject({ name: 'kiro', reason: 'not_ready' });
  });

  test('readiness exclusions count toward the ≥2-models floor (exit 1, not a 1-model panel)', () => {
    const r = review(['guard target'], { X_PANEL_STUB_UNREADY_CODEX: '1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('needs ≥2');
  });

  test('cross gates readiness too: unready provider skipped, run proceeds with the rest', () => {
    const r = panelRaw(['cross', '--models', 'claude,codex', '--prompt', 'gate probe', '--json'],
      { X_PANEL_STUB_UNREADY_CODEX: '1' });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.results.length).toBe(1);
    expect(out.results[0].provider).toBe('claude');
    expect(out.skipped_providers.length).toBe(1);
    expect(out.skipped_providers[0]).toMatchObject({ name: 'codex', reason: 'not_ready' });
    expect(r.stderr).toContain('xm panel doctor');
  });

  test('an empty git diff exits 2 (no N-models × 2-rounds burn on a clean tree); --force overrides', () => {
    // DIR is not a git repo → `git diff HEAD` yields the "(no diff against HEAD)" sentinel.
    const r = panelRaw(['review', '--models', 'claude,codex']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('nothing to review');
    const f = panelRaw(['review', '--force', '--models', 'claude,codex']);
    expect(f.status).toBe(0); // --force proceeds
  });
});

describe('providerReady (auth gate — fixes agy false-negative)', () => {
  test('verified-authed provider is ready', () => {
    expect(providerReady({ installed: true, authed: true, assumedReady: true })).toBe(true);
  });
  test('assumed-ready (no auth-status command + creds present, e.g. agy) IS offered', () => {
    // the bug: agy was authed:null → excluded by authed===true gate even though it works.
    expect(providerReady({ installed: true, authed: null, assumedReady: true })).toBe(true);
  });
  test('null auth WITHOUT creds (likely logged out) is NOT offered', () => {
    expect(providerReady({ installed: true, authed: null, assumedReady: false })).toBe(false);
  });
  test('explicitly NOT authenticated is excluded', () => {
    expect(providerReady({ installed: true, authed: false, assumedReady: false })).toBe(false);
  });
  test('not installed is excluded regardless of auth', () => {
    expect(providerReady({ installed: false, authed: true, assumedReady: true })).toBe(false);
  });
  test('null/garbage input is safely not-ready', () => {
    expect(providerReady(null)).toBe(false);
    expect(providerReady({})).toBe(false);
  });
});

describe('panel status (staleness + project scope + --all)', () => {
  // Own temp .xm so seeded fixtures don't pollute the shared DIR (latestVerdict() reads the
  // alphabetically-last run there and would choke on a verdict-less fixture).
  let SDIR;
  beforeAll(() => { SDIR = mkdtempSync(join(tmpdir(), 'xpanel-status-')); });
  afterAll(() => { rmSync(SDIR, { recursive: true, force: true }); });
  const statusEnv = () => ({ X_PANEL_ROOT: join(SDIR, '.xm'), X_PANEL_GLOBAL_ROOT: join(SDIR, '.xm-global') });
  const seedRun = (run, updatedAt) => {
    const d = join(SDIR, '.xm', 'panel', run);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'status.json'), JSON.stringify({
      run, phase: 'round1 (review)', target_kind: 'literal', target_title: 'seed',
      updated_at: updatedAt, models: [{ label: 'claude', state: 'running' }],
    }));
  };

  test('a non-done run not updated within the window shows "stalled", a fresh one stays live', () => {
    seedRun('panel-stale-fixture', '2020-01-01T00:00:00.000Z'); // ancient → dead process
    seedRun('panel-live-fixture', new Date().toISOString());    // just written → live
    const r = panelRaw(['status', '--json'], statusEnv());
    expect(r.status).toBe(0);
    const rows = JSON.parse(r.stdout);
    const stale = rows.find((x) => x.run === 'panel-stale-fixture');
    const live = rows.find((x) => x.run === 'panel-live-fixture');
    expect(stale.phase).toBe('stalled');     // not the frozen "round1 (review)"
    expect(stale.stale).toBe(true);
    expect(live.stale).toBe(false);
    expect(live.phase).toBe('round1 (review)'); // genuinely in progress
  });

  test('--all groups by project; with no registry it falls back to the current project', () => {
    seedRun('panel-all-fixture', new Date().toISOString());
    const r = panelRaw(['status', '--all', '--json'], statusEnv()); // global root has no projects.json
    expect(r.status).toBe(0);
    const groups = JSON.parse(r.stdout);
    expect(Array.isArray(groups)).toBe(true);
    expect(groups.length).toBeGreaterThanOrEqual(1); // at least the current project
    expect(groups[0].runs.some((x) => x.run === 'panel-all-fixture')).toBe(true);
  });

  test('a run row carries phaseRaw + raw per-agent objects (the data the --watch board renders)', () => {
    const d = join(SDIR, '.xm', 'panel', 'panel-detail-fixture');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'status.json'), JSON.stringify({
      run: 'panel-detail-fixture', phase: 'round1 (review)', target_kind: 'git-diff', target_title: 'diff: a.js',
      updated_at: new Date().toISOString(),
      models: [
        { label: 'claude:claude-opus-4-8', state: 'running', elapsed_s: 45, stdout_bytes: 2130 },
        { label: 'kiro', state: 'failed', elapsed_s: 8, error: 'timeout 600s' },
      ],
    }));
    const r = panelRaw(['status', '--json'], statusEnv());
    const row = JSON.parse(r.stdout).find((x) => x.run === 'panel-detail-fixture');
    expect(row.phaseRaw).toBe('round1 (review)');    // the actual round, for the board header
    expect(row.models[0].state).toBe('running');     // raw objects, not "label:state" strings
    expect(row.models[0].stdout_bytes).toBe(2130);   // activity volume → "↑2.1k"
    expect(row.models.find((m) => m.label === 'kiro').error).toBe('timeout 600s');
  });

  test('--watch --lines N shows each agent\'s output tail (what it is reasoning), not just a byte count', () => {
    const d = join(SDIR, '.xm', 'panel', 'panel-watchlines-fixture');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'status.json'), JSON.stringify({
      run: 'panel-watchlines-fixture', phase: 'round1 (review)', target_kind: 'git-diff', target_title: 'diff: a.js',
      updated_at: new Date().toISOString(),
      models: [{ label: 'claude', state: 'running', elapsed_s: 10, stdout_bytes: 40, stdout_tail: 'ZZMARKER first line\nZZMARKER final reasoning line' }],
    }));
    // --watch loops; kill it after one frame via spawnSync timeout and inspect the captured frame.
    const r = spawnSync('node', [CLI, 'status', '--watch', '--lines', '2', '--interval', '1'],
      { cwd: DIR, env: STUB_ENV(statusEnv()), encoding: 'utf8', timeout: 2500 });
    expect(r.stdout).toContain('ZZMARKER final reasoning line'); // the actual content is rendered
    expect(r.stdout).toContain('panel watch');                   // it is the live board, not the list
  });

  // ── interpreted tails: the board shows what the output MEANS, not raw contract JSON ──

  // Tail fixtures are removed after EACH test: a leftover live run pollutes every later board
  // frame (its tail lines leak into other tests' assertions) and pushes older cross/review
  // fixtures out of the status list's 20-run window.
  const seededTails = [];
  const seedTailRun = (run, models) => {
    const d = join(SDIR, '.xm', 'panel', run);
    mkdirSync(d, { recursive: true });
    seededTails.push(d);
    writeFileSync(join(d, 'status.json'), JSON.stringify({
      run, phase: 'round1 (review)', target_kind: 'git-diff', target_title: 'diff: a.js',
      updated_at: new Date().toISOString(),
      models: models.map((m) => ({ state: 'done', elapsed_s: 10, updated_at: new Date().toISOString(), ...m })),
    }));
  };
  afterEach(() => { while (seededTails.length) rmSync(seededTails.pop(), { recursive: true, force: true }); });
  const watchFrame = (lines) => spawnSync('node', [CLI, 'status', '--watch', '--lines', String(lines), '--interval', '1'],
    { cwd: DIR, env: STUB_ENV(statusEnv()), encoding: 'utf8', timeout: 2500 }).stdout;

  test('a findings JSON tail renders one summarized line per finding, not the raw JSON', () => {
    seedTailRun('panel-tailfind-fixture', [
      { label: 'agy', stdout_tail: '{"findings":[{"severity":"medium","file":"x-build/lib/cli-prompts.mjs","line":165,"claim":"The regex misses multiline flags","evidence":"e"}]}' },
      { label: 'codex', stdout_tail: '{"findings":[]}' },
    ]);
    const out = watchFrame(4);
    expect(out).toContain('[medium] x-build/lib/cli-prompts.mjs:165');  // severity + location
    expect(out).toContain('The regex misses multiline flags');          // the claim itself
    expect(out).toContain('no issues found');                           // [] → explicit clean verdict
    expect(out).not.toContain('{"findings"');                           // never the raw dump
  });

  test('a verdicts JSON tail renders stance + ref + reason per verdict', () => {
    seedTailRun('panel-tailverd-fixture', [
      { label: 'codex', stdout_tail: '{"verdicts":[{"ref":"agy#0","stance":"refute","reason":"path is unreachable"},{"ref":"agy#1","stance":"concede","reason":"real regression"}]}' },
    ]);
    const out = watchFrame(4);
    expect(out).toContain('refute agy#0');
    expect(out).toContain('path is unreachable');
    expect(out).toContain('concede agy#1');
    expect(out).not.toContain('{"verdicts"');
  });

  test('a tail that is ONLY our echoed prompt shows a waiting note, never our own instructions', () => {
    seedTailRun('panel-tailecho-fixture', [
      { label: 'codex', state: 'running', stdout_tail: [
        'Return ONLY a JSON object, no prose. Use the exact bracketed [id] string as "ref":',
        '{"verdicts":[{"ref":"<id, e.g. codex#0>","stance":"refute|concede|abstain","reason":"one line"}]}',
        '- refute = wrong, not real, or not actionable.',
        '- concede = a real issue worth fixing.',
        '- abstain = cannot judge from the provided evidence.',
      ].join('\n') },
    ]);
    const out = watchFrame(4);
    expect(out).toContain("prompt echoed — waiting for the model's answer");
    expect(out).not.toContain('Return ONLY a JSON object'); // the echo itself is suppressed
  });

  test('a still-streaming findings object shows live progress, not truncated JSON', () => {
    seedTailRun('panel-tailpartial-fixture', [
      { label: 'agy', state: 'running', stdout_tail: '{"findings":[{"severity":"low","file":"a.js","line":1,"claim":"first","evidence":"e"},{"severity":"low","file":"b.js","line":2,"claim":"second","evi' },
    ]);
    const out = watchFrame(4);
    expect(out).toContain('2 findings so far');   // counted from the unterminated object
    expect(out).not.toContain('"evidence"');      // no raw JSON fragments
  });

  // stdout_tail keeps only the last 4000 chars, so a model whose answer is bigger (kiro emits
  // ~6.6KB) loses the `{"findings":[` opener — the board used to dump its raw JSON at the user.
  test('a head-truncated findings tail still renders findings, not raw JSON (kiro regression)', () => {
    const finding = (i) => `{"severity":"medium","file":"internal/cli/fleet.go","line":null,"claim":"issue ${i}","evidence":"e"}`;
    seedTailRun('panel-tailcut-fixture', [
      // what the 4000-char window actually holds: mid-object garbage, then whole findings, then `]}`
      { label: 'kiro', stdout_bytes: 6614, stdout_tail: `de.  ${'x'.repeat(20)}"},\n${[1, 2].map(finding).join(',\n')}\n]}` },
    ]);
    const out = watchFrame(4);
    expect(out).toContain('[medium] internal/cli/fleet.go');
    expect(out).toContain('issue 1');
    expect(out).not.toContain('{"severity"'); // the raw dump is gone
  });

  // codex/claude carry the answer inside a JSON string; truncation can cut the envelope line's
  // head, leaving only its escaped fragment. That is still an answer, not "working".
  test('a head-truncated ESCAPED envelope fragment renders findings, not a false "working" note', () => {
    seedTailRun('panel-tailesc-fixture', [
      { label: 'codex', state: 'running', stdout_bytes: 9000, stdout_tail:
        '{"type":"turn.started"}\ntext\":\"{\\"findings\\": [{\\"severity\\":\\"high\\",\\"file\\":\\"a.js\\",\\"line\\":3,\\"claim\\":\\"escaped survivor\\"}]}' },
    ]);
    const out = watchFrame(4);
    expect(out).toContain('[high] a.js:3');
    expect(out).toContain('escaped survivor');
    expect(out).not.toContain('no findings emitted yet');
  });

  // x-review fans one panel out PER LENS, so two runs of the same project+target are live at the
  // same time. Without the lens tag (and the run id) the board printed two identical rows and the
  // operator read it as a duplicate / double-spend.
  test('concurrent lens runs of one target are told apart by lens tag + run id', () => {
    const seed = (run, lens) => {
      const d = join(SDIR, '.xm', 'review', run);
      mkdirSync(d, { recursive: true });
      seededTails.push(d);
      writeFileSync(join(d, 'status.json'), JSON.stringify({
        run, phase: 'round1 (review)', target_kind: 'file', target_title: 'Review target.diff',
        lens_tag: lens, updated_at: new Date().toISOString(),
        models: [{ label: 'kiro', state: 'running', elapsed_s: 5, updated_at: new Date().toISOString() }],
      }));
    };
    seed('panel-20260713-095008-731', 'security');
    seed('panel-20260713-095016-619', 'logic');
    const out = watchFrame(0);
    expect(out).toContain('x-review(file · security)');
    expect(out).toContain('x-review(file · logic)');
    expect(out).toContain('095008-731'); // the run id disambiguates even same-lens reruns
    expect(out).toContain('095016-619');
  });

  // A claim containing a newline or a quote arrives DOUBLE-escaped inside the envelope's JSON
  // string (\\n, \\"). Unescaping `\\n`→newline before `\\`→backslash corrupted it into invalid
  // JSON, so the finding was dropped and the raw dump came back — the exact bug this change set
  // set out to kill. Raised by the panel's own claude+codex reviewers on this diff.
  test('a double-escaped claim (newline/quote inside the text) still parses out of an envelope', () => {
    // outer envelope string: the inner JSON is escaped once, the claim's own \n / " escaped twice
    const inner = '{\\"findings\\": [{\\"severity\\":\\"high\\",\\"file\\":\\"a.js\\",\\"line\\":3,\\"claim\\":\\"line one\\\\nline \\\\\\"two\\\\\\"\\"}]}';
    seedTailRun('panel-tailesc2-fixture', [
      { label: 'codex', state: 'running', stdout_bytes: 9000, stdout_tail: `{"type":"turn.started"}\ntext":"${inner}` },
    ]);
    const out = watchFrame(4);
    expect(out).toContain('[high] a.js:3');
    expect(out).toContain('line one');   // survived the unescape…
    expect(out).not.toContain('\\n');    // …and no escape sequence leaked into the board
  });

  // Our own contract TEMPLATE is item-shaped ("severity":"critical|high|medium|low"), so a vendor
  // echoing the prompt into its stream must not have it salvaged as a real finding.
  test('the echoed contract template is never salvaged as a finding', () => {
    seedTailRun('panel-tailtmpl-fixture', [
      { label: 'codex', state: 'running', stdout_bytes: 9000, stdout_tail:
        '{"type":"turn.started"}\ntext":"…{\\"severity\\":\\"critical|high|medium|low\\",\\"file\\":\\"path\\",\\"claim\\":\\"one line\\"}' },
    ]);
    const out = watchFrame(4);
    expect(out).not.toContain('one line');            // the template is not an answer
    expect(out).toContain('no findings emitted yet'); // still working, honestly reported
  });

  // A Korean glyph occupies TWO terminal columns. Counting it as one made every line twice its
  // assumed width → the terminal soft-wrapped it → paintFrame's line-by-line overwrite landed on
  // the wrong rows and shredded the board.
  test('a wide-glyph (Korean) finding is cut to the terminal width, never left to wrap', () => {
    const cols = (s) => [...s.replace(/\x1b\[[0-9;?]*m/g, '')] // eslint-disable-line no-control-regex
      .reduce((w, ch) => w + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠]/.test(ch) ? 2 : 1), 0);
    const claim = '폴 자체의 실측 소요시간에 비례해 다음 폴을 미루는 듀티사이클 거버너가 정답이다'.repeat(3);
    seedTailRun('panel-tailwide-fixture', [
      { label: 'agy', stdout_tail: `{"findings":[{"severity":"medium","file":"internal/cli/fleet.go","line":1457,"claim":"${claim}","evidence":"e"}]}` },
    ]);
    const out = watchFrame(4);
    const finding = out.split('\n').find((l) => l.includes('internal/cli/fleet.go:1457'));
    expect(finding).toBeDefined();
    expect(cols(finding)).toBeLessThanOrEqual(100); // the non-TTY default terminal width
    expect(finding).toContain('…');                 // cut, and it reads as a cut
  });

  test('more findings than --lines collapses the overflow into a "+N more" line', () => {
    const finding = (i) => `{"severity":"low","file":"f${i}.js","line":${i},"claim":"issue ${i}","evidence":"e"}`;
    seedTailRun('panel-tailmore-fixture', [
      { label: 'agy', stdout_tail: `{"findings":[${[1, 2, 3, 4, 5].map(finding).join(',')}]}` },
    ]);
    const out = watchFrame(4);
    expect(out).toContain('issue 3');    // budget-1 findings shown…
    expect(out).toContain('+2 more');    // …the rest collapsed, not silently dropped
    expect(out).not.toContain('issue 4');
  });

  test('--lines 1 with many findings emits ONE count line, not finding+overflow (budget breach)', () => {
    const finding = (i) => `{"severity":"low","file":"f${i}.js","line":${i},"claim":"issue ${i}","evidence":"e"}`;
    seedTailRun('panel-tailone-fixture', [
      { label: 'agy', stdout_tail: `{"findings":[${[1, 2, 3].map(finding).join(',')}]}` },
    ]);
    const out = watchFrame(1);
    expect(out).toContain('3 findings — issue 1'); // single collapsed line
    expect(out).not.toContain('+2 more');          // no second overflow line
  });

  test('a null element in the findings array must not crash the watch loop (live-crash regression)', () => {
    seedTailRun('panel-tailnull-fixture', [
      { label: 'agy', stdout_tail: '{"findings":[null,{"severity":"low","file":"a.js","line":1,"claim":"the real one","evidence":"e"}]}' },
    ]);
    const out = watchFrame(4);
    expect(out).toContain('[low] a.js:1');        // surviving finding still renders
    expect(out).toContain('the real one');
    expect(out).not.toContain('TypeError');       // no crash, no stack trace
  });

  test('JSON-escaped ANSI in decoded fields never reaches the terminal (reinjection)', () => {
    const ESCB = String.fromCharCode(27);
    seedTailRun('panel-tailansi-fixture', [
      //  inside the JSON string survives the raw-text ANSI strip as a 6-char literal,
      // then JSON.parse decodes it into a REAL escape byte — cleanField must remove it.
      { label: 'agy', stdout_tail: '{"findings":[{"severity":"low","file":"a.js\\u001b[2J","line":1,"claim":"x \\u001b[31mINJECTED\\u001b[0m y","evidence":"e"}]}' },
    ]);
    const out = watchFrame(4);
    expect(out).toContain('INJECTED');            // text content survives…
    expect(out).not.toContain(ESCB);              // …but no escape byte does (NO_COLOR run)
  });

  test('a real answer QUOTING a contract fragment is not mistaken for prompt echo', () => {
    seedTailRun('panel-tailquote-fixture', [
      { label: 'codex', stdout_tail: '{"findings":[{"severity":"low","file":"p.mjs","line":3,"claim":"echoes Return ONLY a JSON object in help text","evidence":"e"}]}' },
    ]);
    const out = watchFrame(4);
    expect(out).toContain('[low] p.mjs:3');       // parsed as an answer…
    expect(out).not.toContain('prompt echoed');   // …not dropped as echo
  });

  test('PROSE output quoting ONE contract phrase keeps everything (2-marker echo rule)', () => {
    seedTailRun('panel-tailprose-fixture', [
      { label: 'codex', state: 'running', stdout_tail: [
        'the docs say - concede = a real issue worth fixing here',  // 1 marker line = a quote, not echo
        'now tracing the diff for real problems',
      ].join('\n') },
    ]);
    const out = watchFrame(4);
    expect(out).toContain('the docs say');                     // content BEFORE the quote survives
    expect(out).toContain('now tracing the diff');
    expect(out).not.toContain('prompt echoed');
  });

  test('--watch --json tails are echo-dropped but verbatim (machines parse the JSON themselves)', () => {
    seedTailRun('panel-tailjson-fixture', [
      { label: 'codex', stdout_tail: 'Return ONLY a JSON object, with no prose before or after:\nIf there are no real issues, return {"findings":[]}.\n{"findings":[]}' },
    ]);
    const r = spawnSync('node', [CLI, 'status', '--watch', '--json', '--lines', '4', '--interval', '1'],
      { cwd: DIR, env: STUB_ENV(statusEnv()), encoding: 'utf8', timeout: 2500 });
    const snap = JSON.parse(r.stdout.trim().split('\n')[0]);
    const run = snap.live.find((x) => x.run === 'panel-tailjson-fixture');
    expect(run.models[0].tail).toEqual(['{"findings":[]}']); // echo gone, answer verbatim
  });

  test('status <run> detail also interprets the tail (findings summary instead of a JSON dump)', () => {
    seedTailRun('panel-taildetail-fixture', [
      { label: 'agy', stdout_tail: '{"findings":[{"severity":"high","file":"lib/x.mjs","line":9,"claim":"Detail view claim","evidence":"e"}]}' },
    ]);
    const r = panelRaw(['status', 'panel-taildetail-fixture'], statusEnv());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[high] lib/x.mjs:9');
    expect(r.stdout).toContain('Detail view claim');
    expect(r.stdout).not.toContain('{"findings"');
  });

  test('codex JSONL and claude result-envelope tails are unwrapped to findings, not dumped raw', () => {
    const codexFindings = JSON.stringify({ findings: [{ severity: 'high', file: 'a.js', line: 1, claim: 'CODEX_CLAIM', evidence: 'e' }] });
    const claudeFindings = JSON.stringify({ findings: [{ severity: 'medium', file: 'b.js', line: 2, claim: 'CLAUDE_CLAIM', evidence: 'e' }] });
    seedTailRun('panel-tailenvelope-fixture', [
      // codex streams a JSONL event stream — the answer rides inside item.completed.text
      { label: 'codex', stdout_tail: [
        JSON.stringify({ type: 'thread.started', thread_id: 't' }),
        JSON.stringify({ type: 'turn.started' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: codexFindings } }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }),
      ].join('\n') },
      // claude prints a single result envelope carrying the answer in .result
      { label: 'claude', stdout_tail: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: claudeFindings }) },
    ]);
    const r = panelRaw(['status', 'panel-tailenvelope-fixture'], statusEnv());
    expect(r.status).toBe(0);
    // interpreted like cursor, not dumped as raw envelope JSON
    expect(r.stdout).toContain('CODEX_CLAIM');
    expect(r.stdout).toContain('[high] a.js:1');
    expect(r.stdout).toContain('CLAUDE_CLAIM');
    expect(r.stdout).toContain('[medium] b.js:2');
    expect(r.stdout).not.toContain('"type":"thread.started"');
    expect(r.stdout).not.toContain('"type":"result"');
  });

  test('a codex tail with only plumbing events (no message yet) shows "working", not raw JSONL', () => {
    seedTailRun('panel-tailworking-fixture', [
      { label: 'codex', state: 'running', stdout_tail: [
        JSON.stringify({ type: 'thread.started', thread_id: 't' }),
        JSON.stringify({ type: 'turn.started' }),
      ].join('\n') },
    ]);
    const r = panelRaw(['status', 'panel-tailworking-fixture'], statusEnv());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('working');
    expect(r.stdout).not.toContain('"type":"thread.started"');
  });

  test('a result envelope preceded by other JSON events is still unwrapped (l6, not first-brace)', () => {
    const findings = JSON.stringify({ findings: [{ severity: 'high', file: 'z.js', line: 3, claim: 'PRE_ENVELOPE_CLAIM', evidence: 'e' }] });
    seedTailRun('panel-tailpre-fixture', [
      { label: 'claude', stdout_tail: [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),   // emitted BEFORE the result
        JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: findings }),
      ].join('\n') },
    ]);
    const r = panelRaw(['status', 'panel-tailpre-fixture'], statusEnv());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PRE_ENVELOPE_CLAIM'); // the result object was located, not the first '{'
    expect(r.stdout).not.toContain('"type":"system"');
  });

  test('a kiro-style ANSI-colorized findings tail renders interpreted, not raw (l8)', () => {
    const findings = JSON.stringify({ findings: [{ severity: 'medium', file: 'k.js', line: 5, claim: 'KIRO_TAIL_CLAIM', evidence: 'e' }] });
    seedTailRun('panel-tailansi-fixture', [
      { label: 'kiro', stdout_tail: '\x1b[38;5;141m> \x1b[0m' + findings + '\x1b[0m' },
    ]);
    const r = panelRaw(['status', 'panel-tailansi-fixture'], statusEnv());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('KIRO_TAIL_CLAIM');
    expect(r.stdout).toContain('[medium] k.js:5');
    expect(r.stdout).not.toContain('\x1b['); // ANSI stripped from the rendered line's content
  });

  test('status <run> --watch live-tails that run (loops the detail, not a one-shot)', () => {
    const d = join(SDIR, '.xm', 'panel', 'panel-runwatch-fixture');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'status.json'), JSON.stringify({
      run: 'panel-runwatch-fixture', phase: 'round1 (review)', target_kind: 'literal', target_title: 'seed',
      updated_at: new Date().toISOString(), models: [{ label: 'claude', state: 'running', elapsed_s: 5 }],
    }));
    const r = spawnSync('node', [CLI, 'status', 'panel-runwatch-fixture', '--watch', '--interval', '1'],
      { cwd: DIR, env: STUB_ENV(statusEnv()), encoding: 'utf8', timeout: 2500 });
    // A one-shot would EXIT before the timeout (signal null); a live loop is still running and gets
    // SIGTERM'd — load-independent proof that <run> --watch keeps polling (regression stays fixed).
    expect(r.signal).toBe('SIGTERM');
    expect(r.stdout).toContain('panel-runwatch-fixture'); // it did render the detail at least once
  });

  test('--lines with no numeric value does not swallow the next flag', () => {
    seedRun('panel-lines-parse-fixture', new Date().toISOString());
    const r = panelRaw(['status', '--lines', '--all', '--json'], statusEnv());
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    // if --lines had eaten --all, this would be the flat single-project rows array; instead it's the
    // grouped --all shape ([{project, runs}]) → --all survived.
    expect(out[0]).toHaveProperty('runs');
    expect(out[0]).toHaveProperty('project');
  });

  test('watching a nonexistent run shows a clean "waiting" line, not a looping error', () => {
    const r = spawnSync('node', [CLI, 'status', 'panel-does-not-exist', '--watch', '--interval', '1'],
      { cwd: DIR, env: STUB_ENV(statusEnv()), encoding: 'utf8', timeout: 2000 });
    expect(r.stdout).toContain('waiting for panel-does-not-exist');
    expect(r.stdout).not.toContain('run not found'); // no red error spam
  });

  // Rich progress fixture: one model done, one mid-flight with the live signals a stream
  // run writes (phase_label, tokens, cost, updated_at) — what the board must surface.
  const seedProgressRun = (run) => {
    const d = join(SDIR, '.xm', 'panel', run);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'status.json'), JSON.stringify({
      run, phase: 'round1 (review)', target_kind: 'git-diff', target_title: 'diff: a.js',
      updated_at: new Date().toISOString(),
      models: [
        { label: 'claude', state: 'done', elapsed_s: 30 },
        { label: 'codex', state: 'running', elapsed_s: 45, phase_label: 'responding', stdout_bytes: 2130,
          tokens: { input: 9000, output: 3300 }, cost_usd: 0.12, updated_at: new Date().toISOString(),
          stdout_tail: 'YYMARKER live tail line' },
      ],
    }));
  };

  test('--watch board shows round progress + live phase/tokens/cost per agent', () => {
    seedProgressRun('panel-progress-fixture');
    const r = spawnSync('node', [CLI, 'status', '--watch', '--lines', '1', '--interval', '1'],
      { cwd: DIR, env: STUB_ENV(statusEnv()), encoding: 'utf8', timeout: 2500 });
    expect(r.stdout).toContain('1/2 done');            // round progress in the run header
    expect(r.stdout).toContain('responding');          // live phase of the running agent
    expect(r.stdout).toContain('12.3k tok');           // live token usage
    expect(r.stdout).toContain('$0.12');               // live cost
    expect(r.stdout).toContain('YYMARKER live tail line'); // --lines content still renders
  });

  test('--watch --json emits one compact JSONL board snapshot per tick (agent-consumable)', () => {
    seedProgressRun('panel-jsonwatch-fixture');
    const r = spawnSync('node', [CLI, 'status', '--watch', '--json', '--lines', '1', '--interval', '1'],
      { cwd: DIR, env: STUB_ENV(statusEnv()), encoding: 'utf8', timeout: 2500 });
    const lines = r.stdout.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const snap = JSON.parse(lines[0]);                 // parses → compact, no ANSI/clear codes
    const run = snap.live.find((x) => x.run === 'panel-jsonwatch-fixture');
    expect(run.progress).toEqual({ done: 1, total: 2 });
    const codex = run.models.find((m) => m.label === 'codex');
    expect(codex.state).toBe('running');
    expect(codex.phase_label).toBe('responding');
    expect(codex.cost_usd).toBe(0.12);
    expect(codex.tokens.output).toBe(3300);
    expect(codex.tail).toEqual(['YYMARKER live tail line']); // --lines flows into JSON too
  });

  test('run-scoped --watch --json ends with exit 0 when the run is done', () => {
    const d = join(SDIR, '.xm', 'panel', 'panel-jsondone-fixture');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'status.json'), JSON.stringify({
      run: 'panel-jsondone-fixture', phase: 'done', target_kind: 'literal', target_title: 'seed',
      updated_at: new Date().toISOString(), models: [{ label: 'claude', state: 'done', elapsed_s: 12 }],
    }));
    const r = spawnSync('node', [CLI, 'status', 'panel-jsondone-fixture', '--watch', '--json', '--interval', '1'],
      { cwd: DIR, env: STUB_ENV(statusEnv()), encoding: 'utf8', timeout: 5000 });
    expect(r.signal).toBe(null);   // exited on its own — the stream ENDS for a consumer
    expect(r.status).toBe(0);
    const last = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop());
    expect(last.done).toBe(true);
    expect(last.phase).toBe('done');
  });

  test('run-scoped --watch --json exits 1 when the run is stalled (dead process)', () => {
    seedRun('panel-jsonstalled-fixture', '2020-01-01T00:00:00.000Z'); // ancient heartbeat
    const r = spawnSync('node', [CLI, 'status', 'panel-jsonstalled-fixture', '--watch', '--json', '--interval', '1'],
      { cwd: DIR, env: STUB_ENV(statusEnv()), encoding: 'utf8', timeout: 5000 });
    expect(r.signal).toBe(null);
    expect(r.status).toBe(1);      // stalled ≠ done — no more progress will ever arrive
    const last = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop());
    expect(last.stale).toBe(true);
  });

  test('lens-injected runs under .xm/review/ are visible to status + watch (the x-review namespace)', () => {
    // x-review's cross-vendor reviews write to .xm/review/<run>/ (not .xm/panel/) — a live one
    // must appear on the board, not be invisible (the aic-rust bug).
    const d = join(SDIR, '.xm', 'review', 'panel-xreview-fixture');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'status.json'), JSON.stringify({
      run: 'panel-xreview-fixture', phase: 'round1 (review)', target_kind: 'file', target_title: 'Review PLAN.md',
      updated_at: new Date().toISOString(),
      models: [{ label: 'claude', state: 'running', elapsed_s: 20 }],
    }));
    // list: present, namespace-labeled
    const list = panelRaw(['status', '--json'], statusEnv());
    const row = JSON.parse(list.stdout).find((x) => x.run === 'panel-xreview-fixture');
    expect(row).toBeDefined();
    expect(row.source).toBe('x-review(file)');       // distinguishable from native "review(file)"
    expect(row.phase).toBe('round1 (review)');       // live, not stalled
    // detail lookup resolves the review namespace
    const detail = panelRaw(['status', 'panel-xreview-fixture', '--json'], statusEnv());
    expect(detail.status).toBe(0);
    expect(JSON.parse(detail.stdout).status.run).toBe('panel-xreview-fixture');
    // watch board picks it up as a live run
    const w = spawnSync('node', [CLI, 'status', '--watch', '--json', '--interval', '1'],
      { cwd: DIR, env: STUB_ENV(statusEnv()), encoding: 'utf8', timeout: 2500 });
    const snap = JSON.parse(w.stdout.trim().split('\n')[0]);
    expect(snap.live.some((x) => x.run === 'panel-xreview-fixture')).toBe(true);
  });

  test('status <run> detail + --watch --json surface round-2 fidelity counters', () => {
    const d = join(SDIR, '.xm', 'panel', 'panel-fidelity-fixture');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'status.json'), JSON.stringify({
      run: 'panel-fidelity-fixture', phase: 'done', target_kind: 'literal', target_title: 'seed',
      updated_at: new Date().toISOString(),
      models: [{ label: 'codex', state: 'done', elapsed_s: 9, unmatched_refs: 2, invalid_stances: 1 }],
    }));
    const detail = panelRaw(['status', 'panel-fidelity-fixture'], statusEnv());
    expect(detail.status).toBe(0);
    expect(detail.stdout).toContain('2 unmatched ref(s)');
    expect(detail.stdout).toContain('1 invalid stance(s)');
    const w = spawnSync('node', [CLI, 'status', 'panel-fidelity-fixture', '--watch', '--json', '--interval', '1'],
      { cwd: DIR, env: STUB_ENV(statusEnv()), encoding: 'utf8', timeout: 5000 });
    const last = JSON.parse(w.stdout.trim().split('\n').filter(Boolean).pop());
    expect(last.models[0].unmatched_refs).toBe(2);
    expect(last.models[0].invalid_stances).toBe(1);
  });

  test('run-scoped text --watch also ends when the run is done', () => {
    const d = join(SDIR, '.xm', 'panel', 'panel-textdone-fixture');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'status.json'), JSON.stringify({
      run: 'panel-textdone-fixture', phase: 'done', target_kind: 'literal', target_title: 'seed',
      updated_at: new Date().toISOString(), models: [{ label: 'claude', state: 'done', elapsed_s: 12 }],
    }));
    const r = spawnSync('node', [CLI, 'status', 'panel-textdone-fixture', '--watch', '--interval', '1'],
      { cwd: DIR, env: STUB_ENV(statusEnv()), encoding: 'utf8', timeout: 5000 });
    expect(r.signal).toBe(null);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('watch ended');
  });

  // ── cross heartbeat (A1): cross runs write a live status.json like review ──

  test('cross writes a status.json heartbeat and marks it done at the end', () => {
    const r = panelRaw(['cross', '--models', 'claude,codex', '--prompt', 'heartbeat probe', '--source', 'op:debate', '--json'], statusEnv());
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    const st = JSON.parse(readFileSync(join(SDIR, '.xm', 'cross', out.run, 'status.json'), 'utf8'));
    expect(st.phase).toBe('done');
    expect(st.source).toBe('op:debate');            // provenance available in the live file
    expect(st.models.every((m) => m.state === 'done')).toBe(true);
    expect(st.models[0].stdout_bytes).toBeGreaterThan(0); // provider output was observed live
  });

  test('a live cross heartbeat appears on the watch board with per-model progress + tails', () => {
    const d = join(SDIR, '.xm', 'cross', 'panel-crosslive-fixture');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'status.json'), JSON.stringify({
      run: 'panel-crosslive-fixture', kind: 'cross', source: 'op:council', title: 'live cross probe',
      phase: 'running', updated_at: new Date().toISOString(),
      models: [
        { label: 'claude', state: 'done', elapsed_s: 20 },
        { label: 'codex', state: 'running', elapsed_s: 33, stdout_bytes: 512,
          stdout_tail: 'XXMARKER cross tail', updated_at: new Date().toISOString() },
      ],
    }));
    const list = panelRaw(['status', '--json'], statusEnv());
    const row = JSON.parse(list.stdout).find((x) => x.run === 'panel-crosslive-fixture');
    expect(row.phase).toBe('running');
    expect(row.source).toBe('op:council');           // source visible MID-run (was result.json-only)
    expect(row.models.find((m) => m.label === 'codex').elapsed_s).toBe(33);
    const w = spawnSync('node', [CLI, 'status', '--watch', '--json', '--lines', '1', '--interval', '1'],
      { cwd: DIR, env: STUB_ENV(statusEnv()), encoding: 'utf8', timeout: 2500 });
    const snap = JSON.parse(w.stdout.trim().split('\n')[0]);
    const live = snap.live.find((x) => x.run === 'panel-crosslive-fixture');
    expect(live.progress).toEqual({ done: 1, total: 2 });
    expect(live.models.find((m) => m.label === 'codex').tail).toEqual(['XXMARKER cross tail']);
  });

  test('a cross heartbeat older than 30s marks the run stalled (review-grade staleness)', () => {
    const d = join(SDIR, '.xm', 'cross', 'panel-crossstale-fixture');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'status.json'), JSON.stringify({
      run: 'panel-crossstale-fixture', kind: 'cross', phase: 'running',
      updated_at: '2020-01-01T00:00:00.000Z', // ancient heartbeat, but the dir mtime is NOW
      models: [{ label: 'claude', state: 'running', elapsed_s: 5 }],
    }));
    const list = panelRaw(['status', '--json'], statusEnv());
    const row = JSON.parse(list.stdout).find((x) => x.run === 'panel-crossstale-fixture');
    expect(row.phase).toBe('stalled');               // updated_at rule wins over the mtime guess
    expect(row.stale).toBe(true);
  });
});

// ── integration: full panel flow via stubs ───────────────────────────

describe('review (stubbed models)', () => {
  test('runs both rounds and writes verdict.json', () => {
    const r = review(['some code change']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Panel verdict');
    const v = latestVerdict();
    // stub scenario: codex refutes the shared finding claude raised → 1 contested
    expect(v.counts.confirmed).toBe(3);
    expect(v.counts.contested).toBe(1);
  });

  test('surfaces cross-model diversity (each model has a unique confirmed finding)', () => {
    const v = latestVerdict();
    const claims = v.confirmed.map(f => f.claim);
    expect(claims).toContain('claude-only issue');
    expect(claims).toContain('codex-only issue');
  });

  test('verdict includes merged consensus and unique count', () => {
    const v = latestVerdict();
    expect(Array.isArray(v.consensus)).toBe(true);
    expect(v.counts.unique).toBe(v.consensus.length);
  });

  test('verdict + status carry a meaningful target_title (not the run id)', () => {
    const r = review(['Find SQL injection and N+1 issues']);
    expect(r.status).toBe(0);
    const v = latestVerdict();
    expect(v.target_title).toBe('Find SQL injection and N+1 issues'); // literal target
    const st = JSON.parse(readFileSync(join(latestRunDir(), 'status.json'), 'utf8'));
    expect(st.target_title).toBe(v.target_title); // live status carries it too
  });

  test('literal target_title redacts secrets before storing/displaying it', () => {
    const r = review(['review this api_key=sk-abcdef1234567890 leak']);
    expect(r.status).toBe(0);
    const v = latestVerdict();
    expect(v.target_title).not.toContain('sk-abcdef1234567890'); // secret never reaches the title
    expect(v.target_title).toContain('[redacted]');
  });

  test('literal target_title redacts BEFORE truncating (secret straddling the 80-char cut)', () => {
    // Secret positioned so truncate-then-redact would slice it to a fragment too short for the
    // redaction regex; redact-then-truncate must catch the whole secret regardless of position.
    const r = review(['x'.repeat(72) + ' sk-DEADBEEFCAFE1234567890 tail']);
    expect(r.status).toBe(0);
    expect(latestVerdict().target_title).not.toContain('sk-DEADBEEF'); // no leaked fragment
  });

  test('git-diff target_title summarizes the diff (not a timestamp)', () => {
    writeProjectConfig({ models: ['claude', 'codex'] });
    // no target → git diff HEAD; DIR is not a repo → empty-diff sentinel, so --force
    // is required (the trivial-target guard exits 2 without it — tested separately).
    const r = panelRaw(['review', '--force']);
    expect(r.status).toBe(0);
    expect(latestVerdict().target_title).toMatch(/^(diff:|git diff)/);
  });

  test('writes live status.json (phase done) after run', () => {
    const r = review(['some target for status']);
    expect(r.status).toBe(0);
    const st = JSON.parse(readFileSync(join(latestRunDir(), 'status.json'), 'utf8'));
    expect(st.phase).toBe('done');
    expect(st.models.length).toBeGreaterThan(0);
  });

  test('writes event log and model output tails for dashboard live view', () => {
    const r = review(['some target for events']);
    expect(r.status).toBe(0);
    const dir = latestRunDir();
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(events.some((ev) => ev.type === 'run_start')).toBe(true);
    expect(events.some((ev) => ev.type === 'stdout' && ev.model === 'claude')).toBe(true);
    expect(events.some((ev) => ev.type === 'round_file_written' && ev.round === 1)).toBe(true);

    const st = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'));
    const claude = st.models.find((m) => m.label === 'claude');
    expect(claude.last_event).toBeTruthy();
    expect(typeof claude.stdout_tail).toBe('string');
    expect(claude.stdout_bytes).toBeGreaterThan(0);
  });

  test('--stream: findings still extracted from envelope AND usage/cost captured', () => {
    const r = review(['stream target', '--stream']);
    expect(r.status).toBe(0);
    const v = latestVerdict();
    // core job intact: same consensus as the non-stream run
    expect(v.counts.confirmed).toBe(3);
    expect(v.counts.contested).toBe(1);
    // Bet B: usage captured and a panel total accumulated (claude reports USD directly)
    expect(v.stream).toBe(true);
    expect(v.usage.totals.cost_usd).toBeGreaterThan(0);
    expect(v.usage.totals.tokens.output).toBeGreaterThan(0);
    expect(v.usage.by_model.claude.cost_usd).toBeGreaterThan(0);
  });

  test('--stream events.jsonl stays milestone-only (no per-delta text spam)', () => {
    const r = review(['stream events target', '--stream']);
    expect(r.status).toBe(0);
    const events = readFileSync(join(latestRunDir(), 'events.jsonl'), 'utf8')
      .trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(events.some((ev) => ev.type === 'usage_final')).toBe(true);
    expect(events.some((ev) => ev.type === 'text')).toBe(false);      // deltas excluded
    expect(events.some((ev) => ev.type === 'thinking')).toBe(false);
  });

  test('--stream auto-disables partial on a large target; --partial forces it on', () => {
    const big = 'x'.repeat(60_000); // > default partial_max_chars (50000)
    const r1 = review([big, '--stream']);
    expect(r1.status).toBe(0);
    expect(latestVerdict().partial).toBe(false); // auto-off on large input

    const r2 = review([big, '--stream', '--partial']);
    expect(r2.status).toBe(0);
    expect(latestVerdict().partial).toBe(true);  // explicit --partial overrides auto-off
  });

  test('small --stream target keeps partial on', () => {
    const r = review(['small target', '--stream']);
    expect(r.status).toBe(0);
    expect(latestVerdict().partial).toBe(true);
  });

  test('timeout auto-raises for large targets; --timeout pins it', () => {
    const r0 = review(['small t', '--stream']);
    expect(r0.status).toBe(0);
    expect(latestVerdict().timeout_s).toBe(600); // base, small target

    const big = 'x'.repeat(60_000);
    const r1 = review([big, '--stream']);
    expect(r1.status).toBe(0);
    expect(latestVerdict().timeout_s).toBeGreaterThan(600); // auto-raised

    const r2 = review([big, '--stream', '--timeout', '120']);
    expect(r2.status).toBe(0);
    expect(latestVerdict().timeout_s).toBe(120); // explicit --timeout pins, no auto-raise
  });

  test('timeout auto-raise is capped by panel.timeout_max_s', () => {
    writeProjectConfig({ timeout_max_s: 700 }); // cap must sit above the 600s base to bind the raise
    const big = 'x'.repeat(60_000);
    const r = panelRaw(['review', big, '--stream', '--models', 'claude,codex']);
    expect(r.status).toBe(0);
    expect(latestVerdict().timeout_s).toBe(700); // 600 base + size-raise → capped at 700
  });

  test('--stream: a non-zero exit is a failure even if JSON was emitted', () => {
    // codex stub emits valid findings JSON then exits 1 → must be reported failed, not parsed-ok
    const r = review(['exit-code target', '--stream'], { X_PANEL_EXIT1_CODEX: '1' });
    expect(r.status).toBe(0);
    const dir = latestRunDir();
    const r1 = JSON.parse(readFileSync(join(dir, 'codex.r1.json'), 'utf8'));
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain('exit 1');
  });

  test('--stream: envelope-only output (no findings) is a failure, not false success', () => {
    // codex stub emits only {"type":"system"}/{"type":"stream_event"} — no findings.
    const r = review(['envelope target', '--stream'], { X_PANEL_ENVELOPE_ONLY_CODEX: '1' });
    expect(r.status).toBe(0);
    const r1 = JSON.parse(readFileSync(join(latestRunDir(), 'codex.r1.json'), 'utf8'));
    expect(r1.ok).toBe(false); // shape-guard rejects the envelope object
    expect(r1.error).toContain('no findings JSON'); // round-1 contract error names the missing key
    expect(r1.r1_status).toBe('failed'); // and the failure is typed for the verdict
    const v = latestVerdict();
    expect(v.by_model.codex.r1).toBe('failed'); // never silently raised:0 (mem-mesh ed2ff3e3)
    expect(v.counts.r1_failed).toBe(1);
  });

  test('prose review + empty contract echo → suspect_empty in verdict, warned in render', () => {
    // The agy failure shape (mem-mesh ed2ff3e3): the model reviews in prose and only
    // echoes {"findings":[]} — parses as ok=true/0 findings, which must NOT read as
    // "reviewed and found nothing".
    const r = review(['prose empty target'], { X_PANEL_PROSE_EMPTY_CLAUDE: '1' });
    expect(r.status).toBe(0);
    const r1 = JSON.parse(readFileSync(join(latestRunDir(), 'claude.r1.json'), 'utf8'));
    expect(r1.ok).toBe(true);
    expect(r1.findings.length).toBe(0);
    expect(r1.r1_status).toBe('suspect_empty');
    const v = latestVerdict();
    expect(v.by_model.claude.r1).toBe('suspect_empty');
    expect(v.counts.r1_suspect).toBe(1);
    expect(r.stdout).toContain('0 findings but substantial prose'); // render warns the operator
  });

  test('a mangled-ref refuter is surfaced end-to-end (verdict counters + render + status.json)', () => {
    // codex hallucinates every ref index → its verdicts address nothing. claude's findings
    // must land UNREVIEWED (not silently confirmed), and the fidelity counters must be
    // visible in verdict.json, the terminal summary, and the live status file.
    const r = review(['mangled refs target'], { X_PANEL_MANGLE_REFS_CODEX: '1' });
    expect(r.status).toBe(0);
    const v = latestVerdict();
    expect(v.by_model.codex.unmatched_refs).toBe(2);
    expect(v.counts.unreviewed).toBe(2); // claude's 2 findings were never addressed…
    expect(v.confirmed.every((f) => f.owner !== 'claude')).toBe(true); // …and never confirmed
    expect(r.stdout).toContain('round-2 fidelity'); // terminal summary warns the operator
    const st = JSON.parse(readFileSync(join(latestRunDir(), 'status.json'), 'utf8'));
    expect(st.models.find((m) => m.label === 'codex').unmatched_refs).toBe(2); // status/--watch surface
  });

  test('--stream accumulates token-level deltas into the live stdout_tail', () => {
    const r = review(['delta tail target', '--stream']);
    expect(r.status).toBe(0);
    const st = JSON.parse(readFileSync(join(latestRunDir(), 'status.json'), 'utf8'));
    // claude stub emits the payload as several text_delta chunks → tail holds the assembled text
    const claude = st.models.find((m) => m.label === 'claude');
    expect(claude.stdout_tail.length).toBeGreaterThan(0);
    expect(claude.stdout_tail).toContain('verdicts'); // round2 payload assembled from deltas
  });

  test('writes a model round file as soon as that model finishes', async () => {
    const panelDir = join(DIR, '.xm', 'panel');
    const before = new Set(existsSync(panelDir) ? readdirSync(panelDir) : []);
    const child = spawn('node', [CLI, 'review', '--models', 'claude,codex', 'slow target'], {
      cwd: DIR,
      env: STUB_ENV({ X_PANEL_DELAY_R1_CODEX_MS: '4000' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    try {
      const partialDir = await waitFor(() => {
        if (!existsSync(panelDir)) return null;
        const runs = readdirSync(panelDir).filter(n => n.startsWith('panel-') && !before.has(n)).sort();
        for (const run of runs) {
          const dir = join(panelDir, run);
          if (existsSync(join(dir, 'claude.r1.json')) && !existsSync(join(dir, 'codex.r1.json'))) return dir;
        }
        return null;
      }, 3000);
      expect(partialDir).toBeTruthy();

      const code = await new Promise((resolve) => child.on('close', resolve));
      expect({ code, stdout, stderr }).toMatchObject({ code: 0 });
    } finally {
      if (child.exitCode == null) child.kill('SIGKILL');
    }
  }, 10000);

  test('--json emits a parseable verdict record', () => {
    const r = review(['some code change', '--json']);
    const rec = JSON.parse(r.stdout);
    expect(rec.run).toMatch(/^panel-/);
    expect(rec.models).toEqual(['claude', 'codex']);
    expect(rec.judge).toBe('rule');
    expect(rec.target_title).toBe('some code change');
  });

  test('fewer than 2 models exits 1', () => {
    const r = review(['x', '--models', 'claude']);
    expect(r.status).toBe(1);
  });

  test('unknown / unavailable model is skipped with a warning', () => {
    // gemini has no stub override and no CLI in the test env → skipped, leaving <2
    const r = review(['x', '--models', 'claude,gemini']);
    expect(r.stderr).toContain('gemini');
    expect(r.status).toBe(1);
  });
});

describe('events-log (readEventsLog / formatEventLine)', () => {
  let EDIR;
  const RECS = [
    { seq: 1, at: '2026-07-09T00:00:01.000Z', type: 'spawn', model: 'claude' },
    { seq: 2, at: '2026-07-09T00:00:02.000Z', type: 'stdout', model: 'claude', text: 'hello', bytes: 5 },
    { seq: 3, at: '2026-07-09T00:00:03.000Z', type: 'stderr', model: 'codex', text: 'warn' },
    { seq: 4, at: '2026-07-09T00:00:04.000Z', type: 'model_done', model: 'claude', ok: true },
  ];
  beforeAll(() => {
    EDIR = mkdtempSync(join(tmpdir(), 'xpanel-events-'));
    writeFileSync(join(EDIR, 'events.jsonl'), RECS.map((r) => JSON.stringify(r)).join('\n') + '\n');
  });
  afterAll(() => { rmSync(EDIR, { recursive: true, force: true }); });

  test('reads all records in file order when limit >= count', () => {
    expect(readEventsLog(EDIR, { limit: 100 }).map((r) => r.seq)).toEqual([1, 2, 3, 4]);
  });

  test('limit keeps only the last N', () => {
    expect(readEventsLog(EDIR, { limit: 2 }).map((r) => r.seq)).toEqual([3, 4]);
  });

  test('sinceSeq returns EVERY record after it, IGNORING limit (no burst dropped)', () => {
    // limit:1 alone would keep only seq 4 — sinceSeq must override the cap so a >limit
    // burst in one follow tick is never permanently lost (the panel-review finding).
    expect(readEventsLog(EDIR, { sinceSeq: 1, limit: 1 }).map((r) => r.seq)).toEqual([2, 3, 4]);
  });

  test('types filter', () => {
    expect(readEventsLog(EDIR, { types: ['stderr'] }).map((r) => r.seq)).toEqual([3]);
  });

  test('missing / unreadable log → [] (no throw)', () => {
    expect(readEventsLog(join(EDIR, 'does-not-exist'), {})).toEqual([]);
  });

  test('maxSeq returns the highest seq, or the floor when empty', () => {
    expect(maxSeq(readEventsLog(EDIR, {}))).toBe(4);
    expect(maxSeq([], 7)).toBe(7);
  });

  test('formatEventLine color:false is plain (no ANSI) and carries model/type/text', () => {
    const line = formatEventLine(RECS[1], { color: false });
    expect(line).not.toContain('\x1b[');
    expect(line).toContain('claude');
    expect(line).toContain('stdout');
    expect(line).toContain('hello');
  });

  test('formatEventLine renders an unknown type via the dot fallback (never blank)', () => {
    const line = formatEventLine({ type: 'brand_new_type', at: RECS[0].at }, { color: false });
    expect(line).toContain('brand_new_type');
    expect(line.trim().length).toBeGreaterThan(0);
  });

  test('sanitizeEventText strips ANSI + control sequences, keeps \\t and \\n', () => {
    expect(sanitizeEventText('safe\x1b[31mRED\x1b[0m\x1b]0;title\x07end\x00\x07')).toBe('safeREDend');
    expect(sanitizeEventText('a\nb\tc')).toBe('a\nb\tc');
    expect(sanitizeEventText(null)).toBe('');
  });

  test('formatEventLine sanitizes escapes embedded in text (terminal-injection guard)', () => {
    const line = formatEventLine({ type: 'stdout', at: RECS[0].at, text: 'x\x1b[31mY' }, { color: false });
    expect(line).not.toContain('\x1b');
    expect(line).toContain('xY');
  });
});

describe('status --logs (raw event stream)', () => {
  test('dumps events.jsonl for a run', () => {
    const r = review(['logs stream target']);
    expect(r.status).toBe(0);
    const runId = latestRunDir().split('/').pop();
    const out = panelRaw(['status', runId, '--logs'], { NO_COLOR: '1' });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('spawn');       // every model spawns
    expect(out.stdout).toContain('run_done');    // milestone marker always present
    expect(out.stdout).toMatch(/claude|codex/);  // a model label appears
  });

  test('--logs without a run id errors (per-run only)', () => {
    const out = panelRaw(['status', '--logs'], { NO_COLOR: '1' });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain('needs a run id');
  });

  test('--logs on a nonexistent run errors', () => {
    const out = panelRaw(['status', 'panel-nope', '--logs'], { NO_COLOR: '1' });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain('not found');
  });
});

describe('signal-killed model surfaces the signal', () => {
  const SIGSTUB = join(import.meta.dirname, 'fixtures', 'panel-stub-signal.mjs');
  test('exit null gains the signal name (exit null (SIGKILL)) instead of a bare code', () => {
    // codex self-SIGKILLs (empty stderr, code null) — the real kiro "exit null" case.
    // A signal death is retried once; the stub SIGKILLs every time, so both attempts die and
    // the surfaced error still names the signal. claude (normal stub) carries the round.
    const r = review(['signal target'], { X_PANEL_CMD_CODEX: SIGSTUB });
    expect(r.stderr).toContain('exit null (SIGKILL)');
    expect(r.stderr).toContain('retrying once'); // the retry path fired
  });
});

describe('signal-killed model recovers instead of being dropped', () => {
  const FLAKYSTUB = join(import.meta.dirname, 'fixtures', 'panel-stub-flaky-signal.mjs');
  test('a transient signal death is survived — the model still contributes', () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'xpanel-flaky-')), 'hit');
    const r = review(['flaky target'], { X_PANEL_CMD_CODEX: FLAKYSTUB, FLAKY_MARKER: marker });
    expect(r.status).toBe(0);
    expect(existsSync(marker)).toBe(true); // the first spawn really did die by signal (wrote the marker)
    expect(r.stderr).toMatch(/✓ codex/);   // …yet a fresh spawn recovered it — not dropped from the panel
  });
});

describe('help', () => {
  test('help prints usage', () => {
    const r = panelRaw(['help']);
    expect(r.stdout).toContain('x-panel');
    expect(r.stdout).toContain('Commands:');
  });
});

describe('UX: config, presets, shortcut, setup', () => {
  test('autodetectModels includes an overridden provider', () => {
    const prev = process.env.X_PANEL_CMD_CLAUDE;
    process.env.X_PANEL_CMD_CLAUDE = STUB;
    expect(autodetectModels()).toContain('claude');
    if (prev === undefined) delete process.env.X_PANEL_CMD_CLAUDE;
    else process.env.X_PANEL_CMD_CLAUDE = prev;
  });

  test('known providers include kiro', () => {
    expect(knownProviders()).toContain('kiro');
  });

  test('parses Kiro model spec into labels', () => {
    const r = panelRaw(['review', 'target', '--models', 'claude,kiro:claude-sonnet-4.6'], { X_PANEL_CMD_KIRO: STUB });
    expect(r.status).toBe(0);
    expect(latestVerdict().models).toEqual(['claude', 'kiro:claude-sonnet-4.6']);
  });

  test('setup saves default models/judge to project config', () => {
    const r = panelRaw(['setup', '--models', 'claude,codex', '--judge', 'rule']);
    expect(r.status).toBe(0);
    const cfg = JSON.parse(readFileSync(join(DIR, '.xm', 'config.json'), 'utf8'));
    expect(cfg.panel.models).toEqual(['claude', 'codex']);
    expect(cfg.panel.judge).toBe('rule');
  });

  test('review uses models from config when --models omitted', () => {
    writeProjectConfig({ models: ['claude', 'codex'] });
    const r = panelRaw(['review', 'some target']);
    expect(r.status).toBe(0);
    expect(latestVerdict().models).toEqual(['claude', 'codex']);
  });

  test('bare "x-panel" runs review (shortcut, no subcommand)', () => {
    writeProjectConfig({ models: ['claude', 'codex'] });
    // --force because DIR has no git repo → the default git-diff target trips the
    // trivial-target guard; the flag still exercises the no-subcommand shortcut path.
    const r = panelRaw(['--force']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Panel verdict');
  });

  test('--fast preset resolves to claude,codex', () => {
    const r = panelRaw(['--fast', 'some target']);
    expect(r.status).toBe(0);
    expect(latestVerdict().models).toEqual(['claude', 'codex']);
  });

  test('parses provider:model spec into labels', () => {
    const r = panelRaw(['review', 'target', '--models', 'claude:opus,codex:gpt-5']);
    expect(r.status).toBe(0);
    expect(latestVerdict().models).toEqual(['claude:opus', 'codex:gpt-5']);
  });

  test('applies model_overrides from config to bare names', () => {
    writeProjectConfig({ models: ['claude', 'codex'], model_overrides: { codex: 'gpt-5' } });
    const r = panelRaw(['review', 'target']);
    expect(r.status).toBe(0);
    expect(latestVerdict().models).toEqual(['claude', 'codex:gpt-5']);
  });

  test('config preset resolves to its model list', () => {
    writeProjectConfig({ presets: { duo: ['claude', 'codex'] } });
    const r = panelRaw(['--preset', 'duo', 'target']);
    expect(r.status).toBe(0);
    expect(latestVerdict().models).toEqual(['claude', 'codex']);
  });
});

describe('parseModelIds (live model catalog)', () => {
  test('cursor "id - Description" format → bare ids (kimi/glm surfaced)', () => {
    const out = 'Available models\n\nauto - Auto\nkimi-k2.5 - Kimi K2.5 (current)\nglm-5.2-max - GLM 5.2 Max\ngpt-5.5-high - GPT-5.5 1M High\n\nTip: use --model <id> (or /model <id>) to switch.';
    const ids = parseModelIds(out);
    expect(ids).toContain('kimi-k2.5');
    expect(ids).toContain('glm-5.2-max');
    expect(ids).toContain('auto');
    expect(ids).not.toContain('Tip:');       // footer skipped
    expect(ids).not.toContain('Available');   // header skipped
  });
  test('kiro "[*] id  N.NNx credits" format → bare ids (glm surfaced)', () => {
    const out = 'Available models (* = default):\n\n* auto                 1.00x credits      chosen by task\n  glm-5                0.50x credits      GLM-5 model\n  deepseek-3.2         0.25x credits      DeepSeek V3.2';
    const ids = parseModelIds(out);
    expect(ids).toEqual(['auto', 'glm-5', 'deepseek-3.2']);
  });
  test('dedupes and tolerates empty/garbage input', () => {
    expect(parseModelIds('')).toEqual([]);
    expect(parseModelIds(null)).toEqual([]);
    expect(parseModelIds('auto - X\nauto - Y')).toEqual(['auto']);
  });
});

describe('preflight (live model check, stubbed)', () => {
  test('every resolved model is probed; ≥2 live → cross_vendor', () => {
    const r = panelRaw(['preflight', '--models', 'claude,codex', '--json']);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.total).toBe(2);
    expect(out.ok).toBe(2);
    expect(out.cross_vendor).toBe(true);
    expect(out.results.every((x) => x.status === 'ok')).toBe(true);
    expect(out.results.map((x) => x.label).sort()).toEqual(['claude', 'codex']);
  });

  test('an unknown/uninstalled provider is flagged, not silently dropped', () => {
    const r = panelRaw(['preflight', '--models', 'claude,faketool', '--json']);
    const out = JSON.parse(r.stdout);
    expect(out.total).toBe(2);
    expect(out.ok).toBe(1);
    expect(out.cross_vendor).toBe(false);
    const fake = out.results.find((x) => x.name === 'faketool');
    expect(fake.ok).toBe(false);
    expect(['unknown', 'not_installed']).toContain(fake.status);
    expect(r.status).toBe(0); // ≥1 live → exit 0
  });

  test('a name:model spec is carried into the probe label', () => {
    const r = panelRaw(['preflight', '--models', 'claude:some-model', '--json']);
    const out = JSON.parse(r.stdout);
    expect(out.results[0].label).toBe('claude:some-model');
    expect(out.results[0].model).toBe('some-model');
    expect(out.results[0].status).toBe('ok');
  });
});

// ── promptSpawnOpts — claude ambient-context isolation ─────────────────────
// Regression for the cross-vendor echo bug (2026-07-05): claude -p spawned in a
// repo cwd assembles CLAUDE.md + hook context around the prompt, and long
// prompts made the model echo that scaffolding instead of answering (55-token
// scaffold echo vs the 10.5KB real answer from a neutral cwd). Prompt runs must
// spawn claude from a neutral tmp dir; every other vendor keeps the caller cwd
// (codex --sandbox read-only reads the repo on purpose).
describe('promptSpawnOpts — claude prompt runs are cwd-isolated', () => {
  test('claude gets a neutral tmp cwd', () => {
    const opts = promptSpawnOpts('claude');
    expect(typeof opts.cwd).toBe('string');
    expect(opts.cwd.length).toBeGreaterThan(0);
    // never the repo cwd — that is the contamination this guards against
    expect(opts.cwd).not.toBe(process.cwd());
  });

  test('other vendors keep the caller cwd (no override)', () => {
    for (const name of ['codex', 'agy', 'cursor', 'kiro']) {
      expect(promptSpawnOpts(name)).toEqual({});
    }
  });
});
