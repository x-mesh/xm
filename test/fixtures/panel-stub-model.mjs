#!/usr/bin/env node
/**
 * Test stub standing in for a model CLI. Invoked as:
 *   node panel-stub-model.mjs <model> <prompt>
 * Returns deterministic JSON so x-panel's flow can be tested without real models.
 * Wraps output in noise to exercise extractJSON.
 */
import { writeFileSync } from 'node:fs';
const [model, prompt = ''] = process.argv.slice(2);
const stream = process.argv.includes('--stream'); // resolveStreamCommand appends --stream
const isRefute = /verdicts/i.test(prompt);

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

if (Number.isFinite(delayMs) && delayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

if (process.env[`X_PANEL_NO_JSON_${envModel}`]) {
  process.stdout.write('plain text without a JSON payload');
  process.exit(0);
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
