#!/usr/bin/env node
/**
 * sim-thresholds.mjs — Deterministic threshold validation for the three quant gates.
 *
 * Background (CLAUDE.md Lessons L9): numeric thresholds must be chosen by a
 * deterministic simulator across realistic input distributions, not by judgment.
 *
 * This simulator models a "good" population and a "bad" population for each gate,
 * runs the REAL production scoring functions over both, and reports, per candidate
 * threshold:
 *   - false_alarm_rate  = P(blocked | good population)   — lower is better
 *   - true_positive_rate = P(blocked | bad population)   — higher is better
 *
 * Determinism: a seeded mulberry32 PRNG drives every random draw, so re-running
 * with the same seed reproduces identical tables. No Math.random anywhere.
 *
 * Gates:
 *   1. ambiguity   — x-probe clarity → ambiguity = 1 - weightedScore(clarity)
 *                    (weights goal=0.4, constraints=0.3, success=0.3); block when ambiguity > threshold.
 *   2. convergence — x-solver detectStop early-stop on iteration sequences;
 *                    "block" = stopped while still genuinely improving (false alarm)
 *                    or legitimately stopped (true positive).
 *   3. drift       — x-build computeDrift weighted score; block when weighted < threshold.
 *
 * Usage: node scripts/sim-thresholds.mjs [--seed 12345] [--n 4000]
 */

import { weightedScore } from '../xm/lib/scoring.mjs';
import { detectStop } from '../x-solver/lib/convergence.mjs';
import { computeDrift } from '../x-build/lib/x-build/drift.mjs';

// ── Deterministic PRNG (mulberry32) ──────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick one element from `arr` with probabilities `probs` (parallel arrays). */
function weightedPick(rng, arr, probs) {
  const r = rng();
  let acc = 0;
  for (let i = 0; i < arr.length; i++) {
    acc += probs[i];
    if (r < acc) return arr[i];
  }
  return arr[arr.length - 1];
}

