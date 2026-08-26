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

import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';

export function resolveXmDir() {
  if (process.env.XM_ROOT) return process.env.XM_ROOT;
  const localXm = resolve(process.cwd(), '.xm');
  if (existsSync(localXm)) return localXm;
  try {
    const commonDir = execSync('git rev-parse --git-common-dir', {
      cwd: process.cwd(), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const mainXm = resolve(process.cwd(), commonDir, '..', '.xm');
    if (existsSync(mainXm)) return mainXm;
  } catch {}
  return localXm;
}

/** `<repo>/.xm/eval[/segments]` */
export function evalDir(...segments) {
  return join(resolveXmDir(), 'eval', ...segments);
}

/** The project root that owns `.xm/` — the directory assertions and gates run in. */
export function projectRoot() {
  return resolve(resolveXmDir(), '..');
}
