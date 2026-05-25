#!/usr/bin/env node
/**
 * x-score-cli.mjs — CLI wrapper for scoring.mjs
 *
 * Usage:
 *   xm score --parts 'goal=0.8,constraints=0.7' --weights 'goal=0.4,constraints=0.6'
 *            [--op '>='] [--threshold 0.7] [--invert] [--json]
 *
 * Options:
 *   --parts      Comma-separated dim=value pairs, values in [0,1]
 *   --weights    Comma-separated dim=weight pairs (any positive scale)
 *   --op         Comparison operator: <=, >=, <, >  (default: >=)
 *   --threshold  Threshold value for passes() (default: 0.5)
 *   --invert     Return 1 - weightedScore (lower-is-better inversion)
 *   --json       Output {"score":..., "passed":...} instead of human text
 */

import { weightedScore, passes } from './scoring.mjs';

// Consume the next CLI token as the value for a flag. Rejects when the next
// token is missing or is itself another flag (e.g. `--threshold --json` would
// otherwise swallow `--json` as the threshold value). [N1 fix]
function requireValue(args, i, flag) {
  const v = args[i];
  if (v === undefined || (typeof v === 'string' && v.startsWith('--'))) {
    process.stderr.write(`xm score: ${flag} requires a value\n`);
    printUsage();
    process.exit(1);
  }
  return v;
}

function parseKVList(str) {
  const result = {};
  for (const pair of str.split(',')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) result[key] = parseFloat(val);
  }
  return result;
}

function printUsage() {
  process.stdout.write(
    'Usage: xm score --parts <dim=val,...> --weights <dim=w,...>\n' +
    '                [--op <=|>=|<|>] [--threshold N] [--invert] [--json]\n'
  );
}

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  printUsage();
  process.exit(0);
}

// --- Parse flags ---
let partsStr = '';
let weightsStr = '';
let op = '>=';
let threshold = 0.5;
let invert = false;
let json = false;

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--parts':      partsStr   = requireValue(args, ++i, '--parts'); break;
    case '--weights':    weightsStr = requireValue(args, ++i, '--weights'); break;
    case '--op':         op         = requireValue(args, ++i, '--op'); break;
    case '--threshold':  threshold  = parseFloat(requireValue(args, ++i, '--threshold')); break;
    case '--invert':     invert     = true; break;
    case '--json':       json       = true; break;
    default:
      process.stderr.write(`xm score: unknown flag "${args[i]}"\n`);
      printUsage();
      process.exit(1);
  }
}

if (!partsStr || !weightsStr) {
  process.stderr.write('xm score: --parts and --weights are required\n');
  printUsage();
  process.exit(1);
}

// Reject a malformed --threshold (e.g. '' or 'abc' → NaN) loudly instead of
// silently producing passed:false for every comparison (NaN fails all ops).
if (Number.isNaN(threshold)) {
  process.stderr.write('xm score: --threshold must be a number\n');
  printUsage();
  process.exit(1);
}

const parts   = parseKVList(partsStr);
const weights = parseKVList(weightsStr);

let score;
try {
  const raw = weightedScore(parts, weights);
  score = invert ? Math.min(1, Math.max(0, 1 - raw)) : raw;
} catch (err) {
  process.stderr.write(`xm score: ${err.message}\n`);
  process.exit(1);
}

let passed;
try {
  passed = passes(score, op, threshold);
} catch (err) {
  process.stderr.write(`xm score: ${err.message}\n`);
  process.exit(1);
}

if (json) {
  process.stdout.write(JSON.stringify({ score, passed }) + '\n');
} else {
  const invertNote = invert ? ' (inverted)' : '';
  const opLabel = `${op} ${threshold}`;
  process.stdout.write(
    `score: ${score.toFixed(4)}${invertNote}  passed(${opLabel}): ${passed}\n`
  );
}

process.exit(0);
