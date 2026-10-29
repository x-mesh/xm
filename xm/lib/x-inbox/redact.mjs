/**
 * x-inbox redact — secret-masking gate for captured command stdout
 * (cross-project-handoff R4).
 *
 * A bug report to another project bundles the *actual* stdout of a repro
 * command. That output can contain `.env` dumps, tokens, or credentials
 * baked into a stack trace, and once it lands in a ledger file it can end
 * up permanently in someone else's repo history (see ledger.mjs header).
 * `redact()` is the single gate every captured command output must pass
 * through before it is written to a ledger file or sent across the wire.
 * Do not add a bypass flag/option — every caller gets the same masking.
 *
 * Reuse, not a second regex system: `SECRET_TERM` / `PROVIDER_KEY_TERM` are
 * imported from x-remote/protocol.mjs (the codebase's one existing secret
 * vocabulary, previously only used to detect "is this prompt asking for a
 * credential"). This module extends the same vocabulary to mask secret
 * *values* in arbitrary text. If a new secret shape needs to be recognized,
 * extend that shared vocabulary — do not start a parallel pattern set here.
 *
 * ReDoS defense: every pattern below uses only single-level, bounded
 * quantifiers (`{0,N}`, fixed lengths) — mirroring the `.{0,40}` style
 * already used by SECRET_RE in protocol.mjs. None of them stack a
 * quantifier inside a repeated group (the classic `(a+)+` shape), so a
 * 100k-char adversarial input cannot trigger catastrophic backtracking
 * regardless of its content. See redact.test.mjs's stress test.
 *
 * KNOWN LIMITATION — encoding bypass (investigated, not silently missed):
 * `redact()` matches raw text only. It never base64- or URL-decodes before
 * scanning, so:
 *   - A secret whose *identifying key name* is percent-encoded (e.g. the
 *     literal bytes `tok%65n=...` instead of `token=...`) will NOT be
 *     masked — the key-name match is a literal substring check.
 *   - A secret that is wholly base64-encoded with no surrounding key=value
 *     context (e.g. piped through `| base64` before being echoed) will NOT
 *     be masked — the encoded blob does not match any known secret shape.
 *   - An encoded *value* that follows a plaintext recognized key name (e.g.
 *     `api_key=aHR0cHM6Ly9...`) IS masked, because ASSIGNMENT_RE only needs
 *     to recognize the key name; it swallows the value opaquely without
 *     needing to decode it.
 * In short: encoding defeats detection only when it also hides the part of
 * the text this module actually keys on (the key name or a known prefix
 * shape). Callers that need encoding-aware scanning must decode candidate
 * substrings themselves before calling redact() — this module does not do
 * it for them.
 */

import { SECRET_TERM, PROVIDER_KEY_TERM } from '../x-remote/protocol.mjs';

const REDACTED = '[REDACTED]';

// 1. `KEY = value` / `KEY: value` assignments where KEY contains a known
//    secret term as a substring — deliberately no `\b` word boundary around
//    the term, matching SECRET_TERM's existing behavior, so compound
//    identifiers like AWS_SECRET_ACCESS_KEY or stripe_api_key still hit via
//    the "secret"/"api_key" substring (the match simply starts at "SECRET"
//    inside the compound name rather than at "AWS_" — the value still gets
//    masked, which is what matters).
//
//    Deliberately NO leading `[A-Za-z0-9_.-]{0,40}` wildcard before the term:
//    an earlier draft had one, and on a 100k-char input with zero matches
//    (e.g. plain prose) it cost ~35ms, because the engine retried the full
//    term alternation (15 branches) at every one of ~40 backtrack lengths,
//    at every one of the 100k start positions. That's linear, not
//    exponential — not "classic" ReDoS — but still an unacceptable
//    per-char constant. Dropping the leading wildcard cut it to <1ms: the
//    global search already slides across every start position on its own,
//    so no explicit leading wildcard is needed to find the term wherever it
//    occurs. Trailing `[A-Za-z0-9_.-]{0,40}` (between term and separator)
//    stays — it only runs at an actual term-match site, which is rare, not
//    at every character position, so its cost is bounded by real matches.
//    Captures the key+separator (group 1) and an optional quote (group 2)
//    separately so the replacement can keep the key name (useful context
//    for a bug report) and mask only the value.
//
//    VALUE CAPTURE — three explicit alternatives, not one shared class.
//    An earlier draft used a single `("|')?([^\s"'\n]{1,500})\2?`, which leaked
//    two ways (both found in cross-vendor review, both now pinned by tests):
//      a) `password="correct horse battery staple"` — the class stops at the
//         first space, so only `correct` was masked and ` horse battery
//         staple"` was re-emitted verbatim right after `[REDACTED]`.
//      b) `api_key=<600 chars>` — the {1,500} cap ended the match mid-value,
//         leaving the last 100 chars in cleartext.
//    Both produced `masked: 1`, i.e. the caller was told the text was clean.
//    Now a quoted value consumes to its CLOSING quote (spaces included) and an
//    unquoted one consumes to whitespace, each bounded at 4000 — comfortably
//    above MAX_CAPTURED_OUTPUT_CHARS (2000) plus the pre-redaction margin, so
//    a value can no longer outrun the cap in practice. Every alternative is a
//    simple negated class (linear, no nested quantifier) — the ReDoS budget
//    documented above still holds; the stress tests assert it.
const ASSIGNMENT_RE = new RegExp(
  `((?:${SECRET_TERM})[A-Za-z0-9_.-]{0,40}\\s{0,10}[:=]\\s{0,10})`
  + `(?:"([^"\\n]{1,4000})"|'([^'\\n]{1,4000})'|([^\\s"'\\n]{1,4000}))`,
  'gi'
);

