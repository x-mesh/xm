/**
 * x-build/verify — Verification commands
 */

import {
  TASK_STATES, C,
  readJSON, writeJSON, readMD,
  tasksPath, prdPath, contextDir, phaseDir,
  resolveProject, renderBar,
  runQualityChecks,
  existsSync, unlinkSync, realpathSync, join, resolve, ROOT, repoRoot, parseOptions, spawnSync,
} from './core.mjs';
import { parsePrdBaseline, computeDrift } from './drift.mjs';
import { recordEffectiveness } from './effectiveness.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// ── cmdQuality ──────────────────────────────────────────────────────

export function cmdQuality(args) {
  const project = resolveProject(null);
  console.log(`${C.bold}🔍 Running quality checks...${C.reset}\n`);
  const results = runQualityChecks(project);

  if (results.length === 0) {
    console.log(`  ${C.dim}No test/lint/build tools detected.${C.reset}`);
    const path = join(phaseDir(project, '04-verify'), 'effectiveness.json');
    const previous = readJSON(path);
    const outcome = { timestamp: new Date().toISOString(), attempts: (previous?.attempts || 0) + 1, passed: true, checks: 0, failures: 0, skipped: 'no_tools' };
    writeJSON(path, outcome);
    recordEffectiveness(project, 'verify_outcome', { ...outcome, first_pass: outcome.attempts === 1 });
    return;
  }

  for (const r of results) {
    console.log(`  ${r.passed ? '✅' : '❌'} ${r.check}${r.passed ? '' : `\n     ${C.red}${r.output.slice(0, 200)}${C.reset}`}`);
  }

  const passCount = results.filter(r => r.passed).length;
  console.log(`\n${renderBar(passCount, results.length)} quality checks`);
  const previous = readJSON(join(phaseDir(project, '04-verify'), 'effectiveness.json'));
  const outcome = {
    timestamp: new Date().toISOString(), attempts: (previous?.attempts || 0) + 1,
    passed: passCount === results.length, checks: results.length, failures: results.length - passCount,
  };
  writeJSON(join(phaseDir(project, '04-verify'), 'effectiveness.json'), outcome);
  recordEffectiveness(project, 'verify_outcome', { ...outcome, first_pass: outcome.attempts === 1 && outcome.passed });
}

// ── structured requirements (shared by coverage + traceability) ─────
//
// Requirements live in two places depending on which flow produced the project:
// the research artifact REQUIREMENTS.md, or — for plan/PRD-first projects — the
// PRD's "Requirements Traceability" section (`- [R1] {text} → SC1`). Reading only
// REQUIREMENTS.md made the Verify gate vacuously fail on PRD-first projects whose
// approved R1..Rn never touched that file (toss-20260721-666aa5a0). PRD wins per
// R# id: it is the document that passed the approval gate.

function parseReqItems(text) {
  if (!text) return [];
  // Strip fenced blocks first so template Format:/Examples: samples never parse
  // as real requirements (same rule as the AC / failure-mode parsers in tasks.mjs).
  const body = text.replace(/```[\s\S]*?```/g, '');
  const out = [];
  for (const m of body.matchAll(/^\s*-\s*\[(R(?:EQ-?)?\d+)\]\s*(.+)$/gim)) {
    // PRD traceability items carry a "→ SC1" pointer tail — not requirement text.
    const desc = m[2].replace(/\s*(?:→|->)\s*SC[\d,\s]*$/i, '').trim();
    if (desc) out.push({ id: m[1], desc });
  }
  return out;
}

