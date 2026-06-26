/**
 * x-panel/synth — normalize model output and synthesize a cross-model verdict.
 *
 * Pure functions (no I/O, no model calls) so they're cheap to unit-test.
 *
 * Adversarial rule (N models): a finding raised by model P is CONFIRMED when no
 * opponent refuted it in round 2, and CONTESTED when at least one opponent
 * refuted it. Round-2 verdicts reference findings by a GLOBAL ref `owner#idx`
 * so 3+ models don't collide on per-model indices. Diversity = which model
 * uniquely surfaced each finding.
 */

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

export function normalizeFindings(raw) {
  const arr = raw && Array.isArray(raw.findings) ? raw.findings : [];
  return arr
    .map((f, i) => ({
      idx: i,
      severity: normalizeSeverity(f.severity),
      file: f.file || null,
      line: f.line ?? null,
      claim: String(f.claim || f.summary || '').trim(),
      evidence: String(f.evidence || '').trim(),
    }))
    .filter(f => f.claim);
}

function normalizeSeverity(s) {
  const v = String(s || 'low').toLowerCase();
  return v in SEV_RANK ? v : 'low';
}

export function normalizeVerdicts(raw) {
  const arr = raw && Array.isArray(raw.verdicts) ? raw.verdicts : [];
  return arr.map(v => ({
    ref: String(v.ref ?? '').trim(), // global ref like "codex#0"
    stance: String(v.stance || '').toLowerCase() === 'refute' ? 'refute' : 'concede',
    reason: String(v.reason || '').trim(),
  })).filter(v => v.ref);
}

/**
 * @param models  string[] participating model names
 * @param round1  { [model]: normalizedFindings[] }
 * @param round2  { [model]: normalizedVerdicts[] }  — model's verdicts on the OTHER models'
 *                findings, each verdict referencing a finding by its global ref `owner#idx`
 */
export function synthesize(models, round1, round2) {
  const confirmed = [];
  const contested = [];
  for (const owner of models) {
    const others = models.filter(m => m !== owner);
    for (const f of round1[owner] || []) {
      const gref = `${owner}#${f.idx}`;
      const opponents = [];
      for (const opp of others) {
        const v = (round2[opp] || []).find(x => x.ref === gref);
        if (v) opponents.push({ model: opp, stance: v.stance, reason: v.reason });
      }
      const entry = { owner, ...f, opponents };
      if (opponents.some(o => o.stance === 'refute')) contested.push(entry);
      else confirmed.push(entry);
    }
  }
  const bySev = (a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9);
  confirmed.sort(bySev);
  contested.sort(bySev);

  const byModel = {};
  for (const m of models) {
    byModel[m] = {
      raised: (round1[m] || []).length,
      confirmed: confirmed.filter(f => f.owner === m).length,
      contested: contested.filter(f => f.owner === m).length,
    };
  }

  const consensus = mergeConsensus(confirmed);
  return {
    models,
    counts: { confirmed: confirmed.length, contested: contested.length, unique: consensus.length },
    by_model: byModel,
    consensus,
    confirmed,
    contested,
  };
}

function sameLine(a, b, tol) {
  if (a == null || b == null) return a === b;
  return Math.abs(a - b) <= tol;
}

/**
 * Merge findings that point at the same issue (same file, line within tolerance)
 * across models into one entry. Collapses the duplicate explosion that grows with
 * model count, and surfaces consensus (how many models agreed) vs single-model
 * findings (diversity). Cross-language claims are preserved per model.
 */
export function mergeConsensus(findings, { lineTolerance = 2 } = {}) {
  const clusters = [];
  for (const f of findings) {
    let cl = clusters.find(c => c.file === f.file && sameLine(c.line, f.line, lineTolerance));
    if (!cl) { cl = { file: f.file, line: f.line, members: [] }; clusters.push(cl); }
    cl.members.push(f);
    if (cl.line == null && f.line != null) cl.line = f.line; // prefer a concrete line
  }
  return clusters.map(c => {
    const models = [...new Set(c.members.map(m => m.owner))];
    const severity = c.members
      .map(m => m.severity)
      .sort((a, b) => (SEV_RANK[a] ?? 9) - (SEV_RANK[b] ?? 9))[0]; // highest severity wins
    return {
      severity,
      file: c.file,
      line: c.line,
      consensus: models.length,
      models,
      claims: c.members.map(m => ({ model: m.owner, severity: m.severity, claim: m.claim })),
    };
  }).sort((a, b) => (b.consensus - a.consensus) || ((SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9)));
}
