import { appendAttentionRows, collectAttention, readAttentionLedger } from './attention-collect.mjs';
import { aggregateEscapeRows } from './escape-ledger.mjs';
import { applyBudget, attentionQueueHealth, rankAttention } from './attention-rank.mjs';
import { resolveMainRepoRoot } from './worktree-shared.mjs';
import { resolve } from 'node:path';

function usage() { console.error('Usage: xm build attention [--backfill] [--dry-run] [--budget N] [--json] [--since Nd|Nh|Nm] [--ack ID] [--note TEXT]'); }
function duration(value) {
  if (value == null) return null;
  const match = /^(\d+)([dhm])$/.exec(value);
  if (!match || Number(match[1]) <= 0) return NaN;
  return Number(match[1]) * ({ d: 864e5, h: 36e5, m: 6e4 }[match[2]]);
}
function stateRoot(cwd=process.cwd()){if(process.env.X_BUILD_ROOT)return resolve(process.env.X_BUILD_ROOT,'..','..');if(process.env.XM_ROOT)return resolve(process.env.XM_ROOT,'..');return resolveMainRepoRoot(cwd)||resolve(cwd);}

export function cmdAttention(args) {
  let backfill = false, dry = false, json = false, budget = 5, ack = null, note = null, since = null;
  const take = index => args[index + 1] != null && !args[index + 1].startsWith('--') ? args[index + 1] : null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--backfill') backfill = true;
    else if (arg === '--dry-run') dry = true;
    else if (arg === '--json') json = true;
    else if (arg === '--budget' && take(index) != null) budget = Number(args[++index]);
    else if (arg === '--ack' && take(index) != null) ack = args[++index];
    else if (arg === '--note' && take(index) != null) note = args[++index];
    else if (arg === '--since' && take(index) != null) since = args[++index];
    else { usage(); process.exitCode = 2; return; }
  }
  const sinceMs = duration(since);
  if (!Number.isInteger(budget) || budget < 0 || Number.isNaN(sinceMs) || (!ack && note)) { usage(); process.exitCode = 2; return; }
  const root = stateRoot();
  try {
    let written = 0;
    const collected = backfill ? collectAttention(root) : { rows: [], parse_errors: 0 };
    if (backfill && !dry) written = appendAttentionRows(root, collected.rows);
    const before = readAttentionLedger(root);
    const visibleInput = dry ? [...before.rows, ...collected.rows] : before.rows;
    if (ack && !visibleInput.some(row => row.id === ack && row.type !== 'ack')) { console.error('Unknown attention id'); process.exitCode = 1; return; }
    if (ack && !dry) written += appendAttentionRows(root, [{ type: 'ack', id: ack, ts: new Date().toISOString(), note }]);
    const ledger = dry ? { ...before, rows: visibleInput } : readAttentionLedger(root);
    const aggregate = aggregateEscapeRows(ledger.rows);
    const cutoff = sinceMs == null ? null : Date.now() - sinceMs;
    const filtered = cutoff == null ? aggregate.rows : aggregate.rows.filter(row => Date.parse(row.ts) >= cutoff);
    const rows = applyBudget(rankAttention(filtered, { budget: 0, acked: aggregate.acked }), budget);
    const queue_health = attentionQueueHealth(filtered, { acked: aggregate.acked });
    const source_counts = { escape: 0, contested: 0, mutant: 0, revived: 0 };
    for (const row of filtered) { const key = row.type === 'surviving_mutant' ? 'mutant' : row.type; if (source_counts[key] != null) source_counts[key] += 1; }
    const exists = ledger.exists || collected.rows.length > 0;
    const out = { items: rows, data: rows, count: rows.length, written, parse_errors: (ledger.parse_errors ?? ledger.skipped ?? 0) + (collected.parse_errors || 0), source_counts, queue_health, state: exists ? 'ok' : 'no_data' };
    if (json) console.log(JSON.stringify(out));
    else if (!exists) console.log('No attention data yet.');
    else if (!rows.length) console.log('No active attention signals.');
    else if (queue_health.warning) { console.log(`⚠ ${queue_health.unacked_count} attention item(s) remain unacknowledged; oldest is ${queue_health.oldest_age_days} days old.`); rows.forEach(row => console.log([row.score, row.type, row.id, row.file || ''].join(' '))); }
    else rows.forEach(row => console.log([row.score, row.type, row.id, row.file || ''].join(' ')));
  } catch (error) { console.error('attention: ' + error.message); process.exitCode = 2; }
}