export function parseStructuredRequirements(project) {
  const reqMd = readMD(join(contextDir(project), 'REQUIREMENTS.md'));
  const prd = readMD(prdPath(project));
  // Header number is flexible (mirrors the AC parser); "Non-Functional
  // Requirements" cannot match because "Requirements" must directly follow the
  // number. The section ends at the next `##` header.
  const section = prd?.match(/##\s*(?:\d+\.?)?\s*Requirements(?:\s+Traceability)?\s*\n[\s\S]*?(?=\n##[ \t\d]|$)/i);
  const fromPrd = section ? parseReqItems(section[0]) : [];
  const fromReqMd = parseReqItems(reqMd);
  const byId = new Map();
  for (const r of fromReqMd) byId.set(r.id.toLowerCase(), r);
  for (const r of fromPrd) byId.set(r.id.toLowerCase(), r); // PRD wins on collision
  const reqs = [...byId.values()].sort(
    (a, b) => Number(a.id.match(/\d+/)?.[0] || 0) - Number(b.id.match(/\d+/)?.[0] || 0));
  return {
    reqs,
    sources: { prd: fromPrd.length, requirements_md: fromReqMd.length },
    // readMD returns '' for a missing file — truthiness IS the existence check.
    files: { prd: !!prd, requirements_md: !!reqMd },
  };
}

function describeReqSources(sources) {
  return `PRD §Requirements Traceability: ${sources.prd} · REQUIREMENTS.md: ${sources.requirements_md}`;
}

/**
 * Tasks explicitly tagged with this requirement id. This is the strict link
 * traceability reports on: an `R#` in `requirements[]` or in the task name.
 */
function tasksTaggedWith(req, tasks) {
  return tasks.filter(t =>
    (Array.isArray(t.requirements) && t.requirements.some(id => String(id).toLowerCase() === req.id.toLowerCase()))
    || String(t.name || '').includes(req.id));
}

/**
 * Coverage is intentionally looser than traceability: it also accepts a task
 * whose name echoes the requirement's opening text, since many plans name tasks
 * after the requirement rather than tagging the id. So a name-echo requirement
 * reads `covered` here while traceability still reports `Tasks: NONE` — that gap
 * is the signal to add the explicit `R#` link, not a bug.
 *
 * What this helper DOES guarantee is that one command never contradicts itself:
 * the verdict printed to the user and the persisted `details[].covered` come
 * from this single predicate.
 */
function requirementCovered(req, tasks) {
  if (tasksTaggedWith(req, tasks).length > 0) return true;
  const prefix = req.desc.toLowerCase().slice(0, 30);
  return prefix.length > 0 && tasks.some(t => String(t.name || '').toLowerCase().includes(prefix));
}

// ── cmdVerifyCoverage ───────────────────────────────────────────────

export function cmdVerifyCoverage(args) {
  const { opts } = parseOptions(args);
  const project = resolveProject(null);
  const taskData = readJSON(tasksPath(project));
  const tasks = taskData?.tasks || [];
  const { reqs, sources, files } = parseStructuredRequirements(project);

  if (!files.requirements_md && !files.prd) {
    console.log('No REQUIREMENTS.md or PRD found. Run: x-build research (or: x-build plan)');
    return;
  }

  if (reqs.length === 0) {
    console.log(`${C.yellow}No structured requirements found — searched PRD §Requirements Traceability and REQUIREMENTS.md${C.reset}`);
    console.log(`  Expected format: - [R1] Description`);
    return;
  }

  console.log(`\n${C.bold}Requirement Coverage${C.reset} ${C.dim}(${describeReqSources(sources)})${C.reset}\n`);

  let covered = 0;
  let uncovered = 0;
  const details = [];

  for (const req of reqs) {
    const found = requirementCovered(req, tasks);

    if (found) {
      console.log(`  [covered] [${req.id}] ${req.desc.slice(0, 60)}`);
      covered++;
    } else {
      console.log(`  [missing] [${req.id}] ${req.desc.slice(0, 60)} ${C.red}— no matching task${C.reset}`);
      uncovered++;
    }
    // Persist the SAME verdict that was printed. This used to recompute with a
    // name-only predicate, so a run could print "All requirements covered" while
    // writing covered:false for most rows.
    details.push({ ...req, covered: found });
  }

  console.log(`\n  Coverage: ${covered}/${reqs.length} (${Math.round(covered/reqs.length*100)}%)`);
  if (uncovered > 0) {
    console.log(`  ${C.yellow}${uncovered} requirements not covered — add tasks or update task names${C.reset}`);
  } else {
    console.log(`  ${C.green}All requirements covered${C.reset}`);
  }

  writeJSON(join(phaseDir(project, '04-verify'), 'coverage-results.json'), {
    timestamp: new Date().toISOString(),
    total: reqs.length,
    covered,
    uncovered,
    sources,
    strict: opts.strict === true,
    details,
  });

  // Coverage is advisory by default (a requirement can legitimately be covered by
  // a task whose name shares no keywords). `--strict` is the opt-in that makes an
  // uncovered requirement visible to CI in the exit code, matching the
  // plan-check --strict convention.
  if (uncovered > 0 && opts.strict) {
    console.log(`  ${C.red}--strict: ${uncovered} uncovered requirement${uncovered === 1 ? '' : 's'} fails the check.${C.reset}`);
    process.exitCode = 1;
  }

  console.log('');
}

// ── cmdVerifyTraceability ───────────────────────────────────────────

export function cmdVerifyTraceability(args) {
  const project = resolveProject(null);
  const prd = readMD(prdPath(project));
  const taskData = readJSON(tasksPath(project));
  const tasks = taskData?.tasks || [];
  const { reqs, sources, files } = parseStructuredRequirements(project);

  if (!files.requirements_md && !files.prd) {
    console.log('No REQUIREMENTS.md or PRD found. Run: x-build research (or: x-build plan)');
    return;
  }

  if (reqs.length === 0) {
    // Requirement docs exist but nothing parsed — a format/parse failure, not a pass.
    // Write a fresh artifact (a stale one from a previous run must not masquerade as
    // current) and fail the exit code: a traceability gate passing green with zero
    // requirements is a vacuous pass.
    console.log(`${C.yellow}No structured requirements found — searched PRD §Requirements Traceability and REQUIREMENTS.md for "- [R1] ..." items. Traceability cannot be verified.${C.reset}`);
    writeJSON(join(phaseDir(project, '04-verify'), 'traceability.json'), {
      timestamp: new Date().toISOString(),
      total: 0,
      fully_covered: 0,
      partial: 0,
      gaps: 0,
      sources,
      matrix: [],
    });
    process.exitCode = 1;
    return;
  }

  // Parse PRD acceptance criteria
  const acSection = prd?.match(/##\s*(?:\d+\.)?\s*Acceptance Criteria[\s\S]*?(?=##\s*\d|$)/i);
  const acItems = acSection ? [...acSection[0].matchAll(/- \[[ x]\] (.+)/gi)].map(m => m[1].trim()) : [];
  if (prd && acItems.length === 0) {
    console.log(`${C.yellow}PRD found but 0 acceptance criteria parsed — expected an "## N. Acceptance Criteria" section with "- [ ] ..." items.${C.reset}`);
    console.log(`  Every requirement will show AC: NONE until the PRD gains a parseable AC section.`);
  }

  console.log(`\n${C.bold}Traceability Matrix${C.reset} — R# ↔ Task ↔ AC ↔ Done Criteria ${C.dim}(${describeReqSources(sources)})${C.reset}\n`);

  let fullyCovered = 0;
  let partial = 0;
  let gaps = 0;
  const matrix = [];

  for (const req of reqs) {
    const matchedTasks = tasksTaggedWith(req, tasks);
    const matchedAC = acItems.filter(ac => ac.toLowerCase().includes(req.id.toLowerCase()));
    const hasDoneCriteria = matchedTasks.some(t => t.done_criteria?.length > 0);

    const taskStr = matchedTasks.length > 0
      ? matchedTasks.map(t => t.id).join(', ')
      : `${C.red}NONE${C.reset}`;
    const acStr = matchedAC.length > 0 ? `${matchedAC.length} AC` : `${C.red}NONE${C.reset}`;
    const dcStr = hasDoneCriteria ? '✅' : `${C.yellow}—${C.reset}`;

    const coverage =
      matchedTasks.length > 0 && matchedAC.length > 0 && hasDoneCriteria ? 'full' :
      matchedTasks.length > 0 ? 'partial' : 'gap';
    const glyph = coverage === 'full' ? '✅' : coverage === 'partial' ? '⚠️' : '❌';

    if (coverage === 'full') fullyCovered++;
    else if (coverage === 'partial') partial++;
    else gaps++;

    matrix.push({
      req_id: req.id,
      coverage,
      description: req.desc,
      tasks: matchedTasks.map(t => t.id),
      acceptance_criteria: matchedAC.length,
      has_done_criteria: hasDoneCriteria,
    });

    console.log(`  ${glyph} [${req.id}] ${req.desc.slice(0, 40).padEnd(40)} → Tasks: ${taskStr} | AC: ${acStr} | DC: ${dcStr}`);
  }

  console.log(`\n  ${C.bold}Summary${C.reset}: ${fullyCovered} full, ${partial} partial, ${gaps} gaps (${reqs.length} total)`);

  if (gaps > 0) {
    console.log(`  ${C.red}${gaps} requirements have no matching tasks — add tasks or update names${C.reset}`);
  }
  if (partial > 0) {
    console.log(`  ${C.yellow}${partial} requirements missing AC or done_criteria — run: tasks done-criteria${C.reset}`);
  }
  if (gaps === 0 && partial === 0) {
    console.log(`  ${C.green}Full traceability achieved${C.reset}`);
  }

  writeJSON(join(phaseDir(project, '04-verify'), 'traceability.json'), {
    timestamp: new Date().toISOString(),
    total: reqs.length,
    fully_covered: fullyCovered,
    partial,
    gaps,
    sources,
    matrix,
  });

  // A requirement with no matching task is a hard traceability failure —
  // callers (CI, phase gates) must see it in the exit code, not just prose.
  if (gaps > 0) {
    process.exitCode = 1;
  }

  console.log('');
}

// ── cmdVerifyContracts ──────────────────────────────────────────────

export function cmdVerifyContracts(args) {
  const project = resolveProject(null);
  const taskData = readJSON(tasksPath(project));
  const tasks = taskData?.tasks || [];

  const withCriteria = tasks.filter(t => t.done_criteria && t.status === 'completed');

  if (withCriteria.length === 0) {
    console.log('No completed tasks with done_criteria found.');
    console.log('  Generate criteria: x-build tasks done-criteria');
    return;
  }

  console.log(`\n${C.bold}Acceptance Contract Verification${C.reset}\n`);

  for (const task of withCriteria) {
    const criteria = Array.isArray(task.done_criteria)
      ? task.done_criteria
      : task.done_criteria.split(';').map(c => c.trim()).filter(Boolean);
    console.log(`  ${task.id}: ${task.name}`);
    for (const c of criteria) {
      console.log(`    ☐ ${c}`);
    }
    console.log('');
  }

  console.log(`${C.yellow}${withCriteria.length} tasks with acceptance contracts listed above.${C.reset}`);
  console.log(`  Verify each criterion manually or delegate to an agent for inspection.`);
  console.log('');
}

// ── cmdVerifyReviewFix ──────────────────────────────────────────────

const TRIAGE_REQUIRED_SEVERITY = new Set(['critical', 'high', 'medium']);
const BLOCKING_SEVERITY = new Set(['critical', 'high']);
const VALID_TRIAGE_DECISIONS = new Set(['fix_now', 'backlog', 'accept_risk', 'false_positive']);
const VALID_REVERIFY_OUTCOMES = new Set(['resolved', 'persistent', 'regression']);

function normalizeSeverity(value) {
  return String(value || '').toLowerCase();
}

function normalizeVerdict(value) {
  return String(value || '').toLowerCase().replace(/[\s-]+/g, '_');
}

function findingId(index) {
  return `F${index + 1}`;
}

function stableFindingId(finding) {
  const identity = {
    file: finding.file || null,
    lens: finding.lens || null,
    summary: findingSummary(finding).trim().replace(/\s+/g, ' '),
  };
  return `rf_${sha256(JSON.stringify(identity)).slice(0, 16)}`;
}

function stableFindingIdFailures(findings) {
  const seen = new Map();
  const failures = [];
  for (const finding of findings) {
    const id = finding.finding_id || stableFindingId(finding);
    const previous = seen.get(id);
    if (previous) {
      failures.push(`Duplicate stable finding_id ${id}: ${previous.id} and ${finding.id}; x-review must disambiguate their content before triage`);
    } else {
      seen.set(id, finding);
    }
  }
  return failures;
}

function findingSummary(finding) {
  return finding.summary || finding.claim || finding.description || finding.title || '';
}

function reviewDir() {
  return join(ROOT, '..', 'review');
}

function workspaceRoot() {
  return repoRoot();
}

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: workspaceRoot(),
    encoding: 'utf8',
    timeout: 10000,
  });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

