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
import { extractJSON, autodetectModels, knownProviders, invokeProvider, normalizeKiroModel, streamCommand, parseStreamLine, costFromTokens, supportsStream, resolveCommand } from '../x-panel/lib/x-panel/adapters.mjs';

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
});

describe('Kiro adapter', () => {
  test('normalizes Anthropic-style Claude IDs to Kiro model IDs', () => {
    expect(normalizeKiroModel('claude-opus-4-8')).toBe('claude-opus-4.8');
    expect(normalizeKiroModel('claude-sonnet-4-6')).toBe('claude-sonnet-4.6');
    expect(normalizeKiroModel('auto')).toBe('auto');
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
    const r = panelRaw(['review']); // no target → git diff HEAD
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
    expect(latestVerdict().timeout_s).toBe(240); // base, small target

    const big = 'x'.repeat(60_000);
    const r1 = review([big, '--stream']);
    expect(r1.status).toBe(0);
    expect(latestVerdict().timeout_s).toBeGreaterThan(240); // auto-raised

    const r2 = review([big, '--stream', '--timeout', '120']);
    expect(r2.status).toBe(0);
    expect(latestVerdict().timeout_s).toBe(120); // explicit --timeout pins, no auto-raise
  });

  test('timeout auto-raise is capped by panel.timeout_max_s', () => {
    writeProjectConfig({ timeout_max_s: 300 });
    const big = 'x'.repeat(60_000);
    const r = panelRaw(['review', big, '--stream', '--models', 'claude,codex']);
    expect(r.status).toBe(0);
    expect(latestVerdict().timeout_s).toBe(300); // capped
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
    expect(r1.error).toContain('no JSON object');
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
