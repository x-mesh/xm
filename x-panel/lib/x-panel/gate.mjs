/**
 * x-panel/gate — panel verdict → merge-gate decision.
 *
 * Pure logic: (verdict, policy) → { decision: 'pass'|'fail', blocking, advisory }.
 * A panel `--json` run exits 0 whenever it RAN, even when it surfaced blocking
 * consensus findings — so "run the panel" and "turn the verdict into a merge gate"
 * are separate steps. `xm panel gate <run>` is the second step for CI / non-worktree
 * users, converting a stored verdict.json into an exit code.
 *
 * PARALLEL COPY: x-build/lib/x-build/gate-panel.mjs carries the same evaluator for
 * its worktree-finish gate (it sources policy from the worktree config instead of a
 * --policy flag). The two evaluation cores (DEFAULT_POLICY / blocksFor /
 * evaluateVerdict / resolvePolicyForPhase) MUST stay in lockstep until x-build
 * delegates to `xm panel gate` via subprocess (tracked follow-up — the consolidation
 * touches x-build's fake-panel test-injection path, so it is done separately).
 */

// Gate phases a policy overlay may target. Mirrors gate-panel's VALID_PHASES.
export const GATE_PHASES = ['before', 'after', 'release'];

// Severity classes that block, per finding bucket. `allow_low` (default true)
// forces every 'low' finding non-blocking regardless of the lists.
//
// Default calibration (docs/worktree-gate-optimization-plan.md §3A): the per-task
// gate blocks critical/high only — a confirmed medium costs a full expensive panel
// round-trip (~20-25 min measured) while being release-fixable. The `release` phase
// overlay re-adds medium so it is DEFERRED to the pre-release integration review,
// never dropped: non-blocking confirmed findings surface as `advisory`.
export const DEFAULT_POLICY = {
  block_confirmed: ['critical', 'high'],
  block_unreviewed: ['critical', 'high'],
  block_contested: ['critical'],
  allow_low: true,
  release: { block_confirmed: ['critical', 'high', 'medium'] },
};

const BUCKETS = ['block_confirmed', 'block_unreviewed', 'block_contested'];
// A bucket holding an unknown severity matches no finding, so a single typo
// (block_confirmed: ["critcal"]) would SILENTLY disable the gate — the worst possible
// failure for a merge guard. Validate the values, not just the container (re-review N3).
const SEVERITIES = ['critical', 'high', 'medium', 'low'];

// Validate one flat policy layer's buckets + allow_low. `where` prefixes error
// messages so an overlay error names its phase (policy.release.block_confirmed …).
function validateFlat(policy, where) {
  for (const b of BUCKETS) {
    if (policy[b] === undefined) continue; // overlays are partial
    if (!Array.isArray(policy[b])) {
      throw new Error(`policy.${where}${b} must be an array of severities (got ${policy[b] === null ? 'null' : typeof policy[b]})`);
    }
    for (const s of policy[b]) {
      if (!SEVERITIES.includes(String(s).toLowerCase())) {
        throw new Error(`policy.${where}${b} has unknown severity "${s}" (expected ${SEVERITIES.join('|')}) — a typo here would silently disable the gate`);
      }
    }
  }
  if (policy.allow_low !== undefined && typeof policy.allow_low !== 'boolean') {
    throw new Error(`policy.${where}allow_low must be a boolean (got ${typeof policy.allow_low})`);
  }
}

// Shallow per-key override on top of the defaults — a present key fully replaces
// the default value (matches x-build gate-panel's mergePolicy semantics). The shape is
// VALIDATED: a malformed bucket (e.g. --policy '{"block_confirmed":"critical"}') used to
// reach blocksFor and die on `.map` with a raw TypeError instead of a controlled gate
// error (F6). Callers map the throw to exit 2. Phase overlay keys (before/after/release)
// are validated as PARTIAL policies — a typo inside an overlay must not silently
// disable the gate at that phase.
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
  // Post-merge every flat bucket + allow_low is defined (defaults guarantee it),
  // so validateFlat's undefined-skip never hides a malformed explicit override.
  validateFlat(merged, '');
  for (const phase of GATE_PHASES) {
    const overlay = merged[phase];
    if (overlay === undefined) continue;
    if (overlay === null || typeof overlay !== 'object' || Array.isArray(overlay)) {
      throw new Error(`policy.${phase} must be a partial policy object (got ${overlay === null ? 'null' : Array.isArray(overlay) ? 'array' : typeof overlay})`);
    }
    for (const k of Object.keys(overlay)) {
      if (!BUCKETS.includes(k) && k !== 'allow_low') {
        throw new Error(`policy.${phase}.${k} is not a valid overlay key (expected ${BUCKETS.join('|')}|allow_low)`);
      }
    }
    validateFlat(overlay, `${phase}.`);
  }
  return merged;
}

/**
 * Resolve the flat effective policy for a gate phase: flat base keys with the
 * phase's overlay (if any) applied per-key. Overlay keys are stripped from the
 * result so downstream consumers always see a flat policy. `phase` null/undefined
 * → flat base only.
 */
export function resolvePolicyForPhase(policy, phase = null) {
  if (phase != null && !GATE_PHASES.includes(phase)) {
    throw new Error(`unknown gate phase "${phase}" (expected ${GATE_PHASES.join('|')})`);
  }
  const flat = {
    block_confirmed: policy.block_confirmed,
    block_unreviewed: policy.block_unreviewed,
    block_contested: policy.block_contested,
    allow_low: policy.allow_low,
  };
  const overlay = phase != null && policy[phase] && typeof policy[phase] === 'object' && !Array.isArray(policy[phase])
    ? policy[phase] : {};
  return { ...flat, ...overlay };
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
// FLAT policy (resolve overlays first via resolvePolicyForPhase). Returns
// { decision, blocking, advisory } — decision 'fail' if any finding in any bucket
// matches its block list. `advisory` carries confirmed non-low findings the policy
// chose NOT to block (e.g. medium under the relaxed per-task default) so a relaxed
// gate never silently drops findings — they surface in artifacts/output and queue
// for the release-phase review.
export function evaluateVerdict(verdict, policy) {
  const allowLow = policy.allow_low !== false;
  const blocking = [];
  for (const b of blocksFor(verdict.confirmed, policy.block_confirmed, allowLow)) blocking.push({ ...b, kind: 'confirmed' });
  for (const b of blocksFor(verdict.unreviewed, policy.block_unreviewed, allowLow)) blocking.push({ ...b, kind: 'unreviewed' });
  for (const b of blocksFor(verdict.contested, policy.block_contested, allowLow)) blocking.push({ ...b, kind: 'contested' });

  const confirmedBlockSet = new Set((Array.isArray(policy.block_confirmed) ? policy.block_confirmed : []).map(s => String(s).toLowerCase()));
  const advisory = [];
  for (const f of verdict.confirmed || []) {
    const sev = String(f.severity || '').toLowerCase();
    if (sev === 'low' || !SEVERITIES.includes(sev)) continue; // low stays governed by allow_low; unknown severities never advise
    if (confirmedBlockSet.has(sev)) continue;                 // already blocking
    advisory.push({ severity: f.severity, file: f.file ?? null, line: f.line ?? null, claim: f.claim ?? null, kind: 'confirmed' });
  }

  return { decision: blocking.length ? 'fail' : 'pass', blocking, advisory };
}
