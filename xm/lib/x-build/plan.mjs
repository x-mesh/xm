/**
 * x-build/plan — Planning + deliberation commands
 */

import {
  PHASES, TASK_STATES, C, ROOT,
  readJSON, writeJSON, readMD, writeMD,
  manifestPath, tasksPath, stepsPath, prdPath, contextDir, phaseDir, projectDir, decisionsPath, archiveDir,
  resolveProject, getExplicitProject,
  loadConfig, loadSharedConfig, parseOptions, fmtDuration, estimateTaskCost, getModelForRole,
  cmdForecastUpdate, loadTokenActuals,
  aggregateRoi, roiSuggestion, readTaskMetrics, ROI_MIN_SAMPLES,
  existsSync, join, readFileSync, mkdirSync,
  getAgentCount, isNormalMode,
  templatesDir,
  readdirSync,
  exitFail,
} from './core.mjs';
import { taskList, vendorModelFields } from './tasks.mjs';
import { stepsStatus, computeSteps } from './tasks.mjs';
import { savePlanIntent, markPlanReady, validatePlanApproval, readPlanState } from './plan-state.mjs';
import { reviewGroupStatus, taskReviewGroup } from './build-policy.mjs';

// ── PRD template version + diagram gate (R4/R5/R12) ──────────────────
// PRD_TEMPLATE_VERSION marks the template revision where Section 8
// (Architecture) started requiring a diagram. cmdSaveArtifact stamps new
// PRDs with `<!-- prd-template-version: N -->`; prdBlockingFindings reads
// that marker back to decide whether a missing diagram blocks (N >= this
// constant) or only warns (no marker, or N below it — pre-existing PRDs).
export const PRD_TEMPLATE_VERSION = 2;

const VERSION_MARKER_RE = /<!--\s*prd-template-version:\s*(\d+)\s*-->/;
const DIAGRAM_MARKER_RE = /■\s*Diagram\s*:/;
const BOX_CHAR_RE = /[─│┌┐└┘├┤┬┴┼╌▶]/;
const MERMAID_KEYWORD_RE = /graph\s+(td|lr|tb|rl)\b|sequencediagram|classdiagram|statediagram|erdiagram/i;

// Line-based linear scan (no nested-regex backtracking) bounding a numbered
// section's scope: from its `## N.` heading line up to (not including) the
// next `## ` heading. Matches on the section NUMBER only — older PRDs reuse
// different subtitle text under the same number (e.g. "## 8. CLI Surface"),
// so matching on "Architecture" would false-negative on them.
//
// Fence-aware (F2): both the start search and the end-boundary search track
// a ``` toggle (same recognition rule as extractFencedBlocks) so a `## N.`-
// looking line INSIDE a fenced code block (e.g. a bash comment "## comment")
// is never mistaken for a heading.
//
// End-boundary regex intentionally allows zero-or-more spaces after `##`
// (F8) — symmetric with the start regex's `\s*` — so a tightly-spaced next
// heading like `##9. Foo` still closes the current section's scope instead
// of leaking into it. The negative lookahead excludes `###` sub-headings.
const NEXT_HEADING_RE = /^##(?!#)/;

// CommonMark-style fence-delimiter matching (F9): a fence line is a run of
// >=3 backticks. Returns that exact run (e.g. '```' or '````') or null. Used
// so a fence's CLOSE is only recognized when it's the same character run
// length-or-longer as its OPEN — a nested ``` (3 backticks) shown as literal
// content inside a ```` (4-backtick) fence must not prematurely close it.
const FENCE_DELIM_RE = /^`{3,}/;
function matchFenceDelim(trimmedLine) {
  const m = FENCE_DELIM_RE.exec(trimmedLine);
  return m ? m[0] : null;
}

function extractSectionScope(lines, headingNum) {
  const headRe = new RegExp(`^##\\s*${headingNum}\\.`);
  let start = -1;
  let fence = null; // active opening delimiter (e.g. '```'/'````'), or null
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (fence) {
      const closeDelim = matchFenceDelim(trimmed);
      if (closeDelim && closeDelim.length >= fence.length) fence = null;
      continue;
    }
    const openDelim = matchFenceDelim(trimmed);
    if (openDelim) { fence = openDelim; continue; }
    if (headRe.test(lines[i])) { start = i; break; }
  }
  if (start === -1) return null;
  fence = null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (fence) {
      const closeDelim = matchFenceDelim(trimmed);
      if (closeDelim && closeDelim.length >= fence.length) fence = null;
      continue;
    }
    const openDelim = matchFenceDelim(trimmed);
    if (openDelim) { fence = openDelim; continue; }
    if (NEXT_HEADING_RE.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end);
}

// Single pass over a section's lines to collect fenced code blocks. An
// unterminated fence is simply dropped (no crash) rather than throwing.
// Same CommonMark delimiter-length rule as extractSectionScope (F9): a
// closing line only counts when its backtick run is >= the opening run.
function extractFencedBlocks(sectionLines) {
  if (!sectionLines) return [];
  const blocks = [];
  let fence = null;
  let lang = '';
  let body = [];
  for (const raw of sectionLines) {
    const trimmed = raw.trim();
    if (fence) {
      const closeDelim = matchFenceDelim(trimmed);
      if (closeDelim && closeDelim.length >= fence.length) {
        blocks.push({ lang, body: body.join('\n') });
        fence = null;
        continue;
      }
      body.push(raw);
      continue;
    }
    const openDelim = matchFenceDelim(trimmed);
    if (openDelim) {
      fence = openDelim;
      lang = trimmed.slice(openDelim.length).trim().toLowerCase();
      body = [];
    }
  }
  return blocks;
}

function countBoxChars(str) {
  const m = str.match(new RegExp(BOX_CHAR_RE.source, 'g'));
  return m ? m.length : 0;
}

function boxCharLineCount(str) {
  return str.split('\n').filter((l) => BOX_CHAR_RE.test(l)).length;
}

// Diagram acceptance for a Section 8 scope — three independent paths, any one
// suffices (validated by scripts/sim-diagram-gate.mjs: 0 false positives on
// real corpus + adversarial synthetic fixtures):
//   1. Primary: `■ Diagram:` marker anywhere in scope (fence-agnostic — a
//      references-extraction PRD has the marker INSIDE the fence) AND at
//      least one non-empty fenced block in scope.
//   2. auxBox: a fenced block with >=6 box-drawing chars AND >=2 lines
//      containing one — dual threshold; a single decorative divider line
//      (e.g. a lone "───...") must NOT pass.
//   3. auxMermaid: a fenced ```mermaid block, or a fenced block containing a
//      mermaid keyword (graph TD/LR, sequenceDiagram, classDiagram, ...).
function sectionHasDiagram(sectionLines) {
  if (!sectionLines) return false;
  const fences = extractFencedBlocks(sectionLines);
  const hasNonEmptyFence = fences.some((f) => f.body.trim().length > 0);
  if (hasNonEmptyFence && DIAGRAM_MARKER_RE.test(sectionLines.join('\n'))) return true;
  for (const f of fences) {
    if (countBoxChars(f.body) >= 6 && boxCharLineCount(f.body) >= 2) return true;
  }
  for (const f of fences) {
    if (f.lang === 'mermaid' && f.body.trim().length > 0) return true;
    if (MERMAID_KEYWORD_RE.test(f.body)) return true;
  }
  return false;
}

// Longest run of consecutive numbered-list markers starting at 1 (1., 2.,
// 3., ...) within a section's scope — a proxy for "a scenario walkthrough
// with >=3 steps". Non-list lines (prose between steps) don't break a run;
// seeing "1." again starts a new run (a second scenario in the same section).
function maxNumberedRun(sectionLines) {
  let maxRun = 0, run = 0, expected = 1;
  const re = /^\s*(\d+)\.\s+/;
  for (const raw of sectionLines) {
    const m = re.exec(raw);
    if (!m) continue;
    const num = parseInt(m[1], 10);
    if (num === expected) {
      run++;
      expected++;
    } else if (num === 1) {
      run = 1;
      expected = 2;
    } else {
      run = 0;
      expected = 1;
    }
    if (run > maxRun) maxRun = run;
  }
  return maxRun;
}

// Most `→` hops found on any single line within a section's scope — a Data
// Flow Trace is conventionally one line (e.g. "Client → API → DB"), so a
// per-line max avoids false-triggering on unrelated arrows scattered across
// separate bullets.
function maxArrowHopsPerLine(sectionLines) {
  let max = 0;
  for (const line of sectionLines) {
    const matches = line.match(/→/g);
    const count = matches ? matches.length : 0;
    if (count > max) max = count;
  }
  return max;
}

// ── prdWriterSpec ───────────────────────────────────────────────────
// Deterministic role/model for the PRD-writing delegate. The PRD is the
// costliest artifact to get wrong, so it routes as a large planner task.

function prdWriterSpec(sharedCfg) {
  const cfg = sharedCfg || loadSharedConfig();
  const model = getModelForRole('planner', 'large', cfg);
  return { role: 'planner', model, ...vendorModelFields(model, cfg) };
}

// ── cmdPlan ─────────────────────────────────────────────────────────

function parsePlanArgs(args) {
  const positional = [];
  let quick = false;
  let interview = false;
  let draft = false;
  let execute = false;

  for (const arg of args) {
    if (arg === '--quick') {
      quick = true;
    } else if (arg === '--interview') {
      interview = true;
    } else if (arg === '--draft') {
      draft = true;
    } else if (arg === '--execute') {
      execute = true;
    } else {
      positional.push(arg);
    }
  }

  return { quick, interview, draft, execute, positional };
}

/**
 * Separate user-only ambiguity from facts the agent can discover itself.
 * Questions are intentionally capped at three so planning converges in one
 * user turn. Repository facts never become questions here; they are probes for
 * research-check.
 */
