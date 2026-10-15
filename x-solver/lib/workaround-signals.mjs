/**
 * workaround-signals.mjs — added-line patterns that often mean a symptom was
 * hidden instead of its cause fixed: an empty catch, a larger timeout or retry
 * count, a new skip or mock, an assert that only checks for a value.
 *
 * These are signals, not verdicts. Every pattern has legitimate uses, so
 * `repro verify` reports them and does not block on them.
 * scripts/measure-workaround-signals.mjs runs this scan over the repository's
 * own fix commits (CLAUDE.md Lesson L9). On 211 of them, a default fallback
 * (`|| []`, `?? null`) fired on 31% and optional chaining on 26%, almost all
 * ordinary data normalization, so both were left out. Empty catch fired on 8%;
 * the other kinds on none. No labeled set of real workarounds exists, so how
 * many workarounds these patterns catch is unmeasured.
 */

const LINE_PATTERNS = [
  { kind: 'empty-catch', re: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/ },
  { kind: 'empty-catch', re: /^\s*except\b[^:]*:\s*pass\s*(?:#.*)?$/ },
  {
    kind: 'skip-or-mock',
    re: /\b(?:it|test|describe)\.skip\(|\bx(?:it|describe)\(|@pytest\.mark\.skip|\bt\.Skip\(|\b(?:jest|vi)\.mock\(|\bmock\.patch\b|\bsinon\.stub\(/,
  },
  { kind: 'not-none-assert', re: /\bassert\s+[\w.[\]]+\s+is\s+not\s+None\b/ },
];

// A value under one of these names going up is how a flaky wait gets "fixed".
const TUNABLE = /timeout|sleep|retries|retry|delay|wait|backoff|attempts/i;
const NUMBER = /\d+(?:\.\d+)?/g;

const shape = (text) => text.trim().replace(NUMBER, '#');
const numbers = (text) => (text.match(NUMBER) || []).map(Number);

function tunableIncrease(removed, added) {
  if (!TUNABLE.test(added) || shape(removed) !== shape(added)) return false;
  const before = numbers(removed);
  const after = numbers(added);
  return before.length === after.length
    && after.some((value, i) => value > before[i])
    && after.every((value, i) => value >= before[i]);
}

/**
 * Parse a unified diff and return the signals on its added lines.
 *
 * @param {string} diffText  output of `git diff` (any context size)
 * @param {{ include?: (file: string) => boolean, ignore?: Set<string> }} [opts]
 *   `include` limits the scan to some files; `ignore` holds `file\0trimmed line`
 *   keys for lines that were already added before the fix (the baseline patch).
 * @returns {{ kind: string, file: string, line: number, text: string }[]}
 */
export function scanDiff(diffText, opts = {}) {
  const include = opts.include ?? (() => true);
  const ignore = opts.ignore ?? new Set();
  const signals = [];
  let file = null;
  let newLine = 0;
  let removed = [];
  for (const raw of String(diffText).split('\n')) {
    if (raw.startsWith('+++ ')) {
      const path = raw.slice(4).trim();
      file = path === '/dev/null' ? null : path.replace(/^b\//, '');
      continue;
    }
    if (raw.startsWith('--- ') || raw.startsWith('diff --git ')) continue;
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      removed = [];
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('-')) {
      removed.push(raw.slice(1));
      continue;
    }
    if (raw.startsWith('+')) {
      const text = raw.slice(1);
      const line = newLine;
      newLine += 1;
      if (!include(file) || ignore.has(`${file}\0${text.trim()}`)) continue;
      for (const { kind, re } of LINE_PATTERNS) {
        if (re.test(text)) signals.push({ kind, file, line, text: text.trim() });
      }
      if (removed.some((before) => tunableIncrease(before, text))) {
        signals.push({ kind: 'tunable-increase', file, line, text: text.trim() });
      }
      continue;
    }
    if (raw.startsWith(' ')) newLine += 1;
  }
  return signals;
}

/** Keys of the lines a patch adds, in the shape `scanDiff`'s `ignore` expects. */
export function addedLineKeys(patchText) {
  const keys = new Set();
  let file = null;
  for (const raw of String(patchText).split('\n')) {
    if (raw.startsWith('+++ ')) {
      const path = raw.slice(4).trim();
      file = path === '/dev/null' ? null : path.replace(/^b\//, '');
    } else if (file && raw.startsWith('+')) {
      keys.add(`${file}\0${raw.slice(1).trim()}`);
    }
  }
  return keys;
}

/** Render a new file's content as an all-added diff section so scanDiff can read it. */
export function newFileDiff(file, content) {
  const lines = String(content).split('\n');
  if (lines.at(-1) === '') lines.pop();
  return [`+++ b/${file}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n');
}
