#!/usr/bin/env node

/**
 * x-solver — Structured Problem Solving CLI
 * term-mesh 생태계의 범용 문제 해결 도구
 *
 * Usage: node x-solver-cli.mjs <command> [args] [options]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { detectStop } from './convergence.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve the .xm/ state dir — subdirectory/worktree-aware. Mirrors x-build's
// resolveXmRoot. Rule: a local .xm/ wins → else THIS working tree's root via
// `git rev-parse --show-toplevel`, so running from a subdirectory reuses the
// repo's .xm instead of spawning a stray one → else cwd/.xm (created on
// demand). show-toplevel stays inside the current checkout: a linked worktree
// returns itself (not the main repo, so worktree state stays independent), and
// a bare repo errors → cwd fallback. It never escapes into a separate parent repo.
function resolveXmDir() {
  const localXm = resolve(process.cwd(), '.xm');
  if (existsSync(localXm)) return localXm;
  try {
    const top = execSync('git rev-parse --show-toplevel', {
      cwd: process.cwd(), encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (top) {
      const topXm = join(top, '.xm');
      if (existsSync(topXm)) return topXm;
    }
  } catch {}
  return localXm;
}

// ROOT resolution:
// 1. XM_SOLVER_ROOT env var (explicit override)
// 2. --global flag → ~/.xm/solver/
// 3. default → <repo>/.xm/solver/ (via resolveXmDir)
const XM_GLOBAL = process.argv.includes('--global');
const ROOT = process.env.XM_SOLVER_ROOT
  ? resolve(process.env.XM_SOLVER_ROOT)
  : XM_GLOBAL
    ? resolve(homedir(), '.xm', 'solver')
    : join(resolveXmDir(), 'solver');

const PLUGIN_ROOT = resolve(__dirname, '..');

// ── Constants ────────────────────────────────────────────────────────

const PHASES = [
  { id: '01-intake',   name: 'intake',   label: 'Intake' },
  { id: '02-classify', name: 'classify', label: 'Classify' },
  { id: '03-solve',    name: 'solve',    label: 'Solve' },
  { id: '04-verify',   name: 'verify',   label: 'Verify' },
  { id: '05-close',    name: 'close',    label: 'Close' },
];

const STRATEGIES = {
  DECOMPOSE: 'decompose',
  ITERATE: 'iterate',
  CONSTRAIN: 'constrain',
  PIPELINE: 'pipeline',
};

const STRATEGY_LABELS = {
  decompose: { name: 'Decompose', icon: '🌳', desc: 'Tree-of-Thought: break into sub-problems, solve each, merge' },
  iterate:   { name: 'Iterate',   icon: '🔄', desc: 'Hypothesis → Test → Refine loop for debugging' },
  constrain: { name: 'Constrain', icon: '🎯', desc: 'Constraint satisfaction: define constraints, score candidates' },
  pipeline:  { name: 'Pipeline',  icon: '🔀', desc: 'Auto-detect problem type and route to best strategy' },
};

// `reproduce` leads iterate, and it has to be first rather than a step inside diagnose.
// solve-advance only permits index+1, so a phase inserted anywhere else would strand
// every problem already sitting on a later phase. Being first also buys the one
// guarantee prompts cannot give: `repro set` is only accepted while the run is in
// `reproduce`, so the failing evidence is provably older than the fix.
const SOLVE_PHASES = {
  decompose: ['decompose', 'explore', 'evaluate', 'synthesize'],
  iterate:   ['reproduce', 'diagnose', 'hypothesize', 'test', 'refine', 'resolve'],
  constrain: ['elicit', 'generate', 'evaluate', 'select'],
  pipeline:  ['classify', 'route', 'meta-verify'],
};

const REPRO_STATUSES = ['reproduced', 'intermittent', 'unavailable'];
const MAX_ITERATION_EXTENSIONS = 2;
const MAX_ITERATIONS_PER_EXTENSION = 3;
const REPRO_TAIL_LINES = 100;
const REPRO_TAIL_BYTES = 8192;

const PROBLEM_STATES = {
  ACTIVE: 'active',
  SOLVED: 'solved',
  CLOSED: 'closed',
  ABANDONED: 'abandoned',
};

// ── ANSI Colors ──────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY && !process.env.NO_COLOR;
const C = isTTY ? {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
} : Object.fromEntries(['reset','bold','dim','red','green','yellow','blue','magenta','cyan'].map(k => [k, '']));

function renderBar(done, total, width = 20) {
  if (total === 0) return `[${C.dim}${'░'.repeat(width)}${C.reset}] 0%`;
  const ratio = done / total;
  const filled = Math.round(ratio * width);
  const pct = Math.round(ratio * 100);
  return `[${C.green}${'█'.repeat(filled)}${C.dim}${'░'.repeat(width - filled)}${C.reset}] ${pct}% ${done}/${total}`;
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ── I/O Helpers ──────────────────────────────────────────────────────

function readJSON(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJSON(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function readMD(path) {
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

function writeMD(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function loadConfig() {
  return readJSON(join(ROOT, 'config.json')) || {};
}

function loadSharedConfig() {
  // Shared config: ROOT is .xm/solver/ → shared = .xm/config.json
  const sharedPath = join(ROOT, '..', 'config.json');
  const local = readJSON(sharedPath);
  if (local) return local;
  // Fallback to global config (~/.xm/config.json)
  const globalPath = join(homedir(), '.xm', 'config.json');
  return readJSON(globalPath) || {};
}

function getMode() {
  // Priority: local config → shared config → default
  const localMode = loadConfig().mode;
  if (localMode) return localMode;
  const sharedMode = loadSharedConfig().mode;
  if (sharedMode) return sharedMode;
  return 'developer';
}

function getAgentCount() {
  const local = loadConfig();
  const localParallel = local.solving?.parallel_agents;
  if (Number.isInteger(localParallel) && localParallel > 0) return localParallel;

  const shared = loadSharedConfig();
  return shared.agent_max_count ?? 4;
}

function parseOptions(args) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = true;
      }
    } else {
      positional.push(args[i]);
    }
  }
  return { opts, positional };
}

// ── Path Helpers ─────────────────────────────────────────────────────

function problemsDir() {
  return join(ROOT, 'problems');
}

function problemDir(name) {
  return join(problemsDir(), name);
}

function manifestPath(name) {
  return join(problemDir(name), 'manifest.json');
}

function phaseDir(problem, phaseId) {
  return join(problemDir(problem), 'phases', phaseId);
}

function intakePath(problem) {
  return phaseDir(problem, '01-intake');
}

function classifyPath(problem) {
  return phaseDir(problem, '02-classify');
}

function solvePath(problem) {
  return phaseDir(problem, '03-solve');
}

function verifyPath(problem) {
  return phaseDir(problem, '04-verify');
}

function closePath(problem) {
  return phaseDir(problem, '05-close');
}

// ── Problem Manager ──────────────────────────────────────────────────

function findCurrentProblem() {
  const dir = problemsDir();
  if (!existsSync(dir)) return null;
  const problems = readdirSync(dir).filter(d =>
    existsSync(manifestPath(d))
  );

  // Find most recent active problem
  let latest = null;
  let latestTime = 0;
  for (const p of problems) {
    const m = readJSON(manifestPath(p));
    if (m && m.state === PROBLEM_STATES.ACTIVE) {
      const t = new Date(m.updated_at || m.created_at).getTime();
      if (t > latestTime) {
        latestTime = t;
        latest = p;
      }
    }
  }
  return latest;
}

function requireProblem(args) {
  const { opts } = parseOptions(args || []);
  const problem = opts.problem || findCurrentProblem();
  if (!problem) {
    console.error('❌ No active problem. Run: x-solver init "description"');
    process.exit(1);
  }
  if (!existsSync(manifestPath(problem))) {
    console.error(`❌ Problem "${problem}" not found.`);
    process.exit(1);
  }
  return problem;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

// ── Init ─────────────────────────────────────────────────────────────

function cmdInit(args) {
  const description = args.join(' ').trim();
  if (!description) {
    console.error('Usage: x-solver init "problem description"');
    process.exit(1);
  }

  mkdirSync(problemsDir(), { recursive: true });

  const slug = slugify(description) || `problem-${Date.now()}`;
  const dir = problemDir(slug);

  if (existsSync(dir)) {
    console.error(`❌ Problem "${slug}" already exists.`);
    process.exit(1);
  }

  // Create phase directories
  for (const phase of PHASES) {
    mkdirSync(phaseDir(slug, phase.id), { recursive: true });
  }

  // Create manifest
  const manifest = {
    name: slug,
    display_name: description,
    current_phase: '01-intake',
    strategy: null,
    state: PROBLEM_STATES.ACTIVE,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    closed_at: null,
  };
  writeJSON(manifestPath(slug), manifest);

  // Init intake files
  writeMD(join(intakePath(slug), 'description.md'), `# Problem\n\n${description}\n`);
  writeJSON(join(intakePath(slug), 'context.json'), { items: [] });
  writeJSON(join(intakePath(slug), 'constraints.json'), { constraints: [] });

  // Init solve files
  writeJSON(join(solvePath(slug), 'candidates.json'), { candidates: [] });
  writeJSON(join(solvePath(slug), 'strategy-state.json'), {});

  console.log(`\n✅ Problem initialized: ${C.bold}${slug}${C.reset}`);
  console.log(`   ${C.dim}${description}${C.reset}`);
  console.log(`\n   Phase: ${C.cyan}Intake${C.reset}`);
  console.log(`   Next: describe, context add, constraints add, or classify\n`);

  // Output JSON for SKILL.md consumption
  console.log(JSON.stringify({
    action: 'init',
    problem: slug,
    description,
    phase: 'intake',
  }));
}

// ── List ─────────────────────────────────────────────────────────────

function cmdList() {
  const dir = problemsDir();
  if (!existsSync(dir)) {
    console.log('No problems yet. Run: x-solver init "description"');
    return;
  }

  const problems = readdirSync(dir).filter(d => existsSync(manifestPath(d)));
  if (problems.length === 0) {
    console.log('No problems yet. Run: x-solver init "description"');
    return;
  }

  console.log(`\n${C.bold}Problems${C.reset} (${problems.length})\n`);

  const stateIcons = {
    active: '🔵', solved: '✅', closed: '⬜', abandoned: '⛔',
  };

  for (const p of problems) {
    const m = readJSON(manifestPath(p));
    const phase = PHASES.find(ph => ph.id === m.current_phase);
    const icon = stateIcons[m.state] || '❓';
    const strategy = m.strategy ? ` [${STRATEGY_LABELS[m.strategy]?.icon || ''}${m.strategy}]` : '';
    console.log(`  ${icon} ${C.bold}${p}${C.reset}${strategy}`);
    console.log(`    ${C.dim}${m.display_name}${C.reset}`);
    console.log(`    Phase: ${phase?.label || m.current_phase}  |  ${m.created_at?.slice(0, 10)}`);
    console.log();
  }
}

// ── Status ───────────────────────────────────────────────────────────

function cmdStatus(args) {
  const problem = requireProblem(args);
  const m = readJSON(manifestPath(problem));
  const phase = PHASES.find(ph => ph.id === m.current_phase);
  const phaseIdx = PHASES.findIndex(ph => ph.id === m.current_phase);

  console.log(`\n${C.bold}Problem: ${m.display_name}${C.reset}`);
  console.log(`  State: ${m.state}  |  Strategy: ${m.strategy || 'not set'}`);
  console.log(`  Created: ${m.created_at?.slice(0, 19)}\n`);

  // Phase progress bar
  const phaseBar = PHASES.map((ph, i) => {
    if (i < phaseIdx) return `${C.green}✓ ${ph.label}${C.reset}`;
    if (i === phaseIdx) return `${C.cyan}▶ ${ph.label}${C.reset}`;
    return `${C.dim}○ ${ph.label}${C.reset}`;
  }).join('  →  ');
  console.log(`  ${phaseBar}\n`);

  // Strategy-specific details
  if (m.strategy) {
    const stratState = readJSON(join(solvePath(problem), 'strategy-state.json'));
    if (stratState && stratState.strategy) {
      const info = STRATEGY_LABELS[m.strategy];
      console.log(`  ${C.bold}Strategy: ${info?.icon} ${info?.name}${C.reset}`);
      if (stratState.current_phase) {
        const phases = SOLVE_PHASES[m.strategy] || [];
        const solveIdx = phases.indexOf(stratState.current_phase);
        console.log(`  Solve phase: ${stratState.current_phase} (${solveIdx + 1}/${phases.length})`);
      }
    }
  }

  // Constraints count
  const constraints = readJSON(join(intakePath(problem), 'constraints.json'));
  if (constraints?.constraints?.length) {
    console.log(`  Constraints: ${constraints.constraints.length}`);
  }

  // Candidates count
  const candidates = readJSON(join(solvePath(problem), 'candidates.json'));
  if (candidates?.candidates?.length) {
    console.log(`  Candidates: ${candidates.candidates.length}`);
  }

  // Classification
  const classification = readJSON(join(classifyPath(problem), 'classification.json'));
  if (classification) {
    console.log(`  Classification: ${classification.recommended_strategy} (confidence: ${Math.round(classification.confidence * 100)}%)`);
  }

  console.log();

  // JSON output for SKILL.md
  console.log(JSON.stringify({
    action: 'status',
    problem,
    phase: phase?.name,
    phase_index: phaseIdx,
    strategy: m.strategy,
    state: m.state,
    constraints_count: constraints?.constraints?.length || 0,
    candidates_count: candidates?.candidates?.length || 0,
  }));
}

// ── Describe ─────────────────────────────────────────────────────────

function cmdDescribe(args) {
  const problem = requireProblem(args);
  const { opts } = parseOptions(args);

  if (!opts.content) {
    // Show current description
    const desc = readMD(join(intakePath(problem), 'description.md'));
    console.log(desc || '(No description set)');
    return;
  }

  writeMD(join(intakePath(problem), 'description.md'), opts.content);
  const m = readJSON(manifestPath(problem));
  m.updated_at = new Date().toISOString();
  writeJSON(manifestPath(problem), m);
  console.log('✅ Description updated.');
}

// ── Context ──────────────────────────────────────────────────────────

function cmdContext(args) {
  const sub = args[0];
  const problem = requireProblem(args.slice(1));
  const contextFile = join(intakePath(problem), 'context.json');

  if (sub === 'add') {
    const { opts } = parseOptions(args.slice(1));
    if (!opts.content) {
      console.error('Usage: x-solver context add --content "..."');
      process.exit(1);
    }
    const data = readJSON(contextFile) || { items: [] };
    data.items.push({
      id: `ctx-${data.items.length + 1}`,
      content: opts.content,
      type: opts.type || 'text',
      added_at: new Date().toISOString(),
    });
    writeJSON(contextFile, data);
    console.log(`✅ Context added (${data.items.length} items total).`);
  } else if (sub === 'list') {
    const data = readJSON(contextFile) || { items: [] };
    if (data.items.length === 0) {
      console.log('No context items yet.');
      return;
    }
    console.log(`\n${C.bold}Context Items${C.reset} (${data.items.length})\n`);
    for (const item of data.items) {
      console.log(`  ${C.cyan}${item.id}${C.reset} [${item.type}] ${item.added_at?.slice(0, 10)}`);
      console.log(`    ${item.content.slice(0, 100)}${item.content.length > 100 ? '...' : ''}`);
      console.log();
    }
  } else {
    console.error('Usage: x-solver context <add|list> [--content "..."]');
    process.exit(1);
  }
}

// ── Constraints ──────────────────────────────────────────────────────

function cmdConstraints(args) {
  const sub = args[0];
  const problem = requireProblem(args.slice(1));
  const constraintFile = join(intakePath(problem), 'constraints.json');

  if (sub === 'add') {
    const { opts, positional } = parseOptions(args.slice(1));
    const description = positional.join(' ') || opts.content;
    if (!description) {
      console.error('Usage: x-solver constraints add "description" [--type hard|soft|preference]');
      process.exit(1);
    }
    const data = readJSON(constraintFile) || { constraints: [] };
    const constraint = {
      id: `c${data.constraints.length + 1}`,
      type: opts.type || 'hard',
      description,
      dimension: opts.dimension || 'general',
      created_at: new Date().toISOString(),
    };
    data.constraints.push(constraint);
    writeJSON(constraintFile, data);
    console.log(`✅ Constraint ${constraint.id} added [${constraint.type}]: ${description}`);
  } else if (sub === 'list') {
    const data = readJSON(constraintFile) || { constraints: [] };
    if (data.constraints.length === 0) {
      console.log('No constraints yet.');
      return;
    }
    const typeIcons = { hard: '🔴', soft: '🟡', preference: '🟢' };
    console.log(`\n${C.bold}Constraints${C.reset} (${data.constraints.length})\n`);
    for (const c of data.constraints) {
      console.log(`  ${typeIcons[c.type] || '⬜'} ${C.bold}${c.id}${C.reset} [${c.type}] ${c.description}`);
    }
    console.log();
  } else if (sub === 'remove') {
    const { positional } = parseOptions(args.slice(1));
    const id = positional[0];
    if (!id) {
      console.error('Usage: x-solver constraints remove <id>');
      process.exit(1);
    }
    const data = readJSON(constraintFile) || { constraints: [] };
    const idx = data.constraints.findIndex(c => c.id === id);
    if (idx === -1) {
      console.error(`❌ Constraint "${id}" not found.`);
      process.exit(1);
    }
    data.constraints.splice(idx, 1);
    writeJSON(constraintFile, data);
    console.log(`✅ Constraint ${id} removed.`);
  } else {
    console.error('Usage: x-solver constraints <add|list|remove>');
    process.exit(1);
  }
}

// ── Classify ─────────────────────────────────────────────────────────

function cmdClassify(args) {
  const problem = requireProblem(args);
  const m = readJSON(manifestPath(problem));
  const description = readMD(join(intakePath(problem), 'description.md'));
  const contextData = readJSON(join(intakePath(problem), 'context.json')) || { items: [] };
  const constraintData = readJSON(join(intakePath(problem), 'constraints.json')) || { constraints: [] };

  // Signal detection
  const text = (description + ' ' + contextData.items.map(i => i.content).join(' ')).toLowerCase();

  // ── Compound keywords: single term implies multiple signals ──
  const COMPOUND_SIGNALS = [
    { pattern: /memory.?leak|메모리.?누수/, signals: ['has_error', 'has_performance'] },
    { pattern: /race.?condition|경쟁.?조건|레이스.?컨디션/, signals: ['has_error', 'has_performance'] },
    { pattern: /deadlock|교착|데드락/, signals: ['has_error', 'has_performance'] },
    { pattern: /n\+1|n\s*\+\s*1\s*quer/, signals: ['has_error', 'has_performance'] },
    { pattern: /oom|out.?of.?memory/, signals: ['has_error', 'has_performance'] },
    { pattern: /sql.?injection|xss.?attack/, signals: ['has_error', 'has_security'] },
    { pattern: /scale.?out|auto.?scal|오토.?스케일/, signals: ['has_infra', 'has_performance'] },
    { pattern: /auth.?leak|token.?expos|credential.?expos/, signals: ['has_security', 'has_error'] },
    { pattern: /auto.?scal|load.?balanc|트래픽.?분산/, signals: ['has_infra', 'has_design_question'] },
  ];

  // Start with base regex detection
  const signals = {
    has_error: /error|exception|crash|fail|bug|panic|segfault|traceback|에러|오류|버그|실패|누수|leak|broken|깨진|안\s*됨|안\s*됩니다/.test(text),
    has_stack_trace: /at\s+\w|file:?\s*line|\.js:\d+|\.py:\d+|\.go:\d+|traceback|stack\s*trace/.test(text),
    has_code_context: contextData.items.some(i => i.type === 'code' || /```/.test(i.content)),
    has_design_question: /should\s+(i|we)|which|how\s+to\s+design|architecture|approach|best\s+way|어떤|어떻게|설계|아키텍처|방법|선택/.test(text),
    has_tradeoff: /\bvs\.?\b|\bor\b(?=\s+\w+\?)|tradeoff|trade-off|pros?\s*(and|\/)\s*cons?|장단점|비교|좋을까/.test(text),
    has_performance: /slow|latency|timeout|performance|optimize|bottleneck|memory\s*usage|cpu|throughput|느림|느려|속도|최적화|병목|타임아웃|지연/.test(text),
    has_security: /vulnerab|injection|xss|csrf|auth\s*bypass|exploit|cve|owasp|secret|credential|보안|취약|인증|권한|토큰\s*유출/.test(text),
    has_infra: /deploy|scale|docker|kubernetes|k8s|ci\s*\/?\s*cd|terraform|helm|aws|gcp|azure|배포|스케일|인프라|컨테이너|클라우드/.test(text),
    has_multiple_dims: constraintData.constraints.length >= 3,
    word_count: text.split(/\s+/).length,
    constraint_count: constraintData.constraints.length,
    context_count: contextData.items.length,
  };

  // Apply compound keywords — activate additional signals
  for (const { pattern, signals: targets } of COMPOUND_SIGNALS) {
    if (pattern.test(text)) {
      for (const s of targets) signals[s] = true;
    }
  }

  // Complexity scoring
  const complexityScore = signals.word_count + signals.constraint_count * 10 + signals.context_count * 5;
  signals.complexity = complexityScore < 30 ? 'trivial' : complexityScore < 80 ? 'low' : complexityScore < 200 ? 'medium' : 'high';

  // ── Weight-based strategy scoring ──
  // Each strategy has signal weights; sum of matched weights = raw score.
  // Raw score is then scaled to confidence via linear mapping [threshold..1.0] → [0.65..0.95].
  // Primary signals (~0.45) alone produce ~0.70 confidence; combos climb toward 0.95.
  const STRATEGY_WEIGHTS = {
    [STRATEGIES.ITERATE]: {
      has_error: 0.45, has_stack_trace: 0.25, has_code_context: 0.15,
      has_performance: 0.30, has_security: 0.30,
    },
    [STRATEGIES.CONSTRAIN]: {
      has_design_question: 0.45, has_tradeoff: 0.30,
      has_multiple_dims: 0.15, has_infra: 0.25,
    },
    [STRATEGIES.DECOMPOSE]: {
      has_multiple_dims: 0.45, has_infra: 0.25,
      has_design_question: 0.15, has_performance: 0.10,
      _complexity_medium_plus: 0.15,
    },
  };

  // Scale raw score → confidence: [SCORE_FLOOR..1.0] maps to [0.65..0.95]
  const SCORE_FLOOR = 0.3;
  const CONF_MIN = 0.65;
  const CONF_MAX = 0.95;
  function scoreToConfidence(raw) {
    if (raw < SCORE_FLOOR) return 0.6;
    const scaled = CONF_MIN + ((raw - SCORE_FLOOR) / (1.0 - SCORE_FLOOR)) * (CONF_MAX - CONF_MIN);
    return Math.min(CONF_MAX, scaled);
  }

  // Compute scores
  const strategyScores = {};
  for (const [strategy, weights] of Object.entries(STRATEGY_WEIGHTS)) {
    let score = 0;
    for (const [signal, weight] of Object.entries(weights)) {
      if (signal === '_complexity_medium_plus') {
        if (signals.complexity === 'medium' || signals.complexity === 'high') score += weight;
      } else if (signals[signal]) {
        score += weight;
      }
    }
    strategyScores[strategy] = score;
  }

  // Pick winner
  const sortedStrategies = Object.entries(strategyScores).sort((a, b) => b[1] - a[1]);
  const [topStrategy, topScore] = sortedStrategies[0];
  const [runnerUp, runnerScore] = sortedStrategies[1] || [null, 0];
  const scoreDelta = topScore - runnerScore;

  // Composite signal count (for display & minor boost)
  const signalCount = [signals.has_error, signals.has_stack_trace, signals.has_code_context,
    signals.has_design_question, signals.has_tradeoff, signals.has_performance,
    signals.has_security, signals.has_infra, signals.has_multiple_dims].filter(Boolean).length;
  const compositeBoost = signalCount >= 4 ? 0.05 : 0;

  // Strategy routing via scores
  let recommended;
  let confidence;
  let reasoning;

  if (signals.complexity === 'trivial' && topScore < 0.3 && !signals.has_error && !signals.has_design_question) {
    recommended = 'direct';
    confidence = 0.95;
    reasoning = 'Simple problem — may not need a full solving strategy';
  } else if (topScore >= SCORE_FLOOR) {
    recommended = topStrategy;
    confidence = Math.min(CONF_MAX, scoreToConfidence(topScore) + compositeBoost);
    // Build reasoning
    const matchedSignals = Object.entries(STRATEGY_WEIGHTS[topStrategy])
      .filter(([s]) => s.startsWith('_') ? (signals.complexity === 'medium' || signals.complexity === 'high') : signals[s])
      .map(([s]) => s.replace(/^(has_|_)/, ''));
    reasoning = `Strongest signal match for ${topStrategy} (${matchedSignals.join(', ')})`;
    if (scoreDelta < 0.15 && runnerUp) {
      reasoning += ` — close runner-up: ${runnerUp} (delta ${Math.round(scoreDelta * 100)}%)`;
    }
  } else {
    recommended = STRATEGIES.PIPELINE;
    confidence = 0.6;
    reasoning = 'No strong signals detected — pipeline will auto-route after deeper analysis';
  }

  // x-op strategy recommendations based on signals
  const xmOpRecommendations = [];
  if (signals.has_error && signals.complexity !== 'trivial') xmOpRecommendations.push({ strategy: 'hypothesis', reason: '원인만 지목하고 끝낼 때 (수정·실행증명 없음). 고쳐야 하면 iterate' });
  if (signals.has_design_question && !signals.has_tradeoff) xmOpRecommendations.push({ strategy: 'socratic', reason: '질문 기반 요구사항 명확화' });
  if (signals.has_design_question && signals.has_multiple_dims) xmOpRecommendations.push({ strategy: 'persona', reason: '다관점 이해관계자 분석' });
  if (signals.has_security) xmOpRecommendations.push({ strategy: 'red-team', reason: '보안 공격/방어 시뮬레이션' });
  if (signals.has_performance) xmOpRecommendations.push({ strategy: 'hypothesis', reason: '병목 원인만 지목할 때. 고쳐서 증명해야 하면 iterate' });
  if (signals.has_infra && signals.has_tradeoff) xmOpRecommendations.push({ strategy: 'debate', reason: '인프라 선택지 찬반 토론' });

  const classification = {
    recommended_strategy: recommended,
    confidence,
    reasoning,
    signals,
    strategy_scores: strategyScores,
    score_delta: scoreDelta,
    composite_boost: compositeBoost,
    xm_op_recommendations: xmOpRecommendations,
    alternative_strategies: Object.values(STRATEGIES).filter(s => s !== recommended),
    classified_at: new Date().toISOString(),
  };

  writeJSON(join(classifyPath(problem), 'classification.json'), classification);

  // Auto-advance phase
  if (m.current_phase === '01-intake') {
    m.current_phase = '02-classify';
    m.updated_at = new Date().toISOString();
    writeJSON(manifestPath(problem), m);
  }

  const info = STRATEGY_LABELS[recommended];
  console.log(`\n${C.bold}Classification Result${C.reset}\n`);
  console.log(`  Recommended: ${info?.icon || '📋'} ${C.bold}${recommended}${C.reset}`);
  console.log(`  Confidence:  ${Math.round(confidence * 100)}%`);
  console.log(`  Reasoning:   ${reasoning}\n`);

  console.log(`  ${C.dim}Signals:${C.reset}`);
  console.log(`    Error: ${signals.has_error}  Stack: ${signals.has_stack_trace}  Code: ${signals.has_code_context}`);
  console.log(`    Design: ${signals.has_design_question}  Tradeoff: ${signals.has_tradeoff}  Multi-dim: ${signals.has_multiple_dims}`);
  console.log(`    Performance: ${signals.has_performance}  Security: ${signals.has_security}  Infra: ${signals.has_infra}`);
  console.log(`    Complexity: ${signals.complexity} (score: ${complexityScore})\n`);

  console.log(`  ${C.dim}Strategy Scores:${C.reset}`);
  for (const [s, sc] of sortedStrategies) {
    const bar = '█'.repeat(Math.round(sc * 20));
    const marker = s === recommended ? ' ◀' : '';
    console.log(`    ${s.padEnd(10)} ${bar} ${Math.round(sc * 100)}%${marker}`);
  }
  if (scoreDelta < 0.15 && runnerUp) {
    console.log(`    ${C.yellow}⚠ Close call (delta ${Math.round(scoreDelta * 100)}%) — consider ${runnerUp} as alternative${C.reset}`);
  }
  console.log();

  if (xmOpRecommendations.length > 0) {
    console.log(`  ${C.bold}x-op Alternatives:${C.reset}`);
    for (const rec of xmOpRecommendations) {
      console.log(`    /xm:op ${rec.strategy} — ${rec.reason}`);
    }
    console.log();
  }

  if (recommended === 'direct') {
    console.log(`  ${C.yellow}Direct path: answer directly, then close when done.${C.reset}`);
    console.log(`  ${C.dim}If this is more complex than expected, choose: x-solver strategy set <decompose|iterate|constrain|pipeline>${C.reset}\n`);
  } else {
    console.log(`  ${C.yellow}Run: x-solver strategy set ${recommended}${C.reset}`);
    console.log(`  ${C.dim}Or choose another: x-solver strategy set <decompose|iterate|constrain|pipeline>${C.reset}\n`);
  }

  // JSON output
  console.log(JSON.stringify({
    action: 'classify',
    problem,
    ...classification,
  }));
}

// ── Strategy ─────────────────────────────────────────────────────────

function cmdStrategy(args) {
  const sub = args[0];
  const problem = requireProblem(args.slice(1));
  const m = readJSON(manifestPath(problem));

  if (sub === 'set') {
    const { positional, opts } = parseOptions(args.slice(1));
    const strategy = positional[0];
    if (!strategy || !Object.values(STRATEGIES).includes(strategy)) {
      console.error(`Usage: x-solver strategy set <${Object.values(STRATEGIES).join('|')}>`);
      process.exit(1);
    }

    // Re-running `strategy set` used to overwrite strategy-state.json wholesale, which
    // reset current_iteration and dropped iteration_extensions, the repro record and
    // every hypothesis. That made the extension cap, the repro gate and the refutation
    // gate all bypassable by one command. Progress is refused unless it is discarded
    // on purpose.
    const existingState = readJSON(join(solvePath(problem), 'strategy-state.json'));
    const started = existingState && (
      existingState.current_phase !== SOLVE_PHASES[existingState.strategy]?.[0]
      || (existingState.phases_completed || []).length > 0
      || (existingState.hypotheses || []).length > 0
      || existingState.repro
    );
    if (started && !(opts.reset === true || typeof opts.reset === 'string')) {
      console.error(`❌ ${existingState.strategy} is already underway (phase: ${existingState.current_phase}).`);
      console.error('   Overwriting would discard the repro record, the hypotheses, and the iteration budget.');
      console.error(`   Continue:  x-solver solve-advance --phase <next>`);
      console.error(`   Start over: x-solver strategy set ${strategy} --reset   (discards the above)`);
      process.exit(1);
    }

    m.strategy = strategy;
    if (m.current_phase === '01-intake' || m.current_phase === '02-classify') {
      m.current_phase = '03-solve';
    }
    m.updated_at = new Date().toISOString();
    writeJSON(manifestPath(problem), m);

    // Initialize strategy state
    const phases = SOLVE_PHASES[strategy];
    writeJSON(join(solvePath(problem), 'strategy-state.json'), {
      strategy,
      current_phase: phases[0],
      phases_completed: [],
      started_at: new Date().toISOString(),
    });

    // For iterate, init the repro record
    if (strategy === STRATEGIES.ITERATE) {
      mkdirSync(join(solvePath(problem), 'repro'), { recursive: true });
      writeJSON(join(solvePath(problem), 'strategy-state.json'), {
        strategy,
        current_phase: SOLVE_PHASES[strategy][0],
        phases_completed: [],
        current_iteration: 0,
        max_iterations: loadConfig().solving?.max_iterations || 3,
        hypotheses: [],
        started_at: new Date().toISOString(),
      });
    }

    // For decompose, init tree
    if (strategy === STRATEGIES.DECOMPOSE) {
      writeJSON(join(solvePath(problem), 'strategy-state.json'), {
        strategy,
        current_phase: 'decompose',
        phases_completed: [],
        tree: {
          id: 'root',
          description: m.display_name,
          children: [],
          status: 'pending',
        },
        max_depth: loadConfig().solving?.max_depth || 2,
        started_at: new Date().toISOString(),
      });
    }

    // For constrain, init matrix
    if (strategy === STRATEGIES.CONSTRAIN) {
      writeJSON(join(solvePath(problem), 'strategy-state.json'), {
        strategy,
        current_phase: 'elicit',
        phases_completed: [],
        constraint_matrix: [],
        started_at: new Date().toISOString(),
      });
    }

    const info = STRATEGY_LABELS[strategy];
    console.log(`\n✅ Strategy set: ${info.icon} ${C.bold}${info.name}${C.reset}`);
    console.log(`   ${info.desc}`);
    console.log(`\n   Phase: ${C.cyan}Solve${C.reset} → ${phases[0]}`);
    console.log(`   Next: x-solver solve\n`);
  } else if (sub === 'show' || !sub) {
    if (!m.strategy) {
      console.log('No strategy set. Run: x-solver classify');
      return;
    }
    const info = STRATEGY_LABELS[m.strategy];
    const stratState = readJSON(join(solvePath(problem), 'strategy-state.json'));
    console.log(`\n  Strategy: ${info.icon} ${C.bold}${info.name}${C.reset}`);
    console.log(`  ${info.desc}`);
    if (stratState?.current_phase) {
      const phases = SOLVE_PHASES[m.strategy];
      const idx = phases.indexOf(stratState.current_phase);
      console.log(`  Solve phase: ${stratState.current_phase} (${idx + 1}/${phases.length})`);
      console.log(`  Completed: ${stratState.phases_completed?.join(', ') || 'none'}`);
    }
    console.log();
  } else {
    console.error('Usage: x-solver strategy <set|show>');
    process.exit(1);
  }
}

// ── Solve ────────────────────────────────────────────────────────────

function cmdSolve(args) {
  const problem = requireProblem(args);
  const { opts } = parseOptions(args);
  const m = readJSON(manifestPath(problem));

  if (!m.strategy) {
    console.error('❌ No strategy set. Run: x-solver classify or x-solver strategy set <name>');
    process.exit(1);
  }

  if (m.current_phase !== '03-solve') {
    m.current_phase = '03-solve';
    m.updated_at = new Date().toISOString();
    writeJSON(manifestPath(problem), m);
  }

  const stratState = readJSON(join(solvePath(problem), 'strategy-state.json'));
  const phases = SOLVE_PHASES[m.strategy];
  const currentPhase = stratState.current_phase;
  const description = readMD(join(intakePath(problem), 'description.md'));
  const contextData = readJSON(join(intakePath(problem), 'context.json')) || { items: [] };
  const constraintData = readJSON(join(intakePath(problem), 'constraints.json')) || { constraints: [] };

  // Build context for agent prompts
  const problemContext = [
    description,
    constraintData.constraints.length > 0
      ? '\n## Constraints\n' + constraintData.constraints.map(c => `- [${c.type.toUpperCase()}] ${c.description}`).join('\n')
      : '',
    contextData.items.length > 0
      ? '\n## Additional Context\n' + contextData.items.map(i => i.content).join('\n\n')
      : '',
  ].join('\n');

  // Output JSON for SKILL.md to orchestrate agents
  const output = {
    action: 'solve',
    problem,
    strategy: m.strategy,
    current_phase: currentPhase,
    next_phase: phases[phases.indexOf(currentPhase) + 1] || null,
    step_only: !!opts.step,
    agent_count: getAgentCount(),
    problem_context: problemContext,
    constraints: constraintData.constraints,
    strategy_state: stratState,
    candidates: readJSON(join(solvePath(problem), 'candidates.json'))?.candidates || [],
  };

  console.log(`\n${C.bold}Solving: ${m.display_name}${C.reset}`);
  console.log(`  Strategy: ${STRATEGY_LABELS[m.strategy]?.icon} ${m.strategy}`);
  console.log(`  Phase: ${C.cyan}${currentPhase}${C.reset}`);
  console.log(`  Progress: ${renderBar(phases.indexOf(currentPhase), phases.length)}\n`);

  console.log(JSON.stringify(output));
}

// ── Solve Phase Advance ──────────────────────────────────────────────

function cmdSolveAdvance(args) {
  const problem = requireProblem(args);
  const { opts } = parseOptions(args);
  const m = readJSON(manifestPath(problem));
  const stratState = readJSON(join(solvePath(problem), 'strategy-state.json'));
  const phases = SOLVE_PHASES[m.strategy];

  if (!opts.phase) {
    console.error('Usage: x-solver solve-advance --phase <phase-name>');
    process.exit(1);
  }

  if (!m.strategy || !phases) {
    console.error('❌ No valid strategy set. Run: x-solver strategy set <decompose|iterate|constrain|pipeline>');
    process.exit(1);
  }

  if (!stratState?.strategy || !stratState.current_phase) {
    console.error('❌ No active solve phase. Run: x-solver strategy set <name> first.');
    process.exit(1);
  }

  const currentIdx = phases.indexOf(stratState.current_phase);
  const targetIdx = phases.indexOf(opts.phase);
  const isIterateRetry = m.strategy === STRATEGIES.ITERATE
    && stratState.current_phase === 'refine'
    && opts.phase === 'hypothesize';

  if (currentIdx === -1) {
    console.error(`❌ Current solve phase "${stratState.current_phase}" is invalid for strategy "${m.strategy}".`);
    process.exit(1);
  }
  if (targetIdx === -1) {
    console.error(`❌ Unknown solve phase "${opts.phase}" for strategy "${m.strategy}". Valid: ${phases.join(', ')}`);
    process.exit(1);
  }
  if (targetIdx !== currentIdx + 1 && !isIterateRetry) {
    console.error(`❌ Invalid phase transition: ${stratState.current_phase} → ${opts.phase}. Expected: ${phases[currentIdx + 1] || '(complete)'}`);
    process.exit(1);
  }

  // A fix is only a fix if something outside the hypothesis's own verifier agreed.
  // `single-signal` is explicitly not enough for a root-cause claim.
  if (m.strategy === STRATEGIES.ITERATE && stratState.current_phase === 'refine' && opts.phase === 'resolve') {
    const unconfirmed = typeof opts.unconfirmed === 'string' ? opts.unconfirmed : null;
    const survived = (stratState.hypotheses || []).filter(
      (h) => h.status === 'confirmed' && h.refutation === 'survived',
    );
    if (!survived.length && unconfirmed !== 'narrow') {
      const confirmed = (stratState.hypotheses || []).filter((h) => h.status === 'confirmed');
      console.error(confirmed.length
        ? '❌ Confirmed hypotheses have not survived an independent refuter.'
        : '❌ No confirmed hypothesis. resolve would be applying a guess.');
      console.error('   Run one refuter per confirmed hypothesis, then record the verdict:');
      console.error('   x-solver hypotheses update <id> --refutation survived|falsified|single-signal --refuted-by refuter-1');
      console.error('   Mitigating without a known cause is a valid answer — say so explicitly:');
      console.error('   x-solver solve-advance --phase resolve --unconfirmed narrow --justification "..."');
      process.exit(1);
    }
    if (unconfirmed === 'narrow') {
      const justification = typeof opts.justification === 'string' ? opts.justification.trim() : '';
      if (!justification) {
        console.error('❌ --unconfirmed narrow requires --justification.');
        process.exit(1);
      }
      stratState.resolve_mode = 'narrow';
      stratState.resolve_justification = justification;
      console.error('⚠️  resolve is limited to reversible, evidence-gathering changes (logging, assertions, a failing test).');
      console.error('   The close summary will state that the cause is still unknown.');
    } else {
      stratState.resolve_mode = 'root_cause';
    }
  }

  // Leaving `reproduce` without a repro record would make every later phase reason
  // about a failure nobody has seen.
  if (m.strategy === STRATEGIES.ITERATE && stratState.current_phase === 'reproduce' && !stratState.repro?.status) {
    console.error('❌ No reproduction recorded. A fix you cannot see fail is a fix you cannot prove.');
    console.error('   x-solver repro set --command "<cmd>" --output-file <captured> --exit-code <n> \\');
    console.error('     --failure-marker "<literal substring from that output>" --status reproduced');
    console.error('   Cannot reproduce it? Say so instead of guessing:');
    console.error('   x-solver repro set --status unavailable --justification "<what you tried>"');
    process.exit(1);
  }
  // Problems started before the reproduce phase existed have no record and never
  // will. Warn, never block — stranding them would be worse than the missing evidence.
  if (m.strategy === STRATEGIES.ITERATE
      && stratState.current_phase === 'diagnose'
      && !stratState.repro?.status
      && !(stratState.phases_completed || []).includes('reproduce')) {
    console.error('⚠️  No repro record (this problem predates the reproduce gate).');
    console.error('   Consider: x-solver repro set --command "..." ... before claiming a fix.');
  }

  let grantedThisCall = null;
  if (isIterateRetry) {
    const currentIteration = Number.isInteger(stratState.current_iteration)
      ? stratState.current_iteration
      : 0;
    const maxIterations = stratState.max_iterations || loadConfig().solving?.max_iterations || 3;
    if (currentIteration + 1 > maxIterations) {
      const extend = opts['extend-iterations'] !== undefined ? Number(opts['extend-iterations']) : null;
      const extensions = Number.isInteger(stratState.iteration_extensions) ? stratState.iteration_extensions : 0;
      const justification = typeof opts.justification === 'string' ? opts.justification.trim() : '';
      if (extend !== null) {
        // Capped so "extend" cannot become an unbounded loop wearing a flag.
        if (extensions >= MAX_ITERATION_EXTENSIONS) {
          console.error(`❌ Already extended ${extensions} times (cap ${MAX_ITERATION_EXTENSIONS}). Narrow the scope or abandon:`);
          console.error('   x-solver solve-advance --phase resolve --unconfirmed narrow --justification "..."');
          console.error('   x-solver close --abandon --summary "..."');
          process.exit(1);
        }
        if (!Number.isInteger(extend) || extend < 1 || extend > MAX_ITERATIONS_PER_EXTENSION) {
          console.error(`❌ --extend-iterations takes 1..${MAX_ITERATIONS_PER_EXTENSION}. Counting extension events alone would let one call grant an unbounded budget.`);
          process.exit(1);
        }
        if (!justification) {
          console.error('❌ --extend-iterations requires --justification: what will the next round do differently?');
          process.exit(1);
        }
        grantedThisCall = { max_iterations: stratState.max_iterations, iteration_extensions: stratState.iteration_extensions };
        stratState.max_iterations = maxIterations + extend;
        stratState.iteration_extensions = extensions + 1;
        console.error(`⚠️  Iterations extended to ${stratState.max_iterations} (extension ${stratState.iteration_extensions}/${MAX_ITERATION_EXTENSIONS}): ${justification}`);
      } else {
        console.error(`❌ Max iterations reached (${maxIterations}). Resolving on an unconfirmed hypothesis is a guess, not a fix.`);
        console.error('   Pick an exit:');
        console.error('   1) narrow   — reversible instrumentation only, cause still unknown:');
        console.error('      x-solver solve-advance --phase resolve --unconfirmed narrow --justification "..."');
        console.error(`   2) extend   — one more round, and say what changes (max ${MAX_ITERATION_EXTENSIONS} extensions):`);
        console.error('      x-solver solve-advance --phase hypothesize --extend-iterations 2 --justification "..."');
        console.error('   3) abandon  — keep the diagnosis, stop honestly:');
        console.error('      x-solver close --abandon --summary "..."');
        process.exit(1);
      }
    }

    // Accumulate iteration outputs for convergence detection.
    // Each entry: { output: string, score?: number } — populated by the caller
    // via --output and --score flags when available.
    if (!Array.isArray(stratState.iteration_outputs)) {
      stratState.iteration_outputs = [];
    }
    const iterOutput = opts.output ?? '';
    const iterScore = opts.score !== undefined ? Number(opts.score) : undefined;
    const iterEntry = iterScore !== undefined
      ? { output: iterOutput, score: iterScore }
      : { output: iterOutput };
    stratState.iteration_outputs.push(iterEntry);

    // Convergence/stagnation/oscillation check — may stop before max_iterations.
    const cfg = loadConfig().solving ?? {};
    const convergeThreshold = cfg.converge_threshold ?? undefined; // undefined → use detectStop default
    const stagnationN = cfg.stagnation_n ?? undefined;
    const stopResult = detectStop(
      stratState.iteration_outputs,
      {
        ...(convergeThreshold !== undefined && { convergeThreshold }),
        ...(stagnationN !== undefined && { stagnationN }),
      }
    );
    if (stopResult.stop) {
      if (grantedThisCall) Object.assign(stratState, grantedThisCall);
      stratState.stop_reason = stopResult.reason;
      stratState.stop_detail = stopResult.detail;
      stratState.updated_at = new Date().toISOString();
      writeJSON(join(solvePath(problem), 'strategy-state.json'), stratState);
      console.error(`⚠️  Early stop (${stopResult.reason}): ${stopResult.detail}`);
      console.error('   Repeating the same round in new words does not become productive with more budget.');
      console.error('   Pick an exit:');
      console.error('   1) narrow  — reversible instrumentation only, cause still unknown:');
      console.error('      x-solver solve-advance --phase resolve --unconfirmed narrow --justification "..."');
      console.error('   2) abandon — keep the diagnosis, stop honestly:');
      console.error('      x-solver close --abandon --summary "..."');
      process.exit(1);
    }

    stratState.current_iteration = currentIteration + 1;
  }

  stratState.phases_completed = stratState.phases_completed || [];
  if (!stratState.phases_completed.includes(stratState.current_phase)) {
    stratState.phases_completed.push(stratState.current_phase);
  }
  if (isIterateRetry) {
    stratState.phases_completed = stratState.phases_completed.filter(
      (phase) => phases.indexOf(phase) !== -1 && phases.indexOf(phase) < targetIdx
    );
  }
  stratState.current_phase = opts.phase;
  stratState.updated_at = new Date().toISOString();
  writeJSON(join(solvePath(problem), 'strategy-state.json'), stratState);

  console.log(`✅ Advanced to solve phase: ${opts.phase}`);
}

// ── Solve Status ─────────────────────────────────────────────────────

function cmdSolveStatus(args) {
  const problem = requireProblem(args);
  const m = readJSON(manifestPath(problem));
  const stratState = readJSON(join(solvePath(problem), 'strategy-state.json'));

  if (!m.strategy || !stratState?.strategy) {
    console.log('No active solving session.');
    return;
  }

  const phases = SOLVE_PHASES[m.strategy];
  const info = STRATEGY_LABELS[m.strategy];

  console.log(`\n${C.bold}Solve Status: ${info.icon} ${info.name}${C.reset}\n`);

  for (const ph of phases) {
    const completed = stratState.phases_completed?.includes(ph);
    const current = stratState.current_phase === ph;
    const icon = completed ? `${C.green}✓${C.reset}` : current ? `${C.cyan}▶${C.reset}` : `${C.dim}○${C.reset}`;
    console.log(`  ${icon} ${current ? C.bold : ''}${ph}${current ? C.reset : ''}`);
  }

  // Strategy-specific info
  if (m.strategy === 'iterate' && stratState.hypotheses?.length) {
    console.log(`\n  Hypotheses: ${stratState.hypotheses.length}`);
    console.log(`  Iteration: ${stratState.current_iteration}/${stratState.max_iterations}`);
  }

  if (m.strategy === 'decompose' && stratState.tree?.children?.length) {
    console.log(`\n  Sub-problems: ${stratState.tree.children.length}`);
    const solved = stratState.tree.children.filter(c => c.status === 'solved').length;
    console.log(`  Solved: ${renderBar(solved, stratState.tree.children.length)}`);
  }

  const candidates = readJSON(join(solvePath(problem), 'candidates.json'));
  if (candidates?.candidates?.length) {
    console.log(`\n  Candidates: ${candidates.candidates.length}`);
  }

  console.log();
}

// ── Reproduction (iterate) ───────────────────────────────────────────

/**
 * Keep the tail — a failure marker is near the end far more often than the start.
 * `marker`, when given, must survive: the stored text is the only durable evidence,
 * and trimming the marker out of it after validating against the full text would
 * leave a record that proves nothing.
 */
