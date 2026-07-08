#!/usr/bin/env node
/**
 * t8 adoption gate bench (docs/x-panel-term-mesh-phase2.md §6): subprocess vs
 * tm-pane backend, measured LIVE — run this inside a term-mesh session with an
 * active team whose panes are mapped in panel.tm_agents. Not a unit test
 * (spends real model calls); bun test never picks it up.
 *
 *   node x-panel/test/bench-tm-backend.mjs [--target <t>] [--models a,b] [--iterations N]
 *
 * GATE (Lesson L9 — thresholds from measurement, not judgment): adopt tm as a
 * default backend ONLY if p50 wall-clock improves ≥20% AND JSON validity has
 * zero regressions. Record the table + verdict in the phase-2 plan §6.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'x-panel-cli.mjs');
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] != null ? args[i + 1] : dflt;
};
const TARGET = flag('--target', 'diff');
const MODELS = flag('--models', 'claude,codex');
const N = Number(flag('--iterations', '3'));

function runOnce(backendArgs) {
  const t0 = Date.now();
  const r = spawnSync('node', [CLI, 'review', TARGET, '--models', MODELS, ...backendArgs], {
    encoding: 'utf8', timeout: 20 * 60_000, env: process.env,
  });
  const ms = Date.now() - t0;
  // JSON validity = every model produced parseable findings AND verdicts (r1/r2 ok flags).
  const panelDir = join(process.cwd(), '.xm', 'panel');
  const runs = existsSync(panelDir) ? readdirSync(panelDir).sort() : [];
  const latest = runs[runs.length - 1];
  let okModels = 0, totalModels = 0;
  if (latest) {
    for (const f of readdirSync(join(panelDir, latest))) {
      if (!/\.r[12]\.json$/.test(f)) continue;
      totalModels += 1;
      try { if (JSON.parse(readFileSync(join(panelDir, latest, f), 'utf8')).ok) okModels += 1; } catch { /* counts as invalid */ }
    }
  }
  return { ms, exit: r.status, okModels, totalModels, run: latest };
}

const p50 = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];

console.log(`bench: target=${TARGET} models=${MODELS} iterations=${N}\n`);
const results = { subprocess: [], tm: [] };
for (let i = 0; i < N; i++) {
  for (const [name, extra] of [['subprocess', ['--no-tm-events']], ['tm', ['--backend', 'tm', '--no-tm-events']]]) {
    process.stdout.write(`  ${name} #${i + 1}… `);
    const r = runOnce(extra);
    results[name].push(r);
    console.log(`${(r.ms / 1000).toFixed(1)}s exit=${r.exit} json=${r.okModels}/${r.totalModels} (${r.run})`);
  }
}

const sub = results.subprocess, tm = results.tm;
const subP50 = p50(sub.map((r) => r.ms)), tmP50 = p50(tm.map((r) => r.ms));
const subInvalid = sub.reduce((n, r) => n + (r.totalModels - r.okModels), 0);
const tmInvalid = tm.reduce((n, r) => n + (r.totalModels - r.okModels), 0);
const improvement = (subP50 - tmP50) / subP50;

console.log(`\np50 wall-clock : subprocess ${(subP50 / 1000).toFixed(1)}s  vs  tm ${(tmP50 / 1000).toFixed(1)}s  (${(improvement * 100).toFixed(1)}% improvement)`);
console.log(`json failures  : subprocess ${subInvalid}  vs  tm ${tmInvalid}`);
const pass = improvement >= 0.20 && tmInvalid <= subInvalid;
console.log(`\nGATE: ${pass ? 'PASS — tm backend may be adopted as a default' : 'FAIL — keep subprocess as the default backend'}`);
console.log('Record this table + verdict in xm/docs/x-panel-term-mesh-phase2.md §6 (t8).');
process.exit(0);
