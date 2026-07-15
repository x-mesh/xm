/**
 * xm-root.mjs — Pure .xm/ STATE root resolution, no internal imports.
 *
 * core.mjs and root.mjs need to turn "current cwd" into "the .xm/ directory
 * that already holds this project's state" without importing each other
 * (root.mjs backs config-loader.mjs/cost-engine.mjs, which core.mjs itself
 * depends on — importing core.mjs back would cycle). This module has zero
 * project imports so both can share it safely.
 *
 * STATE is per-working-tree. Config sharing is a SEPARATE concern —
 * shared-config.mjs resolves .xm/config.json with git-common-dir so a linked
 * worktree reads the MAIN checkout's config. State does NOT: it must follow
 * the working tree the command actually runs in (see resolveXmRoot below),
 * so a worktree's session/build state never lands in the main checkout.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Resolve the .xm/ STATE directory for the current process.
 * Priority: cwd/.xm/ (if it already exists) → the current WORKING TREE's root
 * via `git rev-parse --show-toplevel` (walks up from any subdirectory) →
 * cwd/.xm/ (default; caller creates it if missing).
 *
 * `--show-toplevel` deliberately stays inside the current checkout:
 *   - from a subdirectory it returns the repo root (fixes the stray-.xm bug);
 *   - from a LINKED WORKTREE it returns the worktree itself, NOT the main
 *     repo — so per-worktree state stays independent and `repoRoot()`
 *     (derived from ROOT) keeps pointing at the tree git actually operates on;
 *   - in a BARE repo it errors, and we fall back to cwd/.xm.
 * It never escapes into a separate parent repo.
 *
 * Callers that support an explicit override (env var, --global) must check
 * those first and only fall back to this function for the default case.
 */
export function resolveXmRoot() {
  const localXm = join(process.cwd(), '.xm');
  if (existsSync(localXm)) {
    return localXm;
  }
  try {
    const top = execSync('git rev-parse --show-toplevel', {
      cwd: process.cwd(), encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (top) {
      const topXm = join(top, '.xm');
      if (existsSync(topXm)) {
        return topXm;
      }
    }
  } catch {
    // Not a work tree (bare repo) or git unavailable — fall through
  }
  return localXm;
}