function tailBound(text, marker = null) {
  const full = String(text);
  const lines = full.split('\n');
  let out = lines.slice(-REPRO_TAIL_LINES).join('\n');
  let truncated = lines.length > REPRO_TAIL_LINES;
  if (Buffer.byteLength(out, 'utf8') > REPRO_TAIL_BYTES) {
    out = Buffer.from(out, 'utf8').subarray(-REPRO_TAIL_BYTES).toString('utf8');
    truncated = true;
  }
  if (marker && full.includes(marker) && !out.includes(marker)) {
    const at = full.indexOf(marker);
    const start = Math.max(0, at - Math.floor(REPRO_TAIL_BYTES / 2));
    out = `${truncated ? '[... truncated — window centred on the failure marker ...]\n' : ''}`
      + Buffer.from(full.slice(start), 'utf8').subarray(0, REPRO_TAIL_BYTES).toString('utf8');
    truncated = true;
  }
  return { text: out, truncated };
}

/**
 * How many consecutive clean runs make a fix distinguishable from luck, at the
 * observed failure rate. Computed, not judged: k = ceil(ln(0.05) / ln(1 - p)), so
 * the chance of that many clean runs happening anyway is at most 5%.
 * 3/10 -> 9, 1/10 -> 29. Capped, because a rate low enough to need hundreds of runs
 * is not something a solve session can prove by repetition.
 */
