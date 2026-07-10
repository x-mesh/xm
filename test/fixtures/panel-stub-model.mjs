#!/usr/bin/env node
/**
 * Test stub standing in for a model CLI. Invoked as:
 *   node panel-stub-model.mjs <model> <prompt>
 * Returns deterministic JSON so x-panel's flow can be tested without real models.
 * Wraps output in noise to exercise extractJSON.
 */
import { writeFileSync, existsSync } from 'node:fs';
const [model, prompt = ''] = process.argv.slice(2);
const stream = process.argv.includes('--stream'); // resolveStreamCommand appends --stream
const isRefute = /verdicts/i.test(prompt);

// t5 session-reuse hints (resolveSessionCommand appends these for stubbed providers):
//   --session-mode create|resume [--session-id <uuid>]
const argAfter = (flag) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
};
const sessionMode = argAfter('--session-mode');
const sessionId = argAfter('--session-id');

// Test hook: append one JSONL line per invocation so tests can assert exactly
// which session argv each round used and that resumed prompts omit the target.
if (process.env.X_PANEL_SESSION_LOG) {
  try {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.X_PANEL_SESSION_LOG, JSON.stringify({
      model, refute: isRefute, mode: sessionMode, id: sessionId, hasTarget: /TARGET:/.test(prompt),
    }) + '\n');
  } catch { /* best-effort */ }
}

// Test hook: a provider whose resume path is broken (proves the loud stateless fallback).
if (sessionMode === 'resume' && process.env[`X_PANEL_FAIL_RESUME_${String(model || '').toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`]) {
  process.stderr.write('resume failed (stub)\n');
  process.exit(1);
}

// Test hook: dump the exact round-1 prompt the model received (for snapshot/override tests).
if (process.env.X_PANEL_DUMP_R1 && !isRefute) {
  try { writeFileSync(process.env.X_PANEL_DUMP_R1, prompt); } catch { /* best-effort */ }
}
const envModel = String(model || '').toUpperCase().replace(/[^A-Z0-9_]/g, '_');

// Emit a payload as provider-shaped stream-json/JSONL so the structured path
// (line parsing + findings-from-final-text + usage capture) can be tested.
function emitStream(name, jsonStr) {
  const w = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  // chunk the payload into several pieces to emulate token-level partial streaming
  const chunks = [];
  for (let i = 0; i < jsonStr.length; i += Math.ceil(jsonStr.length / 6) || 1) {
    chunks.push(jsonStr.slice(i, i + (Math.ceil(jsonStr.length / 6) || 1)));
  }
  if (name === 'codex') {
    // codex has no partial mode: final block only
    w({ type: 'turn.started' });
    w({ type: 'item.completed', item: { type: 'agent_message', text: jsonStr } });
    w({ type: 'turn.completed', usage: { input_tokens: 200, output_tokens: 30, cached_input_tokens: 50, reasoning_output_tokens: 15 } });
  } else if (name === 'cursor') {
    w({ type: 'thinking', message: { content: [{ type: 'text', text: 'thinking…' }] } });
    // response deltas as incremental assistant events (text in message.content[])
    for (const ch of chunks) w({ type: 'assistant', message: { content: [{ type: 'text', text: ch }] } });
    w({ type: 'result', result: jsonStr, usage: { inputTokens: 150, outputTokens: 25, cacheReadTokens: 20, cacheWriteTokens: 0 } });
  } else { // claude + default
    // token-level deltas via stream_event/content_block_delta/text_delta, then result
    w({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } });
    for (const ch of chunks) w({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ch } } });
    w({ type: 'result', result: jsonStr, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 10 }, total_cost_usd: 0.012 });
  }
}
const delayMs = Number(process.env[`X_PANEL_DELAY_${isRefute ? 'R2' : 'R1'}_${envModel}_MS`] || process.env[`X_PANEL_DELAY_${envModel}_MS`] || 0);

