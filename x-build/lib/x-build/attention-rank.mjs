/** PURE deterministic ranking for the attention queue. */
const TYPE_WEIGHT = { revived: 100, escape: 90, surviving_mutant: 80, contested: 60 };
const CLASS_WEIGHT = { dismissed_as_fp: 35, accepted_risk: 20, backlogged: 15, reviewed_missed: 10, not_reviewed: 0 };
const SEVERITY_WEIGHT = { critical: 40, high: 30, medium: 20, low: 10 };

export function attentionScore(row, now = Date.now()) {
  const type = TYPE_WEIGHT[row?.type] || 0;
  const escapeClass = CLASS_WEIGHT[row?.escape_class] || 0;
  const severity = SEVERITY_WEIGHT[String(row?.severity || '').toLowerCase()] || 0;
  const timestamp = Date.parse(row?.ts || '');
  const recency = Number.isFinite(timestamp) ? Math.max(0, 20 - Math.floor(Math.max(0, now - timestamp) / 86400000)) : 0;
  return type + escapeClass + severity + recency;
}

export function applyBudget(items, budget = 5) {
  if (!Number.isInteger(budget) || budget < 0) return [];
  return budget === 0 ? [...items] : items.slice(0, budget);
}

export function attentionQueueHealth(rows, { acked = new Set(), now = Date.now(), warningAfterDays = 14 } = {}) {
  const active = (rows || []).filter(row => row && !acked.has(row.id));
  let oldestTimestamp = null;
  for (const row of active) {
    const timestamp = Date.parse(row.ts || '');
    if (Number.isFinite(timestamp) && (oldestTimestamp == null || timestamp < oldestTimestamp)) oldestTimestamp = timestamp;
  }
  const oldestAgeDays = oldestTimestamp == null ? null : Math.max(0, Math.floor((now - oldestTimestamp) / 86400000));
  return {
    warning: oldestAgeDays != null && oldestAgeDays >= warningAfterDays,
    warning_after_days: warningAfterDays,
    unacked_count: active.length,
    oldest_age_days: oldestAgeDays,
  };
}

export function rankAttentionItems({ escapes = [], contested = [], mutants = [], revived = [] } = {}, { acked = new Set(), now = Date.now() } = {}) {
  const rows = [...escapes, ...contested, ...mutants, ...revived]
    .filter(row => row && !acked.has(row.id))
    .map(row => ({ ...row, score: attentionScore(row, now) }));
  rows.sort((a, b) => b.score - a.score
    || String(b.ts).localeCompare(String(a.ts))
    || String(a.id).localeCompare(String(b.id))
    || String(a.artifact || '').localeCompare(String(b.artifact || '')));
  return rows;
}

export function rankAttention(rows, { budget = 5, acked = new Set(), now = Date.now() } = {}) {
  const grouped = { escapes: [], contested: [], mutants: [], revived: [] };
  for (const row of rows || []) {
    if (row?.type === 'escape') grouped.escapes.push(row);
    else if (row?.type === 'contested') grouped.contested.push(row);
    else if (row?.type === 'surviving_mutant') grouped.mutants.push(row);
    else if (row?.type === 'revived') grouped.revived.push(row);
  }
  return applyBudget(rankAttentionItems(grouped, { acked, now }), budget);
}
