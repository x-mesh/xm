#!/usr/bin/env node
// Flaky model stub: SIGKILLs itself on the FIRST invocation (marker absent), then behaves
// like a normal model on every later call. Exercises runRound's retry-once-on-signal path —
// attempt 1 dies by signal, the retry recovers. The marker file is passed via FLAKY_MARKER.
import { existsSync, writeFileSync } from 'node:fs';

const marker = process.env.FLAKY_MARKER;
if (marker && !existsSync(marker)) {
  writeFileSync(marker, '1');
  process.kill(process.pid, 'SIGKILL'); // first spawn: intermittent external-kill lookalike
}
// Later spawns: emit a minimal valid answer so the retried model counts as OK.
// This stub stands in for CODEX, whose raw output under `exec --json` is a JSONL event
// stream — wrap the answer in item.completed so parseStructuredOutput lifts it (a bare
// findings object would parse as "no JSON in the stream" now).
const [name] = process.argv.slice(2);
const args = process.argv.slice(2).join(' ');
const isRefute = /verdicts/i.test(args);
const payload = JSON.stringify(isRefute ? { verdicts: [] } : { findings: [] });
if (name === 'codex') {
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: payload } }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } }) + '\n');
} else {
  console.log(payload);
}
