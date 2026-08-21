import { spawn, spawnSync } from 'node:child_process';
import { extractPlanJSON } from './json-scan.mjs';
import { synthesizePlanCandidates } from './synthesize.mjs';

export const ULTRA_ROLES = ['architect', 'implementer', 'critic'];
export function assignUltraRoles(models) { return models.map((model, index) => ({ model, role: ULTRA_ROLES[index % ULTRA_ROLES.length] })); }
function promptFor(role, requirements) {
  return [
    `You are the ${role} planner. Produce exactly one PlanEnvelope v1 JSON object and no prose.`,
    'Requirements:', String(requirements), '',
    'Use schema_version=1 and include status, executable, goal, requirements, assumptions, decision, tasks, steps, validation, disagreements, unresolved_questions, provenance.',
    'Do not invent repository files, APIs, or commands. Every requirement needs task or validation coverage; every task needs done_criteria.',
  ].join('\n');
}
export function killProcessTree(child, { platform = process.platform, runTaskkill = spawnSync } = {}) {
  if (!child?.pid) return;
  if (platform === 'win32') {
    const result = runTaskkill('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    if (result?.status === 0) return;
    try { child.kill('SIGKILL'); } catch { }
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { } }
}
function runOne(entry, requirements, { command = process.env.X_PLAN_PANEL_CMD || 'xm', timeoutMs = 900000 } = {}) {
  return new Promise((resolve) => {
    const backendArgs = command === 'xm'
      ? ['panel', 'cross', '--models', entry.model, '--source', 'plan:ultra', '--title', `x-plan ${entry.role}`, '--prompt', promptFor(entry.role, requirements), '--json']
      : [entry.model, entry.role, requirements];
    const executable = command.endsWith('.mjs') ? process.execPath : command;
    const args = command.endsWith('.mjs') ? [command, ...backendArgs] : backendArgs;
    const child = spawn(executable, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const timer = setTimeout(() => { killProcessTree(child); finish({ source: entry.model, role: entry.role, ok: false, error: `backend timeout ${timeoutMs}ms`, raw: stdout }); }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (error) => { clearTimeout(timer); finish({ source: entry.model, role: entry.role, ok: false, error: error.message, raw: stdout }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (code !== 0) return finish({ source: entry.model, role: entry.role, ok: false, error: stderr.trim() || `backend exit ${code}`, raw: stdout });
      let candidateText = stdout;
      if (command === 'xm') {
        try { const record = JSON.parse(stdout); const row = (record.results || []).find((item) => item.model === entry.model || item.provider === entry.model.split(':')[0]); candidateText = row?.output || ''; } catch { }
      }
      const plan = extractPlanJSON(candidateText);
      finish(plan ? { source: entry.model, role: entry.role, ok: true, plan, raw: candidateText } : { source: entry.model, role: entry.role, ok: false, error: 'no PlanEnvelope JSON in backend output', raw: candidateText });
    });
  });
}
export async function runUltraPlan(requirements, models, options = {}) {
  const entries = assignUltraRoles(models);
  const maxParallel = Math.max(1, Math.min(Number(options.maxParallel) || 3, 8));
  const candidates = new Array(entries.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(maxParallel, entries.length) }, async () => {
    while (cursor < entries.length) { const index = cursor++; candidates[index] = await runOne(entries[index], requirements, options); }
  }));
  const synthesized = synthesizePlanCandidates(candidates, { requested_models: models, backend: options.command || process.env.X_PLAN_PANEL_CMD || 'xm panel cross' });
  return { ...synthesized, rawCandidates: candidates };
}
