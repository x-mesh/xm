/**
 * x-eval/root — locate `.xm/` the same way x-trace does, so `.xm/eval/cases/`
 * written by `xm trace replay --promote-to-eval` and read by `xm eval` are the
 * same directory.
 *
 * Rule: XM_ROOT env → local .xm/ → main checkout's .xm/ via git-common-dir.
 * Copied from x-trace/lib/x-trace/trace-writer.mjs rather than imported: a
 * cross-plugin relative import breaks in the versioned marketplace-cache layout
 * (each plugin is cached alone under ~/.claude/plugins/cache/xm/<plugin>/<ver>/).
 */

import { lstatSync, realpathSync } from 'node:fs';
import { resolve, join, relative, sep, dirname, basename } from 'node:path';
import { execSync } from 'node:child_process';

function entryInfo(path) {
  try { return lstatSync(path); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function assertNoSymlinkParents(candidate, boundary, label) {
  let boundaryAnchor = resolve(boundary);
  while (!entryInfo(boundaryAnchor)) boundaryAnchor = dirname(boundaryAnchor);
  const boundaryReal = realpathSync(boundaryAnchor);
  const target = resolve(candidate);
  let cursor = target;
  while (true) {
    const info = entryInfo(cursor);
    if (info?.isSymbolicLink()) throw new Error(`${label} must not contain symlinks: ${cursor}`);
    if (info && cursor !== target && !info.isDirectory()) throw new Error(`${label} parent must be a directory: ${cursor}`);
    if (info && realpathSync(cursor) === boundaryReal) return;
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`${label} resolves outside the workspace: ${candidate}`);
    cursor = parent;
  }
}

function assertContainedPath(boundary, target, label) {
  const base = resolve(boundary);
  const candidate = resolve(target);
  if (candidate !== base && !candidate.startsWith(base + sep)) throw new Error(`${label} must stay inside the workspace: ${candidate}`);
  const baseInfo = entryInfo(base);
  if (baseInfo?.isSymbolicLink() || (baseInfo && !baseInfo.isDirectory())) throw new Error(`${label} root must be a regular non-symlink directory: ${base}`);
  const rel = relative(base, candidate);
  let cursor = base;
  for (const part of rel ? rel.split(sep) : []) {
    cursor = join(cursor, part);
    const info = entryInfo(cursor);
    if (!info) break;
    if (info.isSymbolicLink()) throw new Error(`${label} must not contain symlinks: ${cursor}`);
    if (!info.isDirectory()) throw new Error(`${label} parent must be a directory: ${cursor}`);
  }
  let anchor = base;
  while (!entryInfo(anchor)) anchor = dirname(anchor);
  const baseReal = realpathSync(anchor);
  let existing = candidate;
  while (!entryInfo(existing)) existing = dirname(existing);
  const actual = realpathSync(existing);
  if (actual !== baseReal && !actual.startsWith(baseReal + sep)) throw new Error(`${label} resolves outside the workspace: ${candidate}`);
  assertNoSymlinkParents(candidate, base, label);
  return candidate;
}

function validateRoot(candidate, boundary) {
  const absolute = resolve(candidate);
  const info = entryInfo(absolute);
  if (info?.isSymbolicLink()) throw new Error(`XM_ROOT must be a regular non-symlink directory: ${absolute}`);
  const root = join(realpathSync(dirname(absolute)), basename(absolute));
  assertContainedPath(boundary, root, 'XM_ROOT');
  assertNoSymlinkParents(absolute, boundary, 'XM_ROOT');
  if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error(`XM_ROOT must be a regular non-symlink directory: ${root}`);
  return absolute;
}

function workspaceBoundary() {
  try {
    const top = execSync('git rev-parse --show-toplevel', {
      cwd: process.cwd(), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (top) return realpathSync(top);
  } catch {}
  return realpathSync(process.cwd());
}

export function resolveXmDir() {
  const workspace = workspaceBoundary();
  if (process.env.XM_ROOT) return validateRoot(resolve(process.cwd(), process.env.XM_ROOT), workspace);
  const localXm = resolve(workspace, '.xm');
  if (entryInfo(localXm)) return validateRoot(localXm, workspace);
  let commonDir = null;
  try {
    commonDir = execSync('git rev-parse --git-common-dir', {
      cwd: process.cwd(), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {}
  if (commonDir) {
    const mainXm = resolve(process.cwd(), commonDir, '..', '.xm');
    if (entryInfo(mainXm)) return validateRoot(mainXm, dirname(mainXm));
  }
  return validateRoot(localXm, workspace);
}

/** `<repo>/.xm/eval[/segments]` */
export function evalDir(...segments) {
  const root = resolveXmDir();
  return assertContainedPath(root, join(root, 'eval', ...segments), 'x-eval storage path');
}

/** Current checkout/worktree root — executable assertions run against these bytes. */
export function projectRoot() {
  const workspace = workspaceBoundary();
  if (process.env.XM_ROOT) {
    const explicitProject = resolve(process.cwd(), process.env.XM_ROOT, '..');
    try {
      if (realpathSync(explicitProject) === workspace) return explicitProject;
    } catch {}
  }
  return workspace;
}
