/**
 * convergence.mjs — Iteration convergence / stagnation / oscillation detection
 *
 * Used by the iterate strategy to detect when further iterations are unlikely
 * to produce meaningful improvement and the loop should terminate early.
 *
 * NOTE: The default convergeThreshold (0.86) was confirmed by a deterministic
 * simulator (scripts/sim-thresholds.mjs) across realistic input distributions
 * and seeds, per CLAUDE.md Lessons L9 (thresholds from simulation, not judgment).
 */

// ── Token Helpers ────────────────────────────────────────────────────────────

/**
 * Tokenize a string into a Set of lowercase word tokens.
 * Splits on whitespace and punctuation; drops empty tokens.
 */
function tokenize(text) {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s\p{P}]+/u)
      .filter((t) => t.length > 0)
  );
}

// ── similarity ───────────────────────────────────────────────────────────────

/**
 * Compute deterministic Jaccard similarity between two output strings.
 *
 * Algorithm: tokenize both strings (lowercase, split on whitespace+punctuation),
 * compute |intersection| / |union|.
 *
 * Guards:
 * - Either argument is not a string (null, undefined, number, object, …) → 0
 * - Either string is empty → 0 (falls through to the token-count guard below)
 * - Either token set has fewer than 3 tokens → 0
 *   (short outputs don't carry enough signal for meaningful comparison)
 *
 * @param {string} prev
 * @param {string} curr
 * @returns {number} similarity in [0, 1]
 */
export function similarity(prev, curr) {
  if (typeof prev !== 'string' || typeof curr !== 'string') return 0;

  const a = tokenize(prev);
  const b = tokenize(curr);

  if (a.size < 3 || b.size < 3) return 0;

  let intersection = 0;
  for (const tok of a) {
    if (b.has(tok)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── detectStop ───────────────────────────────────────────────────────────────

/**
 * Analyze iteration history and decide whether to stop early.
 *
 * Priority order (highest wins):
 *   oscillating > converged > stagnant > none
 *
 * Definitions:
 *   converged   — last two outputs are highly similar (>= convergeThreshold)
 *   stagnant    — recent stagnationN+1 consecutive pairs all >= convergeThreshold,
 *                 OR (when scores provided) no score improvement in last stagnationN rounds
 *   oscillating — output[i] ≈ output[i-2] AND output[i-1] is dissimilar to BOTH neighbors:
 *                 sim(i-2, i) >= threshold  AND  sim(i-1, i) < threshold  AND  sim(i-2, i-1) < threshold
 *                 (A,B,A pattern: the last output matches two rounds ago but not the round in between)
 *
 * @param {Array<{output: string, score?: number}>} history  — chronological
 * @param {{
 *   convergeThreshold?: number,   // default 0.86 (simulator-confirmed — see module header)
 *   stagnationN?: number,          // default 2
 *   minHistory?: number            // default 2 — note: stagnant detection requires
 *                                  //   history.length >= stagnationN+1; if minHistory < stagnationN+1
 *                                  //   stagnant will never fire (only converged is possible in that range)
 * }} opts
 * @returns {{ stop: boolean, reason: 'converged'|'stagnant'|'oscillating'|'none', detail: string }}
 */
export function detectStop(history, opts = {}) {
  let {
    // 0.86 confirmed by scripts/sim-thresholds.mjs (seed-stable): at 0.86 the
    // simulator reports 0% false-alarm (improving loops not stopped) and 100%
    // true-positive (converge/stagnant/oscillate correctly stopped). The prior
    // 0.90 default missed ~9% of legitimate stops (TP 91%) at the same 0% FA.
    convergeThreshold = 0.86,
    stagnationN = 2,
    minHistory = 2,
  } = opts;

  // Guard: stagnation needs at least 1 round of "no improvement". stagnationN <= 0
  // (or NaN) would slice a 1-element window whose baseline IS the only element, so
  // `improved` is always false → spurious 'stagnant' even when scores rise. Floor to 1.
  if (!(stagnationN >= 1)) stagnationN = 1;

  const none = { stop: false, reason: 'none', detail: 'No stop condition met.' };

  if (!Array.isArray(history) || history.length < minHistory) return none;

  const outputs = history.map((h) => (h && typeof h.output === 'string') ? h.output : '');
  const n = outputs.length;

  // ── 1. Oscillating: A,B,A pattern — check priority first ─────────────────
  if (n >= 3) {
    const simIA = similarity(outputs[n - 3], outputs[n - 1]); // i-2 vs i
    const simIB = similarity(outputs[n - 3], outputs[n - 2]); // i-2 vs i-1
    const simBA = similarity(outputs[n - 2], outputs[n - 1]); // i-1 vs i
    if (simIA >= convergeThreshold && simBA < convergeThreshold && simIB < convergeThreshold) {
      return {
        stop: true,
        reason: 'oscillating',
        detail: `A,B,A pattern detected: sim(i-2,i)=${simIA.toFixed(3)}, sim(i-1,i)=${simBA.toFixed(3)}`,
      };
    }
  }

  // ── 2. Converged / Stagnant ───────────────────────────────────────────────
  const lastSim = similarity(outputs[n - 2], outputs[n - 1]);
  if (lastSim >= convergeThreshold) {
    // Score-based stagnation takes precedence when the RECENT window carries
    // scores. Only the pairs we actually compare (last stagnationN+1 entries)
    // need to be scored — a mixed history (e.g. no score on the first iteration)
    // must not silently bypass the score path and fall back to text-only. [N2 fix]
    //
    // baseline = the first score in the window (the oldest of the stagnationN+1 entries).
    // If ANY later round in the window exceeds the baseline we do NOT stop — this is
    // a conservative choice to avoid early termination: even a single mid-window
    // improvement is treated as "still making progress, keep going."
    if (n >= stagnationN + 1) {
      const recentScores = history
        .slice(n - stagnationN - 1)
        .map((h) => h?.score);
      const recentHasScores = recentScores.every((s) => typeof s === 'number');
      if (recentHasScores) {
        const baseline = recentScores[0]; // oldest score in the window
        const improved = recentScores.slice(1).some((s) => s > baseline);
        if (!improved) {
          return {
            stop: true,
            reason: 'stagnant',
            detail: `No score improvement over last ${stagnationN} iterations (baseline=${baseline}).`,
          };
        }
        // Score improved — do not stop despite textual similarity.
        return none;
      }
    }

    // ── 3. Text-based stagnant: multiple consecutive pairs all converged ──
    // Requires stagnationN+1 entries (stagnationN consecutive pairs).
    if (n >= stagnationN + 1) {
      let allConverged = true;
      for (let i = n - stagnationN - 1; i < n - 1; i++) {
        if (similarity(outputs[i], outputs[i + 1]) < convergeThreshold) {
          allConverged = false;
          break;
        }
      }
      if (allConverged) {
        return {
          stop: true,
          reason: 'stagnant',
          detail: `Last ${stagnationN} consecutive pairs all above threshold (${convergeThreshold.toFixed(3)}).`,
        };
      }
    }

    return {
      stop: true,
      reason: 'converged',
      detail: `Last two outputs similarity=${lastSim.toFixed(3)} >= threshold=${convergeThreshold.toFixed(3)}.`,
    };
  }

  return none;
}
