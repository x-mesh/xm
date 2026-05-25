/**
 * x-build/drift — PRD baseline parser and drift scorer
 *
 * Computes weighted drift between a PRD baseline and current task state.
 * Used by verify-drift to gate progression.
 */

import { loadSharedConfig } from './config-loader.mjs';

// ── Module-level constants ───────────────────────────────────────────

// 0.80 from scripts/sim-thresholds.mjs (seed-stable). CAVEAT: the simulator's
// "healthy" population over-estimated ontology coverage — real dogfooding
// (quant-gates) landed at the 0.80 boundary, exposing an ontology-scoring gap.
// Fixed by plain-path stem extraction + STRUCTURAL_NOISE stopwords (coverage
// 21% -> realistic) and by gating on the rounded score (see computeDrift) so the
// displayed percentage and pass/fail never contradict at the boundary.
const DEFAULT_THRESHOLD = 0.8;

/**
 * Weights for the weighted drift formula.
 * mirrors xm/lib/scoring.mjs weightedScore — inlined to avoid cross-plugin import.
 *   weighted = DRIFT_WEIGHTS.goal * goal + DRIFT_WEIGHTS.constraint * constraint + DRIFT_WEIGHTS.ontology * ontology
 */
const DRIFT_WEIGHTS = { goal: 0.5, constraint: 0.3, ontology: 0.2 };

// File-extension tokens that carry no ontology signal (task names reference
// concepts, never extensions). Excluded from ontology keyword extraction.
const FILE_EXTENSION_NOISE = new Set([
  'mjs', 'js', 'ts', 'jsx', 'tsx', 'cjs', 'json', 'md', 'mdx',
  'py', 'go', 'rs', 'java', 'rb', 'sh', 'yml', 'yaml', 'toml',
  'txt', 'css', 'html', 'sql', 'env', 'lock',
]);

// PRD structural/section vocabulary — these are document scaffolding, not
// ontology entities. They appear in Architecture/Data Model prose (headings,
// track labels, generic nouns) but never as task concepts, so leaving them in
// inflates the denominator and permanently suppresses ontology coverage.
const STRUCTURAL_NOISE = new Set([
  'goal', 'success', 'criteria', 'constraint', 'constraints',
  'architecture', 'risk', 'risks', 'assumption', 'assumptions',
  'boundary', 'boundaries', 'requirement', 'requirements',
  'decision', 'decisions', 'overview', 'scope', 'summary',
  'acceptance', 'traceability', 'section', 'note', 'notes',
  'data', 'model', 'shared', 'track', 'phase', 'open', 'question',
  'questions', 'with', 'this', 'that', 'from', 'into', 'when', 'then',
  'true', 'false', 'null', 'undefined',
]);

// ── PRD Baseline Parsing ────────────────────────────────────────────

/**
 * Parse a PRD.md text into a structured baseline with goal, constraints,
 * and success criteria extracted from standard section headers.
 *
 * Expected PRD format:
 *   ## 1. Goal         — free-form text
 *   ## 2. Success Criteria — items tagged [SC#]
 *   ## 3. Constraints  — items tagged [C#]
 *   ## 6. Architecture (optional, for ontology keywords)
 *   ## 5. Data Model   (optional, for ontology keywords)
 *
 * @param {string} prdText
 * @returns {{ goal: string, successCriteria: Array<{id:string, desc:string}>, constraints: Array<{id:string, desc:string}>, ontologyKeywords: string[] }}
 */
