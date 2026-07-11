// x-panel/history.mjs — the disagreement ledger.
//
// Each finished review appends one row PER MODEL to .xm/panel/history.jsonl, so
// per-vendor accuracy accrues across runs into a per-repo data moat: refutation
// survival rate, catches, round-2 fidelity, and cost per catch — signals a
// stateless API council can't accumulate. Cost/tokens are null ("unknown") until
// usage capture lands — never 0, which would understate real spend (roadmap 빅뱃2).

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Build one row per model from a finished review record (verdict.json shape:
// { run, created_at, models[], by_model{}, usage: { by_model{} } }).
export function historyRows(record) {
  const ts = record.created_at || null;
  const run = record.run || null;
  const models = Array.isArray(record.models) ? record.models : [];
  const byModel = record.by_model || {};
  const usage = (record.usage && record.usage.by_model) || {};
  return models.map((m) => {
    const bm = byModel[m] || {};
    const u = usage[m] || {};
    const tokens = (typeof u.tokens === 'number' && u.tokens > 0) ? u.tokens : null;
    const cost = (typeof u.cost_usd === 'number' && u.cost_usd > 0) ? u.cost_usd : null;
    return {
      ts, run, model: m,
      raised: bm.raised ?? 0,
      confirmed: bm.confirmed ?? 0,      // findings this vendor raised that survived to CONFIRMED
      contested: bm.contested ?? 0,      // …that were refuted by an opponent
      unmatched_refs: bm.unmatched_refs ?? 0, // round-2 fidelity misses (mangled/self refs)
      r1: bm.r1 || 'ok',
      tokens,          // null = unknown (usage capture not wired yet)
      cost_usd: cost,  // null = unknown — never 0
    };
  });
}

// Append the record's per-model rows to <panelDir>/history.jsonl. Returns the row
// count written. Best-effort at the call site: analytics must never break a review.
export function appendPanelHistory(panelDir, record) {
  const rows = historyRows(record);
  if (!rows.length) return 0;
  mkdirSync(panelDir, { recursive: true });
  const path = join(panelDir, 'history.jsonl');
  for (const r of rows) appendFileSync(path, JSON.stringify(r) + '\n', 'utf8');
  return rows.length;
}

export function readPanelHistory(panelDir) {
  const path = join(panelDir, 'history.jsonl');
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip a torn/legacy line */ }
  }
  return out;
}

// Aggregate rows into per-vendor stats. survival_rate = confirmed / raised (fraction
// of a vendor's raised findings that survived refutation). cost is null when NO
// sampled run carried usage — reported as "unknown", not $0.00.
export function aggregatePanelStats(rows) {
  const byModel = new Map();
  for (const r of rows) {
    const k = r.model;
    if (!k) continue;
    if (!byModel.has(k)) {
      byModel.set(k, { model: k, runs: 0, raised: 0, confirmed: 0, contested: 0, unmatched_refs: 0, r1_failed: 0, cost_known_runs: 0, cost_sum: 0, tokens: 0 });
    }
    const a = byModel.get(k);
    a.runs++;
    a.raised += r.raised || 0;
    a.confirmed += r.confirmed || 0;
    a.contested += r.contested || 0;
    a.unmatched_refs += r.unmatched_refs || 0;
    if (r.r1 === 'failed') a.r1_failed++;
    if (typeof r.cost_usd === 'number') { a.cost_known_runs++; a.cost_sum += r.cost_usd; }
    if (typeof r.tokens === 'number') a.tokens += r.tokens;
  }
  return [...byModel.values()].map((a) => ({
    model: a.model,
    runs: a.runs,
    raised: a.raised,
    confirmed: a.confirmed,
    contested: a.contested,
    unmatched_refs: a.unmatched_refs,
    r1_failed: a.r1_failed,
    survival_rate: a.raised > 0 ? a.confirmed / a.raised : null,
    cost_usd: a.cost_known_runs > 0 ? a.cost_sum : null,           // null = unknown
    cost_per_confirmed: (a.cost_known_runs > 0 && a.confirmed > 0) ? a.cost_sum / a.confirmed : null,
  })).sort((x, y) => (y.survival_rate ?? -1) - (x.survival_rate ?? -1) || y.confirmed - x.confirmed);
}
