/**
 * x-build/verify — Verification commands
 */

import {
  TASK_STATES, C,
  readJSON, writeJSON, readMD,
  tasksPath, prdPath, contextDir, phaseDir,
  resolveProject, renderBar,
  runQualityChecks,
  existsSync, join, resolve, ROOT, repoRoot, parseOptions, spawnSync,
} from './core.mjs';
import { parsePrdBaseline, computeDrift } from './drift.mjs';

// ── cmdQuality ──────────────────────────────────────────────────────

export function cmdQuality(args) {
  const project = resolveProject(null);
  console.log(`${C.bold}🔍 Running quality checks...${C.reset}\n`);
  const results = runQualityChecks(project);

  if (results.length === 0) {
    console.log(`  ${C.dim}No test/lint/build tools detected.${C.reset}`);
    return;
  }

  for (const r of results) {
    console.log(`  ${r.passed ? '✅' : '❌'} ${r.check}${r.passed ? '' : `\n     ${C.red}${r.output.slice(0, 200)}${C.reset}`}`);
  }

  const passCount = results.filter(r => r.passed).length;
  console.log(`\n${renderBar(passCount, results.length)} quality checks`);
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

// ── cmdVerifyCoverage ───────────────────────────────────────────────

export function cmdVerifyCoverage(args) {
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

  for (const req of reqs) {
    const found = tasks.some(t =>
      Array.isArray(t.requirements) && t.requirements.some(id => String(id).toLowerCase() === req.id.toLowerCase()) ||
      t.name.includes(req.id) ||
      t.name.toLowerCase().includes(req.desc.toLowerCase().slice(0, 30))
    );

    if (found) {
      console.log(`  [covered] [${req.id}] ${req.desc.slice(0, 60)}`);
      covered++;
    } else {
      console.log(`  [missing] [${req.id}] ${req.desc.slice(0, 60)} ${C.red}— no matching task${C.reset}`);
      uncovered++;
    }
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
    details: reqs.map(r => ({ ...r, covered: tasks.some(t => t.name.includes(r.id)) })),
  });

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
    const matchedTasks = tasks.filter(t =>
      (Array.isArray(t.requirements) && t.requirements.some(id => String(id).toLowerCase() === req.id.toLowerCase())) ||
      t.name.includes(req.id));
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

function normalizeSeverity(value) {
  return String(value || '').toLowerCase();
}

function normalizeVerdict(value) {
  return String(value || '').toLowerCase().replace(/[\s-]+/g, '_');
}

function findingId(index) {
  return `F${index + 1}`;
}

function findingSummary(finding) {
  return finding.summary || finding.description || finding.title || '';
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

function toTriageMap(triage) {
  const items = triage?.target_findings || triage?.findings || [];
  const map = new Map();
  if (Array.isArray(items)) {
    for (const item of items) {
      const id = item.id || item.finding_id;
      if (id) map.set(id, item);
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

  return {
    reviewed_commit: review.reviewed_commit || null,
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
    .map((finding, index) => ({ ...finding, id: findingId(index), severity: normalizeSeverity(finding.severity) }))
    .filter(f => TRIAGE_REQUIRED_SEVERITY.has(f.severity));

  if (opts.init) {
    writeJSON(triagePath, buildTriageTemplate(review));
    console.log(`${C.green}Created review-fix triage template:${C.reset} ${triagePath}`);
    console.log('  Edit decisions, allowed_files, and verification before applying review fixes.');
    return;
  }

  const verdict = normalizeVerdict(review?.verdict);
  if ((verdict === 'lgtm' || verdict === 'pass') && required.length === 0) {
    console.log(`${C.green}Review Fix Gate passed.${C.reset}`);
    console.log('  Last x-review verdict is LGTM and no triage-required findings remain.');
    return;
  }

  const failures = [];
  const warnings = [];

  if (!existsSync(triagePath)) {
    failures.push(`Missing triage file: ${triagePath}`);
    failures.push('Run: x-build verify-review-fix --init');
  } else {
    const triage = readJSON(triagePath);
    const triageMap = toTriageMap(triage);
    const allowedFiles = getAllowedFiles(triage);
    const verification = getVerificationItems(triage);
    const baselineFiles = new Set(Array.isArray(triage.baseline_changed_files) ? triage.baseline_changed_files : []);

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

    if (allowedFiles.length === 0 && required.some(f => triageMap.get(f.id)?.decision === 'fix_now')) {
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
  }

  const report = {
    timestamp: new Date().toISOString(),
    reviewed_commit: review.reviewed_commit || null,
    verdict: review.verdict || null,
    triage_required: required.length,
    passed: failures.length === 0,
    failures,
    warnings,
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
  for (const warning of warnings) console.log(`  ${C.yellow}Warning:${C.reset} ${warning}`);
}
