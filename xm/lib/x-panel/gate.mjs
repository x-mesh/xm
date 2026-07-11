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

const BUCKETS = ['block_confirmed', 'block_unreviewed', 'block_contested'];
// A bucket holding an unknown severity matches no finding, so a single typo
// (block_confirmed: ["critcal"]) would SILENTLY disable the gate — the worst possible
// failure for a merge guard. Validate the values, not just the container (re-review N3).
const SEVERITIES = ['critical', 'high', 'medium', 'low'];

// Shallow per-key override on top of the defaults — a present key fully replaces
// the default list (matches x-build gate-panel's mergePolicy semantics). The shape is
// VALIDATED: a malformed bucket (e.g. --policy '{"block_confirmed":"critical"}') used to
// reach blocksFor and die on `.map` with a raw TypeError instead of a controlled gate
// error (F6). Callers map the throw to exit 2.
export function mergePolicy(override = {}) {
  // The override itself must be a plain object. null/array/string used to spread into
  // something that still "looked like" a policy, so a caller passing garbage got a
  // silently-default gate instead of an error (re-review M2). An explicit `null` is
  // rejected too — it quietly swapped the caller's intended policy for the defaults (R4).
  if (override !== undefined
      && (override === null || typeof override !== 'object' || Array.isArray(override))) {
    const kind = override === null ? 'null' : Array.isArray(override) ? 'array' : typeof override;
    throw new Error(`policy must be a JSON object (got ${kind})`);
  }
  const merged = { ...DEFAULT_POLICY, ...(override || {}) };
  for (const b of BUCKETS) {
    if (!Array.isArray(merged[b])) {
      throw new Error(`policy.${b} must be an array of severities (got ${merged[b] === null ? 'null' : typeof merged[b]})`);
    }
    for (const s of merged[b]) {
      if (!SEVERITIES.includes(String(s).toLowerCase())) {
        throw new Error(`policy.${b} has unknown severity "${s}" (expected ${SEVERITIES.join('|')}) — a typo here would silently disable the gate`);
      }
    }
  }
  if (typeof merged.allow_low !== 'boolean') {
    throw new Error(`policy.allow_low must be a boolean (got ${typeof merged.allow_low})`);
  }
  return merged;
}

function blocksFor(findings, severities, allowLow) {
  const set = new Set((Array.isArray(severities) ? severities : []).map(s => String(s).toLowerCase()));
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
