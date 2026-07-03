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

import { normalizeFindings, normalizeVerdicts, synthesize, mergeConsensus } from '../x-panel/lib/x-panel/synth.mjs';
import { extractJSON, autodetectModels, knownProviders, invokeProvider, normalizeKiroModel, streamCommand, parseStreamLine, costFromTokens, supportsStream, resolveCommand, providerReady, parseModelIds, buildCodexResumeArgs } from '../x-panel/lib/x-panel/adapters.mjs';

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
        '{"verdicts":[{"ref":"<id, e.g. codex#0>","stance":"refute|concede","reason":"one line"}]}',
        '- refute = wrong, not real, or not actionable.',
        '- concede = a real issue worth fixing.',
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