export function parsePrdBaseline(prdText) {
  if (!prdText || typeof prdText !== 'string') {
    return { goal: '', successCriteria: [], constraints: [], ontologyKeywords: [] };
  }

  // ── Goal (## 1. Goal or ## Goal) ──────────────────────────────
  const goalMatch = prdText.match(/##\s*(?:\d+\.\s*)?Goal\b([\s\S]*?)(?=\n##|\s*$)/i);
  const goal = goalMatch ? goalMatch[1].trim() : '';

  // ── Success Criteria [SC#] ────────────────────────────────────
  const scSection = prdText.match(/##\s*(?:\d+\.\s*)?Success Criteria\b([\s\S]*?)(?=\n##|\s*$)/i);
  const successCriteria = [];
  if (scSection) {
    const scPattern = /\[SC(\d+)\]\s*(.+)/g;
    let m;
    while ((m = scPattern.exec(scSection[1])) !== null) {
      successCriteria.push({ id: `SC${m[1]}`, desc: m[2].trim() });
    }
  }

  // ── Constraints [C#] ─────────────────────────────────────────
  const cSection = prdText.match(/##\s*(?:\d+\.\s*)?Constraints?\b([\s\S]*?)(?=\n##|\s*$)/i);
  const constraints = [];
  if (cSection) {
    const cPattern = /\[C(\d+)\]\s*(.+)/g;
    let m;
    while ((m = cPattern.exec(cSection[1])) !== null) {
      constraints.push({ id: `C${m[1]}`, desc: m[2].trim() });
    }
  }

  // ── Ontology keywords from Architecture / Data Model sections ─
  const ontologyKeywords = extractOntologyKeywords(prdText);

  return { goal, successCriteria, constraints, ontologyKeywords };
}

// ── Ontology Keyword Extraction ─────────────────────────────────────

/**
 * Extract meaningful entity/concept keywords from Architecture and Data Model
 * sections of a PRD for ontology coverage scoring.
 *
 * @param {string} prdText
 * @returns {string[]}
 */
function extractOntologyKeywords(prdText) {
  const keywords = new Set();

  const archMatch = prdText.match(/##\s*(?:\d+\.\s*)?Architecture\b([\s\S]*?)(?=\n##|\s*$)/i);
  const dataMatch = prdText.match(/##\s*(?:\d+\.\s*)?Data Model\b([\s\S]*?)(?=\n##|\s*$)/i);

  for (const section of [archMatch?.[1], dataMatch?.[1]]) {
    if (!section) continue;
    extractBacktickTokens(section, keywords);
    extractPlainPathTokens(section, keywords);
    extractCapitalizedTokens(section, keywords);
  }

  // Fallback: when no architecture/data-model sections exist, use capitalized
  // words from goal + success criteria as lightweight ontology
  if (keywords.size === 0) {
    const words = [...prdText.matchAll(/\b([A-Z][a-zA-Z]{3,})\b/g)];
    for (const m of words) {
      keywords.add(m[1].toLowerCase());
    }
  }

  return [...keywords].filter(k => !STRUCTURAL_NOISE.has(k));
}

/**
 * Extract stems from backtick-quoted identifiers (e.g. `drift.mjs` → "drift").
 * Strong signal: authors use backticks to mark specific entities.
 * Extension tokens are dropped as FILE_EXTENSION_NOISE.
 *
 * @param {string} section
 * @param {Set<string>} keywords
 */
function extractBacktickTokens(section, keywords) {
  const backtickTokens = [...section.matchAll(/`([^`]+)`/g)].map(m => m[1].trim());
  for (const tok of backtickTokens) {
    const parts = tok.split(/[\s/.()\[\]]+/).filter(Boolean);
    for (const p of parts) {
      if (p.length >= 3 && !FILE_EXTENSION_NOISE.has(p.toLowerCase())) {
        keywords.add(p.toLowerCase());
      }
    }
  }
}

/**
 * Extract basename stems from plain-text file/path tokens (NOT backtick-quoted).
 * PRDs often write paths as prose ("xm/lib/scoring.mjs 신설"). Extension dropped.
 *
 * @param {string} section
 * @param {Set<string>} keywords
 */
function extractPlainPathTokens(section, keywords) {
  const pathTokens = [...section.matchAll(/\b([A-Za-z][\w-]*)\.(?:mjs|js|ts|jsx|tsx|cjs|json|md|py|go|rs|java|rb)\b/g)];
  for (const m of pathTokens) {
    const stem = m[1].toLowerCase();
    if (stem.length >= 3 && !FILE_EXTENSION_NOISE.has(stem)) {
      keywords.add(stem);
    }
  }
}

/**
 * Extract capitalized or camelCase words (entity names), length >= 4.
 * Catches domain terms like "ScoringEngine", "TaskRecord", etc.
 *
 * @param {string} section
 * @param {Set<string>} keywords
 */
function extractCapitalizedTokens(section, keywords) {
  const wordTokens = [...section.matchAll(/\b([A-Z][a-zA-Z]{3,}|[a-z]{4,}[A-Z][a-zA-Z]+)\b/g)];
  for (const m of wordTokens) {
    keywords.add(m[1].toLowerCase());
  }
}

// ── Drift Computation ───────────────────────────────────────────────

/**
 * Compute weighted drift scores comparing PRD baseline against current tasks.
 *
 * Weighted formula (uses DRIFT_WEIGHTS — mirrors xm/lib/scoring.mjs weightedScore):
 *   weighted = DRIFT_WEIGHTS.goal * goal_score
 *            + DRIFT_WEIGHTS.constraint * constraint_score
 *            + DRIFT_WEIGHTS.ontology * ontology_score
 *
 * NOTE: The default threshold (DEFAULT_THRESHOLD = 0.80) was confirmed by a
 * deterministic simulator (scripts/sim-thresholds.mjs) across realistic input
 * distributions and seeds, per CLAUDE.md Lessons L9. Override via the
 * drift.drift_threshold config key.
 *
 * Config key: drift.drift_threshold (in .xm/config.json or ~/.xm/config.json)
 *
 * @param {{ goal: string, successCriteria: Array<{id:string,desc:string}>, constraints: Array<{id:string,desc:string}>, ontologyKeywords: string[] }} baseline
 * @param {Array<{id:string, name:string, status:string, done_criteria?:string[]|string}>} tasks
 * @param {{ threshold?: number }} [opts]
 * @returns {{ goal_score: number, constraint_score: number, ontology_score: number, weighted: number, gate_pass: boolean, threshold: number }}
 */
export function computeDrift(baseline, tasks, opts = {}) {
  const cfg = loadSharedConfig();
  const threshold = opts.threshold ?? cfg?.drift?.drift_threshold ?? DEFAULT_THRESHOLD;

  const completedTasks = (tasks || []).filter(t => t.status === 'completed');
  const allTasks = tasks || [];

  const goal_score = computeGoalScore(baseline, completedTasks);
  const constraint_score = computeConstraintScore(baseline, allTasks);
  const ontology_score = computeOntologyScore(baseline, allTasks);

  // mirrors xm/lib/scoring.mjs weightedScore — inlined to avoid cross-plugin import
  const weightedRaw = clamp01(
    clamp01(goal_score) * DRIFT_WEIGHTS.goal +
    clamp01(constraint_score) * DRIFT_WEIGHTS.constraint +
    clamp01(ontology_score) * DRIFT_WEIGHTS.ontology
  );
  // Gate on the displayed (rounded) score so a reported "80%" never contradicts
  // an 80% threshold. Comparing raw (0.7967) against threshold while displaying
  // round2 (0.80) produced "80% is below threshold 80%" — a boundary paradox.
  const weighted = round2(weightedRaw);
  const gate_pass = weighted >= threshold;

  return {
    goal_score: round2(goal_score),
    constraint_score: round2(constraint_score),
    ontology_score: round2(ontology_score),
    weighted,
    gate_pass,
    threshold,
  };
}

// ── Score sub-computations ──────────────────────────────────────────

/**
 * goal_score: fraction of success criteria covered by completed tasks.
 * A task "covers" an SC if its name/done_criteria mentions the [SC#] id
 * or has sufficient keyword overlap with the SC description.
 */
function computeGoalScore(baseline, completedTasks) {
  const { successCriteria } = baseline;
  if (successCriteria.length === 0) {
    // No SC tags — fall back to ratio of completed tasks that have done_criteria
    if (completedTasks.length === 0) return 0;
    const withCriteria = completedTasks.filter(t => t.done_criteria?.length > 0);
    return withCriteria.length / completedTasks.length;
  }

  let covered = 0;
  for (const sc of successCriteria) {
    const matched = completedTasks.some(t => taskMentions(t, sc.id, sc.desc));
    if (matched) covered++;
  }
  return covered / successCriteria.length;
}

/**
 * constraint_score: fraction of constraints with no violation signal in tasks.
 * Heuristic: a constraint is "violated" if any task name/done_criteria
 * mentions the [C#] id together with a violation keyword.
 * Without explicit signals, all constraints are assumed satisfied.
 */
function computeConstraintScore(baseline, allTasks) {
  const { constraints } = baseline;
  if (constraints.length === 0) return 1.0;

  const VIOLATION_KEYWORDS = [
    'violation', 'skip', 'bypass', 'workaround',
    'broke', 'breaks', 'ignored', 'disabled',
  ];

  let satisfied = 0;
  for (const c of constraints) {
    const violated = allTasks.some(t => {
      const haystack = taskText(t).toLowerCase();
      const mentionsCid = haystack.includes(c.id.toLowerCase());
      const hasViolationSignal = VIOLATION_KEYWORDS.some(kw => haystack.includes(kw));
      return mentionsCid && hasViolationSignal;
    });
    if (!violated) satisfied++;
  }
  return satisfied / constraints.length;
}

/**
 * ontology_score: fraction of PRD architecture/data-model keywords that
 * appear in at least one task name or done_criteria.
 */
function computeOntologyScore(baseline, allTasks) {
  const { ontologyKeywords } = baseline;
  if (ontologyKeywords.length === 0) return 1.0;

  const taskCorpus = allTasks.map(t => taskText(t).toLowerCase()).join(' ');
  const corpusTokens = taskCorpus.split(/\W+/).filter(Boolean);

  let covered = 0;
  for (const kw of ontologyKeywords) {
    const k = kw.toLowerCase();
    // Exact substring match (strongest signal).
    if (taskCorpus.includes(k)) {
      covered++;
      continue;
    }
    // Stem match: keyword and a task token share a >=5-char prefix. Catches
    // inflection drift ("validation" PRD keyword vs "validate" task token)
    // without matching unrelated short words. Avoids the brittle exact-echo
    // requirement that collapsed ontology coverage on on-track projects.
    if (k.length >= 5 && corpusTokens.some(tok => shareStem(k, tok))) {
      covered++;
    }
  }
  return covered / ontologyKeywords.length;
}

/**
 * Two tokens "share a stem" if one starts with the other (length >= 5) or both
 * share a common prefix of length >= 5. Used for inflection-tolerant ontology
 * matching (validation/validate, simulator/simulate).
 */
export function shareStem(a, b) {
  if (b.length < 5) return false;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  const min = Math.min(a.length, b.length);
  if (min < 5) return false;
  let common = 0;
  for (let i = 0; i < min; i++) {
    if (a[i] === b[i]) common++;
    else break;
  }
  return common >= 5;
}

// ── Helpers ─────────────────────────────────────────────────────────

function taskText(task) {
  const parts = [task.name || '', task.id || ''];
  if (Array.isArray(task.done_criteria)) {
    parts.push(...task.done_criteria);
  } else if (typeof task.done_criteria === 'string') {
    parts.push(task.done_criteria);
  }
  return parts.join(' ');
}

function taskMentions(task, scId, scDesc) {
  const text = taskText(task).toLowerCase();
  if (text.includes(scId.toLowerCase())) return true;
  // Keyword overlap: >= 2 significant words (length >= 4) from SC description appear in task
  const words = scDesc.toLowerCase().split(/\W+/).filter(w => w.length >= 4);
  if (words.length === 0) return false;
  const matches = words.filter(w => text.includes(w));
  return matches.length >= Math.min(2, Math.ceil(words.length * 0.3));
}

function clamp01(v) {
  // mirrors xm/lib/scoring.mjs — inlined to avoid cross-plugin import
  const n = Number(v);
  if (!isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function round2(v) {
  // mirrors xm/lib/scoring.mjs — inlined to avoid cross-plugin import
  return Math.round(v * 100) / 100;
}
