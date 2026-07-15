/**
 * Inline-diff safety net (B).
 *
 * A panel target (a diff) is embedded verbatim into every provider's `-p <prompt>`
 * argument. Two hard walls sit downstream: the OS arg limit (ARG_MAX, 1MiB on darwin)
 * fails the spawn for EVERY provider, and each model has its own input cap (agy
 * truncates silently → "no verdicts JSON"). This budget keeps the inlined diff
 * comfortably under both. It is a floor, not the fix for agy's smaller cap — that is
 * the file handoff (A). Reductions are always LOUD (explicit markers), matching the
 * REFUTE_EVIDENCE_MAX convention: a truncated target must never read as the full change.
 */

// Default inline budget. Leaves ~512KiB of headroom under darwin's 1MiB ARG_MAX for the
// instructions + JSON contract that wrap the diff. Tunable via `panel.diff_inline_max_bytes`.
export const DIFF_INLINE_MAX_BYTES = 512 * 1024;

// agy (Antigravity) truncates a large `-p` prompt internally well below ARG_MAX, silently
// dropping the tail → the panel sees "no verdicts JSON". Above this size the panel hands
// agy the diff as a FILE (the file handoff, A) instead of inlining it. Conservative because
// agy's real cap is undocumented; tunable via `panel.agy_inline_max_bytes`.
export const AGY_INLINE_MAX_BYTES = 128 * 1024;

// Noise files whose diff bodies rarely carry review signal but bloat the prompt.
// Dropped FIRST when a diff exceeds the inline budget (explicit marker, never silent).
export const DIFF_NOISE_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock|poetry\.lock)$|\.min\.(js|css)$|\.map$|(^|\/)(dist|build|vendor|node_modules|__generated__)\//;

// Split a unified diff into per-file sections keyed by the `diff --git a/X b/Y` header.
// A leading non-diff preamble (rare) becomes an anonymous section with file=null.
export function splitDiffSections(text) {
  return String(text || '').split(/(?=^diff --git )/m).filter(Boolean).map((body) => {
    const m = body.match(/^diff --git a\/(.+?) b\//m);
    return { file: m ? m[1] : null, body, bytes: Buffer.byteLength(body) };
  });
}

/**
 * Reduce an inlined diff to <= maxBytes, degrading LOUDLY. Order:
 *   1) drop known-noise files (lockfiles, minified, generated/vendored)
 *   2) greedily keep whole file sections until the budget is spent
 *   3) if a single kept file still overflows, hard-truncate its body
 * Returns { text, reduced, droppedNoise[], omitted[], truncatedFile }.
 * Every reduction leaves a marker so a reviewer knows the diff was cut.
 */
// Truncate a string to at most maxBytes UTF-8 bytes WITHOUT splitting a codepoint — a raw
// byte slice can land mid-sequence and decode to a U+FFFD replacement char, so we drop any
// trailing partial sequence. This is the single ceiling-enforcer: every truncating branch
// returns through it, so shrinkDiff's "<= maxBytes" contract holds regardless of how long
// the trailing marker/omission notes turn out to be (marker length is otherwise unbounded —
// it can list many long file paths).
function capUtf8(str, maxBytes) {
  const s = String(str || '');
  if (Buffer.byteLength(s) <= maxBytes) return s;
  return Buffer.from(s).subarray(0, Math.max(0, maxBytes)).toString('utf8').replace(/�+$/, '');
}

export function shrinkDiff(text, maxBytes = DIFF_INLINE_MAX_BYTES) {
  const full = String(text || '');
  const total = Buffer.byteLength(full);
  if (total <= maxBytes) return { text: full, reduced: false, droppedNoise: [], omitted: [], truncatedFile: null };

  const sections = splitDiffSections(full);
  if (sections.length <= 1) {
    // Not a multi-file diff (literal text or a single huge file): hard-truncate the tail.
    const marker = `\n\n[… target truncated to fit the model input budget of ${maxBytes} bytes (from ${total})]`;
    const head = capUtf8(full, Math.max(0, maxBytes - Buffer.byteLength(marker)));
    return {
      text: capUtf8(head + marker, maxBytes),
      reduced: true, droppedNoise: [], omitted: [], truncatedFile: sections[0]?.file || null,
    };
  }

  const droppedNoise = [];
  const candidates = sections.filter((s) => {
    if (s.file && DIFF_NOISE_RE.test(s.file)) { droppedNoise.push(s.file); return false; }
    return true;
  });

  // Greedy keep whole file sections. MARKER_RESERVE is a first-pass estimate only — the real
  // ceiling is enforced by the marker-aware reservation + capUtf8 below, so an underestimate
  // here never breaks the <= maxBytes contract (it just keeps one extra section that the final
  // cap may trim).
  const MARKER_RESERVE = 300;
  const kept = [];
  const omitted = [];
  let used = 0;
  for (const s of candidates) {
    if (used + s.bytes <= maxBytes - MARKER_RESERVE) { kept.push(s); used += s.bytes; }
    else omitted.push(s);
  }
  // Nothing fit whole (the first real file alone exceeds budget): hard-truncate that one file.
  if (!kept.length && candidates.length) {
    const first = candidates[0];
    const head = capUtf8(first.body, Math.max(0, maxBytes - MARKER_RESERVE));
    kept.push({ ...first, body: `${head}\n[… ${first.file || 'file'} truncated to fit budget]` });
    omitted.push(...candidates.slice(1));
  }

  const notes = [];
  if (droppedNoise.length) notes.push(`${droppedNoise.length} generated/lock file(s) dropped: ${droppedNoise.slice(0, 8).join(', ')}${droppedNoise.length > 8 ? ', …' : ''}`);
  if (omitted.length) notes.push(`${omitted.length} more changed file(s) omitted for size: ${omitted.map((s) => s.file || '(preamble)').slice(0, 8).join(', ')}${omitted.length > 8 ? ', …' : ''}`);
  const marker = `\n\n[… diff reduced from ${total} bytes to fit the model input budget (${maxBytes} bytes). ${notes.join('; ')}]`;
  // Reserve the ACTUAL marker size (its file lists are unbounded), then a final capUtf8 backstop
  // so the return is <= maxBytes even when the marker alone is pathologically large.
  const body = capUtf8(kept.map((s) => s.body).join(''), Math.max(0, maxBytes - Buffer.byteLength(marker)));
  return {
    text: capUtf8(body + marker, maxBytes),
    reduced: true,
    droppedNoise,
    omitted: omitted.map((s) => s.file).filter(Boolean),
    truncatedFile: null,
  };
}
