/**
 * x-panel/tm-backend — EXPERIMENT (t8, docs/x-panel-term-mesh-phase2.md §6):
 * route a panel model call to a persistent term-mesh pane instead of spawning
 * a cold provider CLI.
 *
 * Honest expectation (from the plan): a warm pane only saves CLI cold-start
 * (~1–3s) while the model call dominates (30–120s), so this ships OPT-IN
 * (`--backend tm` + a `panel.tm_agents` provider→agent map) behind a
 * measurement gate — adopt as default ONLY if the live bench
 * (x-panel/test/bench-tm-backend.mjs) shows ≥20% p50 wall-clock improvement
 * with zero JSON-validity regressions.
 *
 * Mechanics — file handoff, never socket text: `tm-agent reply` truncates at
 * 1500 chars which would corrupt JSON, so the task capsule instructs the agent
 * to write the JSON to a file in the run dir; the panel polls that file.
 * The result object mirrors invokeProviderAsync's shape ({ok, json, raw,
 * error}) so runRound consumers cannot tell the backends apart.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { extractJSON } from './adapters.mjs';

// A pane's panel answer is small JSON; cap the handoff read so a runaway or
// misbehaving pane can't slurp an arbitrarily large file into memory.
const MAX_HANDOFF_BYTES = 8 * 1024 * 1024;

/** tm-agent argv prefix. X_PANEL_TM_AGENT points tests at a stub script. */
export function tmAgentCommand(env = process.env) {
  const override = env.X_PANEL_TM_AGENT;
  if (override) return ['node', [override]];
  return ['tm-agent', []];
}

export function tmBackendAvailable(env = process.env) {
  if (env.X_PANEL_TM_AGENT) return existsSync(env.X_PANEL_TM_AGENT);
  const r = spawnSync('sh', ['-c', 'command -v tm-agent'], { encoding: 'utf8' });
  return r.status === 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Delegate one prompt to a term-mesh agent pane and wait for its JSON file.
 *
 * @param {object} opts
 * @param {string} opts.agent     term-mesh agent name (from panel.tm_agents map)
 * @param {string} opts.prompt    full round prompt (written to a file — no shell quoting)
 * @param {string} opts.runDir    .xm/panel/<run>/ — prompt + output live here
 * @param {string} opts.label     model label (file stem; sanitized)
 * @param {number} [opts.timeoutMs]
 * @param {(ev: object) => void} [opts.onEvent]  same event sink as invokeProviderAsync
 * @param {object} [opts.env]
 * @returns {Promise<{ok: boolean, error: string|null, raw: string, json: object|null, backend: 'tm'}>}
 */
export async function invokeViaTmPane({ agent, prompt, runDir, label, timeoutMs = 600_000, onEvent = null, env = process.env }) {
  const emit = (event) => {
    if (!onEvent) return;
    try { onEvent({ at: new Date().toISOString(), ...event }); } catch { /* observer only */ }
  };
  const safe = String(label).replace(/[^a-zA-Z0-9._-]/g, '_');
  const promptPath = join(runDir, `${safe}.tm.prompt.txt`);
  const outPath = join(runDir, `${safe}.tm.json`);
  try { rmSync(outPath, { force: true }); } catch { /* stale run leftovers */ }
  writeFileSync(promptPath, prompt, 'utf8');

  // TM-PROTOCOL-v1 task capsule: absolute paths, JSON-to-file (socket replies
  // truncate at 1500 chars), Standard Reply Header so the pane completes its task.
  const capsule = `TM-PROTOCOL-v1 x-panel call — read the prompt file at ${promptPath} and follow it EXACTLY; write ONLY the JSON object it requests to ${outPath} (no prose, no markdown fences); then reply with STATUS: DONE and FILES: ${outPath}.`;

  const [bin, baseArgs] = tmAgentCommand(env);
  emit({ type: 'lifecycle', provider: agent, note: `tm backend: delegate → ${agent}` });
  const d = spawnSync(bin, [...baseArgs, 'delegate', agent, capsule], { encoding: 'utf8', timeout: 30_000, env });
  if (d.error || d.status !== 0) {
    const error = `tm-agent delegate failed: ${d.error ? String(d.error.message || d.error) : `exit ${d.status}: ${(d.stderr || '').trim().slice(0, 200)}`}`;
    emit({ type: 'error', provider: agent, error });
    return { ok: false, error, raw: '', json: null, backend: 'tm' };
  }

  // Poll for the agent's file. A just-created file may be mid-write, so a
  // parse failure keeps polling until the deadline instead of failing fast.
  const t0 = Date.now();
  let lastRaw = '';
  while (Date.now() - t0 < timeoutMs) {
    if (existsSync(outPath)) {
      let oversize = false;
      try { oversize = statSync(outPath).size > MAX_HANDOFF_BYTES; } catch { /* mid-write; retry next tick */ }
      if (oversize) {
        const error = `tm backend: ${outPath} exceeds ${MAX_HANDOFF_BYTES} bytes — refusing to read`;
        emit({ type: 'error', provider: agent, error });
        return { ok: false, error, raw: '', json: null, backend: 'tm' };
      }
      try { lastRaw = readFileSync(outPath, 'utf8'); } catch { lastRaw = ''; }
      const json = lastRaw ? extractJSON(lastRaw) : null;
      if (json) {
        emit({ type: 'json_parsed', provider: agent });
        return { ok: true, error: null, raw: lastRaw, json, backend: 'tm' };
      }
    }
    await sleep(250);
  }
  const error = existsSync(outPath)
    ? `tm backend: ${outPath} never contained a JSON object`
    : `tm backend: timeout ${Math.round(timeoutMs / 1000)}s waiting for ${outPath}`;
  emit({ type: 'timeout', provider: agent, error });
  return { ok: false, error, raw: lastRaw, json: null, backend: 'tm' };
}
