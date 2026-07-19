/**
 * x-inbox target resolution — turns a user-typed project name into a
 * confirmed, writable path before a toss is attempted (cross-project-handoff
 * R2, R5).
 *
 * `resolveTarget()` is the mandatory pre-flight gate for `/xm:toss <name>`:
 * every delivery path MUST call it before touching mem-mesh or writing an
 * outbox item. It never guesses — on anything less than a confident single
 * match it returns `ok:false` with a reason a caller can print verbatim.
 *
 * Two identity systems disagree on what a "project" is, and this module has
 * to bridge them:
 *
 *   - x-kit (`x-projects-registry.mjs` `resolveCanonicalPath()`) walks
 *     `git rev-parse --git-common-dir` and collapses a worktree to its main
 *     checkout — a worktree and its main repo share ONE registry entry.
 *   - mem-mesh (`app/cli/project_identity.py`) does not collapse worktrees.
 *     Its priority chain is: `MEM_MESH_PROJECT_ID` env → `git config --local
 *     --get mem-mesh.project-id` → `.mem-mesh/project-id` file at the git
 *     root → `basename(git rev-parse --show-toplevel)`.
 *
 * `resolveMemMeshProjectId()` below reimplements mem-mesh's chain verbatim
 * (not x-kit's `resolveCanonicalPath()`) so the id handed to `pin_add` is the
 * same id mem-mesh would compute for itself if it ran in that directory. See
 * PRD `cross-project-handoff` §7 Risks ("x-kit과 mem-mesh의 프로젝트 정체성
 * 불일치로 오배송") for why this split exists.
 *
 * Known limitation (see the TODO on the success branch below): when the
 * target is a worktree with no `mem-mesh.project-id` set anywhere, this
 * module computes the id mem-mesh would fall back to, but does NOT yet write
 * it into the target's git config — so the two systems still drift the next
 * time an unrelated process resolves identity for that same worktree. Fixing
 * that requires writing into a target repo's git config, which needs its own
 * confirmation gate; deferred here on purpose.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { execSync } from 'node:child_process';

import { loadRegistry } from '../x-projects-registry.mjs';

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
 * Resolve the project id mem-mesh would compute for `path`, following its
 * priority chain exactly (mem-mesh `resolved_project_identity()`,
 * app/cli/project_identity.py:188-204):
 *
 *   1. `MEM_MESH_PROJECT_ID` env var
 *   2. `git config --local --get mem-mesh.project-id` in `path`
 *   3. `.mem-mesh/project-id` file at `path`'s git root
 *   4. `basename(git rev-parse --show-toplevel)` — or `basename(path)` when
 *      `path` is not inside a git repo at all
 *
 * Deliberately NOT `resolveCanonicalPath()` from x-projects-registry.mjs —
 * that function collapses worktrees to their main checkout, which is exactly
 * the x-kit-side behavior mem-mesh does not share. Using it here would
 * reintroduce the identity mismatch this function exists to avoid.
 */
