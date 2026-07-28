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
 * `resolveMemMeshProjectId()` (re-exported from ../mem-mesh-identity.mjs)
 * follows mem-mesh's chain verbatim
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

import { existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

import { loadRegistry } from '../x-projects-registry.mjs';

// The identity chain itself lives one tier up: x-build's handoff mirror needs
// the exact same answer, and a second implementation is how the two drift.
// Imported for local use AND re-exported, so this module's public surface is
// unchanged — `export ... from` alone re-exports without binding the name
// locally, and resolveTarget() below calls it.
import { resolveMemMeshProjectId } from '../mem-mesh-identity.mjs';

export {
  resolveMemMeshProjectId,
  MEM_MESH_ENV_VAR,
  MEM_MESH_GIT_CONFIG_KEY,
  MEM_MESH_PROJECT_ID_RELPATH,
} from '../mem-mesh-identity.mjs';


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