function requiredCleanRuns(failed, total) {
  const p = failed / total;
  if (!(p > 0 && p < 1)) return 1;
  return Math.min(50, Math.ceil(Math.log(0.05) / Math.log(1 - p)));
}

/** `N/M`, both integers, 0 < N < M. Anything else is not an observed rate. */
function parseRuns(value) {
  const match = /^(\d+)\/(\d+)$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const failed = Number(match[1]);
  const total = Number(match[2]);
  if (!(total > 0) || !(failed >= 0) || failed > total) return null;
  return { failed, total };
}

/**
 * Fingerprint of the working tree. Compared across `repro set` and `repro verify` it
 * answers one question the output alone cannot: did anything actually change? An
 * identical digest means the "fix" edited nothing.
 * Returns null where git cannot answer; the caller then records that it could not check.
 */
function worktreeDigest() {
  try {
    const head = execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
    // `git status --porcelain` alone is path + status letters, so editing a file that
    // was ALREADY modified when the repro was recorded leaves the digest unchanged —
    // and that is the most common iterate case (an uncommitted edit broke it, and the
    // fix touches that same file). Hash tracked content instead, and mix in the
    // untracked list separately so a new evidence file cannot masquerade as a fix.
    const content = execSync('git diff HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
    const untracked = execSync('git ls-files --others --exclude-standard', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
    return {
      tracked: createHash('sha256').update(`${head}\n${content}`).digest('hex').slice(0, 16),
      untracked: createHash('sha256').update(untracked).digest('hex').slice(0, 16),
    };
  } catch {
    return null;
  }
}

function readCapturedOutput(opts) {
  if (typeof opts['output-file'] === 'string') {
    if (!existsSync(opts['output-file'])) return { error: `Output file not found: ${opts['output-file']}` };
    return { text: readFileSync(opts['output-file'], 'utf8') };
  }
  if (typeof opts.output === 'string') return { text: opts.output };
  return { error: 'Provide the captured output: --output "<text>" or --output-file <path>' };
}

function cmdRepro(args) {
  const sub = args[0];
  const problem = requireProblem(args.slice(1));
  const { opts } = parseOptions(args.slice(1));
  const statePath = join(solvePath(problem), 'strategy-state.json');
  const stratState = readJSON(statePath);

  if (!stratState || stratState.strategy !== STRATEGIES.ITERATE) {
    console.error('❌ repro is part of the iterate strategy. Run: x-solver strategy set iterate');
    process.exitCode = 1;
    return;
  }

  const reproDir = join(solvePath(problem), 'repro');

  if (sub === 'show') {
    console.log(JSON.stringify({ action: 'repro', sub: 'show', problem, repro: stratState.repro ?? null }));
    return;
  }

  if (sub === 'set') {
    if (stratState.current_phase !== 'reproduce') {
      console.error(`❌ repro set belongs to the reproduce phase (currently: ${stratState.current_phase}).`);
      console.error('   Recording the failure after the fix would prove nothing about the order of events.');
      process.exitCode = 1;
      return;
    }
    const status = typeof opts.status === 'string' ? opts.status : 'reproduced';
    if (!REPRO_STATUSES.includes(status)) {
      console.error(`❌ Unknown --status "${status}". One of: ${REPRO_STATUSES.join(', ')}`);
      process.exitCode = 1;
      return;
    }

    if (status === 'unavailable') {
      const justification = typeof opts.justification === 'string' ? opts.justification.trim() : '';
      if (!justification) {
        console.error('❌ --status unavailable requires --justification: what did you try, and which case is it?');
        console.error('   (environment-only / symptom already gone / needs production scale / no failing instance)');
        process.exitCode = 1;
        return;
      }
      stratState.repro = {
        status,
        justification,
        command: null,
        failure_marker: null,
        before: null,
        baseline_commit: typeof opts['baseline-commit'] === 'string' ? opts['baseline-commit'] : null,
        worktree_digest: worktreeDigest(),
        recorded_at: new Date().toISOString(),
      };
      // The message promised a limit; record it so the limit is real state, not prose.
      stratState.resolve_mode = 'narrow';
      stratState.resolve_justification = justification;
      writeJSON(statePath, stratState);
      console.log(`⚠️  Reproduction unavailable — recorded. resolve is limited to reversible, evidence-gathering changes.`);
      console.log(JSON.stringify({ action: 'repro', sub: 'set', problem, repro: stratState.repro }));
      return;
    }

    const command = typeof opts.command === 'string' ? opts.command.trim() : '';
    if (!command) {
      console.error('❌ --command is required: one command a stranger could run to see this fail.');
      process.exitCode = 1;
      return;
    }
    const captured = readCapturedOutput(opts);
    if (captured.error) {
      console.error(`❌ ${captured.error}`);
      process.exitCode = 1;
      return;
    }
    const marker = typeof opts['failure-marker'] === 'string' ? opts['failure-marker'].trim() : '';
    if (!marker) {
      console.error('❌ --failure-marker is required: a literal substring that appears only when the bug happens.');
      process.exitCode = 1;
      return;
    }
    // The one check that makes the whole gate load-bearing: the marker has to be in
    // the text that was actually captured. Without it the marker is a wish.
    if (!captured.text.includes(marker)) {
      console.error(`❌ The failure marker is not in the captured output: ${JSON.stringify(marker)}`);
      console.error('   Pick the marker FROM the output you pasted, not from memory.');
      process.exitCode = 1;
      return;
    }
    let exitCode = null;
    if (opts['exit-code'] !== undefined) {
      exitCode = Number(opts['exit-code']);
      if (!Number.isInteger(exitCode) || exitCode < 0) {
        console.error(`❌ --exit-code must be a non-negative integer, got ${JSON.stringify(opts['exit-code'])}.`);
        process.exitCode = 1;
        return;
      }
    }

    let runs = null;
    if (status === 'intermittent') {
      runs = parseRuns(opts.runs);
      if (!runs || runs.failed === 0 || runs.failed === runs.total) {
        console.error('❌ --status intermittent requires --runs N/M with 0 < N < M (e.g. --runs 3/10).');
        console.error('   A rate is what separates an intermittent failure from a failed reproduction attempt.');
        process.exitCode = 1;
        return;
      }
    }

    const bounded = tailBound(captured.text, marker);
    mkdirSync(reproDir, { recursive: true });
    writeFileSync(join(reproDir, 'before.out.txt'), bounded.text, 'utf8');

    stratState.repro = {
      status,
      command,
      failure_marker: marker,
      justification: null,
      runs: runs ? `${runs.failed}/${runs.total}` : null,
      required_clean_runs: runs ? requiredCleanRuns(runs.failed, runs.total) : null,
      before: {
        exit_code: exitCode,
        output_path: 'repro/before.out.txt',
        truncated: bounded.truncated,
      },
      baseline_commit: typeof opts['baseline-commit'] === 'string' ? opts['baseline-commit'] : null,
      worktree_digest: worktreeDigest(),
      after: null,
      regression_proof: 'absent',
      recorded_at: new Date().toISOString(),
    };
    writeJSON(statePath, stratState);
    writeJSON(join(reproDir, 'before.json'), stratState.repro);

    console.log(`✅ Reproduction recorded (${status}).`);
    console.log(`   Command: ${command}`);
    console.log(`   Marker:  ${marker}`);
    if (runs) console.log(`   Rate: ${runs.failed}/${runs.total} — a fix needs ${stratState.repro.required_clean_runs} clean runs to beat chance.`);
    console.log(JSON.stringify({ action: 'repro', sub: 'set', problem, repro: stratState.repro }));
    return;
  }

  if (sub === 'verify') {
    const repro = stratState.repro;
    if (!repro || repro.status === 'unavailable') {
      console.error('❌ Nothing to verify against: no reproduction was recorded.');
      process.exitCode = 1;
      return;
    }
    if (stratState.current_phase !== 'resolve') {
      console.error(`❌ repro verify belongs to the resolve phase (currently: ${stratState.current_phase}).`);
      process.exitCode = 1;
      return;
    }
    // Deliberately no --command flag. Re-running the recorded command is the whole
    // point; letting the caller supply a new one would let a narrowed command pass.
    const captured = readCapturedOutput(opts);
    if (captured.error) {
      console.error(`❌ ${captured.error}`);
      console.error(`   Re-run the recorded command and capture it: ${repro.command}`);
      process.exitCode = 1;
      return;
    }
    // An empty capture also "does not contain the marker". Absence of output is not
    // evidence of a fix — it is evidence that nothing was captured.
    if (!captured.text.trim()) {
      console.error('❌ The after-run capture is empty. An empty output does not show the failure is gone.');
      console.error(`   Re-run and capture it: ${repro.command}`);
      process.exitCode = 1;
      return;
    }
    if (captured.text.includes(repro.failure_marker)) {
      console.error(`❌ The failure marker is still present: ${JSON.stringify(repro.failure_marker)}`);
      console.error('   The bug still reproduces. This is not a fix yet.');
      process.exitCode = 1;
      return;
    }
    const afterExit = opts['exit-code'] !== undefined ? Number(opts['exit-code']) : null;
    if (afterExit !== 0) {
      console.error(`❌ The command still exits ${afterExit}. Pass --exit-code 0 only when it actually succeeds.`);
      process.exitCode = 1;
      return;
    }

    const nowDigest = worktreeDigest();
    const beforeDigest = repro.worktree_digest;
    // Only the tracked half decides. An untracked file — such as the captured output
    // this very workflow tells the agent to write — must not count as "something changed".
    const comparable = nowDigest !== null && beforeDigest !== null
      && typeof nowDigest.tracked === 'string' && typeof beforeDigest.tracked === 'string';
    const unchanged = comparable && nowDigest.tracked === beforeDigest.tracked;
    const allowNoDiff = opts['allow-no-diff'] === true || typeof opts['allow-no-diff'] === 'string';
    if (unchanged && !allowNoDiff) {
      console.error('❌ Tracked files are identical to when the failure was recorded.');
      console.error('   Nothing was changed, so nothing was fixed — the command simply behaved differently.');
      console.error('   If that is genuinely the finding: --allow-no-diff --justification "<why>"');
      process.exitCode = 1;
      return;
    }
    if (unchanged && allowNoDiff && !(typeof opts.justification === 'string' && opts.justification.trim())) {
      console.error('❌ --allow-no-diff requires --justification.');
      process.exitCode = 1;
      return;
    }
    // Not comparable is not the same as verified. Say so rather than recording a
    // check that never ran as though it had passed.
    if (!comparable) {
      console.error('⚠️  Could not compare the working tree (git unavailable or digest missing).');
      console.error('   The "something actually changed" check did not run; the record says so.');
    }

    let cleanRuns = null;
    let proof = 'proven';
    if (repro.status === 'intermittent') {
      cleanRuns = parseRuns(opts.runs);
      const needed = repro.required_clean_runs ?? 1;
      if (!cleanRuns || cleanRuns.failed !== 0) {
        console.error(`❌ An intermittent failure needs clean runs: --runs 0/${needed}`);
        console.error(`   One passing run at rate ${repro.runs} happens by chance more often than not.`);
        process.exitCode = 1;
        return;
      }
      if (cleanRuns.total < needed) {
        console.error(`⚠️  ${cleanRuns.total} clean runs is below the ${needed} needed at rate ${repro.runs}.`);
        proof = 'degraded';
      }
    }

    const regressionTest = typeof opts['regression-test'] === 'string' ? opts['regression-test'] : null;
    if (regressionTest && !existsSync(regressionTest)) {
      console.error(`❌ --regression-test path does not exist: ${regressionTest}`);
      process.exitCode = 1;
      return;
    }

    const bounded = tailBound(captured.text);
    mkdirSync(reproDir, { recursive: true });
    writeFileSync(join(reproDir, 'after.out.txt'), bounded.text, 'utf8');

    repro.after = {
      exit_code: afterExit,
      output_path: 'repro/after.out.txt',
      truncated: bounded.truncated,
      clean_runs: cleanRuns ? `${cleanRuns.failed}/${cleanRuns.total}` : null,
      regression_test: regressionTest,
      worktree_digest: nowDigest,
      worktree_unchanged: comparable ? unchanged : null,
      worktree_comparable: comparable,
      justification: unchanged ? String(opts.justification).trim() : null,
      verified_at: new Date().toISOString(),
    };
    repro.regression_proof = proof;
    writeJSON(statePath, stratState);
    writeJSON(join(reproDir, 'after.json'), repro.after);

    console.log(`✅ Regression proof: ${proof}. The marker is gone and the command exits 0.`);
    if (!regressionTest) console.log('   No --regression-test given: nothing pins this fix against coming back.');
    console.log(JSON.stringify({ action: 'repro', sub: 'verify', problem, repro }));
    return;
  }

  console.error('Usage: x-solver repro <set|verify|show>');
  process.exitCode = 1;
}

// ── Hypotheses (iterate) ─────────────────────────────────────────────

function cmdHypotheses(args) {
  const sub = args[0];
  const problem = requireProblem(args.slice(1));
  const stratState = readJSON(join(solvePath(problem), 'strategy-state.json'));

  if (!stratState || stratState.strategy !== 'iterate') {
    console.error('❌ Hypotheses only available in iterate strategy.');
    process.exit(1);
  }

  if (sub === 'list' || !sub) {
    const hypos = stratState.hypotheses || [];
    if (hypos.length === 0) {
      console.log('No hypotheses yet.');
      return;
    }
    const statusIcons = {
      pending: '⬜', confirmed: '✅', refuted: '❌', inconclusive: '🟡',
    };
    console.log(`\n${C.bold}Hypotheses${C.reset} (${hypos.length})\n`);
    for (const h of hypos) {
      console.log(`  ${statusIcons[h.status] || '❓'} ${C.bold}${h.id}${C.reset}: ${h.description}`);
      if (h.evidence_for?.length) console.log(`    ${C.green}+${C.reset} ${h.evidence_for.join('; ')}`);
      if (h.evidence_against?.length) console.log(`    ${C.red}-${C.reset} ${h.evidence_against.join('; ')}`);
      console.log();
    }
  } else if (sub === 'add') {
    const { positional, opts } = parseOptions(args.slice(1));
    const description = positional.join(' ') || opts.content;
    if (!description) {
      console.error('Usage: x-solver hypotheses add "description"');
      process.exit(1);
    }
    if (!stratState.hypotheses) stratState.hypotheses = [];
    stratState.hypotheses.push({
      id: `h${stratState.hypotheses.length + 1}`,
      description,
      status: 'pending',
      evidence_for: [],
      evidence_against: [],
      test_result: null,
    });
    writeJSON(join(solvePath(problem), 'strategy-state.json'), stratState);
    console.log(`✅ Hypothesis h${stratState.hypotheses.length} added.`);
  } else if (sub === 'update') {
    const { positional, opts } = parseOptions(args.slice(1));
    const id = positional[0];
    if (!id) {
      console.error('Usage: x-solver hypotheses update <id> --status <pending|confirmed|refuted|inconclusive> [--refutation <survived|falsified|single-signal>]');
      process.exit(1);
    }
    const h = stratState.hypotheses?.find(h => h.id === id);
    if (!h) {
      console.error(`❌ Hypothesis "${id}" not found.`);
      process.exit(1);
    }
    if (opts.status) h.status = opts.status;
    if (opts.evidence_for) h.evidence_for.push(opts.evidence_for);
    if (opts.evidence_against) h.evidence_against.push(opts.evidence_against);
    if (opts.test_result) h.test_result = opts.test_result;
    // A hypothesis verified by the agent that owns it has corroborated nothing.
    // `single-signal` is the honest middle: plausible, but only one source says so.
    if (opts.refutation) {
      const REFUTATIONS = ['survived', 'falsified', 'single-signal'];
      if (!REFUTATIONS.includes(opts.refutation)) {
        console.error(`❌ Unknown --refutation "${opts.refutation}". One of: ${REFUTATIONS.join(', ')}`);
        process.exit(1);
      }
      h.refutation = opts.refutation;
      if (opts['refuted-by']) h.refuted_by = opts['refuted-by'];
    }
    writeJSON(join(solvePath(problem), 'strategy-state.json'), stratState);
    console.log(`✅ Hypothesis ${id} updated.`);
  } else {
    console.error('Usage: x-solver hypotheses <list|add|update>');
    process.exit(1);
  }
}

// ── Tree (decompose) ─────────────────────────────────────────────────

function cmdTree(args) {
  const sub = args[0] || 'show';
  const problem = requireProblem(args.slice(1));
  const stratState = readJSON(join(solvePath(problem), 'strategy-state.json'));

  if (!stratState || stratState.strategy !== 'decompose') {
    console.error('❌ Tree only available in decompose strategy.');
    process.exit(1);
  }

  if (sub === 'show') {
    const tree = stratState.tree;
    if (!tree) {
      console.log('No tree yet. Run: x-solver solve');
      return;
    }
    console.log(`\n${C.bold}Problem Tree${C.reset}\n`);
    printTree(tree, '');
    console.log();
  } else if (sub === 'add') {
    const { positional, opts } = parseOptions(args.slice(1));
    const description = positional.join(' ') || opts.content;
    if (!description) {
      console.error('Usage: x-solver tree add "sub-problem description" [--difficulty trivial|medium|hard]');
      process.exit(1);
    }
    if (!stratState.tree.children) stratState.tree.children = [];
    stratState.tree.children.push({
      id: `sp${stratState.tree.children.length + 1}`,
      description,
      difficulty: opts.difficulty || 'medium',
      status: 'pending',
      candidates: [],
      selected: null,
    });
    writeJSON(join(solvePath(problem), 'strategy-state.json'), stratState);
    console.log(`✅ Sub-problem sp${stratState.tree.children.length} added.`);
  } else if (sub === 'update') {
    const { positional, opts } = parseOptions(args.slice(1));
    const id = positional[0];
    if (!id) {
      console.error('Usage: x-solver tree update <id> --status <pending|solving|solved>');
      process.exit(1);
    }
    const child = stratState.tree.children?.find(c => c.id === id);
    if (!child) {
      console.error(`❌ Sub-problem "${id}" not found.`);
      process.exit(1);
    }
    if (opts.status) child.status = opts.status;
    if (opts.selected) child.selected = opts.selected;
    writeJSON(join(solvePath(problem), 'strategy-state.json'), stratState);
    console.log(`✅ Sub-problem ${id} updated.`);
  } else {
    console.error('Usage: x-solver tree <show|add|update>');
    process.exit(1);
  }
}

function printTree(node, prefix) {
  const statusIcons = { pending: '⬜', solving: '🔵', solved: '✅' };
  const icon = statusIcons[node.status] || '❓';
  console.log(`${prefix}${icon} ${C.bold}${node.id}${C.reset}: ${node.description}`);
  if (node.difficulty) console.log(`${prefix}   difficulty: ${node.difficulty}`);
  if (node.selected) console.log(`${prefix}   selected: ${node.selected}`);
  if (node.children) {
    for (const child of node.children) {
      printTree(child, prefix + '  ');
    }
  }
}

// ── Candidates ───────────────────────────────────────────────────────

function cmdCandidates(args) {
  const sub = args[0];
  const problem = requireProblem(args.slice(1));
  const candidateFile = join(solvePath(problem), 'candidates.json');

  if (sub === 'list' || !sub) {
    const data = readJSON(candidateFile) || { candidates: [] };
    if (data.candidates.length === 0) {
      console.log('No candidates yet.');
      return;
    }
    console.log(`\n${C.bold}Solution Candidates${C.reset} (${data.candidates.length})\n`);
    for (const c of data.candidates) {
      const sel = c.selected ? ` ${C.green}★ SELECTED${C.reset}` : '';
      console.log(`  ${C.cyan}${c.id}${C.reset}${sel} (from: ${c.source || 'manual'})`);
      if (c.sub_problem) console.log(`    Sub-problem: ${c.sub_problem}`);
      console.log(`    ${c.description}`);
      if (c.scores && Object.keys(c.scores).length > 0) {
        console.log(`    Scores: ${JSON.stringify(c.scores)}`);
      }
      console.log();
    }
  } else if (sub === 'add') {
    const { opts, positional } = parseOptions(args.slice(1));
    const description = positional.join(' ') || opts.content;
    if (!description) {
      console.error('Usage: x-solver candidates add "description" [--source agent-1] [--sub-problem sp1]');
      process.exit(1);
    }
    const data = readJSON(candidateFile) || { candidates: [] };
    data.candidates.push({
      id: `cand-${data.candidates.length + 1}`,
      source: opts.source || 'manual',
      sub_problem: opts['sub-problem'] || null,
      description,
      details: opts.details || '',
      scores: {},
      selected: false,
      created_at: new Date().toISOString(),
    });
    writeJSON(candidateFile, data);
    console.log(`✅ Candidate cand-${data.candidates.length} added.`);
  } else if (sub === 'select') {
    const { positional } = parseOptions(args.slice(1));
    const id = positional[0];
    if (!id) {
      console.error('Usage: x-solver candidates select <id>');
      process.exit(1);
    }
    const data = readJSON(candidateFile) || { candidates: [] };
    const cand = data.candidates.find(c => c.id === id);
    if (!cand) {
      console.error(`❌ Candidate "${id}" not found.`);
      process.exit(1);
    }
    // Deselect others
    for (const c of data.candidates) c.selected = false;
    cand.selected = true;
    writeJSON(candidateFile, data);
    console.log(`✅ Candidate ${id} selected.`);
  } else if (sub === 'score') {
    const { positional, opts } = parseOptions(args.slice(1));
    const id = positional[0];
    if (!id || !opts.constraint || !opts.score) {
      console.error('Usage: x-solver candidates score <id> --constraint c1 --score 8');
      process.exit(1);
    }
    const data = readJSON(candidateFile) || { candidates: [] };
    const cand = data.candidates.find(c => c.id === id);
    if (!cand) {
      console.error(`❌ Candidate "${id}" not found.`);
      process.exit(1);
    }
    cand.scores[opts.constraint] = parseFloat(opts.score);
    writeJSON(candidateFile, data);
    console.log(`✅ Candidate ${id} scored: ${opts.constraint}=${opts.score}`);
  } else {
    console.error('Usage: x-solver candidates <list|add|select|score>');
    process.exit(1);
  }
}

// ── Phase Management ─────────────────────────────────────────────────

function cmdPhase(args) {
  const sub = args[0];
  const problem = requireProblem(args.slice(1));
  const m = readJSON(manifestPath(problem));
  const currentIdx = PHASES.findIndex(p => p.id === m.current_phase);

  if (sub === 'next') {
    if (currentIdx >= PHASES.length - 1) {
      console.log('Already at the last phase.');
      return;
    }
    const next = PHASES[currentIdx + 1];
    m.current_phase = next.id;
    m.updated_at = new Date().toISOString();
    writeJSON(manifestPath(problem), m);
    console.log(`✅ Advanced to phase: ${C.bold}${next.label}${C.reset}`);
  } else if (sub === 'set') {
    const { positional } = parseOptions(args.slice(1));
    const target = positional[0];
    const phase = PHASES.find(p => p.name === target || p.id === target);
    if (!phase) {
      console.error(`❌ Unknown phase: "${target}". Valid: ${PHASES.map(p => p.name).join(', ')}`);
      process.exit(1);
    }
    m.current_phase = phase.id;
    m.updated_at = new Date().toISOString();
    writeJSON(manifestPath(problem), m);
    console.log(`✅ Phase set to: ${C.bold}${phase.label}${C.reset}`);
  } else {
    const phase = PHASES[currentIdx];
    console.log(`Current phase: ${C.bold}${phase.label}${C.reset} (${phase.id})`);
  }
}

// ── Verify ───────────────────────────────────────────────────────────

// Exit codes are the gate. A blocked verification must not exit 0, or every
// caller downstream reads silence as success (same contract as x-build's phase gates).
const VERIFY_EXIT = { passed: 0, failed: 1, unverified: 2 };

// What to do next, keyed by why the run could not be called verified.
const UNVERIFIED_NEXT = {
  no_selected_candidate: [
    'No candidate is selected, so there is nothing to check the constraints against.',
    '  x-solver candidates add "<solution>" --source executor && x-solver candidates select <id>',
  ],
  unscored_hard_constraints: [
    'Hard constraints carry no score, so nothing was actually checked.',
    '  x-solver candidates score <id> --constraint <cid> --score <n>',
    '  or, for a constraint execution cannot check:',
    '  x-solver verify --manual "<what holds>" --evidence "<command you ran + its output>"',
  ],
  regression_proof_absent: [
    'The recorded failure was never re-run after the fix, so nothing shows it stopped happening.',
    '  x-solver repro verify --output-file <after> --exit-code 0 [--regression-test <path>]',
  ],
  insufficient_clean_runs: [
    'An intermittent failure needs enough clean runs to beat chance; the run reported fewer.',
    '  x-solver repro show   # tells you how many are needed',
  ],
  no_hard_constraints: [
    'No hard constraint says what "solved" means here, so passing would assert nothing.',
    '  x-solver constraints add "<must hold>" --type hard',
    '  or, if the proof is an execution rather than a constraint:',
    '  x-solver verify --manual "<what holds>" --evidence "<command you ran + its output>"',
  ],
};

/**
 * Judge the selected candidate against the recorded constraints.
 *
 * Three-valued on purpose. The two-valued form counted an unscored hard constraint
 * as a pass (`null !== false`) and an empty hard-constraint list as a vacuous pass,
 * so a problem could report PASSED having checked nothing — the opposite of this
 * skill's own rule that "solved" is confirmed by execution only. Same reasoning as
 * the traceability gate in x-build/lib/x-build/verify.mjs.
 */
function evaluateConstraints(constraints, selected) {
  const checks = [];
  for (const c of constraints) {
    const score = selected?.scores?.[c.id];
    const scored = score !== undefined;
    const check = {
      constraint_id: c.id,
      type: c.type,
      description: c.description,
      blocking: c.type === 'hard',
    };
    if (c.type === 'hard') {
      check.passed = scored ? score > 0 : null;
      check.status = scored ? (score > 0 ? 'passed' : 'failed') : 'unverified';
      check.note = scored ? `Score: ${score}` : 'Not scored — needs agent verification';
    } else {
      check.score = scored ? score : null;
      check.status = scored ? 'scored' : 'unscored';
      check.note = scored ? `Score: ${score}/10` : 'Not scored';
    }
    checks.push(check);
  }

  const hard = checks.filter((c) => c.blocking);
  const summary = {
    hard_total: hard.length,
    hard_passed: hard.filter((c) => c.status === 'passed').length,
    hard_failed: hard.filter((c) => c.status === 'failed').length,
    hard_unverified: hard.filter((c) => c.status === 'unverified').length,
    soft_total: checks.length - hard.length,
    soft_scored: checks.filter((c) => !c.blocking && c.status === 'scored').length,
  };

  let status;
  let reason = null;
  if (!selected) { status = 'unverified'; reason = 'no_selected_candidate'; }
  else if (summary.hard_failed > 0) { status = 'failed'; reason = 'hard_constraint_failed'; }
  else if (summary.hard_unverified > 0) { status = 'unverified'; reason = 'unscored_hard_constraints'; }
  else if (summary.hard_total === 0) { status = 'unverified'; reason = 'no_hard_constraints'; }
  else { status = 'passed'; }

  return { checks, summary, status, reason };
}

/**
 * Older verification.json files predate `status`. Derive one so a problem that was
 * already verified does not become impossible to close.
 */
function normalizeVerification(raw) {
  if (!raw) return null;
  if (raw.status) return raw;
  // In the legacy manual shape `reason` held the human's justification text, while
  // it now names a machine-readable cause. Keep the text, but not in that slot.
  const legacyClaim = raw.method === 'manual' && typeof raw.reason === 'string' ? raw.reason : null;
  // Do NOT trust the legacy `passed`: it was produced by the two-valued rule this
  // release removed, so it says "passed" for exactly the states now called unverified.
  // The constraint check is still on disk, so recompute from it.
  const hard = (raw.constraint_check ?? []).filter((c) => c.type === 'hard');
  let status;
  let reason = null;
  if (hard.some((c) => c.passed === false)) { status = 'failed'; reason = 'hard_constraint_failed'; }
  else if (hard.some((c) => c.passed !== true)) { status = 'unverified'; reason = 'unscored_hard_constraints'; }
  else if (hard.length === 0) { status = 'unverified'; reason = 'no_hard_constraints'; }
  else { status = 'passed'; }
  return {
    ...raw,
    status,
    reason,
    passed: status === 'passed',
    ...(legacyClaim ? { manual: { claim: legacyClaim, evidence: null, at: raw.verified_at ?? null } } : {}),
  };
}

function cmdVerify(args) {
  const problem = requireProblem(args);
  const { opts } = parseOptions(args);
  const m = readJSON(manifestPath(problem));

  if (m.current_phase !== '04-verify') {
    m.current_phase = '04-verify';
    m.updated_at = new Date().toISOString();
    writeJSON(manifestPath(problem), m);
  }

  // The auto judgement runs even for --manual, so a human attestation overlays a real
  // constraint check instead of erasing it. The old manual path wrote four fields and
  // dropped constraint_check entirely, leaving no record of what was skipped.
  const constraintData = readJSON(join(intakePath(problem), 'constraints.json')) || { constraints: [] };
  const candidateData = readJSON(join(solvePath(problem), 'candidates.json')) || { candidates: [] };
  const selected = candidateData.candidates.find(c => c.selected);
  const description = readMD(join(intakePath(problem), 'description.md'));
  const judged = evaluateConstraints(constraintData.constraints, selected);
  const stratState = readJSON(join(solvePath(problem), 'strategy-state.json'));
  const repro = m.strategy === STRATEGIES.ITERATE ? (stratState?.repro ?? null) : null;
  const resolveMode = m.strategy === STRATEGIES.ITERATE ? (stratState?.resolve_mode ?? null) : null;

  const verification = {
    method: opts.manual ? 'manual' : 'auto',
    status: judged.status,
    reason: judged.reason,
    passed: judged.status === 'passed',
    summary: judged.summary,
    selected_candidate: selected?.id || null,
    constraint_check: judged.checks,
    repro_status: repro?.status ?? null,
    regression_proof: repro ? (repro.regression_proof ?? 'absent') : null,
    resolve_mode: resolveMode,
    attested_by: null,
    manual: null,
    problem_context: description,
    candidate_description: selected?.description || null,
    constraints: constraintData.constraints,
    verified_at: new Date().toISOString(),
  };

  // A reproduced failure that was never re-run after the fix has not been shown to be
  // gone. Constraint scores say the solution meets its requirements; only the
  // regression proof says the original failure stopped happening.
  if (repro?.status === 'reproduced' && verification.regression_proof !== 'proven') {
    verification.status = 'unverified';
    verification.reason = 'regression_proof_absent';
    verification.passed = false;
  }
  // An intermittent fix with fewer clean runs than the computed k is not proof either.
  if (repro?.status === 'intermittent' && verification.regression_proof !== 'proven') {
    verification.status = 'unverified';
    verification.reason = verification.regression_proof === 'degraded'
      ? 'insufficient_clean_runs'
      : 'regression_proof_absent';
    verification.passed = false;
  }

  if (opts.manual) {
    const claim = typeof opts.manual === 'string' ? opts.manual.trim() : '';
    const evidence = typeof opts.evidence === 'string' ? opts.evidence.trim() : '';
    if (!claim) {
      console.error('❌ --manual needs the claim it attests.');
      console.error('   Usage: x-solver verify --manual "<what holds>" --evidence "<command + output>"');
      process.exitCode = 1;
      return;
    }
    if (!evidence) {
      console.error('❌ --manual requires --evidence: the command you ran and what it printed.');
      console.error('   An attestation with no evidence is the same unearned green light the auto gate refuses.');
      process.exitCode = 1;
      return;
    }
    if (evidence === claim) {
      console.error('❌ --evidence repeats --manual verbatim. Restating the claim is not verification.');
      process.exitCode = 1;
      return;
    }
    // There is nothing for an attestation to be about when no solution is recorded.
    if (judged.reason === 'no_selected_candidate') {
      console.error('❌ Nothing to attest: no candidate is selected, so the claim names no solution.');
      console.error('   x-solver candidates add "<solution>" --source executor && x-solver candidates select <id>');
      process.exitCode = 1;
      return;
    }
    // A regression proof is an execution result, so --manual is not the way around it.
    if (verification.reason === 'regression_proof_absent' || verification.reason === 'insufficient_clean_runs') {
      console.error('❌ The recorded failure has not been re-run since the fix. That is checkable by execution.');
      console.error('   x-solver repro verify --output-file <after> --exit-code 0');
      process.exitCode = 1;
      return;
    }
    // --manual exists for constraints execution cannot check (SKILL.md: "maintainable
    // code"), not to overturn a constraint execution already checked and failed.
    const failed = judged.checks.filter((c) => c.status === 'failed');
    if (failed.length) {
      console.error(`❌ Cannot attest over a measured failure: ${failed.map((c) => c.constraint_id).join(', ')}`);
      console.error('   Fix the constraint or re-score it. --manual does not overturn a measurement.');
      process.exitCode = 1;
      return;
    }
    verification.status = 'passed';
    verification.reason = null;
    verification.passed = true;
    verification.attested_by = 'human';
    verification.manual = { claim, evidence, at: verification.verified_at };
  }

  writeJSON(join(verifyPath(problem), 'verification.json'), verification);

  console.log(`\n${C.bold}Verification${C.reset}\n`);
  if (selected) console.log(`  Selected: ${C.cyan}${selected.id}${C.reset}: ${selected.description}\n`);

  for (const check of verification.constraint_check) {
    const icon = check.status === 'passed' ? '✅'
      : check.status === 'failed' ? '❌'
      : check.status === 'scored' ? '📊' : '⚠️';
    console.log(`  ${icon} ${check.constraint_id} [${check.type}]: ${check.description}`);
    console.log(`     ${check.note}`);
  }

  const label = {
    passed: `${C.green}PASSED${C.reset}`,
    failed: `${C.red}FAILED${C.reset}`,
    unverified: `${C.yellow}UNVERIFIED${C.reset}`,
  }[verification.status];
  console.log(`\n  Overall: ${label}${verification.attested_by === 'human' ? ' (attested by human)' : ''}\n`);

  for (const line of UNVERIFIED_NEXT[verification.reason] ?? []) {
    console.log(`  ${line}`);
  }
  if (verification.status === 'unverified') console.log('');

  // JSON output for SKILL.md
  console.log(JSON.stringify({
    action: 'verify',
    problem,
    ...verification,
  }));

  // Set, never process.exit(): exiting here would truncate the JSON above.
  process.exitCode = VERIFY_EXIT[verification.status];
}

// ── Close ────────────────────────────────────────────────────────────

function cmdClose(args) {
  const problem = requireProblem(args);
  const { opts } = parseOptions(args);
  const m = readJSON(manifestPath(problem));

  const candidateData = readJSON(join(solvePath(problem), 'candidates.json')) || { candidates: [] };
  const selected = candidateData.candidates.find(c => c.selected);
  const verification = normalizeVerification(readJSON(join(verifyPath(problem), 'verification.json')));

  // close used to stamp SOLVED unconditionally — with no verification at all, or with a
  // failing one. That made every downstream reader of `state` untrustworthy.
  const abandoned = opts.abandon === true || typeof opts.abandon === 'string';
  if (abandoned) {
    // Abandoning is terminal, so it must not quietly rewrite a problem that already
    // reached one — least of all one that closed as solved.
    if (m.state && m.state !== PROBLEM_STATES.ACTIVE) {
      console.error(`❌ This problem is already ${m.state}. Abandoning would overwrite that record.`);
      process.exitCode = 1;
      return;
    }
    if (!(typeof opts.summary === 'string' && opts.summary.trim())) {
      console.error('❌ --abandon requires --summary "<what was learned before stopping>".');
      console.error('   Keeping the diagnosis is the entire point of abandoning rather than deleting.');
      process.exitCode = 1;
      return;
    }
    m.current_phase = '05-close';
    m.state = PROBLEM_STATES.ABANDONED;
    m.closed_at = new Date().toISOString();
    m.updated_at = m.closed_at;
    writeJSON(manifestPath(problem), m);
    writeJSON(join(closePath(problem), 'summary.json'), {
      problem: m.display_name,
      strategy: m.strategy,
      solution: 'Abandoned — no proven fix',
      verification_passed: false,
      verification_status: verification?.status ?? 'none',
      abandoned: true,
      duration_ms: new Date(m.closed_at).getTime() - new Date(m.created_at).getTime(),
      closed_at: m.closed_at,
      custom_summary: opts.summary || null,
    });
    console.log(`\n${C.yellow}⚠ Problem abandoned${C.reset}: ${C.bold}${m.display_name}${C.reset}`);
    console.log(`   The diagnosis is kept. Nothing is recorded as solved.\n`);
    return;
  }

  const forced = opts.force === true || typeof opts.force === 'string';

  // A verification is a statement about the candidate and constraints it saw. If either
  // moved since, the stored verdict is about something else.
  const constraintsNow = (readJSON(join(intakePath(problem), 'constraints.json')) || { constraints: [] }).constraints;
  const staleCandidate = verification && verification.selected_candidate !== undefined
    && (selected?.id ?? null) !== (verification.selected_candidate ?? null);
  const staleConstraints = verification && Array.isArray(verification.constraints)
    && verification.constraints.map((c) => c.id).sort().join(',') !== constraintsNow.map((c) => c.id).sort().join(',');
  const stale = Boolean(staleCandidate || staleConstraints);
  if (verification?.status === 'passed' && stale && !forced) {
    console.error('❌ The verification on file is stale — it checked a different state.');
    if (staleCandidate) console.error(`   Verified candidate: ${verification.selected_candidate ?? 'none'}, selected now: ${selected?.id ?? 'none'}`);
    if (staleConstraints) console.error('   The constraint set changed since the verification ran.');
    console.error('   Re-run: x-solver verify');
    process.exitCode = 2;
    return;
  }

  if (verification?.status !== 'passed' && !forced) {
    const why = !verification
      ? 'This problem has no verification record.'
      : `Verification is ${verification.status}${verification.reason ? ` (${verification.reason})` : ''}.`;
    console.error(`❌ Cannot close: ${why}`);
    console.error('   Run: x-solver verify');
    console.error('   To close anyway, say why — it will be recorded as closed, not solved:');
    console.error('   x-solver close --force --reason "<why this is being closed unproven>"');
    process.exitCode = 2;
    return;
  }

  const forceReason = typeof opts.reason === 'string' ? opts.reason.trim() : '';
  if (forced && !forceReason) {
    console.error('❌ --force requires --reason "<why this is being closed unproven>".');
    process.exitCode = 1;
    return;
  }

  const unproven = forced && verification?.status !== 'passed';
  m.current_phase = '05-close';
  // CLOSED, not SOLVED: "the work stopped here" is a different claim from "this was
  // proven solved", and the dashboard already renders only `solved` as green.
  m.state = unproven ? PROBLEM_STATES.CLOSED : PROBLEM_STATES.SOLVED;
  m.closed_at = new Date().toISOString();
  m.updated_at = new Date().toISOString();
  writeJSON(manifestPath(problem), m);

  const summary = {
    problem: m.display_name,
    strategy: m.strategy,
    solution: selected?.description || opts.summary || 'No solution recorded',
    verification_passed: verification?.status === 'passed',
    verification_status: verification?.status ?? 'none',
    verification_method: verification?.method ?? null,
    repro_status: verification?.repro_status ?? null,
    regression_proof: verification?.regression_proof ?? null,
    resolve_mode: verification?.resolve_mode ?? null,
    forced: unproven,
    force_reason: unproven ? forceReason : null,
    duration_ms: new Date(m.closed_at).getTime() - new Date(m.created_at).getTime(),
    closed_at: m.closed_at,
    custom_summary: opts.summary || null,
  };

  writeJSON(join(closePath(problem), 'summary.json'), summary);

  const headline = unproven
    ? `${C.yellow}⚠ Problem closed UNPROVEN${C.reset}: ${C.bold}${m.display_name}${C.reset}`
    : `${C.green}✅ Problem closed${C.reset}: ${C.bold}${m.display_name}${C.reset}`;
  console.log(`\n${headline}`);
  console.log(`   Strategy: ${m.strategy}`);
  console.log(`   Solution: ${summary.solution}`);
  if (unproven) console.log(`   ${C.yellow}Verification: ${summary.verification_status} — ${forceReason}${C.reset}`);
  // Say it out loud: "closed" and "the cause was found" are different claims.
  if (summary.resolve_mode === 'narrow') {
    console.log(`   ${C.yellow}Root cause was never confirmed — this run mitigated the symptom only.${C.reset}`);
  }
  if (summary.repro_status && summary.regression_proof !== 'proven') {
    console.log(`   ${C.yellow}Regression proof: ${summary.regression_proof} — the recorded failure was not shown to be gone.${C.reset}`);
  }
  console.log(`   Duration: ${fmtDuration(summary.duration_ms)}\n`);
}

// ── History ──────────────────────────────────────────────────────────

function cmdHistory(args) {
  const dir = problemsDir();
  if (!existsSync(dir)) {
    console.log('No history.');
    return;
  }

  const problems = readdirSync(dir)
    .filter(d => existsSync(manifestPath(d)))
    .map(d => ({ name: d, ...readJSON(manifestPath(d)) }))
    .filter(m => m.state === PROBLEM_STATES.SOLVED || m.state === PROBLEM_STATES.CLOSED)
    .sort((a, b) => new Date(b.closed_at || 0) - new Date(a.closed_at || 0));

  if (problems.length === 0) {
    console.log('No solved problems yet.');
    return;
  }

  console.log(`\n${C.bold}Solved Problems${C.reset} (${problems.length})\n`);
  for (const p of problems) {
    const summary = readJSON(join(closePath(p.name), 'summary.json'));
    const info = STRATEGY_LABELS[p.strategy];
    console.log(`  ${info?.icon || '📋'} ${C.bold}${p.name}${C.reset}`);
    console.log(`    ${p.display_name}`);
    console.log(`    Strategy: ${p.strategy}  |  ${p.closed_at?.slice(0, 10)}`);
    if (summary?.solution) {
      console.log(`    Solution: ${summary.solution.slice(0, 80)}${summary.solution.length > 80 ? '...' : ''}`);
    }
    console.log();
  }
}

// ── Next (Smart Routing) ─────────────────────────────────────────────

function cmdNext(args) {
  const problem = findCurrentProblem();

  if (!problem) {
    console.log(JSON.stringify({
      action: 'next',
      recommendation: 'init',
      message: 'No active problem. Start with: x-solver init "description"',
    }));
    return;
  }

  const m = readJSON(manifestPath(problem));
  const phase = PHASES.find(p => p.id === m.current_phase);
  let recommendation;
  let message;

  switch (m.current_phase) {
    case '01-intake': {
      const desc = readMD(join(intakePath(problem), 'description.md'));
      const ctx = readJSON(join(intakePath(problem), 'context.json'));
      const constraints = readJSON(join(intakePath(problem), 'constraints.json'));
      if (!desc || desc.trim().length < 20) {
        recommendation = 'describe';
        message = 'Add a detailed problem description: x-solver describe --content "..."';
      } else {
        recommendation = 'classify';
        message = 'Ready to classify. Run: x-solver classify';
      }
      break;
    }
    case '02-classify': {
      const classification = readJSON(join(classifyPath(problem), 'classification.json'));
      if (!classification) {
        recommendation = 'classify';
        message = 'Run classification: x-solver classify';
      } else if (classification.recommended_strategy === 'direct') {
        recommendation = 'direct';
        message = 'Simple problem: answer directly. If it becomes complex, choose a solver strategy.';
      } else if (!m.strategy) {
        recommendation = 'strategy set';
        message = `Set strategy (recommended: ${classification.recommended_strategy}): x-solver strategy set ${classification.recommended_strategy}`;
      } else {
        recommendation = 'phase next';
        message = 'Strategy set. Advance: x-solver phase next';
      }
      break;
    }
    case '03-solve': {
      const stratState = readJSON(join(solvePath(problem), 'strategy-state.json'));
      const phases = SOLVE_PHASES[m.strategy] || [];
      const currentIdx = phases.indexOf(stratState?.current_phase);
      if (currentIdx < phases.length - 1) {
        recommendation = 'solve';
        message = `Continue solving (${stratState?.current_phase}): x-solver solve`;
      } else {
        const candidates = readJSON(join(solvePath(problem), 'candidates.json'));
        const hasSelected = candidates?.candidates?.some(c => c.selected);
        if (!hasSelected && candidates?.candidates?.length > 0) {
          recommendation = 'candidates select';
          message = 'Select a solution candidate: x-solver candidates select <id>';
        } else {
          recommendation = 'phase next';
          message = 'Solving complete. Advance to verify: x-solver phase next';
        }
      }
      break;
    }
    case '04-verify': {
      const verification = normalizeVerification(readJSON(join(verifyPath(problem), 'verification.json')));
      if (!verification) {
        recommendation = 'verify';
        message = 'Run verification: x-solver verify';
      } else if (verification.status === 'passed') {
        recommendation = 'close';
        message = 'Verification passed. Close: x-solver close';
      } else if (verification.status === 'unverified') {
        // Neither passed nor failed: nothing was checked, so pointing at solve would be
        // as wrong as pointing at close.
        recommendation = 'verify';
        message = `Nothing was verified (${verification.reason}). Supply evidence, then re-run: x-solver verify`;
      } else {
        recommendation = 'solve';
        message = 'Verification failed. Return to solve: x-solver phase set solve';
      }
      break;
    }
    case '05-close': {
      // next must not tell the caller to close when close will refuse.
      const verification = normalizeVerification(readJSON(join(verifyPath(problem), 'verification.json')));
      if (verification?.status === 'passed') {
        recommendation = 'close';
        message = 'Ready to close: x-solver close';
      } else {
        recommendation = 'verify';
        message = `Close is gated on verification (currently ${verification?.status ?? 'none'}). Run: x-solver verify`;
      }
      break;
    }
  }

  console.log(`\n${C.bold}Next Step${C.reset}\n`);
  console.log(`  Problem: ${m.display_name}`);
  console.log(`  Phase: ${phase?.label}`);
  console.log(`  ${C.yellow}→ ${message}${C.reset}\n`);

  console.log(JSON.stringify({
    action: 'next',
    problem,
    phase: phase?.name,
    recommendation,
    message,
    strategy: m.strategy,
  }));
}

// ── Handoff ──────────────────────────────────────────────────────────

function cmdHandoff(args) {
  const { opts } = parseOptions(args);

  if (opts.restore) {
    const problem = findCurrentProblem();
    if (!problem) {
      console.log('No active problem to restore.');
      return;
    }
    const handoff = readJSON(join(problemDir(problem), 'handoff.json'));
    if (!handoff) {
      console.log('No handoff data found.');
      return;
    }
    console.log(`\n${C.bold}Restored Session${C.reset}\n`);
    console.log(`  Problem: ${handoff.display_name}`);
    console.log(`  Phase: ${handoff.phase}`);
    console.log(`  Strategy: ${handoff.strategy || 'not set'}`);
    if (handoff.solve_phase) console.log(`  Solve phase: ${handoff.solve_phase}`);
    if (handoff.next_action) console.log(`  Next: ${handoff.next_action}`);
    console.log();

    console.log(JSON.stringify({ action: 'handoff-restore', ...handoff }));
    return;
  }

  const problem = requireProblem(args);
  const m = readJSON(manifestPath(problem));
  const stratState = readJSON(join(solvePath(problem), 'strategy-state.json'));
  const constraintData = readJSON(join(intakePath(problem), 'constraints.json'));
  const candidateData = readJSON(join(solvePath(problem), 'candidates.json'));

  const handoff = {
    problem,
    display_name: m.display_name,
    phase: PHASES.find(p => p.id === m.current_phase)?.name,
    strategy: m.strategy,
    solve_phase: stratState?.current_phase,
    constraints_count: constraintData?.constraints?.length || 0,
    candidates_count: candidateData?.candidates?.length || 0,
    next_action: null,
    saved_at: new Date().toISOString(),
  };

  writeJSON(join(problemDir(problem), 'handoff.json'), handoff);
  console.log(`✅ Handoff saved for: ${m.display_name}`);
}

// ── Mode ─────────────────────────────────────────────────────────────

function cmdMode(args) {
  const sub = args[0];

  if (!sub || sub === 'show') {
    const mode = getMode();
    console.log(`Current mode: ${C.bold}${mode}${C.reset}`);
    return;
  }

  if (!['developer', 'normal'].includes(sub)) {
    console.error('Usage: x-solver mode <developer|normal>');
    process.exit(1);
  }

  const config = loadConfig();
  config.mode = sub;
  writeJSON(join(ROOT, 'config.json'), config);
  console.log(`✅ Mode set to: ${sub}`);
}

// ── Help ─────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
${C.bold}x-solver${C.reset} — Structured Problem Solving

${C.bold}USAGE${C.reset}
  x-solver <command> [args] [options]

${C.bold}PROBLEM MANAGEMENT${C.reset}
  init <description>        Create new problem
  list                      List all problems
  status                    Show current problem status
  close [--summary "..."]   Close problem (requires a passed verification)
  close --abandon --summary "..."
                            Stop without a fix; keeps the diagnosis, records nothing as solved
  strategy set <s> --reset  Discard an in-progress run (repro, hypotheses, iteration budget)
  history                   Show solved problems
  next                      Suggest the next action
  handoff [--restore]       Save/restore session

${C.bold}INTAKE${C.reset}
  describe --content "..."  Set problem description
  context add --content     Add context
  context list              List context items
  constraints add "..."     Add constraint [--type hard|soft|preference]
  constraints list          List constraints
  constraints remove <id>   Remove constraint

${C.bold}CLASSIFY${C.reset}
  classify                  Auto-classify + recommend strategy
  strategy set <name>       Set strategy (decompose|iterate|constrain|pipeline)
  strategy show             Show current strategy

${C.bold}SOLVE${C.reset}
  solve [--step]            Execute strategy
  solve-status              Show solving progress
  solve-advance --phase X   Advance solve phase
  hypotheses list|add|update  (iterate) Manage hypotheses
  tree show|add|update      (decompose) Manage problem tree
  candidates list|add|select|score  Manage solution candidates

${C.bold}VERIFY & CLOSE${C.reset}
  verify                    Check the selected candidate against hard constraints
                            exit 0 passed / 1 failed / 2 unverified (nothing checked)
  verify --manual "<claim>" --evidence "<command + output>"
                            Attest a constraint execution cannot check. Evidence is
                            required, and a measured failure cannot be attested over.
  close --force --reason "..."
                            Close without a passed verification. Records state=closed,
                            not solved.
  phase next|set <name>     Manage phases

${C.bold}SETTINGS${C.reset}
  mode developer|normal     Set display mode
  help                      Show this help
`);
}

// ── Main Router ──────────────────────────────────────────────────────

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case 'init':           cmdInit(args); break;
  case 'list':           cmdList(); break;
  case 'status':         cmdStatus(args); break;
  case 'describe':       cmdDescribe(args); break;
  case 'context':        cmdContext(args); break;
  case 'constraints':    cmdConstraints(args); break;
  case 'classify':       cmdClassify(args); break;
  case 'strategy':       cmdStrategy(args); break;
  case 'solve':          cmdSolve(args); break;
  case 'solve-advance':  cmdSolveAdvance(args); break;
  case 'solve-status':   cmdSolveStatus(args); break;
  case 'repro':          cmdRepro(args); break;
  case 'hypotheses':     cmdHypotheses(args); break;
  case 'tree':           cmdTree(args); break;
  case 'candidates':     cmdCandidates(args); break;
  case 'phase':          cmdPhase(args); break;
  case 'verify':         cmdVerify(args); break;
  case 'close':          cmdClose(args); break;
  case 'history':        cmdHistory(args); break;
  case 'next':           cmdNext(args); break;
  case 'handoff':        cmdHandoff(args); break;
  case 'mode':           cmdMode(args); break;
  case 'help':
  case '--help':
  case '-h':             printHelp(); break;
  default:
    if (!cmd) {
      printHelp();
    } else {
      console.error(`❌ Unknown command: "${cmd}". Run: x-solver help`);
      process.exit(1);
    }
}
