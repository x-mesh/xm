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
const args = process.argv.slice(2).join(' ');
const isRefute = /verdicts/i.test(args);
console.log(JSON.stringify(isRefute ? { verdicts: [] } : { findings: [] }));
