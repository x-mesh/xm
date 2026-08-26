/**
 * x-eval/stats — the handful of numeric helpers bench/gate need.
 *
 * Copied rather than imported from x-build/lib/x-build/adaptive-routing.mjs:
 * a cross-plugin import breaks in the versioned marketplace-cache layout.
 */

function finite(values) {
  return (values || []).map(Number).filter(Number.isFinite);
}

export function mean(values) {
  const v = finite(values);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/** Population standard deviation (σ) — bench.md reports σ over the trials that ran. */
export function sigma(values) {
  const v = finite(values);
  if (!v.length) return null;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
}

export function median(values) {
  const v = finite(values).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export function round(value, digits = 2) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}
