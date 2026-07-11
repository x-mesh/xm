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
export function hooksOff() {
  return !!process.env.XM_BUILD_HOOKS_OFF;
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
  const lgtm = verdict === 'lgtm' || verdict === 'pass';

  const unresolvedBlocking = lgtm
    ? []
    : fixNow
      .filter(f => BLOCKING_SEV.has(String(f.severity || '').trim().toLowerCase()))
      .map(f => ({ id: f.id ?? null, severity: f.severity, file: f.file ?? null, summary: f.summary || f.claim || '' }));

  return { active: fixNow.length > 0, allowedFiles, unresolvedBlocking };
}

// Paths the scope guard must NEVER block: everything under .xm/ (review-fix state,
// tasks, the later-queue) — blocking those would self-lock the harness and produce
// the known later-queue false positives the design excludes.
export function isProtectedPath(rel) {
  if (!rel) return true;
  const norm = String(rel).split(sep).join('/');
  return norm === '.xm' || norm.startsWith('.xm/');
}

// True when filePath (absolute or repo-relative) falls within the allowed set.
// allowed_files entries are repo-relative; compare normalized POSIX paths with an
// endsWith fallback so a different base prefix still matches the same file.
export function isAllowed(filePath, projectRoot, allowedFiles) {
  const abs = isAbsolute(filePath) ? filePath : resolve(projectRoot, filePath);
  const rel = relative(projectRoot, abs).split(sep).join('/');
  for (const raw of allowedFiles) {
    const a = String(raw).split(sep).join('/');
    if (rel === a || rel.endsWith('/' + a) || a.endsWith('/' + rel)) return true;
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
