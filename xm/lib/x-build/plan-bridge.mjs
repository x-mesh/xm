/** Route x-build planning to the standalone x-plan engine. */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PHASES, ROOT, XM_GLOBAL, findCurrentProject, getExplicitProject, manifestPath, readJSON, repoRoot } from './core.mjs';
import { cmdImportPlan } from './plan-import.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// Only Research and Plan accept an imported plan; cmdImportPlan enforces the
// same rule and exits the process when it is violated, so the bridge checks it
// first and downgrades to an advisory message instead.
const IMPORTABLE_PHASES = new Set(['research', 'plan']);

/** Distinguishes "x-plan is not installed here" from a crash inside x-plan. */
class XPlanUnavailable extends Error {}

// ROOT is <repo>/.xm/build, so x-plan's artifact directory is its sibling.
// Matches x-plan's own repositoryRoot() resolution for every non-global run.
function planArtifactsDir() {
  return join(ROOT, '..', 'plan');
}

// quick mode writes <ts>-<slug>.json; standard/ultra write <session>/envelope.json.
function artifactEntries() {
  const dir = planArtifactsDir();
  if (!existsSync(dir)) return new Map();
  const entries = new Map();
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const path = join(dir, name);
    let stats;
    try { stats = statSync(path); } catch { continue; }
    entries.set(name, stats.isDirectory() ? join(path, 'envelope.json') : path);
  }
  return entries;
}

function newestArtifactSince(before) {
  let newest = null;
  for (const [name, path] of artifactEntries()) {
    if (before.has(name) || !existsSync(path)) continue;
    let mtime;
    try { mtime = statSync(path).mtimeMs; } catch { continue; }
    if (!newest || mtime > newest.mtime) newest = { path, mtime };
  }
  return newest?.path || null;
}

// --replace and --no-import belong to the bridge. x-plan's parser rejects
// unknown options with exit 2, so they must never reach it.
function splitBridgeFlags(rawArgs) {
  const args = [];
  let replace = false;
  let skipImport = false;
  for (const arg of rawArgs) {
    if (arg === '--replace') replace = true;
    else if (arg === '--no-import') skipImport = true;
    else args.push(arg);
  }
  return { args, replace, skipImport };
}

async function loadXPlanMain() {
  const candidates = [
    join(HERE, '..', 'x-plan-cli.mjs'),
    join(HERE, '..', '..', '..', 'x-plan', 'lib', 'x-plan-cli.mjs'),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const module = await import(pathToFileURL(candidate).href);
    if (typeof module.main === 'function') return module.main;
  }
  throw new XPlanUnavailable('x-plan entry point is unavailable');
}

async function delegateToXPlan(args) {
  let main;
  try {
    main = await loadXPlanMain();
  } catch (error) {
    if (!(error instanceof XPlanUnavailable)) throw error;
    // Standalone x-build installs do not contain x-plan's module tree. Delegate
    // through the public dispatcher only for that concrete packaging boundary.
    // stdio stays inherited, so activation and x-plan's exact result are visible.
    console.error('xm build plan: x-plan module is not colocated; delegating to `xm plan`');
    const delegated = spawnSync('xm', ['plan', ...args], { stdio: 'inherit', env: process.env });
    if (delegated.error) {
      console.error('xm build plan: dispatcher delegation failed: ' + delegated.error.message);
      return 2;
    }
    return delegated.status ?? 2;
  }
  // main()'s own exceptions propagate: an internal x-plan crash must not be
  // reported as the exit-2 usage error x-plan reserves for bad input.
  return await main(args);
}

/** Returns null when the plan can be imported, otherwise the reason it cannot. */
function importBlocker(planPath) {
  const project = getExplicitProject() || findCurrentProject();
  if (!project) return 'this workspace has no x-build project';
  const manifest = readJSON(manifestPath(project));
  if (!manifest) return `project "${project}" has no manifest`;
  const phase = PHASES.find((entry) => entry.id === manifest.current_phase)?.name;
  if (!IMPORTABLE_PHASES.has(phase)) return `project "${project}" is in the ${phase || 'unknown'} phase`;
  let envelope;
  try { envelope = JSON.parse(readFileSync(planPath, 'utf8')); } catch (error) { return 'the plan artifact could not be read: ' + error.message; }
  if (envelope?.status !== 'complete' || envelope?.executable !== true) return 'the plan is still a draft (executable: no)';
  return null;
}

export async function cmdXPlan(rawArgs) {
  if (XM_GLOBAL) {
    console.error('xm build plan: --global is not supported by the deprecated alias; x-plan resolves its own repository root, so the artifact and the x-build project would land in different trees.');
    console.error('xm build plan: run `xm plan` in the target repository, or `xm build legacy-plan --global` for the former planner.');
    return 2;
  }
  const { args, replace, skipImport } = splitBridgeFlags(rawArgs);
  const before = new Set(artifactEntries().keys());
  const code = await delegateToXPlan(args);
  if (code !== 0) return code;

  const planPath = newestArtifactSince(before);
  if (!planPath || skipImport) return code;

  const shown = relative(repoRoot(), planPath) || planPath;
  const blocker = importBlocker(planPath);
  if (blocker) {
    console.error(`xm build plan: plan saved to ${shown}; not imported because ${blocker}.`);
    console.error('xm build plan: use `xm build legacy-plan` for the PRD/task lifecycle, or `xm build import-plan <path>` once the plan is executable.');
    return code;
  }

  console.error(`xm build plan: importing ${shown} into the x-build project.`);
  const report = await cmdImportPlan([planPath, ...(replace ? ['--replace'] : [])]);
  if (!report) return process.exitCode || 2;
  return 0;
}