function range(start, end, step) {
  const out = [];
  for (let v = start; v <= end + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

function pct(x) {
  return (x * 100).toFixed(1) + '%';
}

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let SEED = 12345;
let N = 4000;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--seed') SEED = parseInt(args[++i], 10);
  else if (args[i] === '--n') N = parseInt(args[++i], 10);
}

// ═══════════════════════════════════════════════════════════════════════════
// GATE 1: AMBIGUITY (x-probe)
// ═══════════════════════════════════════════════════════════════════════════
//
// Clarity per dimension ∈ {0.0 (assumption), 0.5 (heuristic), 1.0 (validated)}.
// ambiguity = 1 - weightedScore({goal,constraints,success}, {0.4,0.3,0.3}).
// A gate "blocks" (RETHINK) when ambiguity > threshold.
//
//   GOOD  = "clear idea": each dimension mostly 1.0, occasionally 0.5.
//   BAD   = "vague idea": each dimension mostly 0.0–0.5, rarely 1.0.

function drawClarity(rng, dist) {
  // dist = [p0, p05, p1] probabilities for clarity ∈ {0, 0.5, 1}
  return weightedPick(rng, [0.0, 0.5, 1.0], dist);
}

function simAmbiguity(seed, n, thresholds) {
  const rng = mulberry32(seed);
  const W = { goal: 0.4, constraints: 0.3, success: 0.3 };

  // Ambiguity is a DISCRETE quantity: with clarity ∈ {0, 0.5, 1} per dimension,
  // ambiguity = 1 - weighted(clarity) can only take 15 distinct values
  // (0, 0.15, 0.20, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.80, 0.85, 1.0).
  // A threshold therefore selects a *band*, not a continuous cut. The simulator's
  // task is to pick the band that separates "clear" from "vague" with low FA.
  //
  // Population semantics (deliberate, documented — see PRD/L9 methodology):
  //   GOOD "clear idea": each dimension is grounded. A clear idea may carry at
  //     most light uncertainty: P(validated)=0.85, P(heuristic)=0.13, P(assumption)=0.02.
  //     This encodes "a clear idea rarely has an outright ungrounded dimension."
  //   BAD "vague idea": dimensions are largely ungrounded:
  //     P(validated)=0.10, P(heuristic)=0.40, P(assumption)=0.50.
  const goodDist = [0.02, 0.13, 0.85]; // [P(0), P(0.5), P(1)]
  const badDist = [0.5, 0.4, 0.1];

  const goodAmb = [];
  const badAmb = [];
  for (let i = 0; i < n; i++) {
    const g = {
      goal: drawClarity(rng, goodDist),
      constraints: drawClarity(rng, goodDist),
      success: drawClarity(rng, goodDist),
    };
    goodAmb.push(1 - weightedScore(g, W));
    const b = {
      goal: drawClarity(rng, badDist),
      constraints: drawClarity(rng, badDist),
      success: drawClarity(rng, badDist),
    };
    badAmb.push(1 - weightedScore(b, W));
  }

  return thresholds.map((t) => {
    // block when ambiguity > threshold
    const fa = goodAmb.filter((a) => a > t).length / n; // good but blocked
    const tp = badAmb.filter((a) => a > t).length / n; // bad and blocked
    return { t, fa, tp };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// GATE 2: CONVERGENCE (x-solver)
// ═══════════════════════════════════════════════════════════════════════════
//
// We synthesize iteration output sequences with controllable token overlap
// between consecutive iterations, then call the REAL detectStop().
//
// Scenarios:
//   (a) improving   — GOOD: each step adds/changes ~30% of tokens (real progress)
//   (b) converging  — BAD: steps barely change (<10% token churn) → should stop
//   (c) stagnant    — BAD: identical outputs repeated → should stop
//   (d) oscillating — BAD: A,B,A pattern → should stop
//
// "block" = detectStop returns stop:true.
//   GOOD scenario (improving): block = false alarm.
//   BAD scenarios: block = true positive.

const WORDBANK = [];
for (let i = 0; i < 400; i++) WORDBANK.push('word' + i);

/** Build a sentence of `len` tokens drawn from WORDBANK starting at offset. */
function buildText(tokens) {
  return tokens.join(' ');
}

/**
 * Generate an improving sequence: start with a base set of tokens, each step
 * replaces a `churn` fraction with fresh tokens (simulating genuine rewrites).
 */
function genImproving(rng, steps, baseLen, churn) {
  let cur = [];
  let nextFresh = 0;
  for (let i = 0; i < baseLen; i++) cur.push('w' + nextFresh++);
  const seq = [buildText(cur)];
  for (let s = 1; s < steps; s++) {
    const replace = Math.max(1, Math.round(baseLen * churn));
    // replace `replace` random positions with fresh tokens
    const next = cur.slice();
    for (let r = 0; r < replace; r++) {
      const idx = Math.floor(rng() * baseLen);
      next[idx] = 'w' + nextFresh++;
    }
    cur = next;
    seq.push(buildText(cur));
  }
  return seq;
}

/** Converging sequence: tiny churn (≈ a few % tokens) each step. */
function genConverging(rng, steps, baseLen, churn) {
  return genImproving(rng, steps, baseLen, churn);
}

/** Stagnant: identical output repeated. */
function genStagnant(rng, steps, baseLen) {
  const cur = [];
  let f = 0;
  for (let i = 0; i < baseLen; i++) cur.push('w' + f++);
  const txt = buildText(cur);
  return Array.from({ length: steps }, () => txt);
}

/** Oscillating: A,B,A pattern (B is a distinct rewrite). */
function genOscillating(rng, baseLen) {
  const a = [];
  let f = 0;
  for (let i = 0; i < baseLen; i++) a.push('a' + f++);
  const b = [];
  f = 0;
  for (let i = 0; i < baseLen; i++) b.push('b' + f++);
  const A = buildText(a);
  const B = buildText(b);
  return [A, B, A];
}

function simConvergence(seed, n, thresholds) {
  const rng = mulberry32(seed);
  const baseLen = 40;

  // Pre-generate populations (independent of threshold) so we can re-score.
  const good = []; // improving sequences (should NOT stop)
  const bad = []; // converging/stagnant/oscillating (SHOULD stop)

  const perScenario = Math.floor(n / 4);
  for (let i = 0; i < perScenario; i++) {
    // GOOD: genuine improvement, 25–40% churn per step, 3–5 steps
    const steps = 3 + Math.floor(rng() * 3);
    const churn = 0.25 + rng() * 0.15;
    good.push(genImproving(rng, steps, baseLen, churn));
  }
  for (let i = 0; i < perScenario; i++) {
    // BAD-converging: tiny churn 2–8%
    const steps = 3 + Math.floor(rng() * 3);
    const churn = 0.02 + rng() * 0.06;
    bad.push(genConverging(rng, steps, baseLen, churn));
  }
  for (let i = 0; i < perScenario; i++) {
    const steps = 3 + Math.floor(rng() * 3);
    bad.push(genStagnant(rng, steps, baseLen));
  }
  for (let i = 0; i < n - 3 * perScenario; i++) {
    bad.push(genOscillating(rng, baseLen));
  }

  return thresholds.map((t) => {
    let faStop = 0;
    for (const seq of good) {
      const r = detectStop(seq.map((o) => ({ output: o })), { convergeThreshold: t });
      if (r.stop) faStop++;
    }
    let tpStop = 0;
    for (const seq of bad) {
      const r = detectStop(seq.map((o) => ({ output: o })), { convergeThreshold: t });
      if (r.stop) tpStop++;
    }
    return { t, fa: faStop / good.length, tp: tpStop / bad.length };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// GATE 3: DRIFT (x-build)
// ═══════════════════════════════════════════════════════════════════════════
//
// computeDrift weighted = 0.5*goal + 0.3*constraint + 0.2*ontology.
// Gate blocks (FAIL) when weighted < threshold.
//
// Rather than reverse-engineer text that yields a target score, we build PRD +
// task fixtures from controlled score targets, then call the REAL computeDrift
// via synthetic baselines/tasks that deterministically produce the desired
// sub-scores. We construct baselines/tasks so that:
//   goal_score      = (#SC covered)/(#SC)
//   constraint_score = (#C not violated)/(#C)
//   ontology_score   = (#kw present)/(#kw)
//
// GOOD ("normal completion"): high coverage on all three.
// BAD  ("drift"): goal/ontology coverage collapses (the dogfooding failure mode).

function buildDriftCase(rng, scTotal, scCovered, cTotal, cViolated, kwTotal, kwCovered) {
  // Success criteria
  const successCriteria = [];
  for (let i = 1; i <= scTotal; i++) {
    successCriteria.push({ id: `SC${i}`, desc: `criterion number ${i} alpha beta gamma` });
  }
  const constraints = [];
  for (let i = 1; i <= cTotal; i++) {
    constraints.push({ id: `C${i}`, desc: `constraint number ${i}` });
  }
  const ontologyKeywords = [];
  for (let i = 1; i <= kwTotal; i++) ontologyKeywords.push('kw' + i);

  const baseline = { goal: 'goal text', successCriteria, constraints, ontologyKeywords };

  // Tasks: completed tasks that mention covered SC ids + covered kw.
  // Each covered SC → a completed task that references its id.
  const tasks = [];
  for (let i = 1; i <= scCovered; i++) {
    tasks.push({
      id: `t-sc${i}`,
      name: `implement SC${i}`,
      status: 'completed',
      done_criteria: [`covers SC${i}`],
    });
  }
  // A pending task carrying covered ontology keywords (ontology counts all tasks).
  const kwTokens = [];
  for (let i = 1; i <= kwCovered; i++) kwTokens.push('kw' + i);
  if (kwTokens.length > 0) {
    tasks.push({
      id: 't-ont',
      name: 'ontology coverage ' + kwTokens.join(' '),
      status: 'pending',
      done_criteria: [],
    });
  }
  // Violated constraints: a task mentioning C# id + a violation keyword.
  for (let i = 1; i <= cViolated; i++) {
    tasks.push({
      id: `t-cviol${i}`,
      name: `C${i} was bypass`,
      status: 'completed',
      done_criteria: [`C${i} skip`],
    });
  }
  return { baseline, tasks };
}

function simDrift(seed, n, thresholds) {
  const rng = mulberry32(seed);
  const half = Math.floor(n / 2);

  // GOOD population: normal completion. goal coverage 0.8–1.0, constraints fully
  // satisfied, ontology 0.7–1.0. (Models a healthy finished project.)
  const goodWeighted = [];
  for (let i = 0; i < half; i++) {
    const scTotal = 4 + Math.floor(rng() * 3); // 4–6
    const goalCov = 0.8 + rng() * 0.2;
    const scCovered = Math.round(scTotal * goalCov);
    const cTotal = 2 + Math.floor(rng() * 3);
    const kwTotal = 4 + Math.floor(rng() * 5); // 4–8
    const ontCov = 0.7 + rng() * 0.3;
    const kwCovered = Math.round(kwTotal * ontCov);
    const { baseline, tasks } = buildDriftCase(rng, scTotal, scCovered, cTotal, 0, kwTotal, kwCovered);
    goodWeighted.push(computeDrift(baseline, tasks, { threshold: 0.5 }).weighted);
  }

  // BAD population: drift. goal coverage 0.2–0.6, some constraints violated,
  // ontology coverage collapses 0.0–0.4 (the dogfooding failure: ontology=0.18).
  const badWeighted = [];
  for (let i = 0; i < n - half; i++) {
    const scTotal = 4 + Math.floor(rng() * 3);
    const goalCov = 0.2 + rng() * 0.4;
    const scCovered = Math.round(scTotal * goalCov);
    const cTotal = 2 + Math.floor(rng() * 3);
    const cViolated = rng() < 0.4 ? 1 : 0;
    const kwTotal = 4 + Math.floor(rng() * 5);
    const ontCov = rng() * 0.4;
    const kwCovered = Math.round(kwTotal * ontCov);
    const { baseline, tasks } = buildDriftCase(rng, scTotal, scCovered, cTotal, cViolated, kwTotal, kwCovered);
    badWeighted.push(computeDrift(baseline, tasks, { threshold: 0.5 }).weighted);
  }

  return thresholds.map((t) => {
    // block (FAIL) when weighted < threshold
    const fa = goodWeighted.filter((w) => w < t).length / goodWeighted.length;
    const tp = badWeighted.filter((w) => w < t).length / badWeighted.length;
    return { t, fa, tp };
  });
}

// ── Reporting ────────────────────────────────────────────────────────────────

function printTable(title, rows, blurb) {
  console.log('\n' + '═'.repeat(72));
  console.log(title);
  console.log('═'.repeat(72));
  if (blurb) console.log(blurb);
  console.log('  threshold │ false-alarm (good blocked) │ true-positive (bad blocked)');
  console.log('  ──────────┼────────────────────────────┼────────────────────────────');
  for (const r of rows) {
    console.log(
      `   ${r.t.toFixed(2)}     │   ${pct(r.fa).padStart(8)}                 │   ${pct(r.tp).padStart(8)}`
    );
  }
}

/**
 * Recommend a threshold under an explicit cost model per gate.
 *
 * Two objectives, chosen by `objective`:
 *   'min-fa'  — false-alarm is the dominant cost (blocking a good case is
 *               expensive / irreversible). Among rows with TP >= minTp, pick the
 *               one with the lowest FA; tie-break by `conservative`.
 *   'max-tp'  — a missed bad case is the dominant cost (e.g. a vague idea that
 *               slips to PROCEED → wrong build). Among rows with FA <= maxFa,
 *               pick the highest TP; tie-break by `conservative`.
 *
 * `conservative` tie-break: 'higher' favors a higher (stricter-block) threshold,
 * 'lower' favors a lower (looser-block) threshold — direction depends on gate
 * polarity, set by the caller.
 */
function recommend(rows, { objective, maxFa = 0.02, minTp = 0.9, conservative = 'higher' }) {
  let pool;
  if (objective === 'max-tp') {
    const eligible = rows.filter((r) => r.fa <= maxFa);
    if (eligible.length === 0) {
      const minFa = Math.min(...rows.map((r) => r.fa));
      pool = rows.filter((r) => r.fa === minFa);
    } else {
      const maxTp = Math.max(...eligible.map((r) => r.tp));
      pool = eligible.filter((r) => r.tp >= maxTp - 1e-9);
    }
  } else {
    // 'min-fa'
    const eligible = rows.filter((r) => r.tp >= minTp);
    if (eligible.length === 0) {
      const maxTp = Math.max(...rows.map((r) => r.tp));
      pool = rows.filter((r) => r.tp === maxTp);
    } else {
      const minFa = Math.min(...eligible.map((r) => r.fa));
      pool = eligible.filter((r) => r.fa <= minFa + 1e-9);
    }
  }
  pool.sort((a, b) => (conservative === 'higher' ? b.t - a.t : a.t - b.t));
  return pool[0];
}

// ── Run ──────────────────────────────────────────────────────────────────────

console.log(`# Threshold Simulation  (seed=${SEED}, n=${N} per population)`);

const ambThresholds = range(0.1, 0.4, 0.05);
const ambRows = simAmbiguity(SEED, N, ambThresholds);
printTable(
  'GATE 1 — AMBIGUITY (x-probe)  block when ambiguity > threshold',
  ambRows,
  'good = clear idea (mostly validated) │ bad = vague idea (mostly ungrounded)'
);
// Ambiguity cost model: a vague idea that slips to PROCEED → wrong build (very
// expensive). Blocking a clear idea only triggers RETHINK (cheap re-validation).
// So maximize TP, accept moderate FA, tie-break to the LOWER (tighter) threshold.
const ambPick = recommend(ambRows, { objective: 'max-tp', maxFa: 0.12, conservative: 'lower' });

const convThresholds = range(0.8, 0.95, 0.01);
const convRows = simConvergence(SEED, N, convThresholds);
printTable(
  'GATE 2 — CONVERGENCE (x-solver)  block(stop) when outputs too similar',
  convRows,
  'good = genuinely improving (should NOT stop) │ bad = converge/stagnant/oscillate (SHOULD stop)'
);
// Convergence: stopping a still-improving loop wastes the remaining gains (FA bad).
// Higher threshold = stricter "are they REALLY similar" = fewer false stops.
// Empirical cap: the converged unit test relies on a 0.9375-similar pair stopping,
// so the chosen default must be <= 0.93 to keep that test green.
// Convergence cost model: stopping a still-improving loop forfeits the remaining
// gains (expensive false alarm). Minimize FA, require strong TP, and among ties
// pick the HIGHER threshold (stricter "are they REALLY converged"). Empirical cap
// 0.93 keeps the converged unit test (0.9375-similar pair) green.
const convEligible = convRows.filter((r) => r.t <= 0.93);
const convPick = recommend(convEligible, { objective: 'min-fa', minTp: 0.95, conservative: 'higher' });

const driftThresholds = range(0.6, 0.85, 0.05);
const driftRows = simDrift(SEED, N, driftThresholds);
printTable(
  'GATE 3 — DRIFT (x-build)  block(FAIL) when weighted < threshold',
  driftRows,
  'good = normal completion (high coverage) │ bad = drifted (goal+ontology collapse)'
);
// Drift cost model: blocking a healthy completion is costly and demoralizing (FA).
// Minimize FA, require strong TP, tie-break to the HIGHER threshold for a stricter
// drift gate (more margin against the ontology-collapse fragility seen in dogfood).
const driftPick = recommend(driftRows, { objective: 'min-fa', minTp: 0.95, conservative: 'higher' });

console.log('\n' + '═'.repeat(72));
console.log('RECOMMENDATIONS (false-alarm minimized, true-positive retained)');
console.log('═'.repeat(72));
console.log(
  `  ambiguity   threshold = ${ambPick.t.toFixed(2)}   (FA ${pct(ambPick.fa)}, TP ${pct(ambPick.tp)})`
);
console.log(
  `  convergence threshold = ${convPick.t.toFixed(2)}   (FA ${pct(convPick.fa)}, TP ${pct(convPick.tp)})`
);
console.log(
  `  drift       threshold = ${driftPick.t.toFixed(2)}   (FA ${pct(driftPick.fa)}, TP ${pct(driftPick.tp)})`
);
console.log('');

// Emit machine-readable summary for downstream consumption / commit record.
const summary = {
  seed: SEED,
  n: N,
  ambiguity: { picked: ambPick.t, fa: ambPick.fa, tp: ambPick.tp, table: ambRows },
  convergence: { picked: convPick.t, fa: convPick.fa, tp: convPick.tp, table: convRows },
  drift: { picked: driftPick.t, fa: driftPick.fa, tp: driftPick.tp, table: driftRows },
};
if (args.includes('--json')) {
  console.log(JSON.stringify(summary, null, 2));
}
