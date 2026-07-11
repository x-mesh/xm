// hook-state.mjs — shared disk-only state reader for x-build blocking hooks.
//
// Copied VERBATIM into a project's .claude/hooks/ by `x-build hooks install`, so it
// must depend only on node builtins and read only disk state (no subprocess, no
// network — a hook runs on every tool call / stop and must be fast + fail-open).
//
// Two hooks consume this: xm-build-scope-guard.mjs (PreToolUse) and
// xm-build-stop-gate.mjs (Stop).

import { existsSync, readFileSync } from 'node:fs';
import { join, relative, isAbsolute, resolve, sep } from 'node:path';

// Global kill switch — either hook fails open when set. The documented escape hatch.
// Explicit falsy spellings do NOT disable: a bare `!!process.env.X` treats the string
// "0" as truthy, so `XM_BUILD_HOOKS_OFF=0` used to silently turn the guards OFF (F8).
export function hooksOff() {
  // Fail CLOSED on any spelling that reads as "not off" — `XM_BUILD_HOOKS_OFF=off`
  // most naturally means "the off-switch is off", i.e. keep the guards ON.
  const v = String(process.env.XM_BUILD_HOOKS_OFF ?? '').trim().toLowerCase();
  return !['', '0', 'false', 'no', 'off'].includes(v);
}

function readJSON(p) {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; }
  catch { return null; } // malformed state → treat as absent (fail-open upstream)
}

const BLOCKING_SEV = new Set(['critical', 'high']);

/**
 * Read the review-fix state from <projectDir>/.xm/review/.
 * @returns {{ active: boolean, allowedFiles: string[], unresolvedBlocking: Array<{id,severity,file,summary}> }}
 *   active            — a triage.json exists with ≥1 fix_now finding (review-fix in progress).
 *   allowedFiles      — triage.fix_scope.allowed_files (the edit scope).
 *   unresolvedBlocking— fix_now findings of severity critical/high WHILE the latest
 *                       x-review verdict is not lgtm/pass. Fixing + a fresh LGTM
 *                       re-review empties this (mirrors verify-review-fix's own pass
 *                       condition), so the block auto-clears without new state.
 */
export function reviewFixState(projectDir) {
  const reviewDir = join(projectDir, '.xm', 'review');
  const triage = readJSON(join(reviewDir, 'triage.json'));
  if (!triage) return { active: false, allowedFiles: [], unresolvedBlocking: [] };

  const findings = Array.isArray(triage.target_findings) ? triage.target_findings
    : Array.isArray(triage.findings) ? triage.findings : [];
  const fixNow = findings.filter(f => String(f.decision || '').trim().toLowerCase() === 'fix_now');

  const rawAllowed = triage.fix_scope?.allowed_files || triage.allowed_files || [];
  const allowedFiles = Array.isArray(rawAllowed) ? rawAllowed.map(String) : [];

  const result = readJSON(join(reviewDir, 'last-result.json'));
  const verdict = String(result?.verdict || '').trim().toLowerCase();
  // The verdict only speaks for the review it came from: a LEFTOVER LGTM must not
  // deactivate the guard for a fresh triage. This correlation FAILS CLOSED — an LGTM
  // releases only when both artifacts carry the SAME reviewed_commit. The first attempt
  // fell back to "verdict alone" whenever either side omitted the commit, which left the
  // exact fail-open it was meant to close (re-review R5: a triage with no reviewed_commit
  // was disarmed by ANY stale LGTM). `verify-review-fix --init` always stamps the commit,
  // so the normal flow correlates; an un-stampable triage is released by regenerating it
  // (--init) or by the documented XM_BUILD_HOOKS_OFF bypass.
  const lgtm = (verdict === 'lgtm' || verdict === 'pass')
    && !!triage.reviewed_commit
    && result?.reviewed_commit === triage.reviewed_commit;

  const unresolvedBlocking = lgtm
    ? []
    : fixNow
      .filter(f => BLOCKING_SEV.has(String(f.severity || '').trim().toLowerCase()))
      .map(f => ({ id: f.id ?? null, severity: f.severity, file: f.file ?? null, summary: f.summary || f.claim || '' }));

  // A review-fix is ACTIVE only while it is unfinished. Deriving `active` from the mere
  // presence of fix_now findings left the scope-guard blocking every out-of-scope edit
  // FOREVER after the fix landed — nothing rewrites triage.json's decisions, so the
  // repo stayed locked to the old allowed_files until the file was deleted by hand (F2).
  // A fresh LGTM re-review is the same "done" signal unresolvedBlocking already uses.
  return { active: fixNow.length > 0 && !lgtm, allowedFiles, unresolvedBlocking };
}

// The guard's OWN decision source. Hard-allowing all of .xm/ let a constrained agent
// disarm the guard with one permitted Write — delete the fix_now decisions and it
// evaporates (F4). triage.json is therefore NOT auto-allowed.
//
// last-result.json is deliberately NOT in this set: its LGTM is the ONLY thing that
// releases the guard, so blocking it would stop the re-review from ever recording the
// release — a self-lock worse than the hole it closed (re-review C-a). Forging an LGTM
// there is a deliberate act on par with XM_BUILD_HOOKS_OFF, and the reviewed_commit
// correlation below keeps a STALE verdict from silently disarming a fresh triage.
//
// Compared case-insensitively: macOS/APFS is case-insensitive by default, so a write to
// `.xm/review/Triage.json` hits the same file and would otherwise slip past an exact
// compare (re-review M1). Over-blocking a genuinely different casing on a case-sensitive
// FS is the safe direction.
const GUARD_INPUTS = new Set(['.xm/review/triage.json']);

// Paths the scope guard must never block: the rest of .xm/ (tasks, phases, the
// later-queue) — blocking those would self-lock the harness and produce the known
// later-queue false positives the design excludes.
export function isProtectedPath(rel) {
  if (!rel) return true;
  const norm = String(rel).split(sep).join('/');
  if (GUARD_INPUTS.has(norm.toLowerCase())) return false; // never hard-allow the guard's own input
  return norm === '.xm' || norm.startsWith('.xm/');
}

// True when filePath (absolute or repo-relative) falls within the allowed set.
// Match is EXACT, or the allowed entry is a directory that contains the file.
// The old endsWith suffix/prefix fallback let a genuinely different file pass whenever
// its path merely ENDED with an allowed entry — `nested/src/auth.ts` slipped through an
// `src/auth.ts` scope, defeating the guard (F1, 3/3 vendor consensus).
export function isAllowed(filePath, projectRoot, allowedFiles) {
  const abs = isAbsolute(filePath) ? filePath : resolve(projectRoot, filePath);
  const rel = relative(projectRoot, abs).split(sep).join('/');
  for (const raw of allowedFiles) {
    let a = String(raw);
    // An ABSOLUTE allowed_files entry (hand-edited triage) would match nothing under a
    // repo-relative compare, silently blocking every in-scope edit (re-review C-b).
    // Relativize it against the project root first.
    if (isAbsolute(a)) a = relative(projectRoot, a);
    a = a.split(sep).join('/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!a || a.startsWith('..')) continue; // outside the repo → cannot be in scope
    if (rel === a) return true;                // exact file
    if (rel.startsWith(a + '/')) return true;  // inside an allowed directory
  }
  return false;
}

// Repo-relative POSIX path for a hook's file_path input, or null if outside the repo.
export function repoRelative(filePath, projectRoot) {
  if (typeof filePath !== 'string' || !filePath) return null;
  const abs = isAbsolute(filePath) ? filePath : resolve(projectRoot, filePath);
  const rel = relative(projectRoot, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}