export function gaugeIntent(goal, { forceInterview = false } = {}) {
  const text = String(goal || '').trim();
  const lower = text.toLowerCase();
  const gaps = [];
  const questions = [];
  const add = (kind, code, question, why) => {
    gaps.push({ kind, code, why });
    if (question && questions.length < 3) questions.push({ code, question });
  };

  const vagueOnly = text.split(/\s+/).length < 4
    && /^(개선|수정|정리|최적화|만들어|구현|fix|improve|optimize|refactor|build|update)/i.test(text);
  if (vagueOnly) add('intent_gap', 'scope', '어떤 대상과 사용자 흐름을 이번 작업 범위에 포함할까요?', 'scope changes the task graph');
  if (/(성능|빠르게|최적화|performance|faster|optimi[sz]e)/i.test(text)
      && !/(ms|초|s\b|%|p\d{2}|throughput|latency|기준|목표)/i.test(text)) {
    add('intent_gap', 'success_criteria', '완료를 판단할 성능 기준이나 측정 지표는 무엇인가요?', 'success criteria are user-owned');
  }
  if (/(삭제|폐기|drop|delete|purge|마이그레이션|migration|배포|deploy|public api|공개 api|schema)/i.test(lower)
      && !/(승인|허용|backward compatible|하위 호환|rollback|롤백)/i.test(lower)) {
    add('authority_gap', 'authority', '데이터·외부 contract 변경과 rollback 범위를 어디까지 승인할까요?', 'irreversible or external contract change');
  }
  if (/( 또는 |\bor\b|\bvs\b|어느|선택)/i.test(lower)) {
    // Implementation alternatives are agent-owned by default: inspect the
    // repository and choose by existing conventions. Only public behavior,
    // authority, scope, or success criteria justify another user turn.
    add('implementation_choice', 'choice', null, 'resolve from repository conventions unless it changes public behavior');
  }
  if (forceInterview && questions.length === 0) {
    add('intent_gap', 'refinement', '원하는 결과, 제외 범위, 완료 기준 중 더 구체화할 부분은 무엇인가요?', 'detailed interview was explicitly requested');
  }

  return {
    readiness: questions.length ? 'clarify' : 'ready',
    gaps,
    questions,
    fact_probes: ['repository_structure', 'existing_behavior', 'tests_and_conventions'],
  };
}

export async function cmdPlan(args) {
  const { quick, interview, draft, execute, positional } = parsePlanArgs(args);
  const goal = positional.join(' ');
  const project = resolveProject(null);

  if (!goal) {
    const taskData = readJSON(tasksPath(project));
    const stepData = readJSON(stepsPath(project));
    if (!taskData?.tasks?.length) {
      console.log('No plan yet. Use: /xm:build plan "목표를 설명하세요"');
      return;
    }
    taskList(project);
    if (stepData?.steps?.length) stepsStatus(project);
    return;
  }

  const manifest = readJSON(manifestPath(project));
  if (!getExplicitProject() && manifest?.goal && manifest.goal.trim() !== goal.trim()) {
    console.log(JSON.stringify({
      action: 'select-project',
      blocked: true,
      reason: 'explicit_goal_does_not_match_active_project',
      active_project: project,
      active_goal: manifest.goal,
      requested_goal: goal,
      next_action: 'pass --project <name> or initialize a new project',
    }, null, 2));
    process.exitCode = 2;
    return;
  }
  const requestedAction = execute ? 'build' : 'plan_only';
  const intentCheck = gaugeIntent(goal, { forceInterview: interview });
  const planState = savePlanIntent(project, {
    goal, requestedAction, intentCheck, forcedInterview: interview, draft,
  });
  // Deterministic research gauge (R2): the skill layer reads this to scale
  // Research (full/slim) or — ONLY at quick-eligible — suggest --quick via
  // AskUserQuestion. Gauge failure degrades to null (skill treats null as
  // full), never blocks planning.
  let researchSignal = null;
  if (!quick) {
    try { researchSignal = await gaugeResearch(goal); } catch { researchSignal = null; }
  }
  const output = {
    action: 'auto-plan',
    project,
    goal,
    requested_action: requestedAction,
    stop_after: requestedAction === 'plan_only' ? 'plan_bundle' : 'execute_complete',
    plan_state: planState.state,
    executable: planState.executable,
    intent_check: intentCheck,
    next_action: intentCheck.readiness === 'clarify'
      ? (draft ? 'produce_non_executable_draft' : 'ask_blocking_questions_once')
      : 'research_then_generate_plan',
    research_may_reopen_intent: true,
    quick,
    flow: quick ? 'quick' : 'full',
    skip_research: quick,
    research_signal: researchSignal,
    project_kind: manifest?.project_kind || 'brownfield',
    current_phase: PHASES.find(p => p.id === manifest?.current_phase)?.name,
    prd_writer: prdWriterSpec(),
    existing_tasks: readJSON(tasksPath(project))?.tasks?.length || 0,
    templates_available: existsSync(templatesDir())
      ? readdirSync(join(templatesDir(), 'tasks')).map(f => f.replace('.md', ''))
      : [],
    has_context: existsSync(join(contextDir(project), 'CONTEXT.md')),
    has_requirements: existsSync(join(contextDir(project), 'REQUIREMENTS.md')),
    context_summary: existsSync(join(contextDir(project), 'CONTEXT.md'))
      ? readMD(join(contextDir(project), 'CONTEXT.md'))?.slice(0, 2000)
      : null,
    requirements_summary: existsSync(join(contextDir(project), 'REQUIREMENTS.md'))
      ? readMD(join(contextDir(project), 'REQUIREMENTS.md'))?.slice(0, 2000)
      : null,
    roadmap_summary: existsSync(join(contextDir(project), 'ROADMAP.md'))
      ? readMD(join(contextDir(project), 'ROADMAP.md'))?.slice(0, 2000)
      : null,
  };

  console.log(JSON.stringify(output, null, 2));
}

// ── cmdPlanCheck ────────────────────────────────────────────────────

// Deterministic PRD structural check keyed to the PRD template's own Gate rule
// (references/prd-template.md:23): "If any [A*, low] or Q* status: blocking
// remains unresolved, Plan phase MUST halt." Only these unambiguous markers
// block; missing top-level sections are warnings. Pure function over PRD text.
// A delta PRD is the lightweight tier used by Quick Mode: Goal + Success Criteria
// + Acceptance Criteria only, marked `<!-- prd-tier: delta -->` and (deliberately)
// carrying NO template-version marker, so the diagram gate stays a warning instead
// of blocking. It still satisfies the Execute-entry wall (a PRD exists) and feeds
// the AC parser, traceability, and drift baseline. `full` is everything else.
export function prdTier(prdText) {
  return /<!--\s*prd-tier:\s*delta\s*-->/i.test(prdText || '') ? 'delta' : 'full';
}