function reviewedCommitCovers(originalCommit, reviewedCommit) {
  if (!originalCommit || !reviewedCommit) return false;
  if (originalCommit === reviewedCommit) return true;
  if (!/^[0-9a-f]{7,40}$/i.test(originalCommit) || !/^[0-9a-f]{7,40}$/i.test(reviewedCommit)) return false;
  const result = spawnSync('git', ['merge-base', '--is-ancestor', originalCommit, reviewedCommit], {
    cwd: workspaceRoot(),
    encoding: 'utf8',
    timeout: 10000,
  });
  return result.status === 0;
}

function collectChangedFilesSinceReview(reviewedCommit) {
  const changed = new Set();
  const add = files => {
    if (!files) return;
    for (const file of files) changed.add(file);
  };

  if (/^[0-9a-f]{7,40}$/i.test(String(reviewedCommit || ''))) {
    add(runGit(['diff', '--name-only', `${reviewedCommit}..HEAD`]));
  }

  add(runGit(['diff', '--name-only']));
  add(runGit(['diff', '--name-only', '--cached']));
  add(runGit(['ls-files', '--others', '--exclude-standard']));

  return [...changed].sort();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeWorkspacePath(file) {
  const root = resolve(workspaceRoot());
  const abs = resolve(root, String(file || ''));
  if (abs === root || (!abs.startsWith(`${root}/`) && !abs.startsWith(`${root}\\`))) return null;
  return abs;
}

function currentFileSnapshot(file) {
  const abs = safeWorkspacePath(file);
  if (!abs) return { file, invalid: true, exists: false, sha256: null };
  if (!existsSync(abs)) return { file, exists: false, sha256: null };
  try {
    const root = realpathSync(workspaceRoot());
    const real = realpathSync(abs);
    if (real === root || (!real.startsWith(`${root}/`) && !real.startsWith(`${root}\\`))) {
      return { file, invalid: true, exists: true, sha256: null };
    }
    return { file, exists: true, sha256: sha256(readFileSync(real)) };
  } catch {
    return { file, invalid: true, exists: true, sha256: null };
  }
}

function assessReviewFreshness(review) {
  const files = Array.isArray(review?.reviewed_files_all)
    ? [...new Set(review.reviewed_files_all.filter(file => typeof file === 'string' && file.trim()).map(file => file.trim()))].sort()
    : [];
  const snapshots = Array.isArray(review?.reviewed_file_snapshots) ? review.reviewed_file_snapshots : [];
  const expectedByFile = new Map();
  const failures = [];

  if (files.length === 0) failures.push('last-result.json is missing reviewed_files_all; re-run x-review');
  for (const snapshot of snapshots) {
    const file = typeof snapshot?.file === 'string' ? snapshot.file.trim() : '';
    if (!file || expectedByFile.has(file)) {
      failures.push(`last-result.json has an invalid or duplicate reviewed_file_snapshots entry: ${file || '<missing file>'}`);
      continue;
    }
    expectedByFile.set(file, snapshot);
  }

  const changed = [];
  const canonical = [];
  const currentSnapshots = new Map();
  for (const file of files) {
    const expected = expectedByFile.get(file);
    if (!expected) {
      failures.push(`last-result.json has no reviewed_file_snapshots entry for ${file}; re-run x-review`);
      continue;
    }
    const expectedExists = expected.exists === true;
    const expectedSha = expectedExists && typeof expected.sha256 === 'string' ? expected.sha256.toLowerCase() : null;
    if (expected.exists !== true && expected.exists !== false) {
      failures.push(`reviewed_file_snapshots entry has invalid exists value: ${file}`);
      continue;
    }
    if (expectedExists && !/^[0-9a-f]{64}$/.test(expectedSha || '')) {
      failures.push(`reviewed_file_snapshots entry has invalid sha256: ${file}`);
      continue;
    }
    if (!expectedExists && expected.sha256 != null) {
      failures.push(`reviewed_file_snapshots entry for absent file must use sha256=null: ${file}`);
      continue;
    }
    const current = currentFileSnapshot(file);
    currentSnapshots.set(file, current);
    if (current.invalid) {
      failures.push(`reviewed file path is unsafe or unreadable: ${file}`);
      continue;
    }
    canonical.push({ file, exists: expectedExists, sha256: expectedSha });
    if (current.exists !== expectedExists || current.sha256 !== expectedSha) changed.push(file);
  }

  for (const file of expectedByFile.keys()) {
    if (!files.includes(file)) failures.push(`reviewed_file_snapshots contains a file outside reviewed_files_all: ${file}`);
  }

  return {
    files,
    changed: [...new Set(changed)].sort(),
    failures,
    digest: failures.length === 0 ? `sha256:${sha256(JSON.stringify(canonical))}` : null,
    currentSnapshots,
  };
}

function toTriageMap(triage) {
  const items = triage?.target_findings || triage?.findings || [];
  const map = new Map();
  if (Array.isArray(items)) {
    for (const item of items) {
      if (item.id) map.set(item.id, item);
      if (item.finding_id) map.set(item.finding_id, item);
    }
  }
  return map;
}

function getAllowedFiles(triage) {
  const files = triage?.fix_scope?.allowed_files || triage?.allowed_files || [];
  return Array.isArray(files) ? files : [];
}

function getVerificationItems(triage) {
  const items = triage?.verification || triage?.fix_scope?.verification || [];
  return Array.isArray(items) ? items : [];
}

function buildTriageTemplate(review) {
  const findings = Array.isArray(review.findings) ? review.findings : [];
  const targetFindings = findings.map((finding, index) => {
    const severity = normalizeSeverity(finding.severity);
    return {
      id: findingId(index),
      finding_id: stableFindingId(finding),
      severity,
      file: finding.file || null,
      line: finding.line ?? null,
      summary: findingSummary(finding),
      decision: BLOCKING_SEVERITY.has(severity)
        ? 'fix_now'
        : (TRIAGE_REQUIRED_SEVERITY.has(severity) ? '' : 'backlog'),
      evidence: '',
      fix_notes: '',
    };
  });

  const allowedFiles = [...new Set(targetFindings
    .filter(f => TRIAGE_REQUIRED_SEVERITY.has(f.severity) && f.file)
    .map(f => f.file))].sort();

  const freshness = assessReviewFreshness(review);
  return {
    schema: 1,
    initialized_at: new Date().toISOString(),
    reviewed_commit: review.reviewed_commit || null,
    review_snapshot_digest: freshness.digest,
    verdict: review.verdict || null,
    baseline_changed_files: collectChangedFilesSinceReview(review.reviewed_commit),
    target_findings: targetFindings,
    fix_scope: {
      allowed_files: allowedFiles,
      forbidden: [
        'unrelated refactors',
        'drive-by formatting outside allowed_files',
        'new feature work not required by a fix_now finding',
      ],
    },
    verification: [
      'Run x-build quality',
      'Run tests covering each fix_now finding',
      'Re-run x-review after review-fix changes',
    ],
  };
}

function lifecyclePath() {
  return join(reviewDir(), 'finding-lifecycle.json');
}

function buildLifecycle(review, triage, freshness) {
  const triageMap = toTriageMap(triage);
  const findings = (Array.isArray(review.findings) ? review.findings : []).map((finding, index) => {
    const id = findingId(index);
    const findingIdStable = stableFindingId(finding);
    const item = triageMap.get(findingIdStable) || triageMap.get(id);
    return {
      id,
      finding_id: findingIdStable,
      severity: normalizeSeverity(finding.severity),
      file: finding.file || null,
      line: finding.line ?? null,
      summary: findingSummary(finding),
      decision: String(item?.decision || '').trim().toLowerCase(),
      state: 'open',
      outcome: null,
      evidence: null,
      file_snapshot: null,
      updated_at: new Date().toISOString(),
    };
  });
  return {
    schema: 1,
    reviewed_commit: review.reviewed_commit || null,
    reviewed_files_all: [...freshness.files],
    review_snapshot_digest: freshness.digest,
    triage_digest: `sha256:${sha256(JSON.stringify(triage))}`,
    updated_at: new Date().toISOString(),
    findings,
  };
}

function lifecycleMatches(lifecycle, review, freshness, triageDigest) {
  return lifecycle?.schema === 1 &&
    lifecycle.reviewed_commit === (review.reviewed_commit || null) &&
    lifecycle.review_snapshot_digest === freshness.digest &&
    lifecycle.triage_digest === triageDigest &&
    Array.isArray(lifecycle.findings);
}

function snapshotMatches(a, b) {
  return !!a && !!b && a.invalid !== true && b.invalid !== true &&
    a.file === b.file && a.exists === b.exists && a.sha256 === b.sha256;
}

function lifecycleFileSnapshot(file, freshness) {
  if (file) return freshness.currentSnapshots?.get(file) || currentFileSnapshot(file);
  const current = freshness.files.map(path => freshness.currentSnapshots?.get(path) || currentFileSnapshot(path));
  if (current.some(snapshot => snapshot.invalid)) return { file: null, invalid: true, exists: null, sha256: null };
  return {
    file: null,
    exists: null,
    sha256: sha256(JSON.stringify(current.map(snapshot => ({ file: snapshot.file, exists: snapshot.exists, sha256: snapshot.sha256 })))),
  };
}

function syncLifecycle(lifecycle, required, triageMap, freshness, fixAuthorized) {
  const changed = new Set(freshness.changed);
  const now = new Date().toISOString();
  for (const finding of required) {
    const findingIdStable = stableFindingId(finding);
    const item = triageMap.get(findingIdStable) || triageMap.get(finding.id);
    let row = lifecycle.findings.find(entry => entry.finding_id === findingIdStable || entry.id === finding.id);
    if (!row) {
      row = {
        id: finding.id, finding_id: findingIdStable, severity: finding.severity,
        file: finding.file || null, line: finding.line ?? null, summary: findingSummary(finding),
        state: 'open', outcome: null, evidence: null, file_snapshot: null,
      };
      lifecycle.findings.push(row);
    }
    row.id = finding.id;
    row.finding_id = findingIdStable;
    row.decision = String(item?.decision || '').trim().toLowerCase();
    if (row.decision !== 'fix_now') continue;
    const current = lifecycleFileSnapshot(row.file, freshness);
    if (row.state === 'reverified' && snapshotMatches(row.file_snapshot, current)) continue;
    row.outcome = null;
    row.evidence = null;
    row.file_snapshot = null;
    if (row.file ? changed.has(row.file) : freshness.changed.length > 0) {
      row.state = 'fixed';
    } else {
      row.state = fixAuthorized ? 'fix_authorized' : 'open';
    }
    row.updated_at = now;
  }
  lifecycle.updated_at = now;
  return lifecycle;
}

// ── cmdVerifyDrift ──────────────────────────────────────────────────

export function cmdVerifyDrift(args) {
  const { opts } = parseOptions(args);
  const project = resolveProject(null);
  const prd = readMD(prdPath(project));
  const taskData = readJSON(tasksPath(project));
  const tasks = taskData?.tasks || [];

  if (!prd) {
    console.log(`${C.yellow}No PRD.md found. Run: x-build plan${C.reset}`);
    return;
  }

  const baseline = parsePrdBaseline(prd);
  const threshold = opts.threshold != null ? Number(opts.threshold) : undefined;
  const result = computeDrift(baseline, tasks, threshold != null ? { threshold } : {});

  const passIcon = result.gate_pass ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
  const pct = v => `${Math.round(v * 100)}%`;

  console.log(`\n${C.bold}PRD Drift Score${C.reset}\n`);
  console.log(`  Goal coverage        (gates): ${pct(result.goal_score).padStart(4)}  ${renderScoreBar(result.goal_score)}`);
  console.log(`  Constraint adherence  (diag): ${pct(result.constraint_score).padStart(4)}  ${renderScoreBar(result.constraint_score)}`);
  console.log(`  Ontology coverage     (diag): ${pct(result.ontology_score).padStart(4)}  ${renderScoreBar(result.ontology_score)}`);
  console.log(`  ${'─'.repeat(48)}`);
  console.log(`  Drift score (=goal coverage): ${pct(result.weighted).padStart(4)}  (threshold: ${pct(result.threshold)})`);
  console.log(`\n  Gate: ${passIcon}\n`);

  if (!result.gate_pass) {
    console.log(`  ${C.yellow}Drift score ${pct(result.weighted)} is below threshold ${pct(result.threshold)}.${C.reset}`);
    if (result.goal_score < result.threshold) {
      const scCount = baseline.successCriteria.length;
      const completedCount = tasks.filter(t => t.status === 'completed').length;
      console.log(`  ${C.dim}Hint: ${completedCount} completed tasks cover ${pct(result.goal_score)} of ${scCount} success criteria.${C.reset}`);
    }
  }

  // Show baseline summary
  console.log(`  ${C.dim}Parsed: ${baseline.successCriteria.length} SC, ${baseline.constraints.length} constraints, ${baseline.ontologyKeywords.length} ontology keywords${C.reset}`);

  const outPath = join(phaseDir(project, '04-verify'), 'drift-score.json');
  writeJSON(outPath, {
    timestamp: new Date().toISOString(),
    project,
    ...result,
    baseline_summary: {
      success_criteria_count: baseline.successCriteria.length,
      constraints_count: baseline.constraints.length,
      ontology_keyword_count: baseline.ontologyKeywords.length,
    },
  });

  console.log(`  Saved: ${outPath}\n`);

  if (!result.gate_pass) {
    process.exitCode = 1;
  }
}

function renderScoreBar(score) {
  const filled = Math.round(clamp01Score(score) * 10);
  return `[${'█'.repeat(filled)}${'░'.repeat(10 - filled)}]`;
}

function clamp01Score(v) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function cmdVerifyReviewFix(args) {
  const { opts } = parseOptions(args);
  const resultPath = join(reviewDir(), 'last-result.json');
  const triagePath = join(reviewDir(), opts.triage || 'triage.json');

  if (!existsSync(resultPath)) {
    console.log(`${C.yellow}No x-review result found.${C.reset}`);
    console.log('  Run: /xm:review diff');
    process.exitCode = 1;
    return;
  }

  const review = readJSON(resultPath);
  const findings = Array.isArray(review?.findings) ? review.findings : [];
  const required = findings
    .map((finding, index) => ({ ...finding, id: findingId(index), finding_id: stableFindingId(finding), severity: normalizeSeverity(finding.severity) }))
    .filter(f => TRIAGE_REQUIRED_SEVERITY.has(f.severity));
  const freshness = assessReviewFreshness(review);
  const findingIdFailures = stableFindingIdFailures(required);

  if (opts.init) {
    const initFailures = [...freshness.failures, ...findingIdFailures];
    if (freshness.changed.length > 0) {
      initFailures.push(`Reviewed files changed since x-review: ${freshness.changed.join(', ')}. Re-run x-review before triage.`);
    }
    if (initFailures.length > 0) {
      console.log(`${C.red}Review Fix Gate failed.${C.reset}`);
      for (const failure of initFailures) console.log(`  - ${failure}`);
      process.exitCode = 1;
      return;
    }
    const previousGatePath = join(reviewDir(), 'review-fix-gate.json');
    if (existsSync(previousGatePath)) unlinkSync(previousGatePath);
    const triage = buildTriageTemplate(review);
    writeJSON(triagePath, triage);
    writeJSON(lifecyclePath(), buildLifecycle(review, triage, freshness));
    console.log(`${C.green}Created review-fix triage template:${C.reset} ${triagePath}`);
    console.log('  Edit decisions, allowed_files, and verification before applying review fixes.');
    return;
  }

  const verdict = normalizeVerdict(review?.verdict);
  if ((verdict === 'lgtm' || verdict === 'pass') && required.length === 0) {
    const existingTriage = readJSON(triagePath);
    const existingLifecycle = readJSON(lifecyclePath());
    const existingGate = readJSON(join(reviewDir(), 'review-fix-gate.json'));
    const currentTriageDigest = existingTriage ? `sha256:${sha256(JSON.stringify(existingTriage))}` : null;
    const triageFixNow = (Array.isArray(existingTriage?.target_findings) ? existingTriage.target_findings : [])
      .filter(item => String(item.decision || '').trim().toLowerCase() === 'fix_now');
    const lifecycleAware = existingTriage?.schema === 1
      || (!!existingTriage?.initialized_at && !!existingTriage?.review_snapshot_digest)
      || existingLifecycle?.schema === 1
      || !!existingGate?.lifecycle_digest;
    if (lifecycleAware && (!existingTriage || !existingLifecycle || !existingGate)) {
      console.log(`${C.red}Review Fix Gate failed.${C.reset}`);
      console.log('  - LGTM cannot close a lifecycle-aware review-fix with missing triage, lifecycle, or gate artifacts');
      process.exitCode = 1;
      return;
    }
    const fixNow = triageFixNow;
    if (lifecycleAware) {
      const rows = Array.isArray(existingLifecycle.findings) ? existingLifecycle.findings : [];
      const incomplete = fixNow.filter((finding) => {
        const row = rows.find(item => finding.finding_id && item.finding_id === finding.finding_id);
        const current = row ? lifecycleFileSnapshot(row.file, freshness) : null;
        return row?.state !== 'reverified' || row?.outcome !== 'resolved' || !snapshotMatches(row.file_snapshot, current);
      });
      const correlated = reviewedCommitCovers(existingTriage.reviewed_commit, review.reviewed_commit || null)
        && existingLifecycle.reviewed_commit === existingTriage.reviewed_commit
        && existingGate.reviewed_commit === existingTriage.reviewed_commit
        && existingLifecycle.triage_digest === currentTriageDigest
        && existingGate.triage_digest === currentTriageDigest
        && existingGate?.lifecycle_digest === `sha256:${sha256(JSON.stringify(existingLifecycle))}`
        && freshness.failures.length === 0
        && freshness.changed.length === 0
        && Array.isArray(existingLifecycle.reviewed_files_all)
        && existingLifecycle.reviewed_files_all.every(file => freshness.files.includes(file));
      if (!correlated || incomplete.length > 0) {
        console.log(`${C.red}Review Fix Gate failed.${C.reset}`);
        if (!correlated) console.log('  - LGTM does not correlate with the authorized finding lifecycle receipt');
        if (incomplete.length > 0) console.log(`  - LGTM cannot close unresolved or stale finding lifecycle entries: ${incomplete.map(item => item.id || item.finding_id).join(', ')}`);
        process.exitCode = 1;
        return;
      }
    }
    console.log(`${C.green}Review Fix Gate passed.${C.reset}`);
    console.log('  Last x-review verdict is LGTM and no triage-required findings remain.');
    return;
  }

  const failures = [...findingIdFailures];
  const warnings = [];
  let lifecycle = null;
  let fixAuthorized = false;
  let triageDigest = null;
  let lifecycleSummary = { open: 0, fix_authorized: 0, fixed: 0, reverified: 0 };

  if (!existsSync(triagePath)) {
    failures.push(`Missing triage file: ${triagePath}`);
    failures.push('Run: x-build verify-review-fix --init');
  } else {
    const triage = readJSON(triagePath);
    const triageMap = toTriageMap(triage);
    const allowedFiles = getAllowedFiles(triage);
    const verification = getVerificationItems(triage);
    const baselineFiles = new Set(Array.isArray(triage.baseline_changed_files) ? triage.baseline_changed_files : []);
    const previousGate = readJSON(join(reviewDir(), 'review-fix-gate.json'));
    triageDigest = `sha256:${sha256(JSON.stringify(triage))}`;
    fixAuthorized = (previousGate?.authorized === true || (previousGate?.passed === true && previousGate?.stage === 'ready_for_fix')) &&
      previousGate?.reviewed_commit === (review.reviewed_commit || null) &&
      previousGate?.review_snapshot_digest === freshness.digest &&
      previousGate?.triage_digest === triageDigest;

    lifecycle = readJSON(lifecyclePath());
    if (!lifecycleMatches(lifecycle, review, freshness, triageDigest)) {
      lifecycle = buildLifecycle(review, triage, freshness);
    }
    const lifecycleDigestBeforeSync = `sha256:${sha256(JSON.stringify(lifecycle))}`;
    if (previousGate?.lifecycle_digest && previousGate.lifecycle_digest !== lifecycleDigestBeforeSync) {
      failures.push('finding-lifecycle.json changed since the last review-fix gate; re-run verify-review-fix --init');
      fixAuthorized = false;
    }
    lifecycle = syncLifecycle(lifecycle, required, triageMap, freshness, fixAuthorized);

    if (opts.reverify) {
      const requested = String(opts.reverify);
      const outcome = String(opts.outcome || '').trim().toLowerCase();
      const evidence = String(opts.evidence || '').trim();
      const row = lifecycle.findings.find(entry => entry.id === requested || entry.finding_id === requested);
      if (!row) failures.push(`Unknown finding for --reverify: ${requested}`);
      else if (row.decision !== 'fix_now') failures.push(`${requested}: only fix_now findings can be reverified`);
      else if (!['fixed', 'reverified'].includes(row.state)) failures.push(`${requested}: finding bytes must change before reverification (current: ${row.state})`);
      else if (!VALID_REVERIFY_OUTCOMES.has(outcome)) failures.push(`${requested}: --outcome must be resolved, persistent, or regression`);
      else if (!evidence) failures.push(`${requested}: --evidence is required for reverification`);
      else {
        row.state = 'reverified';
        row.outcome = outcome;
        row.evidence = evidence;
        row.file_snapshot = lifecycleFileSnapshot(row.file, freshness);
        row.reverified_at = new Date().toISOString();
        row.updated_at = row.reverified_at;
      }
    }

    failures.push(...freshness.failures);
    if (triage.review_snapshot_digest !== freshness.digest) {
      failures.push('triage.json review_snapshot_digest does not match last-result.json; re-run verify-review-fix --init');
    }
    const unauthorizedChanges = fixAuthorized
      ? freshness.changed.filter(file => !allowedFiles.includes(file))
      : freshness.changed;
    if (unauthorizedChanges.length > 0) {
      failures.push(fixAuthorized
        ? `Reviewed files changed outside fix_scope.allowed_files: ${unauthorizedChanges.join(', ')}`
        : `Reviewed files changed before the review-fix gate authorized edits: ${unauthorizedChanges.join(', ')}. Re-run x-review.`);
    }

    if (review.reviewed_commit && triage.reviewed_commit && review.reviewed_commit !== triage.reviewed_commit) {
      failures.push('triage.json reviewed_commit does not match last-result.json reviewed_commit');
    }

    for (const finding of required) {
      const decision = triageMap.get(finding.id);
      if (!decision) {
        failures.push(`${finding.id}: missing triage decision for ${finding.severity} finding`);
        continue;
      }

      const rawDecision = String(decision.decision || '').trim();
      const value = rawDecision.toLowerCase();
      if (!rawDecision) {
        failures.push(`${finding.id}: ${finding.severity} finding requires an explicit triage decision`);
        continue;
      }
      if (!VALID_TRIAGE_DECISIONS.has(value)) {
        failures.push(`${finding.id}: invalid decision "${decision.decision}"`);
        continue;
      }

      if (BLOCKING_SEVERITY.has(finding.severity) && value === 'backlog') {
        failures.push(`${finding.id}: ${finding.severity} finding cannot be moved to backlog`);
      }

      if ((value === 'accept_risk' || value === 'false_positive') && !String(decision.evidence || '').trim()) {
        failures.push(`${finding.id}: ${value} requires evidence`);
      }

      if (value === 'fix_now' && finding.file && !allowedFiles.includes(finding.file)) {
        failures.push(`${finding.id}: fix_now file is not in fix_scope.allowed_files (${finding.file})`);
      }
    }

    if (allowedFiles.length === 0 && required.some(f => f.file && triageMap.get(f.id)?.decision === 'fix_now')) {
      failures.push('fix_scope.allowed_files must include every file that review fixes may touch');
    }

    if (verification.length === 0) {
      failures.push('verification must list at least one command or evidence check');
    }

    const changedFiles = collectChangedFilesSinceReview(review.reviewed_commit);
    const drift = changedFiles.filter(file =>
      !baselineFiles.has(file) &&
      file !== '.xm/review/triage.json' &&
      file !== '.xm/review/review-fix-gate.json' &&
      file !== '.xm/review/finding-lifecycle.json' &&
      !file.startsWith('.xm/review/history/') &&
      !allowedFiles.includes(file)
    );

    if (drift.length > 0) {
      failures.push(`Changed files outside fix_scope.allowed_files: ${drift.join(', ')}`);
    }

    if (changedFiles.length === 0) {
      warnings.push('No changed files detected since the reviewed commit. Run this again after applying review fixes.');
    }

    const baselineOutsideScope = [...baselineFiles].filter(file =>
      !file.startsWith('.xm/review/') &&
      !allowedFiles.includes(file)
    );
    if (baselineOutsideScope.length > 0) {
      warnings.push(`Baseline already includes files outside fix_scope.allowed_files; file-level drift is only enforced for new files: ${baselineOutsideScope.join(', ')}`);
    }

    writeJSON(lifecyclePath(), lifecycle);
    const fixNowRows = lifecycle.findings.filter(row => row.decision === 'fix_now');
    lifecycleSummary = Object.fromEntries(['open', 'fix_authorized', 'fixed', 'reverified'].map(state => [state, lifecycle.findings.filter(row => row.state === state).length]));
    if (fixAuthorized && freshness.changed.length > 0) {
      for (const row of fixNowRows) {
        if (row.state !== 'reverified') failures.push(`${row.id}: fix requires explicit reverification`);
        else if (row.outcome !== 'resolved') failures.push(`${row.id}: reverification outcome is ${row.outcome}; expected resolved`);
      }
    }
  }

  const hasFixedBytes = freshness.changed.length > 0;
  const resolvedCandidates = lifecycle?.findings?.filter(row => row.decision === 'fix_now') || [];
  const allResolved = resolvedCandidates.length > 0 && resolvedCandidates.every(row => row.state === 'reverified' && row.outcome === 'resolved');
  const authorized = fixAuthorized || (!hasFixedBytes && failures.length === 0);
  const awaitingOnly = failures.length > 0 && failures.every(failure =>
    /fix requires explicit reverification|reverification outcome is/.test(failure)
  );
  const stage = failures.length > 0
    ? (fixAuthorized && hasFixedBytes && awaitingOnly ? 'awaiting_reverification' : 'blocked')
    : (fixAuthorized && allResolved ? 'reverified' : 'ready_for_fix');
  if (lifecycle && authorized && !hasFixedBytes && failures.length === 0) {
    for (const row of lifecycle.findings) {
      if (row.decision === 'fix_now' && row.state === 'open') {
        row.state = 'fix_authorized';
        row.updated_at = new Date().toISOString();
      }
    }
    lifecycle.updated_at = new Date().toISOString();
    lifecycleSummary = Object.fromEntries(['open', 'fix_authorized', 'fixed', 'reverified'].map(state => [state, lifecycle.findings.filter(row => row.state === state).length]));
    writeJSON(lifecyclePath(), lifecycle);
  }

  const report = {
    timestamp: new Date().toISOString(),
    reviewed_commit: review.reviewed_commit || null,
    verdict: review.verdict || null,
    triage_required: required.length,
    stage,
    authorized,
    review_snapshot_digest: freshness.digest,
    triage_digest: triageDigest,
    lifecycle_digest: lifecycle ? `sha256:${sha256(JSON.stringify(lifecycle))}` : null,
    passed: failures.length === 0,
    failures,
    warnings,
    lifecycle: lifecycleSummary,
  };
  writeJSON(join(reviewDir(), 'review-fix-gate.json'), report);

  if (failures.length > 0) {
    console.log(`${C.red}Review Fix Gate failed.${C.reset}`);
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log(`${C.green}Review Fix Gate passed.${C.reset}`);
  console.log(`  Triage-required findings: ${required.length}`);
  if (stage === 'reverified') console.log(`  Reverified: ${lifecycleSummary.reverified} finding(s) resolved against current file bytes.`);
  for (const warning of warnings) console.log(`  ${C.yellow}Warning:${C.reset} ${warning}`);
}
