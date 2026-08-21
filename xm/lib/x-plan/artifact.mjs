import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { normalizePlanEnvelope } from './normalize.mjs';
import { renderPlan } from './render.mjs';
import { validatePlanEnvelope } from './validate.mjs';

function repositoryRoot(cwd) {
  if (existsSync(join(cwd, '.xm'))) return cwd;
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).trim();
    if (top) return top;
  } catch {}
  return cwd;
}

function slug(value) {
  const normalized = String(value || '').normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return normalized.slice(0, 48) || 'plan';
}

function timestamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function availablePath(dir, stem, extension = '') {
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const path = join(dir, suffix ? stem + '-' + suffix + extension : stem + extension);
    if (!existsSync(path)) return path;
  }
  throw new Error('could not allocate a unique plan artifact path');
}

function writeAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), '.' + basename(path) + '.' + process.pid + '.tmp');
  const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
  try {
    writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

function readJSON(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function validatedPlan(input, now, mode) {
  const plan = normalizePlanEnvelope(input);
  const stored = normalizePlanEnvelope({
    ...plan,
    provenance: { ...plan.provenance, artifact_type: 'plan', mode, created_at: plan.provenance?.created_at || now.toISOString(), updated_at: now.toISOString() },
  });
  const checked = validatePlanEnvelope(stored);
  if (!checked.valid) {
    const error = new Error('refusing to persist an invalid PlanEnvelope');
    error.validation = checked;
    throw error;
  }
  return stored;
}

function saveQuick(plan, root, { cwd, now, outputPath }) {
  const dir = join(root, '.xm', 'plan');
  mkdirSync(dir, { recursive: true });
  const path = outputPath ? resolve(cwd, outputPath) : availablePath(dir, timestamp(now) + '-' + slug(plan.goal), '.json');
  writeAtomic(path, plan);
  return { path, relativePath: relative(root, path) || basename(path), plan, manifest: null };
}

function saveSession(plan, root, options) {
  const { cwd, now, outputPath, mode, evidence, questions, critique, candidates, sessionId } = options;
  const base = join(root, '.xm', 'plan');
  mkdirSync(base, { recursive: true });
  const sessionPath = sessionId ? resolve(base, sessionId) : outputPath ? resolve(cwd, outputPath) : availablePath(base, timestamp(now) + '-' + slug(plan.goal));
  if (sessionId && (sessionPath === base || !sessionPath.startsWith(base + '/'))) throw new Error('plan session must stay under .xm/plan');
  mkdirSync(sessionPath, { recursive: true });

  const existingManifest = readJSON(join(sessionPath, 'manifest.json'), null);
  if (sessionId && !existingManifest) throw new Error('plan session not found: ' + sessionId);
  const evidenceArtifact = evidence || readJSON(join(sessionPath, 'evidence.json'), { schema_version: 1, items: [] });
  const questionArtifact = questions || readJSON(join(sessionPath, 'questions.json'), {
    schema_version: 1,
    items: plan.unresolved_questions.map((text, index) => ({ id: 'Q' + (index + 1), text, kind: 'blocking_unknown', status: 'open', answer: null })),
  });
  const critiqueArtifact = critique || readJSON(join(sessionPath, 'critique.json'), { schema_version: 1, status: 'not_recorded', findings: [] });
  const evidenceItems = Array.isArray(evidenceArtifact.items) ? evidenceArtifact.items : [];
  const questionItems = Array.isArray(questionArtifact.items) ? questionArtifact.items : [];
  if (!Array.isArray(evidenceArtifact.items)) throw new Error('evidence.items must be an array');
  if (!Array.isArray(questionArtifact.items)) throw new Error('questions.items must be an array');
  if (questionItems.length > 3) throw new Error('at most 3 planning questions are allowed per interview round');
  for (const item of questionItems) {
    if (!['discoverable', 'user_owned', 'safe_default', 'blocking_unknown'].includes(item.kind)) throw new Error('invalid question kind: ' + item.kind);
    if (!['open', 'answered'].includes(item.status)) throw new Error('invalid question status: ' + item.status);
    if (item.status === 'answered' && !String(item.answer || '').trim()) throw new Error('answered questions require a non-empty answer');
  }
  if (!['not_recorded', 'passed', 'changes_required'].includes(critiqueArtifact.status)) throw new Error('invalid critique status: ' + critiqueArtifact.status);
  const openQuestions = questionItems.some((item) => item.status !== 'answered');
  const critiquePassed = critiqueArtifact.status === 'passed';
  const phase = !evidenceItems.length ? 'inspect'
    : openQuestions || plan.unresolved_questions.length ? 'clarify'
      : !critiquePassed ? 'critique' : 'finalize';
  if (plan.executable) {
    const readinessErrors = [];
    if (!evidenceItems.length) readinessErrors.push('repository evidence is required');
    if (openQuestions) readinessErrors.push('all user-owned questions must be answered');
    if (!critiquePassed) readinessErrors.push('critique must pass');
    if (plan.tasks.some((task) => task.expected_files.length === 0)) readinessErrors.push('every task needs expected_files');
    if (plan.validation.commands.length === 0) readinessErrors.push('validation commands are required');
    if (readinessErrors.length) throw new Error('executable session is not ready: ' + readinessErrors.join('; '));
  }
  const phaseIndex = ['inspect', 'clarify', 'draft', 'critique', 'finalize'].indexOf(phase);
  const manifest = {
    schema_version: 1, id: basename(sessionPath), goal: plan.goal, mode, phase,
    status: plan.status, executable: plan.executable,
    created_at: existingManifest?.created_at || plan.provenance.created_at, updated_at: now.toISOString(),
    history: [...(existingManifest?.history || []), ...(existingManifest?.phase === phase ? [] : [{ phase, at: now.toISOString() }])],
    artifacts: {
      plan: 'plan.md', envelope: 'envelope.json', evidence: 'evidence.json', questions: 'questions.json', critique: 'critique.json',
      candidates: candidates?.length ? 'candidates/' : null,
    },
  };
  writeAtomic(join(sessionPath, 'plan.md'), renderPlan(plan));
  writeAtomic(join(sessionPath, 'envelope.json'), plan);
  writeAtomic(join(sessionPath, 'evidence.json'), evidenceArtifact);
  writeAtomic(join(sessionPath, 'questions.json'), questionArtifact);
  writeAtomic(join(sessionPath, 'critique.json'), critiqueArtifact);
  for (const [index, candidate] of (candidates || []).entries()) {
    const label = String(index + 1).padStart(2, '0') + '-' + slug(candidate.role || candidate.source || 'candidate');
    writeAtomic(join(sessionPath, 'candidates', label + '.json'), candidate);
  }
  writeAtomic(join(sessionPath, 'manifest.json'), manifest);
  return { path: join(sessionPath, 'envelope.json'), sessionPath, relativePath: relative(root, sessionPath), plan, manifest };
}

export function savePlanArtifact(input, options = {}) {
  const cwd = resolve(options.cwd || process.cwd());
  const now = options.now || new Date();
  const mode = options.mode === 'default' ? 'quick' : (options.mode || 'quick');
  const root = repositoryRoot(cwd);
  const plan = validatedPlan(input, now, mode);
  if (mode === 'quick') return saveQuick(plan, root, { cwd, now, outputPath: options.outputPath || null });
  return saveSession(plan, root, { ...options, cwd, now, mode });
}