export function resolveMemMeshProjectId(path, opts = {}) {
  const abs = resolve(path);

  // MEM_MESH_PROJECT_ID is a PROCESS-WIDE override: mem-mesh defines it as the
  // top of the identity chain for "what project am I?". That makes it correct
  // when resolving the CALLER's own identity, and wrong when resolving some
  // OTHER checkout's — it ignores `path` entirely, so with the variable
  // exported every toss would address the sender's own project id no matter
  // which target was named.
  //
  // Cross-vendor review split on this exactly: claude/cursor called it
  // misrouting, codex called it mem-mesh's documented override. Both hold —
  // for different call sites. So the env step is opt-in and the two callers
  // declare intent: toss() passes allowEnvOverride (self), resolveTarget()
  // does not (foreign).
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

function normalizeForFuzzy(value) {
  return String(value).toLowerCase().replace(/[-_\s]+/g, '');
}

/** Classic Levenshtein edit distance, O(len(a) * len(b)), two-row DP. */
function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,       // deletion
        curr[j - 1] + 1,   // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Loose "could this be a typo of that" check used only to decide whether an
 * unmatched query is `unregistered` (no plausible near-miss) or `ambiguous`
 * (a near-miss exists, so don't guess — surface it and stop). Deliberately
 * generous: a false-positive candidate is a safe failure (caller sees an
 * extra name and re-types the exact one); a false negative would silently
 * report "unregistered" for what was actually a typo, which is worse.
 *
 * Note this also fires when `input` and `candidateId` are IDENTICAL once
 * hyphens/underscores/whitespace are stripped (e.g. "gitkit" vs "git-kit").
 * That is intentional — PRD's own failure-path example is exactly this typo,
 * and it must stop and ask rather than silently normalize and match.
 */
export function isSimilarProjectName(input, candidateId) {
  const a = normalizeForFuzzy(input);
  const b = normalizeForFuzzy(candidateId);
  if (!a || !b) return false;
  if (a === b) return true;

  const shorter = Math.min(a.length, b.length);
  if (shorter >= 3 && (a.includes(b) || b.includes(a))) return true;

  const threshold = Math.max(1, Math.floor(shorter * 0.34));
  return levenshteinDistance(a, b) <= threshold;
}

/**
 * Resolve a user-typed target name to a confirmed project before any
 * delivery attempt. MUST be called before mem-mesh `pin_add`/`add` or any
 * outbox write (PRD R2, R5) — never proceed on an `ok:false` result.
 *
 * Registry lookup only (does not scan the filesystem) — a directory that
 * has never been `xm project add`-ed is structurally unregistered, not a
 * typo, per PRD §6 Out of Scope ("`.xm/` 없는 생 checkout으로의 전달").
 * Archived registry entries are treated as if absent — a name matching only
 * an archived entry falls through to the same unregistered/ambiguous checks
 * as a name with no entry at all.
 *
 * @param {string} name
 * @returns {{ ok: true, path: string, memMeshProjectId: string }
 *         | { ok: false, reason: 'unregistered'|'missing'|'ambiguous', candidates: string[], message: string }}
 */
export function resolveTarget(name) {
  const query = typeof name === 'string' ? name.trim() : '';
  if (!query) {
    return {
      ok: false,
      reason: 'unregistered',
      candidates: [],
      message: 'No target name given.',
    };
  }

  const registry = loadRegistry();
  const active = registry.projects.filter((p) => !p.archived);

  const exact = active.find((p) => p.id === query || p.name === query);
  if (exact) {
    // Registry membership is not proof the checkout still exists —
    // gcRegistry() only runs on manual `xm project gc`, so a deleted or
    // moved directory can sit in the registry indefinitely (0 other call
    // sites reap it). Verify directly before trusting the entry.
    if (!existsSync(join(exact.path, '.xm'))) {
      return {
        ok: false,
        reason: 'missing',
        candidates: [],
        message: `"${exact.id}" is registered at ${exact.path}, but .xm/ no longer exists there `
          + `(the registration is stale — nothing auto-removes it). `
          + `Run \`xm project gc\` to drop it, or \`xm project add <path>\` if it moved.`,
      };
    }

    const memMeshProjectId = resolveMemMeshProjectId(exact.path);

    // TODO(cross-project-handoff t4, PRD R5 / §7 Risks): when exact.path is a
    // worktree and memMeshProjectId fell all the way through to the basename
    // fallback (no env var, no git config, no .mem-mesh/project-id file),
    // x-kit's resolveCanonicalPath() would collapse this same path to its
    // main checkout while mem-mesh's chain (above) does not — so the two
    // systems disagree on identity for every future call that isn't routed
    // through this function. The PRD's fix is to idempotently run
    // `git config --local mem-mesh.project-id <memMeshProjectId>` inside
    // exact.path here, once, so later mem-mesh calls agree with what we just
    // computed. NOT implemented: writing into a target repo's git config is
    // an action on someone else's repo and needs its own confirmation gate
    // before landing (see coordinator note on this task). Whoever implements
    // it: only write when `runGitLine(exact.path, 'config --local --get ' +
    // MEM_MESH_GIT_CONFIG_KEY)` first comes back null — never overwrite an
    // existing value, and never write when memMeshProjectId came from the
    // env var (that's a per-invocation override, not something to persist).
    return { ok: true, path: exact.path, memMeshProjectId };
  }

  // Match the exact lookup above, which accepts EITHER id or name. Checking
  // only `p.id` here meant a typo of a project's *name* fell through to
  // `unregistered` ("no such project") instead of `ambiguous` ("did you
  // mean…?") — the least helpful answer for the most likely mistake.
  const similar = active.filter(
    (p) => isSimilarProjectName(query, p.id)
      || (p.name && p.name !== p.id && isSimilarProjectName(query, p.name)),
  );
  if (similar.length > 0) {
    const candidates = similar.map((p) => p.id);
    return {
      ok: false,
      reason: 'ambiguous',
      candidates,
      message: `No project registered as "${query}". Did you mean: ${candidates.join(', ')}? `
        + 'Re-run with the exact name — resolveTarget never guesses which one you meant.',
    };
  }

  return {
    ok: false,
    reason: 'unregistered',
    candidates: [],
    message: `No project registered as "${query}" and no similar name found. `
      + 'Run `xm project add <path>` to register it (it must already have a .xm/).',
  };
}
