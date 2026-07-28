/**
 * Runs core.runQualityChecks() inside a disposable X_BUILD_ROOT and prints the
 * results as JSON on stdout.
 *
 * This exists as a separate PROCESS on purpose. core.mjs binds `ROOT` at import
 * time, and an ES module is a per-process singleton: once any earlier test file
 * in the same `bun test` run has imported core.mjs, a later file setting
 * X_BUILD_ROOT before its own `await import(...)` gets the already-cached
 * module and its sandbox silently evaporates. runQualityChecks then reads the
 * REAL repo's .xm/config.json and spawns its serial_quality_command — for this
 * repo that is a nested `bun test`, which took ~90s and blew the 5s per-test
 * timeout depending only on which files ran first.
 *
 * Usage: bun test/fixtures/quality-sandbox.mjs <xmDir> <project>
 *   xmDir   — the sandbox's `.xm` directory; ROOT becomes <xmDir>/build, so
 *             repoRoot() is <xmDir>/.., i.e. the sandbox repo root.
 *   project — project name under <xmDir>/build/projects/.
 */
import { join } from 'node:path';

const [, , xmDir, project] = process.argv;
if (!xmDir || !project) {
  process.stderr.write('usage: quality-sandbox.mjs <xmDir> <project>\n');
  process.exit(2);
}

process.env.X_BUILD_ROOT = join(xmDir, 'build');
// HOME too: loadSharedConfig() merges ~/.xm/config.json, which would otherwise
// leak the developer's own gate_scripts into the assertions.
process.env.HOME = join(xmDir, 'home');

const core = await import('../../x-build/lib/x-build/core.mjs');

const results = core.runQualityChecks(project);
const saved = core.readJSON(join(core.phaseDir(project, '04-verify'), 'quality-results.json'));
process.stdout.write(JSON.stringify({ root: core.ROOT, repoRoot: core.repoRoot(), results, saved }));