// 2. `Authorization: Bearer <token>` / bare `Bearer <token>` headers. Keeps
//    the "Bearer " marker, masks only the token.
const BEARER_RE = /\b(Bearer\s{1,5})[A-Za-z0-9._~+/=-]{10,500}/gi;

// 3. Provider-issued key prefixes (sk-, xox[baprs]-, gh[pousr]-) — reused
//    verbatim from protocol.mjs's PROVIDER_KEY_TERM. No key name context
//    needed; the shape itself is the signal, so the whole match is masked.
const PROVIDER_KEY_RE = new RegExp(`\\b${PROVIDER_KEY_TERM}`, 'gi');

// 4. AWS access key IDs — fixed-length shape (AKIA/ASIA + 16 upper-alnum),
//    no key-name context needed.
const AWS_KEY_RE = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;

// 5. JWT-shaped bearer tokens (header.payload.signature — header is always
//    base64 of `{"`) — catches a bare JWT even with no preceding "Bearer" or
//    key name.
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,500}\.[A-Za-z0-9_-]{10,500}\.[A-Za-z0-9_-]{10,500}\b/g;

// 6. PEM private-key blocks. The body charset is restricted to what a real
//    base64 PEM body can contain (letters/digits/`+`/`/`/`=`/whitespace) —
//    notably NOT `-` or `[\s\S]` wildcard. An earlier draft used `[\s\S]`
//    (reluctant, capped at 20k), which is correct but slow: dense adversarial
//    input packed with `-----BEGIN...PRIVATE KEY-----` markers and no `-----END`
//    anywhere forced a fresh 20k-char forward scan at *every* BEGIN occurrence
//    (~30ms on a 100k-char input of nothing but repeated BEGIN markers).
//    Excluding `-` from the body charset makes a failed match fail immediately
//    at the next marker's leading dash instead of scanning ahead to the cap
//    (~0.15ms on the same adversarial input) — and it's more correct too, since
//    a real PEM body never contains a literal `-`.
const PEM_RE = /-----BEGIN[ A-Z]{0,30}PRIVATE KEY-----[A-Za-z0-9+/=\s]{1,20000}-----END[ A-Z]{0,30}PRIVATE KEY-----/g;

// Structurally self-contained patterns (no key-name context needed): PEM
// blocks, provider key prefixes, AWS key IDs, bare JWTs.
const WHOLE_MATCH_PATTERNS = [PEM_RE, PROVIDER_KEY_RE, AWS_KEY_RE, JWT_RE];

/**
 * Mask known secret patterns in `text`. Pure function, no I/O.
 *
 * Order matters for the *count*, not just the text: ASSIGNMENT_RE runs
 * FIRST, before the whole-match patterns. A provider-shaped secret often
 * sits inside a recognizable `key=value` context too (e.g.
 * `api_key='sk-proj-...'`, `token: "<jwt>"`) — if a whole-match pattern
 * masked that value first, ASSIGNMENT_RE would then match `key=[REDACTED]`
 * as if `[REDACTED]` were itself a fresh secret value and mask (and count)
 * it a second time. Running the key=value scan first consumes the whole
 * value in one shot, so the later whole-match passes find nothing left to
 * match at that span. `masked` then reflects one masked secret, not two.
 *
 * @param {string} text
 * @returns {{ text: string, masked: number }}
 */
export function redact(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: typeof text === 'string' ? text : '', masked: 0 };
  }

  let result = text;
  let masked = 0;

  ASSIGNMENT_RE.lastIndex = 0;
  // Groups: 1 = key+separator, 2 = double-quoted value, 3 = single-quoted
  // value, 4 = unquoted value. Exactly one of 2/3/4 is defined per match; the
  // quote is re-emitted around [REDACTED] so the line still parses as it did.
  result = result.replace(ASSIGNMENT_RE, (_match, keyAndSep, dq, sq) => {
    masked += 1;
    const q = dq !== undefined ? '"' : sq !== undefined ? "'" : '';
    return `${keyAndSep}${q}${REDACTED}${q}`;
  });

  BEARER_RE.lastIndex = 0;
  result = result.replace(BEARER_RE, (_match, prefix) => {
    masked += 1;
    return `${prefix}${REDACTED}`;
  });

  for (const pattern of WHOLE_MATCH_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, () => {
      masked += 1;
      return REDACTED;
    });
  }

  return { text: result, masked };
}
