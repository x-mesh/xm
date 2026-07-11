/**
 * x-panel/gate — panel verdict → merge-gate decision.
 *
 * Pure logic: (verdict, policy) → { decision: 'pass'|'fail', blocking }. A panel
 * `--json` run exits 0 whenever it RAN, even when it surfaced blocking consensus
 * findings — so "run the panel" and "turn the verdict into a merge gate" are
 * separate steps. `xm panel gate <run>` is the second step for CI / non-worktree
 * users, converting a stored verdict.json into an exit code.
 *
 * PARALLEL COPY: x-build/lib/x-build/gate-panel.mjs carries the same evaluator for
 * its worktree-finish gate (it sources policy from the worktree config instead of a
 * --policy flag). The two evaluation cores (DEFAULT_POLICY / blocksFor /
 * evaluateVerdict) MUST stay in lockstep until x-build delegates to `xm panel gate`
 * via subprocess (tracked follow-up — the consolidation touches x-build's fake-panel
 * test-injection path, so it is done separately, not bundled here).
 */

// Severity classes that block, per finding bucket. `allow_low` (default true)
// forces every 'low' finding non-blocking regardless of the lists.
export const DEFAULT_POLICY = {
  block_confirmed: ['critical', 'high', 'medium'],
  block_unreviewed: ['critical', 'high'],
  block_contested: ['critical'],
  allow_low: true,
};

// Shallow per-key override on top of the defaults — a present key fully replaces
// the default list (matches x-build gate-panel's mergePolicy semantics).
export function mergePolicy(override = {}) {
  return { ...DEFAULT_POLICY, ...(override || {}) };
}

function blocksFor(findings, severities, allowLow) {
  const set = new Set((severities || []).map(s => String(s).toLowerCase()));
  const out = [];
  for (const f of findings || []) {
    const sev = String(f.severity || '').toLowerCase();
    if (allowLow && sev === 'low') continue;
    if (!set.has(sev)) continue;
    out.push({ severity: f.severity, file: f.file ?? null, line: f.line ?? null, claim: f.claim ?? null });
  }
  return out;
}

// Evaluate a synthesized verdict ({confirmed, unreviewed, contested}[]) against a
// policy. Returns { decision, blocking } — decision 'fail' if any finding in any
// bucket matches its block list.
export function evaluateVerdict(verdict, policy) {
  const allowLow = policy.allow_low !== false;
  const blocking = [];
  for (const b of blocksFor(verdict.confirmed, policy.block_confirmed, allowLow)) blocking.push({ ...b, kind: 'confirmed' });
  for (const b of blocksFor(verdict.unreviewed, policy.block_unreviewed, allowLow)) blocking.push({ ...b, kind: 'unreviewed' });
  for (const b of blocksFor(verdict.contested, policy.block_contested, allowLow)) blocking.push({ ...b, kind: 'contested' });
  return { decision: blocking.length ? 'fail' : 'pass', blocking };
}
