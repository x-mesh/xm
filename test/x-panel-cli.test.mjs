/**
 * x-panel PoC tests.
 * - synth/adapters: pure-function unit tests
 * - CLI: full review flow driven by stub model commands (no real models)
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { normalizeFindings, normalizeVerdicts, synthesize, mergeConsensus } from '../x-panel/lib/x-panel/synth.mjs';
import { extractJSON, autodetectModels } from '../x-panel/lib/x-panel/adapters.mjs';

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

beforeAll(() => { DIR = mkdtempSync(join(tmpdir(), 'xpanel-')); });
afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

// ── unit: synth ──────────────────────────────────────────────────────

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
  test('coerces stance + global ref, drops empty refs', () => {
    const out = normalizeVerdicts({ verdicts: [
      { ref: 'codex#0', stance: 'REFUTE', reason: 'r' },
      { ref: 'codex#1', stance: 'maybe' },
      { ref: '', stance: 'refute' },
    ] });
    expect(out.length).toBe(2);
    expect(out[0].ref).toBe('codex#0');
    expect(out[0].stance).toBe('refute');
    expect(out[1].stance).toBe('concede'); // unknown → concede
  });
});

describe('synthesize', () => {
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

  test('writes live status.json (phase done) after run', () => {
    const r = review(['some target for status']);
    expect(r.status).toBe(0);
    const panelDir = join(DIR, '.xm', 'panel');
    const runs = readdirSync(panelDir).filter(n => n.startsWith('panel-')).sort();
    const st = JSON.parse(readFileSync(join(panelDir, runs[runs.length - 1], 'status.json'), 'utf8'));
    expect(st.phase).toBe('done');
    expect(st.models.length).toBeGreaterThan(0);
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
    const r = panelRaw([]);
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