export function prdBlockingFindings(prdText) {
  const blocking = [];
  const warnings = [];
  if (!prdText) return { blocking, warnings };

  for (const raw of prdText.split('\n')) {
    const line = raw.trim();
    if (/\[A\d+,\s*low\]/i.test(line)) {
      blocking.push(`Low-confidence assumption unresolved — ${line.slice(0, 120)}`);
    }
    // "→ Status: blocking | answered" is the template's unfilled menu — only a
    // genuinely-unresolved "blocking" (without "answered") blocks.
    if (/status:\s*blocking/i.test(line) && !/answered/i.test(line)) {
      blocking.push(`Open question still blocking — ${line.slice(0, 120)}`);
    }
  }
  if (!/^##\s*0\.\s*Assumptions/im.test(prdText)) warnings.push('Section 0 (Assumptions & Open Questions) is missing');
  if (!/^##\s*12\.\s*Acceptance Criteria/im.test(prdText)) warnings.push('Section 12 (Acceptance Criteria) is missing');

  // ── Diagram gate (R4/R5/R12) ──────────────────────────────────────
  const lines = prdText.split('\n');

  // Section 8 (Architecture): missing diagram blocks ONLY for PRDs stamped
  // at/above PRD_TEMPLATE_VERSION (R12 retroactive policy) — pre-existing
  // PRDs (no marker, or an older version) get a warning instead, never a
  // hard block on re-entry.
  const section8 = extractSectionScope(lines, 8);
  if (!sectionHasDiagram(section8)) {
    const versionMatch = prdText.match(VERSION_MARKER_RE);
    const version = versionMatch ? parseInt(versionMatch[1], 10) : 0;
    const isNewTemplate = versionMatch != null && version >= PRD_TEMPLATE_VERSION;
    const msg = section8
      ? 'Section 8 (Architecture) has no diagram — add "■ Diagram:" + a fenced block, a box-drawing diagram, or a mermaid diagram'
      : 'Section 8 (Architecture) is missing';
    if (isNewTemplate) blocking.push(msg);
    else warnings.push(msg);
  }

  // Section 9 (Key Scenarios): a >=3-step scenario without any diagram is a
  // warning, regardless of template version — this never blocks. Reuses
  // sectionHasDiagram (marker/auxBox/auxMermaid) rather than "any fence
  // exists" — an unrelated example fence (e.g. ```typescript) or an empty
  // fence must not suppress this warning.
  const section9 = extractSectionScope(lines, 9);
  if (section9 && maxNumberedRun(section9) >= 3 && !sectionHasDiagram(section9)) {
    warnings.push('Section 9 has ≥3-step scenarios but no sequence diagram');
  }

  // Section 10 (Data Flow / Data Model): a >=3-hop trace without any diagram
  // is a warning, regardless of template version. Same sectionHasDiagram reuse.
  const section10 = extractSectionScope(lines, 10);
  if (section10 && maxArrowHopsPerLine(section10) >= 3 && !sectionHasDiagram(section10)) {
    warnings.push('Section 10 has a ≥3-hop Data Flow Trace but no diagram');
  }

  if (!/^##\s*At a Glance/im.test(prdText)) {
    warnings.push('"At a Glance" section is missing');
  }

  return { blocking, warnings };
}

export function cmdPrdCheck(args) {
  const project = resolveProject(null);
  const json = args.includes('--json');
  const prd = readMD(prdPath(project));

  if (!prd) {
    if (json) console.log(JSON.stringify({ project, exists: false, blocked: true, blocking: ['PRD not found'], warnings: [] }, null, 2));
    else console.error('❌ No PRD found. Run: /xm:build plan');
    exitFail(1);
    return;
  }

  const { blocking, warnings } = prdBlockingFindings(prd);
  const tier = prdTier(prd);
  if (json) {
    console.log(JSON.stringify({ project, exists: true, tier, blocked: blocking.length > 0, blocking, warnings }, null, 2));
  } else {
    console.log(`\n${C.bold}📋 PRD Check${C.reset}${tier === 'delta' ? ` ${C.dim}(delta tier — lightweight; diagram/structure gaps are expected warnings)${C.reset}` : ''}\n`);
    if (!blocking.length && !warnings.length) console.log(`  ${C.green}✓ No blocking items or structural gaps.${C.reset}`);
    for (const b of blocking) console.log(`  ${C.red}✗ ${b}${C.reset}`);
    for (const w of warnings) console.log(`  ${C.yellow}⚠ ${w}${C.reset}`);
    console.log('');
  }
  if (blocking.length) exitFail(1);
}

export function cmdPlanCheck(args) {
  const strict = args.includes('--strict');
  const project = resolveProject(null);
  const taskData = readJSON(tasksPath(project));
  const requirements = readMD(join(contextDir(project), 'REQUIREMENTS.md'));
  const context = readMD(join(contextDir(project), 'CONTEXT.md'));

  const checks = [];
  const tasks = taskData?.tasks || [];

  // 1. Atomicity — a "large" task exceeds the one-session unit, so each one is a
  // split candidate regardless of dependencies. Smaller tasks give the executor
  // clearer scope and make parallelism safer.
  for (const t of tasks) {
    if (t.size === 'large') {
      checks.push({ dim: 'atomicity', level: 'warn', task: t.id, msg: `Task "${t.name}" is large (>1 session) — split into 2+ smaller tasks` });
    }
  }
  // G4: Flag excessive large tasks in aggregate too
  const largeTasks = tasks.filter(t => t.size === 'large');
  if (largeTasks.length >= 3) {
    checks.push({ dim: 'atomicity', level: 'warn', msg: `${largeTasks.length} large tasks — plan is too coarse; decompose: ${largeTasks.map(t => t.id).join(', ')}` });
  }

  // 2. Dependencies
  const ids = new Set(tasks.map(t => t.id));
  for (const t of tasks) {
    for (const dep of (t.depends_on || [])) {
      if (!ids.has(dep)) {
        checks.push({ dim: 'dependencies', level: 'error', task: t.id, msg: `Unknown dependency "${dep}"` });
      }
    }
  }

  // 3. Cycle detection
  try {
    computeSteps(tasks);
  } catch (e) {
    checks.push({ dim: 'dependencies', level: 'error', msg: e.message });
  }

  // 4. Requirements coverage
  if (requirements) {
    const reqIds = [...requirements.matchAll(/^-\s*\[R(\d+)\]/gm)].map(m => `R${m[1]}`);
    if (reqIds.length > 0) {
      // G2: Search task names AND done_criteria for R# references
      const taskText = tasks.map(t => [t.name, ...(t.done_criteria || [])].join(' ')).join(' ');
      for (const rid of reqIds) {
        if (!taskText.includes(rid)) {
          checks.push({ dim: 'coverage', level: strict ? 'error' : 'warn', msg: `Requirement ${rid} not referenced in any task name or done_criteria` });
        }
      }
    }
  }

  // 5. Size distribution
  const sizes = { small: 0, medium: 0, large: 0 };
  for (const t of tasks) sizes[t.size || 'medium']++;
  if (tasks.length > 0 && sizes.large / tasks.length > 0.5) {
    checks.push({ dim: 'granularity', level: 'warn', msg: `>50% tasks are large — consider decomposing further` });
  }
  // G6: Upper bound — too many tasks is also a smell
  if (tasks.length > 15) {
    checks.push({ dim: 'granularity', level: 'warn', msg: `${tasks.length} tasks — plan may be over-decomposed. Consider merging related small tasks` });
  }

  // 6. Task count sanity
  if (tasks.length === 0) {
    checks.push({ dim: 'completeness', level: 'error', msg: 'No tasks defined' });
  } else if (tasks.length < 3) {
    checks.push({ dim: 'completeness', level: 'warn', msg: 'Very few tasks — plan may be too coarse' });
  }

  // 7. Context fit
  if (!context) {
    checks.push({ dim: 'context', level: 'warn', msg: 'No CONTEXT.md found — run discuss first for better plans' });
  }

  // 8. Naming
  // G7: Extended verb list
  const verbPattern = /^(add|create|implement|design|setup|configure|write|build|test|fix|update|remove|refactor|migrate|deploy|integrate|validate|analyze|research|review|document|optimize|enable|extract|scaffold|evaluate|generate|define|extend|replace|monitor|provision|secure|audit|prepare|ensure|initialize|bootstrap|wire|connect|expose|handle)/i;
  for (const t of tasks) {
    if (!verbPattern.test(t.name)) {
      checks.push({ dim: 'naming', level: 'info', task: t.id, msg: `"${t.name}" — consider starting with a verb` });
    }
  }

  // 9. Tech-leakage
  const TECH_TERMS = 'React|Vue|Angular|Next\\.?js|Express|FastAPI|Django|Flask|Spring|Rails|Laravel|PostgreSQL|MySQL|MongoDB|Redis|Kafka|RabbitMQ|Docker|Kubernetes|AWS|GCP|Azure|Vercel|Supabase|Firebase|SQLite|GraphQL|gRPC|Prisma|Drizzle|TypeORM|Sequelize|Zod|Joi|JWT|OAuth|Tailwind|Vite|Webpack|Rollup|esbuild|Playwright|Jest|Vitest|pytest|JUnit|SwiftUI|UIKit|Jetpack\\s*Compose|Flutter|Dart|Kotlin|Swift|Go|Rust|Python|TypeScript|Node\\.?js|Deno|Bun';
  const declaredTechs = new Set();
  if (context) {
    const techRe = new RegExp(`\\b(${TECH_TERMS})\\b`, 'gi');
    const techMatches = context.match(techRe) || [];
    for (const m of techMatches) declaredTechs.add(m.toLowerCase());
  }
  const prd = readMD(prdPath(project));
  if (prd) {
    const constraintSection = prd.match(/## 3\. Constraints[\s\S]*?(?=## \d|$)/);
    if (constraintSection) {
      const techRe = new RegExp(`\\b(${TECH_TERMS})\\b`, 'gi');
      const prdTechs = constraintSection[0].match(techRe) || [];
      for (const m of prdTechs) declaredTechs.add(m.toLowerCase());
    }
  }
  for (const t of tasks) {
    const techRe = new RegExp(`\\b(${TECH_TERMS})\\b`, 'gi');
    const found = t.name.match(techRe) || [];
    for (const tech of found) {
      if (!declaredTechs.has(tech.toLowerCase())) {
        checks.push({ dim: 'tech-leakage', level: 'warn', task: t.id, msg: `"${tech}" is not declared in CONTEXT.md or PRD Constraints — consider using intent instead of implementation` });
      }
    }
  }

  // 10. Scope clarity — done_criteria 미설정 경고
  for (const t of tasks) {
    if (!t.done_criteria?.length) {
      checks.push({ dim: 'scope-clarity', level: 'warn', task: t.id, msg: `"${t.name}" has no done_criteria — completion is ambiguous. Run: tasks done-criteria` });
    }
  }

  // 10b. Description presence — a task with no description AND no [R#] ref is
  // unexplained: the executor can only guess intent from the one-line name.
  for (const t of tasks) {
    const hasReqRef = /\[R\d+\]/i.test(t.name);
    if (!t.description?.trim() && !hasReqRef) {
      checks.push({ dim: 'scope-clarity', level: 'info', task: t.id, msg: `"${t.name}" has no description and no [R#] ref — intent is implicit. Add: tasks update ${t.id} --desc "what + why"` });
    }
  }

  // G1: Scope guard — check task names against PRD "Out of Scope" items
  const prdForScope = prd;
  if (prdForScope) {
    const oosMatch = prdForScope.match(/## 6[\.\s]*Out of Scope([\s\S]*?)(?=\n## \d|$)/i);
    if (oosMatch) {
      const stopWords = new Set(['that','this','will','with','from','have','should','would','could','also','only','more','than','each','been','were','does','into','other','their','about','being','after','before','these','those','through','between','first','which','where','while','under','since','during','without','within','until','above','below','along','across','around','against','among','beyond','during','except','inside','outside','toward','upon','using','including']);
      const oosKeywords = (oosMatch[1].match(/\b\w{4,}\b/g) || []).map(w => w.toLowerCase()).filter(w => !stopWords.has(w));
      if (oosKeywords.length > 0) {
        for (const t of tasks) {
          const nameWords = t.name.toLowerCase().split(/\s+/);
          const hits = oosKeywords.filter(kw => nameWords.includes(kw));
          if (hits.length >= 2) {
            checks.push({ dim: 'scope-clarity', level: 'warn', task: t.id, msg: `"${t.name}" may overlap with Out of Scope (matched: ${hits.join(', ')})` });
          }
        }
      }
    }
  }

  // 11. Risk ordering — G3: Use actual DAG step position instead of array index
  try {
    const steps = computeSteps(tasks);
    const totalSteps = steps.length;
    if (totalSteps > 1) {
      for (const t of tasks) {
        if (t.size === 'large' && !t.depends_on?.length) {
          const stepIdx = steps.findIndex(s => s.includes(t.id));
          if (stepIdx > totalSteps / 2) {
            checks.push({ dim: 'risk-ordering', level: 'warn', task: t.id, msg: `Large root task "${t.name}" is in DAG step ${stepIdx + 1}/${totalSteps} — consider front-loading high-risk work` });
          }
        }
      }
    }
  } catch (e) { /* cycle already caught in deps check */ }

  // 12. Expected files — the worktree pipeline batches parallel-safe tasks by
  // comparing per-task expected_files. A task with no/empty list is excluded from
  // parallel batching (runs sequentially), so this is a warn, never an error —
  // existing plans without the field must not fail plan-check.
  for (const t of tasks) {
    const ef = t.expected_files;
    if (ef === undefined || ef === null) {
      checks.push({ dim: 'expected-files', level: 'warn', task: t.id, msg: `"${t.name}" has no expected_files — excluded from parallel worktree batching (runs sequentially). Add: tasks update ${t.id} --expected-files "a.mjs,b.mjs"` });
      continue;
    }
    if (!Array.isArray(ef)) {
      checks.push({ dim: 'expected-files', level: 'warn', task: t.id, msg: `expected_files must be an array of relative paths` });
      continue;
    }
    if (ef.length === 0) {
      checks.push({ dim: 'expected-files', level: 'warn', task: t.id, msg: `"${t.name}" has empty expected_files — excluded from parallel worktree batching (runs sequentially)` });
      continue;
    }
    for (const f of ef) {
      if (typeof f !== 'string' || !f.trim()) {
        checks.push({ dim: 'expected-files', level: 'warn', task: t.id, msg: `expected_files contains a non-string or empty entry` });
      } else if (f.startsWith('/') || /^[A-Za-z]:[\\/]/.test(f)) {
        checks.push({ dim: 'expected-files', level: 'warn', task: t.id, msg: `expected_files entry "${f}" is an absolute path — use a project-relative path` });
      }
    }
  }

  // 13. Failure-mode coverage — pathological/adversarial inputs are the failure
  // class plans leave implicit. The PRD-section check stays warn (upstream nudge;
  // pre-existing PRDs must not fail wholesale), but the PER-TASK check is
  // MODEL-AWARE: the phase-routing experiment (docs/phase-model-routing-experiment.md)
  // measured 0/3 pathological-input survival for sonnet execution WITHOUT
  // failure-mode enumeration vs 2/3 for opus — so a risk-domain task that will
  // execute on sonnet-or-below without stress done_criteria is an ERROR (blocks
  // the plan gate), while opus/inherit executions keep the probabilistic cushion
  // and stay warn. Escape valve: an explicit `none — <rationale>` in done_criteria
  // waives the check (the §7.5 convention), so a false-positive regex hit is a
  // one-line fix, never a dead end.
  if (prd && !/##\s*(?:7\.5\.?)?\s*Failure Modes/i.test(prd)) {
    checks.push({ dim: 'failure-mode-coverage', level: 'warn', msg: `PRD has no Failure Modes section — pathological/adversarial inputs are unenumerated; implementers will not defend against them` });
  }
  // Word-start anchored (\b) to cut substring false-positives — "mismatch",
  // "sparse", "mainstream", "deadlock" no longer trip the parser/cache/stream/lock
  // stems. An occasional false positive is waivable via `none — <rationale>`.
  const RISK_DOMAIN_RE = /\b(pars|match|regex|cach|concurren|lock|queue|auth|crypto|input|stream|proto)/i;
  const STRESS_RE = /스트레스|stress|pathological|adversarial|병적|timeout|hang|무한/i;
  const WAIVER_RE = /\bnone\s*[—–-]/i; // "none — <why this task has no failure modes>"
  const LOW_TIER = new Set(['haiku', 'sonnet']);
  const fmCfg = loadSharedConfig();
  for (const t of tasks) {
    const haystack = `${t.name} ${t.description || ''}`;
    if (RISK_DOMAIN_RE.test(haystack)) {
      const dc = (t.done_criteria || []).join(' ');
      if (STRESS_RE.test(dc)) continue;
      if (WAIVER_RE.test(dc)) continue; // explicitly waived with rationale
      const role = t.role || (t.size === 'large' ? 'deep-executor' : 'executor');
      const model = getModelForRole(role, t.size, fmCfg);
      if (LOW_TIER.has(model)) {
        checks.push({ dim: 'failure-mode-coverage', level: 'error', task: t.id, msg: `"${t.name}" touches a risk domain and executes on ${model} — measured 0/3 pathological-input survival without failure-mode enumeration (docs/phase-model-routing-experiment.md). Add stress/adversarial done_criteria (tasks done-criteria), or waive with done_criteria "none — <rationale>", or route the task to a higher tier` });
      } else {
        checks.push({ dim: 'failure-mode-coverage', level: 'warn', task: t.id, msg: `"${t.name}" touches a risk domain (parser/matcher/cache/concurrency/auth/input) but has no stress/adversarial done_criteria — executes on ${model} (probabilistic cushion); add a Failure Modes section, then run: tasks done-criteria` });
      }
    }
  }

  // 14. Delegation contract — a task headed for delegation (worktree
  // parallel-safe via expected_files, or executing on a low tier) without an
  // interface_contract leaves the delegate free to renegotiate signatures and
  // invariants mid-task. Warn-only: the contract is the delegation interface,
  // not a universal requirement.
  for (const t of tasks) {
    if (t.interface_contract) continue;
    const role = t.role || (t.size === 'large' ? 'deep-executor' : 'executor');
    const model = getModelForRole(role, t.size, fmCfg);
    const parallelSafe = Array.isArray(t.expected_files) && t.expected_files.length > 0;
    if (parallelSafe || LOW_TIER.has(model)) {
      const why = parallelSafe ? 'worktree parallel-safe (expected_files set)' : `executes on ${model}`;
      checks.push({ dim: 'delegation-contract', level: 'warn', task: t.id, msg: `"${t.name}" is delegation-shaped (${why}) but has no interface_contract — add: tasks update ${t.id} --interface-contract "시그니처·불변식 2-3줄"` });
    }
  }

  // 15. Review-group order — groups are sequential review boundaries. An
  // earlier group may not depend on a later one or execution would deadlock
  // while the later group is intentionally held behind the earlier review.
  const groupOrder = new Map();
  for (const t of tasks) {
    const group = taskReviewGroup(t);
    if (!groupOrder.has(group)) groupOrder.set(group, groupOrder.size);
  }
  for (const t of tasks) {
    const taskRank = groupOrder.get(taskReviewGroup(t));
    for (const depId of (t.depends_on || [])) {
      const dep = tasks.find((candidate) => candidate.id === depId);
      if (dep && groupOrder.get(taskReviewGroup(dep)) > taskRank) {
        checks.push({
          dim: 'review-groups', level: 'error', task: t.id,
          msg: `Earlier review group "${taskReviewGroup(t)}" depends on later group "${taskReviewGroup(dep)}" via ${depId}`,
        });
      }
    }
  }

  // Output
  const errors = checks.filter(c => c.level === 'error');
  const warns = checks.filter(c => c.level === 'warn');

  console.log(`\n${C.bold}Plan Check — ${tasks.length} tasks${C.reset}\n`);

  const dims = ['atomicity', 'dependencies', 'coverage', 'granularity', 'completeness', 'context', 'naming', 'tech-leakage', 'scope-clarity', 'risk-ordering', 'expected-files', 'failure-mode-coverage', 'delegation-contract', 'review-groups', 'overall'];
  for (const dim of dims) {
    const dimChecks = checks.filter(c => c.dim === dim);
    if (dimChecks.length === 0) {
      console.log(`  [pass] ${dim}`);
    } else {
      const hasError = dimChecks.some(c => c.level === 'error');
      const icon = hasError ? '[FAIL]' : '[warn]';
      console.log(`  ${icon} ${dim}`);
      for (const c of dimChecks) {
        const lvl = c.level === 'error' ? C.red : c.level === 'warn' ? C.yellow : C.dim;
        console.log(`     ${lvl}${c.task ? `[${c.task}] ` : ''}${c.msg}${C.reset}`);
      }
    }
  }

  console.log('');
  if (errors.length > 0) {
    console.log(`  ${C.red}${errors.length} errors — fix before proceeding${C.reset}`);
  } else if (warns.length > 0) {
    console.log(`  ${C.yellow}${warns.length} warnings — review recommended${C.reset}`);
  } else {
    console.log(`  ${C.green}All checks passed${C.reset}`);
  }

  writeJSON(join(phaseDir(project, '02-plan'), 'plan-check.json'), {
    timestamp: new Date().toISOString(),
    tasks_count: tasks.length,
    checks,
    passed: errors.length === 0,
  });
  markPlanReady(project, errors.length === 0);

  console.log('');
}

// ── cmdDiscuss ──────────────────────────────────────────────────────

export function cmdDiscuss(args) {
  const { opts, positional } = parseOptions(args);
  const project = resolveProject(null);
  const manifest = readJSON(manifestPath(project));
  const mode = opts.mode || 'interview';
  const round = parseInt(opts.round ?? '1');
  const maxRounds = parseInt(opts['max-rounds'] || '3');

  const phaseName = PHASES.find(p => p.id === manifest.current_phase)?.name;
  const projectKind = manifest.project_kind || 'brownfield';

  const output = {
    action: 'discuss',
    project,
    mode,
    round,
    max_rounds: maxRounds,
    goal: manifest.display_name || project,
    current_phase: phaseName,
    project_kind: projectKind,
    existing_context: existsSync(join(contextDir(project), 'CONTEXT.md'))
      ? readMD(join(contextDir(project), 'CONTEXT.md'))?.slice(0, 500)
      : null,
  };

  if (mode === 'interview') {
    // round > 1 naturally excludes round 0 from this prevPath auto-load, so
    // Round 0's isolated filename (below) never feeds into the r{n} chain.
    const prevPath = join(phaseDir(project, '01-research'), `discuss-interview-r${round - 1}.json`);
    if (round > 1 && existsSync(prevPath)) {
      output.previous_round = readJSON(prevPath);
    }
    output.completeness_dimensions = [
      'functional_requirements', 'non_functional_requirements', 'constraints',
      'error_handling', 'security', 'performance', 'data_model', 'integrations',
    ];
    // Round 0 (greenfield-only, pre-interview) saves to a name isolated from
    // the discuss-interview-r{n} chain — round 1's prevPath lookup above only
    // ever looks at r{round-1}, so "discuss-round0.json" is never mistaken
    // for r0 in that chain.
    const round0Path = join(phaseDir(project, '01-research'), 'discuss-round0.json');
    output.save_path = round === 0
      ? round0Path
      : join(phaseDir(project, '01-research'), `discuss-interview-r${round}.json`);
    if (projectKind === 'greenfield') {
      output.round0_pending = !existsSync(round0Path);
    }
  } else if (mode === 'validate') {
    output.requirements = existsSync(join(contextDir(project), 'REQUIREMENTS.md'))
      ? readMD(join(contextDir(project), 'REQUIREMENTS.md')) : null;
    output.roadmap = existsSync(join(contextDir(project), 'ROADMAP.md'))
      ? readMD(join(contextDir(project), 'ROADMAP.md')) : null;
    output.context_full = existsSync(join(contextDir(project), 'CONTEXT.md'))
      ? readMD(join(contextDir(project), 'CONTEXT.md')) : null;
  } else if (mode === 'critique') {
    const path = prdPath(project);
    output.prd = existsSync(path) ? readMD(path) : null;
    output.tasks = readJSON(tasksPath(project))?.tasks || [];
    output.requirements = existsSync(join(contextDir(project), 'REQUIREMENTS.md'))
      ? readMD(join(contextDir(project), 'REQUIREMENTS.md')) : null;
    output.plan_check = readJSON(join(phaseDir(project, '02-plan'), 'plan-check.json'));
    const prevCritiquePath = join(phaseDir(project, '02-plan'), `discuss-critique-r${round - 1}.json`);
    if (round > 1 && existsSync(prevCritiquePath)) {
      output.previous_round = readJSON(prevCritiquePath);
    }
  } else if (mode === 'adapt') {
    output.tasks = readJSON(tasksPath(project))?.tasks || [];
    output.steps = readJSON(join(projectDir(project), 'steps.json'));
    const progressPath = join(phaseDir(project, '03-execute'), 'progress.json');
    output.progress = existsSync(progressPath) ? readJSON(progressPath) : null;
    output.topic = positional.join(' ') || null;
  }

  const discussDir = mode === 'critique'
    ? phaseDir(project, '02-plan')
    : mode === 'adapt'
      ? phaseDir(project, '03-execute')
      : phaseDir(project, '01-research');
  const resultPath = join(discussDir, `discuss-${mode}.json`);
  if (existsSync(resultPath)) {
    output.previous_result = readJSON(resultPath);
  }

  console.log(JSON.stringify(output, null, 2));
}

// ── cmdResearch ─────────────────────────────────────────────────────

export function cmdResearch(args) {
  const { opts, positional } = parseOptions(args);
  const project = resolveProject(null);
  const manifest = readJSON(manifestPath(project));
  const goal = positional.join(' ') || manifest.display_name || project;

  const projectKind = manifest.project_kind || 'brownfield';
  const isGreenfield = projectKind === 'greenfield';
  // Greenfield has no existing stack/features to research — swap toward
  // landscape scan + user-scenario framing instead.
  const perspectives = isGreenfield
    ? ['landscape', 'user-scenarios', 'architecture', 'pitfalls']
    : ['stack', 'features', 'architecture', 'pitfalls'];
  const sharedCfg = loadSharedConfig();
  const model = opts.model || getModelForRole('researcher', 'medium', sharedCfg);

  const output = {
    action: 'research',
    project,
    goal,
    agents: parseInt(opts.agents || String(getAgentCount())),
    perspectives,
    model,
    project_kind: projectKind,
    suggest_probe: isGreenfield,
    agents_spec: perspectives.map(p => {
      const spec = { perspective: p, role: 'researcher', model, ...vendorModelFields(model, sharedCfg) };
      if (isGreenfield && p === 'landscape') spec.web = true;
      return spec;
    }),
    existing_requirements: existsSync(join(contextDir(project), 'REQUIREMENTS.md'))
      ? readMD(join(contextDir(project), 'REQUIREMENTS.md'))?.slice(0, 500)
      : null,
    existing_context: existsSync(join(contextDir(project), 'CONTEXT.md'))
      ? readMD(join(contextDir(project), 'CONTEXT.md'))?.slice(0, 500)
      : null,
    notes_path: join(phaseDir(project, '01-research'), 'notes.md'),
    per_agent_save_command: 'x-build save research-notes --agent <perspective> --content "<raw-agent-output>"',
    mandatory_steps: [
      'Spawn one agent per perspective in parallel.',
      'When each agent returns, PRINT its full output to the user.',
      'Then call: x-build save research-notes --agent <perspective> --content "..." — persists raw output to notes_path.',
      'After all agents complete, synthesize ROADMAP and PRINT it before x-build save roadmap.',
      'Never advance the phase until the user has seen every raw agent output AND the synthesized ROADMAP.',
    ],
  };

  console.log(JSON.stringify(output, null, 2));
}

// ── cmdPrdGate ─────────────────────────────────────────────────

export function cmdPrdGate(args) {
  const { opts } = parseOptions(args);
  const project = resolveProject(null);
  const manifest = readJSON(manifestPath(project));

  const prd = readMD(prdPath(project));
  if (!prd) {
    console.error('❌ No PRD.md found. Create a PRD first during the Plan phase.');
    exitFail(1);
  }

  const requirements = readMD(join(contextDir(project), 'REQUIREMENTS.md'));
  const context = readMD(join(contextDir(project), 'CONTEXT.md'));
  const taskData = readJSON(tasksPath(project));
  const planCheck = readJSON(join(phaseDir(project, '02-plan'), 'plan-check.json'));
  const threshold = parseInt(opts.threshold || '7');

  const rubric = [
    { criterion: 'completeness', weight: 0.25, description: 'All requirements are addressed with acceptance criteria' },
    { criterion: 'feasibility', weight: 0.20, description: 'Tasks are realistic given constraints and tech stack' },
    { criterion: 'atomicity', weight: 0.20, description: 'Tasks are properly decomposed and independently executable' },
    { criterion: 'clarity', weight: 0.20, description: 'PRD is unambiguous — no room for misinterpretation' },
    { criterion: 'risk-coverage', weight: 0.15, description: 'Edge cases, failure modes (incl. pathological/adversarial inputs) are enumerated per requirement with verification' },
  ];

  const output = {
    action: 'prd-gate',
    project,
    goal: manifest.display_name || project,
    threshold,
    judges: parseInt(opts.judges || '3'),
    rubric,
    prd,
    requirements: requirements?.slice(0, 3000) || null,
    context_summary: context?.slice(0, 1500) || null,
    tasks_count: taskData?.tasks?.length || 0,
    plan_check_passed: planCheck?.passed ?? null,
    result_path: join(phaseDir(project, '02-plan'), 'prd-gate.json'),
  };

  console.log(JSON.stringify(output, null, 2));
}

// ── cmdConsensus ───────────────────────────────────────────────

export function cmdConsensus(args) {
  const { opts } = parseOptions(args);
  const project = resolveProject(null);
  const manifest = readJSON(manifestPath(project));

  const prd = readMD(prdPath(project));
  if (!prd) {
    console.error('❌ No PRD.md found. Create a PRD first during the Plan phase.');
    exitFail(1);
  }

  const requirements = readMD(join(contextDir(project), 'REQUIREMENTS.md'));
  const round = parseInt(opts.round || '1');
  const maxRounds = parseInt(opts['max-rounds'] || '3');

  const prevPath = join(phaseDir(project, '02-plan'), `consensus-r${round - 1}.json`);
  const previousRound = (round > 1 && existsSync(prevPath)) ? readJSON(prevPath) : null;

  const sharedCfg = loadSharedConfig();
  // Roles + their review focus; model (and the additive vendor fields) are
  // resolved per role below so each consensus agent carries the same
  // model_vendor / model_by_vendor contract the execution plan emits.
  const consensusRoles = [
    {
      role: 'architect',
      prompt_focus: [
        'Module boundaries are clear',
        'Interfaces and dependencies are defined',
        'No missing architectural decisions',
      ],
    },
    {
      role: 'critic',
      prompt_focus: [
        'No missing requirements or scenarios',
        'No contradictions between sections',
        'Risks are not underestimated',
        'Per-requirement failure modes (pathological inputs, unbounded loops, performance blow-ups) are enumerated — flag any requirement missing them',
      ],
    },
    {
      role: 'planner',
      prompt_focus: [
        'Structure is decomposable into tasks',
        'Success criteria are measurable',
        'Timeline and cost are realistic',
      ],
    },
    {
      role: 'security',
      prompt_focus: [
        'Security requirements are not missing',
        'Risk mitigations are concrete and actionable',
        'Sensitive data handling is specified',
        'Adversarial inputs and resource-exhaustion failure modes (e.g. ReDoS-class) are specified with verification',
      ],
    },
  ];
  const agents = consensusRoles.map(({ role, prompt_focus }) => {
    const model = getModelForRole(role, 'medium', sharedCfg);
    return { role, model, ...vendorModelFields(model, sharedCfg), prompt_focus };
  });

  const output = {
    action: 'consensus',
    project,
    goal: manifest.display_name || project,
    round,
    max_rounds: maxRounds,
    agents,
    prd,
    requirements: requirements?.slice(0, 3000) || null,
    previous_round: previousRound,
    result_path: join(phaseDir(project, '02-plan'), `consensus-r${round}.json`),
  };

  console.log(JSON.stringify(output, null, 2));
}

// ── cmdForecast ─────────────────────────────────────────────────────

// `x-build roi [--by model|role|strategy] [--json]` — quality earned per dollar, from
// MEASURED actuals only. Answers "which model earns its spend" and suggests a
// model_overrides change — but only when the data is calibrated (빅뱃1). Never guesses
// from estimated cost or the default 1.0 quality, and never writes config itself.
export function cmdRoi(args) {
  const { opts } = parseOptions(args);
  const dim = ['model', 'role', 'strategy'].includes(opts.by) ? opts.by : 'model';
  const json = args.includes('--json');
  const rows = readTaskMetrics();
  const stats = aggregateRoi(rows, dim);
  const suggestion = roiSuggestion(stats);
  const calibrated = stats.filter((s) => s.calibrated);

  if (json) {
    console.log(JSON.stringify({ by: dim, min_samples: ROI_MIN_SAMPLES, models: stats, suggestion, calibrated: calibrated.length }, null, 2));
    return;
  }

  console.log(`\n${C.bold}💵 ROI — quality per dollar${C.reset} ${C.dim}(by ${dim}; ≥${ROI_MIN_SAMPLES} measured+scored tasks to calibrate)${C.reset}\n`);
  if (!stats.length) {
    console.log(`  ${C.dim}No task metrics yet. ROI accrues as tasks report real cost + score:${C.reset}`);
    console.log(`  ${C.dim}  tasks update <id> --status completed --tokens-in N --tokens-out M --score S${C.reset}\n`);
    return;
  }
  for (const s of stats) {
    if (s.calibrated) {
      console.log(`  ${s.key.padEnd(12)} ${C.green}${s.score_per_usd}${C.reset} score/$  ${C.dim}(q ${s.avg_quality} ÷ $${s.avg_cost_usd}, n=${s.calibrated_samples})${C.reset}`);
    } else {
      console.log(`  ${s.key.padEnd(12)} ${C.dim}estimate-only — ${s.calibrated_samples}/${ROI_MIN_SAMPLES} calibrated of ${s.tasks} task(s)${C.reset}`);
    }
  }
  console.log('');
  if (suggestion) {
    console.log(`  ${C.yellow}Suggestion:${C.reset} ${suggestion.best} earns ${suggestion.ratio}× the score/$ of ${suggestion.worst}.`);
    console.log(`  ${C.dim}Consider: /xm config set model_overrides '{"<role>": "${suggestion.best}"}' — your call, not auto-applied.${C.reset}\n`);
  } else if (calibrated.length < 2) {
    console.log(`  ${C.dim}No routing suggestion: need ≥2 calibrated ${dim}s. Record actual cost + scores to unlock.${C.reset}\n`);
  } else {
    console.log(`  ${C.dim}No routing suggestion: the calibrated ${dim}s are within ${1.3}× score/$ of each other — no clear winner.${C.reset}\n`);
  }
}

export function cmdForecast(args) {
  // `forecast update` re-aggregates measured token actuals from the metrics log
  // so subsequent forecasts price from ground truth instead of static estimates.
  if (args[0] === 'update') return cmdForecastUpdate();

  const project = resolveProject(null);
  const taskData = readJSON(tasksPath(project));
  const config = loadConfig();
  const defaultModel = config.models?.executor || 'sonnet';

  if (!taskData?.tasks?.length) {
    console.log('No tasks to forecast. Run: x-build tasks add <name>');
    return;
  }

  console.log(`\n${C.bold}💰 Cost Forecast${C.reset} ${C.dim}(model: ${defaultModel})${C.reset}\n`);

  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;

  const sharedCfg = loadSharedConfig();
  for (const task of taskData.tasks) {
    if (task.status === TASK_STATES.COMPLETED || task.status === TASK_STATES.CANCELLED) continue;

    const role = task.role || (task.size === 'large' ? 'deep-executor' : 'executor');
    const model = getModelForRole(role, task.size, sharedCfg);
    const est = estimateTaskCost(task, model);
    totalCost += est.cost_usd;
    totalInput += est.input_tokens;
    totalOutput += est.output_tokens;

    const costStr = `$${est.cost_usd.toFixed(3)}`;
    const confIcon = est.confidence === 'high' ? '' : est.confidence === 'medium' ? ' ~' : ' ≈';
    const multStr = est.multiplier > 1.05 ? ` ${C.dim}(×${est.multiplier.toFixed(1)})${C.reset}` : '';
    console.log(`  ${task.id}: ${task.name.padEnd(30)} ${C.dim}${task.size.padEnd(8)}${C.reset} ${model.padEnd(8)} ${C.yellow}${costStr}${confIcon}${C.reset}${multStr}`);
  }

  console.log(`  ${'─'.repeat(60)}`);
  console.log(`  ${'Total'.padEnd(30)} ${' '.repeat(17)} ${C.bold}${C.yellow}$${totalCost.toFixed(3)}${C.reset}`);
  console.log(`  ${C.dim}Input: ~${(totalInput / 1000).toFixed(0)}K tokens, Output: ~${(totalOutput / 1000).toFixed(0)}K tokens${C.reset}`);
  console.log(`  ${C.dim}Confidence: ≈ = low (complex/strategy), ~ = medium, (blank) = high${C.reset}`);

  // Say whether these numbers are calibrated from measured actuals or still pure
  // estimates — the forecaster only trusts an actual average at ≥10 samples/size.
  const actuals = loadTokenActuals();
  const counts = actuals?.sample_counts || {};
  const calibrated = Object.keys(counts).filter(s => counts[s] >= 10);
  if (calibrated.length) {
    console.log(`  ${C.dim}Calibrated from actuals: ${calibrated.map(s => `${s} (${counts[s]})`).join(', ')}${C.reset}`);
  } else {
    const measured = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(`  ${C.dim}Estimate-only (${measured} measured sample${measured === 1 ? '' : 's'}; ≥10/size calibrates). Record actuals: tasks update <id> --tokens-in N --tokens-out M${C.reset}`);
  }

  const budget = config.budget?.max_usd;
  if (budget) {
    const pct = (totalCost / budget * 100).toFixed(0);
    const color = totalCost > budget ? C.red : totalCost > budget * 0.8 ? C.yellow : C.green;
    console.log(`  ${color}Budget: $${totalCost.toFixed(2)} / $${budget} (${pct}%)${C.reset}`);
  }

  console.log('');
}

// ── cmdNext ─────────────────────────────────────────────────────────

/**
 * resolveNext — Determine the next action based on current phase + artifact state.
 * Pure state → recommendation function. No side effects.
 */
function R(en, ko) { return isNormalMode() ? ko : en; }

function resolveNext(project) {
  const manifest = readJSON(manifestPath(project));
  const phase = PHASES.find(p => p.id === manifest.current_phase);
  const taskData = readJSON(tasksPath(project));
  const contextExists = existsSync(join(contextDir(project), 'CONTEXT.md'));
  const reqExists = existsSync(join(contextDir(project), 'REQUIREMENTS.md'));
  const roadmapExists = existsSync(join(contextDir(project), 'ROADMAP.md'));
  const prdExists = existsSync(prdPath(project));
  const planCheckPath = join(phaseDir(project, '02-plan'), 'plan-check.json');
  const planCheckExists = existsSync(planCheckPath);

  const artifacts = { context: contextExists, requirements: reqExists, roadmap: roadmapExists, prd: prdExists, plan_check: planCheckExists };
  const base = { project: manifest.display_name || project, phase: phase?.name || 'unknown', artifacts };

  switch (phase?.name) {
    case 'research': {
      if (!contextExists) {
        return { ...base, action: 'discuss', args: ['--mode', 'interview'], reason: R('No CONTEXT.md found. Start requirements interview.', '요구사항을 정리하는 인터뷰를 시작하세요.') };
      }
      if (!reqExists) {
        return { ...base, action: 'research', args: [], reason: R('CONTEXT.md exists but no REQUIREMENTS.md. Run parallel research.', '요구사항 문서가 없습니다. 조사를 시작하세요.') };
      }
      return { ...base, action: 'phase', args: ['next'], reason: R('Research artifacts ready. Advance to Plan phase.', '조사가 끝났습니다. 계획 단계로 넘어가세요.'), ready: true };
    }
    case 'plan': {
      const tasks = taskData?.tasks || [];
      if (!prdExists) {
        let goal = null;
        if (contextExists) {
          const ctx = readMD(join(contextDir(project), 'CONTEXT.md'));
          const goalMatch = ctx.match(/^## Goal\s*\n+(.+)/m);
          if (goalMatch) goal = goalMatch[1].trim();
        }
        return { ...base, action: 'plan', args: goal ? [goal] : [], reason: R('PRD.md is missing. Generate and save a PRD before executing.', 'PRD가 없습니다. 실행 전에 PRD를 생성하고 저장하세요.'), goal, task_count: tasks.length, ready: false, prd_writer: prdWriterSpec() };
      }
      if (tasks.length === 0) {
        let goal = null;
        if (prdExists) {
          const prd = readMD(prdPath(project));
          const goalMatch = prd.match(/^## 1\. Goal\s*\n+(.+)/m);
          if (goalMatch) goal = goalMatch[1].trim();
        }
        if (!goal && contextExists) {
          const ctx = readMD(join(contextDir(project), 'CONTEXT.md'));
          const goalMatch = ctx.match(/^## Goal\s*\n+(.+)/m);
          if (goalMatch) goal = goalMatch[1].trim();
        }
        return { ...base, action: 'plan', args: goal ? [goal] : [], reason: goal ? R(`Auto-extracted goal: "${goal}"`, `목표를 자동으로 찾았습니다: "${goal}"`) : R('No tasks yet. Run plan with a goal.', '할 일이 없습니다. 목표를 정해서 계획을 세우세요.'), goal, prd_writer: prdWriterSpec() };
      }
      if (!planCheckExists) {
        return { ...base, action: 'plan-check', args: [], reason: R(`${tasks.length} tasks defined but not validated. Run plan-check.`, `할 일 ${tasks.length}개가 있지만 검증되지 않았습니다. 계획을 점검하세요.`), task_count: tasks.length };
      }
      const checkResult = readJSON(planCheckPath);
      if (!checkResult?.passed) {
        return { ...base, action: 'plan-check', args: [], reason: R('Plan-check failed. Fix issues and re-run.', '계획 점검에서 문제가 발견되었습니다. 수정 후 다시 점검하세요.'), plan_check_passed: false };
      }
      const approval = validatePlanApproval(project);
      if (!approval.ok) {
        return {
          ...base,
          action: 'approve-plan',
          args: [],
          reason: R('Plan is ready but still needs final approval.', '계획이 준비되었습니다. 최종 승인만 남았습니다.'),
          ready: false,
          approval_reason: approval.reason,
        };
      }
      if (approval.requested_action === 'plan_only') {
        return {
          ...base,
          action: 'plan-complete',
          args: [],
          reason: R('Approved Plan Bundle is complete. Execution is intentionally paused.', '승인된 Plan Bundle이 완성되었습니다. 실행은 의도적으로 멈춘 상태입니다.'),
          ready: true,
          resume_command: 'x-build run',
        };
      }
      return { ...base, action: 'phase', args: ['next'], reason: R('Plan validated. Advance to Execute phase.', '계획이 확인되었습니다. 실행 단계로 넘어가세요.'), ready: true };
    }
    case 'execute': {
      const stepData = readJSON(stepsPath(project));
      if (!stepData?.steps?.length) {
        return { ...base, action: 'steps', args: ['compute'], reason: R('No steps computed. Calculate execution order.', '실행 순서가 아직 없습니다. 순서를 계산하세요.') };
      }
      const allDone = (taskData?.tasks || []).every(t =>
        [TASK_STATES.COMPLETED, TASK_STATES.CANCELLED].includes(t.status)
      );
      const groupSummary = readPlanState(project)
        ? reviewGroupStatus(project, taskData?.tasks || [], { cwd: process.cwd() })
        : { review_required: false, all_passed: true, active_group: null };
      if (groupSummary.review_required) {
        return {
          ...base,
          action: 'review-group',
          args: [groupSummary.active_group],
          reason: R(`Review group "${groupSummary.active_group}" is ready. Review it before continuing.`, `리뷰 그룹 "${groupSummary.active_group}"이 준비되었습니다. 계속하기 전에 리뷰하세요.`),
          ready: true,
        };
      }
      if (allDone) {
        if (!groupSummary.all_passed) {
          return {
            ...base,
            action: 'review-group',
            args: [groupSummary.active_group].filter(Boolean),
            reason: R('Task execution is complete but its review group has not passed.', '작업 실행은 끝났지만 리뷰 그룹이 통과하지 않았습니다.'),
            ready: false,
          };
        }
        return { ...base, action: 'phase', args: ['next'], reason: R('All tasks completed. Advance to Verify phase.', '모든 할 일이 끝났습니다. 확인 단계로 넘어가세요.'), ready: true };
      }
      return { ...base, action: 'run', args: [], reason: R('Execute next step via agent orchestration.', '다음 할 일을 실행하세요.') };
    }
    case 'verify': {
      return { ...base, action: 'quality', args: [], reason: R('Run test/lint/build checks, then verify-coverage.', '테스트와 품질 검사를 실행하세요.') };
    }
    case 'close': {
      return { ...base, action: 'close', args: ['--summary'], reason: R('Finalize the project.', '프로젝트를 마무리하세요.') };
    }
    default:
      return { ...base, action: null, args: [], reason: 'Unknown phase state.' };
  }
}

export async function cmdNext(args) {
  const project = resolveProject(null);
  const jsonMode = args.includes('--json');
  const result = resolveNext(project);
  const manifest = readJSON(manifestPath(project));

  const projectKind = manifest?.project_kind || 'brownfield';
  result.project_kind = projectKind;
  result.suggest_probe = projectKind === 'greenfield';
  // Greenfield gate: signal whether the pre-interview Round 0 has run yet, so
  // the skill layer can insert it before Round 1 instead of re-running it.
  if (projectKind === 'greenfield' && result.phase === 'research') {
    result.round0_pending = !existsSync(join(phaseDir(project, '01-research'), 'discuss-round0.json'));
  }

  // Attach the deterministic research gauge when the next action IS research —
  // the skill layer uses it to scale the fan-out (full/slim) or, only at 0/4,
  // suggest --quick (user-confirmed; never auto-skip). Failure → absent field.
  if (result.action === 'research' || result.action === 'discuss') {
    try {
      const ctx = readMD(join(contextDir(project), 'CONTEXT.md')) || '';
      const goalMatch = ctx.match(/^## Goal\s*\n+(.+)/m);
      const goalText = goalMatch ? goalMatch[1].trim() : (manifest?.display_name || '');
      result.research_signal = await gaugeResearch(goalText);
    } catch { /* gauge is advisory on next — absence means "treat as full" */ }
  }

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const phase = PHASES.find(p => p.id === manifest.current_phase);

  console.log(`\n${C.bold}Next Step${C.reset}\n`);
  console.log(`  Project: ${manifest.display_name || project}`);
  console.log(`  Phase:   ${phase?.label || '?'}\n`);

  const color = result.ready ? C.green : C.yellow;
  const cmd = result.action === 'phase' ? `x-build ${result.action} ${result.args.join(' ')}` :
              result.action === 'plan' && result.goal ? `x-build plan "${result.goal}"` :
              `x-build ${result.action}${result.args.length ? ' ' + result.args.join(' ') : ''}`;
  console.log(`  ${color}-> Run: ${cmd}${C.reset}`);
  console.log(`    ${result.reason}`);
  console.log('');
}

// ── cmdHandoff ──────────────────────────────────────────────────────

export function cmdHandoff(args) {
  const { opts } = parseOptions(args);
  const project = resolveProject(null);
  const handoffPath = join(projectDir(project), 'HANDOFF.json');

  if (opts.restore || args[0] === '--restore') {
    if (!existsSync(handoffPath)) {
      console.log('No handoff file found.');
      return;
    }
    const handoff = readJSON(handoffPath);
    console.log(`\n${C.bold}Session Handoff — ${handoff.project}${C.reset}`);
    console.log(`  Saved: ${handoff.saved_at}`);
    console.log(`  Phase: ${handoff.phase}`);
    console.log(`\n${C.bold}Summary:${C.reset}`);
    console.log(`  ${handoff.summary}`);
    if (handoff.pending_tasks?.length) {
      console.log(`\n${C.bold}Pending tasks:${C.reset}`);
      for (const t of handoff.pending_tasks) {
        console.log(`  [ ] ${t.id}: ${t.name}`);
      }
    }
    if (handoff.recent_decisions?.length) {
      console.log(`\n${C.bold}Recent decisions:${C.reset}`);
      for (const d of handoff.recent_decisions) {
        console.log(`  * ${d}`);
      }
    }
    console.log('');
    return;
  }

  // Save handoff
  const manifest = readJSON(manifestPath(project));
  const phase = PHASES.find(p => p.id === manifest.current_phase);
  const taskData = readJSON(tasksPath(project));
  const decisions = readJSON(decisionsPath(project));

  const pendingTasks = (taskData?.tasks || [])
    .filter(t => ![TASK_STATES.COMPLETED, TASK_STATES.CANCELLED].includes(t.status))
    .map(t => ({ id: t.id, name: t.name, status: t.status }));

  const recentDecisions = (decisions?.decisions || [])
    .slice(-5)
    .map(d => d.title);

  const completedCount = (taskData?.tasks || []).filter(t => t.status === TASK_STATES.COMPLETED).length;
  const totalCount = (taskData?.tasks || []).length;

  const handoff = {
    project,
    phase: phase?.label || manifest.current_phase,
    saved_at: new Date().toISOString(),
    summary: `Phase: ${phase?.label}. Tasks: ${completedCount}/${totalCount} completed. ${pendingTasks.length} remaining.`,
    pending_tasks: pendingTasks,
    recent_decisions: recentDecisions,
    context_files: {
      has_context: existsSync(join(contextDir(project), 'CONTEXT.md')),
      has_requirements: existsSync(join(contextDir(project), 'REQUIREMENTS.md')),
      has_roadmap: existsSync(join(contextDir(project), 'ROADMAP.md')),
    },
  };

  writeJSON(handoffPath, handoff);
  console.log(`Handoff saved for "${project}"`);
  console.log(`   Restore in new session: x-build handoff --restore`);
}

// ── cmdSummarize ────────────────────────────────────────────────────

export function cmdSummarize(args) {
  const project = resolveProject(null);
  const stepData = readJSON(stepsPath(project));
  const taskData = readJSON(tasksPath(project));

  if (!stepData?.steps?.length) {
    console.log('No steps to summarize.');
    return;
  }

  console.log(`\n${C.bold}📋 Step Summaries${C.reset}\n`);

  let totalCompleted = 0;
  let totalFailed = 0;
  let totalDuration = 0;

  for (const step of stepData.steps) {
    const summary = _summarizeStep(project, step.id, taskData, stepData);
    if (!summary) continue;

    totalCompleted += summary.completed;
    totalFailed += summary.failed;

    const durations = summary.tasks.filter(t => t.duration_ms).map(t => t.duration_ms);
    const stepDuration = durations.reduce((a, b) => a + b, 0);
    totalDuration += stepDuration;

    const icon = summary.completed === summary.total_tasks ? '✅' :
                 summary.failed > 0 ? '❌' : '⬜';

    console.log(`  ${icon} Step ${step.id}: ${summary.completed}/${summary.total_tasks} tasks ${C.dim}(${fmtDuration(stepDuration)})${C.reset}`);
    for (const t of summary.tasks) {
      const tIcon = { completed: '✅', failed: '❌', running: '🔵', pending: '⬜', ready: '🟡' }[t.status] || '⬜';
      const dur = t.duration_ms ? ` ${C.dim}${fmtDuration(t.duration_ms)}${C.reset}` : '';
      console.log(`    ${tIcon} ${t.id}: ${t.name}${dur}`);
    }
  }

  console.log(`\n${C.bold}Total:${C.reset} ${totalCompleted} completed, ${totalFailed} failed, ${fmtDuration(totalDuration)} elapsed\n`);
}

function _summarizeStep(project, stepId, taskData, stepData) {
  if (!stepData?.steps || !taskData?.tasks) return null;

  const step = stepData.steps.find(s => s.id === stepId);
  if (!step) return null;

  const taskDetails = step.tasks.map(id => {
    const t = taskData.tasks.find(t => t.id === id);
    return {
      id,
      name: t?.name || '?',
      status: t?.status || 'unknown',
      duration_ms: t?.completed_at && t?.started_at
        ? new Date(t.completed_at) - new Date(t.started_at)
        : null,
    };
  });

  const summary = {
    step_id: stepId,
    total_tasks: taskDetails.length,
    completed: taskDetails.filter(t => t.status === 'completed').length,
    failed: taskDetails.filter(t => t.status === 'failed').length,
    tasks: taskDetails,
    summarized_at: new Date().toISOString(),
  };

  // Archive full step data
  const aDir = archiveDir(project);
  mkdirSync(aDir, { recursive: true });
  writeJSON(join(aDir, `step-${stepId}.json`), summary);

  return summary;
}

// ── cmdSaveArtifact ─────────────────────────────────────────────────

export function cmdSaveArtifact(args) {
  const { opts, positional } = parseOptions(args);
  const project = resolveProject(null);
  const type = positional[0];

  if (!type) {
    console.error('Usage: x-build save <context|requirements|roadmap|project|plan|research-notes> [--content "..."] [--agent <name>]');
    exitFail(1);
  }

  let content = opts.content || '';
  if (!content && !process.stdin.isTTY) {
    content = readFileSync(0, 'utf8');
  }

  if (!content) {
    console.error('No content provided. Use --content or pipe via stdin.');
    exitFail(1);
  }

  const paths = {
    'context': join(contextDir(project), 'CONTEXT.md'),
    'requirements': join(contextDir(project), 'REQUIREMENTS.md'),
    'roadmap': join(contextDir(project), 'ROADMAP.md'),
    'project': join(contextDir(project), 'PROJECT.md'),
    'plan': prdPath(project),
    'research-notes': join(phaseDir(project, '01-research'), 'notes.md'),
  };

  const dest = paths[type];
  if (!dest) {
    console.error(`Unknown artifact type: "${type}". Valid: ${Object.keys(paths).join(', ')}`);
    exitFail(1);
  }

  if (type === 'research-notes') {
    const agent = opts.agent || 'agent';
    const timestamp = new Date().toISOString();
    const header = `\n## ${agent} — ${timestamp}\n\n`;
    const body = content.endsWith('\n') ? content : content + '\n';
    const existing = existsSync(dest) ? readFileSync(dest, 'utf8') : '# Research Notes\n\n';
    const base = existing.trim().length > 0 ? existing : '# Research Notes\n\n';
    writeMD(dest, base + header + body);
    console.log(`Appended research note (agent=${agent}) to: ${dest}`);
    return;
  }

  // R12: stamp new PRDs with the template version so prdBlockingFindings can
  // tell "written under the diagram-mandatory template" apart from
  // pre-existing PRDs. Never re-stamp a PRD that already carries a marker.
  if (type === 'plan' && !VERSION_MARKER_RE.test(content)) {
    content = `<!-- prd-template-version: ${PRD_TEMPLATE_VERSION} -->\n${content}`;
  }

  writeMD(dest, content);
  console.log(`Saved ${type} artifact: ${dest}`);
}

// ── cmdContextUsage ─────────────────────────────────────────────────

export function cmdContextUsage(args) {
  const project = resolveProject(null);
  const manifest = readJSON(manifestPath(project));

  let totalChars = 0;
  const files = [];

  const checkFile = (path, label) => {
    if (existsSync(path)) {
      const content = readFileSync(path, 'utf8');
      totalChars += content.length;
      files.push({ label, chars: content.length, tokens: Math.round(content.length / 4) });
    }
  };

  checkFile(join(contextDir(project), 'CONTEXT.md'), 'CONTEXT.md');
  checkFile(join(contextDir(project), 'REQUIREMENTS.md'), 'REQUIREMENTS.md');
  checkFile(join(contextDir(project), 'ROADMAP.md'), 'ROADMAP.md');
  checkFile(join(contextDir(project), 'PROJECT.md'), 'PROJECT.md');
  checkFile(join(contextDir(project), 'decisions.md'), 'Decisions');
  checkFile(join(contextDir(project), 'brief.md'), 'Brief');
  checkFile(tasksPath(project), 'Tasks JSON');
  checkFile(stepsPath(project), 'Steps JSON');

  for (const phase of PHASES) {
    const planPath = join(phaseDir(project, phase.id), `${phase.name}-PLAN.md`);
    checkFile(planPath, `${phase.label} Plan`);
  }

  const totalTokens = Math.round(totalChars / 4);
  const maxTokens = 200000;
  const usedPct = Math.round((totalTokens / maxTokens) * 100);

  console.log(`\n${C.bold}Context Usage — ${project}${C.reset}\n`);
  console.log(`  Total: ~${totalTokens.toLocaleString()} tokens (${usedPct}% of ~200K window)\n`);

  files.sort((a, b) => b.tokens - a.tokens);
  for (const f of files) {
    const bar = '#'.repeat(Math.max(1, Math.round(f.tokens / (totalTokens || 1) * 20)));
    console.log(`  ${f.label.padEnd(20)} ${C.dim}~${f.tokens.toLocaleString().padStart(6)} tokens${C.reset} ${C.cyan}${bar}${C.reset}`);
  }

  console.log('');
  if (usedPct > 75) {
    console.log(`  ${C.red}High context usage — consider: x-build handoff${C.reset}`);
  } else if (usedPct > 35) {
    console.log(`  ${C.yellow}Moderate context usage — monitor growth${C.reset}`);
  } else {
    console.log(`  ${C.green}Context usage is healthy${C.reset}`);
  }
  console.log('');
}

// ── cmdResearchCheck ─────────────────────────────────────────────────
// Deterministic research-routing gauge. Four signals decide whether a goal
// may SUGGEST skipping the Research phase — the LLM layer never judges this
// alone, and a --quick suggestion is only permitted at 0/4 hits (and even
// then only as an AskUserQuestion suggestion, never an automatic skip).
// Fail-safe direction: any signal that cannot be judged (empty goal,
// x-memory unavailable, unreadable lessons) counts as a HIT, pushing the
// recommendation TOWARD research, never away from it.
// Named research-check (not *signals*) to avoid colliding with x-memory's
// unrelated collectContextSignals.

const RC_CONTRACT_RE = /\b(schema|contract|migration|rename|protocol|vocabulary|api)\b|스키마|계약|어휘|프로토콜|마이그레이션|필드/i;
const RC_IRREVERSIBLE_RE = /\b(release|publish|deploy|marketplace|drop|delete|remove|deprecat)/i;
const RC_IRREVERSIBLE_KO = /릴리스|배포|삭제|제거|외부/;

// Dual-path import of x-memory's store (bundle first, then source tree) —
// mirrors loadPanelAdapters in shared-config. Returns null when unavailable;
// the caller treats that as fail-safe HIT, never a silent pass.
async function loadMemoryStore() {
  const { fileURLToPath } = await import('node:url');
  const { dirname } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'x-memory', 'store.mjs'),                                   // xm bundle: xm/lib/x-build → xm/lib/x-memory
    join(here, '..', '..', '..', 'x-memory', 'lib', 'x-memory', 'store.mjs'),    // source: x-build/lib/x-build → x-memory/lib/x-memory
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try { return await import(p); } catch { /* try next */ }
    }
  }
  return null;
}

function rcTokens(goal) {
  return String(goal).toLowerCase().split(/[\s/\-_.,:;()[\]{}'"]+/).filter((t) => t.length >= 4);
}

// Reusable core for cmdPlan/cmdNext wiring — same fail-safe rules as the CLI.
export async function gaugeResearch(goal) {
  return _gauge(String(goal ?? '').trim());
}

export async function cmdResearchCheck(args) {
  const { opts, positional } = parseOptions(args);
  const goal = (opts.goal != null ? String(opts.goal) : positional.join(' ')).trim();
  const out = await _gauge(goal);

  if (opts.json !== undefined) {
    console.log(JSON.stringify(out, null, 2));
    return out;
  }
  const { signals, hits, recommendation } = out;
  console.log(`\n${C.bold}Research check${C.reset} — ${hits}/${signals.length} signals\n`);
  for (const s of signals) {
    console.log(`  ${s.hit ? `${C.yellow}HIT ${C.reset}` : `${C.dim}miss${C.reset}`} ${s.id.padEnd(22)} ${C.dim}${s.evidence}${C.reset}`);
  }
  const label = recommendation === 'quick-eligible'
    ? `${C.green}quick-eligible${C.reset} — --quick MAY be suggested (user confirmation still required; never auto-skip)`
    : recommendation === 'slim'
      ? `${C.yellow}slim${C.reset} — targeted research (1-2 agents) on the hit signals`
      : `${C.red}full${C.reset} — full research (4 agents)`;
  console.log(`\n  recommendation: ${label}\n`);
  return out;
}

async function _gauge(goal) {
  const signals = [];
  const failSafe = (id, why) => signals.push({ id, hit: true, evidence: `judgment unavailable (${why}) — fail-safe HIT` });

  if (goal.length < 10) {
    // Too little text to judge anything — every signal fails safe toward research.
    for (const id of ['contract-vocabulary', 'no-memory-map', 'irreversible-surface', 'lessons-match']) {
      failSafe(id, 'goal too short to judge');
    }
  } else {
    // 1. Contract/schema vocabulary — cross-cutting changes need consumer sweeps.
    const m1 = goal.match(RC_CONTRACT_RE);
    signals.push(m1
      ? { id: 'contract-vocabulary', hit: true, evidence: `matched "${m1[0]}"` }
      : { id: 'contract-vocabulary', hit: false, evidence: 'no contract/schema vocabulary in goal' });

    // 2. Memory map — a goal with NO recall hits is unknown territory.
    try {
      const store = await loadMemoryStore();
      if (!store || typeof store.searchIndex !== 'function') {
        failSafe('no-memory-map', 'x-memory not installed');
      } else {
        const results = store.searchIndex(goal);
        signals.push(results.length === 0
          ? { id: 'no-memory-map', hit: true, evidence: 'no x-memory hits — unknown territory' }
          : { id: 'no-memory-map', hit: false, evidence: `${results.length} x-memory hit(s) — map exists (top: "${results[0].title || results[0].id}")` });
      }
    } catch (e) {
      failSafe('no-memory-map', `x-memory error: ${String(e?.message || e).slice(0, 60)}`);
    }

    // 3. Irreversible surface — released schemas/migrations/external contracts.
    const m3 = goal.match(RC_IRREVERSIBLE_RE) || goal.match(RC_IRREVERSIBLE_KO);
    signals.push(m3
      ? { id: 'irreversible-surface', hit: true, evidence: `matched "${m3[0]}"` }
      : { id: 'irreversible-surface', hit: false, evidence: 'no irreversibility vocabulary in goal' });

    // 4. Lessons — a recorded STOP/START in this area means the trap is known.
    try {
      const lessonsDir = join(ROOT, '..', 'humble', 'lessons');
      if (!existsSync(lessonsDir)) {
        signals.push({ id: 'lessons-match', hit: false, evidence: 'no lessons directory — nothing recorded' });
      } else {
        const toks = rcTokens(goal);
        let matched = null;
        for (const f of readdirSync(lessonsDir).filter((f) => f.endsWith('.json'))) {
          let lesson;
          try { lesson = JSON.parse(readFileSync(join(lessonsDir, f), 'utf8')); } catch { continue; }
          const text = `${lesson.content || ''} ${lesson.reason || ''}`.toLowerCase();
          const tok = toks.find((t) => text.includes(t));
          if (tok) { matched = { id: lesson.id || f, tok }; break; }
        }
        signals.push(matched
          ? { id: 'lessons-match', hit: true, evidence: `lesson ${matched.id} mentions "${matched.tok}"` }
          : { id: 'lessons-match', hit: false, evidence: 'no lesson overlaps the goal' });
      }
    } catch (e) {
      failSafe('lessons-match', `lessons error: ${String(e?.message || e).slice(0, 60)}`);
    }
  }

  const hits = signals.filter((s) => s.hit).length;
  // quick-eligible ONLY at 0/4 — one hit scales the research, it never re-opens quick.
  const recommendation = hits === 0 ? 'quick-eligible' : hits <= 2 ? 'slim' : 'full';
  return { goal, signals, hits, total: signals.length, recommendation };
}
