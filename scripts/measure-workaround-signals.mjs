#!/usr/bin/env node
/**
 * measure-workaround-signals.mjs — How often do real fixes trip the workaround scan?
 *
 * Background (CLAUDE.md Lessons L9): a signal may only become a gate after its rate
 * on the intended population is measured. Here the population is this repository's
 * own `fix` commits. They were reviewed and merged as fixes, so a signal on one of
 * them is treated as a false alarm. That is an upper bound: some of those commits
 * may themselves be workarounds.
 *
 * Usage: node scripts/measure-workaround-signals.mjs [--limit N] [--grep '^fix']
 * Prints, per signal kind, how many fix commits it fired on and the rate.
 */

import { execFileSync } from 'node:child_process';
import { scanDiff } from '../x-solver/lib/workaround-signals.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const grep = opt('--grep', '^fix');
const limit = Number(opt('--limit', '0'));

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
let shas = git('log', '-E', `--grep=${grep}`, '--no-merges', '--format=%H').split('\n').filter(Boolean);
if (limit > 0) shas = shas.slice(0, limit);

// Bundle copies under xm/ duplicate the source diff; count each change once.
const include = (file) => !file.startsWith('xm/') && !/\.(md|lock)$/.test(file);

const byKind = new Map();
let anySignal = 0;
for (const sha of shas) {
  const diff = git('show', '--format=', '--no-color', '--no-ext-diff', '-U0', sha);
  const kinds = new Set(scanDiff(diff, { include }).map((s) => s.kind));
  if (kinds.size) anySignal += 1;
  for (const kind of kinds) byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
}

const pct = (n) => `${((100 * n) / Math.max(1, shas.length)).toFixed(1)}%`;
console.log(`fix commits scanned: ${shas.length} (grep ${JSON.stringify(grep)}, excluding xm/ bundle copies, *.md, *.lock)`);
console.log('kind                 commits  rate');
for (const [kind, n] of [...byKind].sort((a, b) => b[1] - a[1])) {
  console.log(`${kind.padEnd(20)} ${String(n).padStart(7)}  ${pct(n)}`);
}
console.log(`${'any'.padEnd(20)} ${String(anySignal).padStart(7)}  ${pct(anySignal)}`);
