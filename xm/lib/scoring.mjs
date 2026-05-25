/**
 * scoring.mjs — shared deterministic scoring utilities
 *
 * Used by x-probe, x-solver, x-build for consistent weighted score computation.
 *
 * Input validation policy: CLAMP
 *   - Non-numeric or NaN values are treated as 0 (silent clamp, not throw).
 *   - Values outside [0, 1] are clamped to [0, 1].
 *   - Negative weights are clamped to 0 (ignored in normalization).
 *   - Rationale: scoring runs inside agent pipelines where partial/missing
 *     dimensions are normal; hard throws would abort valid multi-step flows.
 *     Callers that need strict validation should check inputs before calling.
 */

/**
 * Clamp a value to [0, 1]. Non-numeric and NaN inputs become 0.
 * @param {unknown} v
 * @returns {number}
 */
function clamp01(v) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Clamp a weight to [0, +∞). Negative or non-numeric weights become 0.
 * @param {unknown} v
 * @returns {number}
 */
function clampWeight(v) {
  const n = Number(v);
  if (!isFinite(n) || n < 0) return 0;
  return n;
}

/**
 * Compute a normalized weighted score over the dimensions present in `parts`.
 *
 * Only dimensions that appear in BOTH `parts` and `weights` are included.
 * The total weight of included dimensions is used as the denominator
 * (partial-dimension renormalization), so missing dimensions do not deflate
 * the score.
 *
 * @param {Record<string, number>} parts  - dimension values in [0, 1]
 * @param {Record<string, number>} weights - per-dimension weights (any positive scale)
 * @returns {number} weighted score in [0, 1], or 0 if no matching dimensions
 *
 * @example
 * // All dimensions present
 * weightedScore({ goal: 0.8, constraints: 0.6 }, { goal: 0.5, constraints: 0.5 })
 * // => 0.7  (0.8*0.5 + 0.6*0.5) / 1.0
 *
 * @example
 * // Partial dimensions — renormalized over existing weight sum
 * weightedScore({ goal: 0.8 }, { goal: 0.4, constraints: 0.3, success: 0.3 })
 * // => 0.8  (only goal matches; weight 0.4 / 0.4 = 1.0)
 */
export function weightedScore(parts, weights) {
  // Null/undefined/non-object inputs follow the CLAMP policy (return 0, not throw):
  // the header contract promises silent handling of partial/missing data, so a
  // missing parts/weights map must not raise TypeError mid-pipeline.
  if (parts == null || weights == null || typeof parts !== 'object' || typeof weights !== 'object') {
    return 0;
  }

  let numerator = 0;
  let denominator = 0;

  for (const [dim, rawW] of Object.entries(weights)) {
    if (!Object.prototype.hasOwnProperty.call(parts, dim)) continue;
    const w = clampWeight(rawW);
    const v = clamp01(parts[dim]);
    numerator += v * w;
    denominator += w;
  }

  if (denominator === 0) return 0;
  return clamp01(numerator / denominator);
}

/**
 * Test whether `score` satisfies a threshold condition.
 *
 * @param {number} score     - the score to test (typically from weightedScore)
 * @param {'<='|'>='|'<'|'>'} op - comparison operator
 * @param {number} threshold - the threshold value
 * @returns {boolean}
 * @throws {Error} if `op` is not one of the four supported operators
 *
 * @example
 * passes(0.75, '>=', 0.7)  // true
 * passes(0.75, '<', 0.8)   // true
 * passes(0.75, '<=', 0.5)  // false
 */
export function passes(score, op, threshold) {
  const s = Number(score);
  const t = Number(threshold);
  switch (op) {
    case '<=': return s <= t;
    case '>=': return s >= t;
    case '<':  return s < t;
    case '>':  return s > t;
    default:
      throw new Error(`scoring.passes: unsupported operator "${op}". Use <=, >=, <, or >.`);
  }
}