// Optional heartbeat: emit a stderr tick every X_PANEL_HB_<MODEL>_MS during the delay so the
// idle-reset timeout guard sees continuous activity (a "working" model that must NOT be killed).
// Without it, the delay is pure silence (a "stalled" model the idle timer should kill).
const hbMs = Number(process.env[`X_PANEL_HB_${envModel}_MS`] || 0);
if (Number.isFinite(delayMs) && delayMs > 0) {
  if (Number.isFinite(hbMs) && hbMs > 0) {
    let waited = 0;
    while (waited < delayMs) {
      const step = Math.min(hbMs, delayMs - waited);
      await new Promise((resolve) => setTimeout(resolve, step));
      waited += step;
      process.stderr.write('.'); // activity heartbeat — not part of the JSON payload
    }
  } else {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

if (process.env[`X_PANEL_NO_JSON_${envModel}`]) {
  process.stdout.write('plain text without a JSON payload');
  process.exit(0);
}

// Emit NOTHING and exit 0 — a gateway CLI (cursor especially) that returns success with an
// empty completion (transient rate-limit / silent auth refusal). The raw-text cross path must
// treat this as a FAILURE (loud, retryable), not a silent blank. An optional stderr hint is
// emitted when X_PANEL_EMPTY_<MODEL> holds a non-"1" message, to exercise the reason passthrough.
if (process.env[`X_PANEL_EMPTY_${envModel}`]) {
  const hint = process.env[`X_PANEL_EMPTY_${envModel}`];
  if (hint && hint !== '1') process.stderr.write(hint);
  process.exit(0);
}

// Transient flavour: FIRST invocation returns exit-0-empty, later ones succeed — proves the
// cross retry recovers a flaky gateway. A marker file remembers it already failed once.
if (process.env[`X_PANEL_EMPTY_ONCE_${envModel}`]) {
  const marker = process.env[`X_PANEL_EMPTY_ONCE_${envModel}`];
  if (!existsSync(marker)) { writeFileSync(marker, '1'); process.exit(0); }
  // else: fall through to the normal output below (recovered on retry)
}

// Emit valid JSON but exit non-zero — a crashed provider whose output still
// contains JSON must be treated as FAILURE, not a successful review.
if (process.env[`X_PANEL_EXIT1_${envModel}`]) {
  const payload = JSON.stringify({ findings: [] });
  if (stream) emitStream(model, payload);
  else process.stdout.write(payload);
  process.exit(1);
}

// Emit ONLY JSONL envelope lines (no findings/verdicts) — the rawCap fallback must
// NOT mistake an envelope object for a successful review.
if (process.env[`X_PANEL_ENVELOPE_ONLY_${envModel}`]) {
  if (stream) {
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'stream_event', event: { type: 'message_start' } }) + '\n');
  } else {
    process.stdout.write('{"type":"system","subtype":"init"}');
  }
  process.exit(0);
}

// Round-1-only: a model that reviews in PROSE and merely echoes the empty contract
// object (the agy failure shape, mem-mesh ed2ff3e3) — parses as ok=true findings=[]
// and must surface as r1_status=suspect_empty, never as a clean "0 findings".
if (!isRefute && process.env[`X_PANEL_PROSE_EMPTY_${envModel}`]) {
  const prose = 'I reviewed the change carefully. 1) The retry loop never persists its state to disk. '
    + '2) The mtime-based prune races with concurrent writers. 3) The stream fallback duplicates '
    + 'already-printed text on reconnect. 4) The config merge drops nested keys. 5) The error path '
    + 'swallows the original stack. These are the issues I found in this diff, described in detail. ';
  process.stdout.write(prose + 'If there are no real issues, return {"findings":[]}.');
  process.exit(0);
}

// t5: codex discloses its session id in the run banner — emulate it on session
// creation so the capture path (SESSION_ID_RE) is exercised end to end.
if (sessionMode === 'create' && model === 'codex') {
  const sid = process.env.X_PANEL_STUB_SESSION_ID || '123e4567-e89b-42d3-a456-426614174000';
  process.stderr.write(`session id: ${sid}\n`);
  // Security regression hook: emulate a prompt-injected review target making the
  // model emit a FAKE banner into stdout (the content channel). The capture must
  // trust only stderr, so this stdout id must never win the round-2 resume.
  if (process.env.X_PANEL_STUB_STDOUT_SESSION_ID) {
    process.stdout.write(`session id: ${process.env.X_PANEL_STUB_STDOUT_SESSION_ID}\n`);
  }
}

if (isRefute) {
  const refs = [...prompt.matchAll(/\[([^\]]+#\d+)\]/g)].map((m) => m[1]); // global ref "owner#idx" (owner may contain ':')
  const verdicts = refs.map((ref, i) => ({
    ref,
    // codex refutes the opponent's first finding → creates one CONTESTED entry
    stance: model === 'codex' && i === 0 ? 'refute' : 'concede',
    reason: 'stub reason',
  }));
  const payload = JSON.stringify({ verdicts });
  if (stream) emitStream(model, payload);
  else process.stdout.write('noise before ' + payload + ' noise after');
} else {
  const findings = model === 'claude'
    ? [
        { severity: 'high', file: 'a.js', line: 1, claim: 'shared issue', evidence: 'ev' },
        { severity: 'low', file: 'b.js', line: 2, claim: 'claude-only issue', evidence: 'ev' },
      ]
    : [
        { severity: 'high', file: 'a.js', line: 1, claim: 'shared issue (codex view)', evidence: 'ev' },
        { severity: 'medium', file: 'c.js', line: 3, claim: 'codex-only issue', evidence: 'ev' },
      ];
  const payload = JSON.stringify({ findings });
  if (stream) emitStream(model, payload);
  else process.stdout.write(payload);
}
