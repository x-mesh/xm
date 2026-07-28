/**
 * mem-mesh project identity — the single implementation of the id mem-mesh
 * itself would compute for a given path.
 *
 * This lives in the shared `lib/` tier (alongside shared-config.mjs) rather
 * than inside either consumer, because two plugins need the SAME answer and a
 * second implementation is exactly how they drift:
 *
 *   - `x-inbox` (toss / inbox / receipts) resolves it to address another
 *     project's mem-mesh space, and to know its own id when receiving.
 *   - `x-build` stamps it into the handoff mem-mesh mirror, which `handon`
 *     later searches by. When the two disagree, handoff writes under one id and
 *     the search finds nothing — with no error, because an empty result set is
 *     indistinguishable from "no handoff exists".
 *
 * That divergence was live: x-build derived the id from `repoRoot()`, which is
 * `.xm`-anchored (see x-build/lib/x-build/xm-root.mjs — a local `.xm` wins
 * before git is consulted at all), and it implemented only the last step of the
 * chain below. So a repo with a nested `.xm` produced the subdirectory's name,
 * and the documented remedy (`git config --local mem-mesh.project-id <id>`) had
 * no effect on the mirror.
 *
 * The chain mirrors mem-mesh's `resolved_project_identity()`
 * (app/cli/project_identity.py:188-204) exactly:
 *
 *   1. `MEM_MESH_PROJECT_ID` env var        (opt-in — see `allowEnvOverride`)
 *   2. `git config --local --get mem-mesh.project-id` in `path`
 *   3. `.mem-mesh/project-id` file at `path`'s git root
 *   4. `basename(git rev-parse --show-toplevel)` — or `basename(path)` when
 *      `path` is not inside a git repo at all
 *
 * Step 4 is `--show-toplevel`, NOT `--git-common-dir`: mem-mesh treats a linked
 * worktree as its own project. Deliberately NOT `resolveCanonicalPath()` from
 * x-projects-registry.mjs, which collapses a worktree to its main checkout —
 * that is x-kit-side behavior mem-mesh does not share, and adopting it here
 * would reintroduce the very identity mismatch this module exists to avoid.
 * Pinned by test/x-inbox-target.test.mjs ("worktree identity does NOT collapse
 * to the main checkout").
 */

import { readFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { execSync } from 'node:child_process';

/** mem-mesh's own priority-chain constants (app/cli/project_identity.py:15-17). */
export const MEM_MESH_ENV_VAR = 'MEM_MESH_PROJECT_ID';
export const MEM_MESH_GIT_CONFIG_KEY = 'mem-mesh.project-id';
export const MEM_MESH_PROJECT_ID_RELPATH = join('.mem-mesh', 'project-id');

function runGitLine(cwd, args) {
  try {
    const out = execSync(`git ${args}`, {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function readMemMeshProjectIdFile(root) {
  try {
    const raw = readFileSync(join(root, MEM_MESH_PROJECT_ID_RELPATH), 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the project id mem-mesh would compute for `path`.
 *
 * @param {string} path
 * @param {{ allowEnvOverride?: boolean }} [opts]
 *   `MEM_MESH_PROJECT_ID` is a PROCESS-WIDE override: mem-mesh defines it as
 *   the top of the identity chain for "what project am I?". That makes it
 *   correct when resolving the CALLER's own identity, and wrong when resolving
 *   some OTHER checkout's — it ignores `path` entirely, so with the variable
 *   exported every toss would address the sender's own project id no matter
 *   which target was named.
 *
 *   Cross-vendor review split on this exactly: claude/cursor called it
 *   misrouting, codex called it mem-mesh's documented override. Both hold —
 *   for different call sites. So the env step is opt-in and callers declare
 *   intent: resolving SELF passes `allowEnvOverride`, resolving a FOREIGN
 *   checkout does not.
 * @returns {string}
 */
export function resolveMemMeshProjectId(path, opts = {}) {
  const abs = resolve(path);

  const { allowEnvOverride = false } = opts;
  if (allowEnvOverride) {
    const envValue = (process.env[MEM_MESH_ENV_VAR] || '').trim();
    if (envValue) return envValue;
  }

  const configValue = runGitLine(abs, `config --local --get ${MEM_MESH_GIT_CONFIG_KEY}`);
  if (configValue) return configValue;

  const gitRoot = runGitLine(abs, 'rev-parse --show-toplevel');
  const root = gitRoot ? resolve(gitRoot) : abs;

  const fileValue = readMemMeshProjectIdFile(root);
  if (fileValue) return fileValue;

  return basename(root);
}
