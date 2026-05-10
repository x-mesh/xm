#!/usr/bin/env node
// @ts-check
/**
 * install-cli.mjs — `xm install` entry point.
 *
 * 1차 구현(P-A 단계, t5): --list, --dry-run, --target, --global/--local 파싱.
 * 실제 file write (--target → renderer 호출)은 Phase B/C/D/E에서 추가.
 *
 *   xm install --list
 *   xm install --target cursor --dry-run
 *   xm install --target cursor,codex --global --dry-run
 *
 * --list와 --dry-run은 둘 다 fs를 변경하지 않음. 차이:
 *   --list      target/scope 매트릭스로 출력 경로만 enumerate (간결)
 *   --dry-run   각 파일의 write mode + bytes hint 포함 (자세함)
 */

import { parseTargets, safeJoin, scanSecrets } from './security.mjs';
import { TARGET_TOOLS, PRD_VERSION, targetDirFor } from './types.mjs';
import { scanAll, listMissingCliRefs } from './scan.mjs';
import { planAll, planTarget, bundleDir } from './plan-paths.mjs';
import { writeOverwrite, writeMergeMarker, removeMarkerBlock } from './merge.mjs';
import { renderCursorWithDiagnostics } from './transform/cursor.mjs';
import { renderCursorShared, discoverPluginRoots } from './transform/cursor-shared.mjs';
import { renderCodexWithDiagnostics } from './transform/codex.mjs';
import { renderCodexShared, assertAgentsBlockSize } from './transform/codex-shared.mjs';
import { renderKiroWithDiagnostics } from './transform/kiro.mjs';
import { renderKiroShared } from './transform/kiro-shared.mjs';
import { renderAntigravityWithDiagnostics } from './transform/antigravity.mjs';
import { renderOpencodeWithDiagnostics } from './transform/opencode.mjs';
import { CODEX_AGENTS_MAX_BYTES } from './types.mjs';
import { buildManifest, writeManifest, readManifest, verifyManifest, manifestPath, discoverManifests, readManifestIfExists, shouldSkipTarget } from './manifest.mjs';
import { existsSync, readFileSync, readdirSync, lstatSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';

const HERE = dirname(fileURLToPath(import.meta.url));

// HERE is .../lib/install. Default skills/lib paths differ by layout:
//   - source repo:   HERE/../../.. = <repo>     → skills at xm/skills, lib at xm/lib
//   - plugin cache:  HERE/../..    = <plug>     → skills at <plug>/skills, lib at <plug>/lib
// Probe cache layout first; the marketplace cache puts the version dir between
// the plugin root and lib/, which made the old `../../..` jump one level too high.
function inferDefaultPaths(here) {
  const pluginRoot = resolve(here, '..', '..');
  if (existsSync(resolve(pluginRoot, 'skills')) && existsSync(resolve(pluginRoot, 'lib'))) {
    return { skillsDir: resolve(pluginRoot, 'skills'), libDir: resolve(pluginRoot, 'lib') };
  }
  const repoRoot = resolve(here, '..', '..', '..');
  return { skillsDir: resolve(repoRoot, 'xm', 'skills'), libDir: resolve(repoRoot, 'xm', 'lib') };
}
const DEFAULT_PATHS = inferDefaultPaths(HERE);

/**
 * @typedef {Object} ParsedArgs
 * @property {boolean} list
 * @property {boolean} dryRun
 * @property {boolean} verify
 * @property {boolean} uninstall
 * @property {boolean} autoDetect
 * @property {boolean} force
 * @property {boolean} yes
 * @property {boolean} allowUnverified
 * @property {boolean} interactive
 * @property {boolean} listInstalled
 * @property {boolean} propagate
 * @property {boolean} help
 * @property {'global'|'local'} scope
 * @property {import('./types.mjs').TargetTool[] | null} targets
 * @property {string} skillsDir
 * @property {string} libDir
 * @property {string[]} only          Whitelist plugin names (--only x-build,x-op)
 */

/**
 * @param {string[]} argv  process.argv.slice(2)
 * @returns {ParsedArgs}
 */
export function parseArgs(argv) {
  /** @type {ParsedArgs} */
  const out = {
    list: false,
    dryRun: false,
    verify: false,
    uninstall: false,
    autoDetect: false,
    force: false,
    yes: false,
    allowUnverified: false,
    interactive: false,
    listInstalled: false,
    propagate: false,
    help: false,
    scope: 'local',
    targets: null,
    skillsDir: DEFAULT_PATHS.skillsDir,
    libDir: DEFAULT_PATHS.libDir,
    only: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--list': out.list = true; break;
      case '--list-installed': out.listInstalled = true; break;
      case '--propagate': out.propagate = true; break;
      case '--dry-run': out.dryRun = true; break;
      case '--verify': out.verify = true; break;
      case '--uninstall': out.uninstall = true; break;
      case '--auto-detect': out.autoDetect = true; break;
      case '--force': out.force = true; break;
      case '--yes': case '-y': out.yes = true; break;
      case '--allow-unverified': out.allowUnverified = true; break;
      case '--interactive': out.interactive = true; break;
      case '--global': out.scope = 'global'; break;
      case '--local': out.scope = 'local'; break;
      case '-h': case '--help': out.help = true; break;
      case '--target': out.targets = parseTargets(argv[++i] ?? ''); break;
      case '--skills-dir': out.skillsDir = resolve(argv[++i] ?? ''); break;
      case '--lib-dir': out.libDir = resolve(argv[++i] ?? ''); break;
      case '--only': out.only = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean); break;
      default:
        if (a.startsWith('--target=')) out.targets = parseTargets(a.slice('--target='.length));
        else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
        else throw new Error(`unexpected arg: ${a}`);
    }
  }
  return out;
}

const HELP = `xm install — render xm SKILLs to non-Claude AI tools

USAGE
  xm install --list
  xm install --interactive
  xm install --target <tool[,tool...]> [--global|--local] [--dry-run] [--force] [--yes]
  xm install --verify [--target <tool>]
  xm install --auto-detect

TARGETS
  ${TARGET_TOOLS.join(', ')}

OPTIONS
  --list                 Show planned output paths and exit (no fs writes).
  --list-installed       List installed manifests as JSON (target/scope/installRoot/prdVersion/fileCount).
  --propagate            Re-render every installed manifest target. Outputs JSON summary.
  --dry-run              Show full plan with write modes (no fs writes).
  --verify               Re-check installed manifest integrity (re-hash + selfChecksum).
  --auto-detect          Pick targets from cwd signatures (.cursor/, .kiro/, AGENTS.md). (not yet implemented)
  --interactive          Prompt for scope and targets (default when \`xm install\` runs in a TTY).
  --target <list>        Comma-separated subset of targets.
  --global               Install under \$HOME/.<tool>/ (default: project-local).
  --local                Install under cwd/.<tool>/ (default).
  --force                Permit overwriting non-xm content (asks unless --yes).
  --yes / -y             Skip interactive confirmation in CI.
  --allow-unverified     Skip SHA-256 manifest check (audited, R-SEC-15).
  --only <list>          Limit to specific plugin names.
  --skills-dir <path>    Override SKILL.md source directory.
  --lib-dir <path>       Override xm/lib/ bundle source directory.
  -h, --help             Show this help.

PRD: ${PRD_VERSION}`;

const TARGET_LABELS = Object.freeze({
  cursor: 'Cursor',
  codex: 'Codex CLI',
  kiro: 'Kiro',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
});

/**
 * @param {string} input
 * @param {'global'|'local'} fallback
 * @returns {'global'|'local'}
 */
export function parseScopeSelection(input, fallback = 'local') {
  const value = input.trim().toLowerCase();
  if (!value) return fallback;
  if (value === '1' || value === 'local' || value === 'l') return 'local';
  if (value === '2' || value === 'global' || value === 'g') return 'global';
  throw new Error(`unknown scope selection: ${JSON.stringify(input)} (use local/global or 1/2)`);
}

/**
 * @param {string} token
 * @returns {import('./types.mjs').TargetTool}
 */
function resolveTargetToken(token) {
  const value = token.trim().toLowerCase();
  if (!value) throw new Error('empty target selection');
  if (/^\d+$/.test(value)) {
    const index = Number(value) - 1;
    const target = TARGET_TOOLS[index];
    if (!target) throw new Error(`target number out of range: ${value}`);
    return target;
  }
  if (TARGET_TOOLS.includes(/** @type {any} */ (value))) {
    return /** @type {import('./types.mjs').TargetTool} */ (value);
  }
  const matches = TARGET_TOOLS.filter((target) => target.startsWith(value) || target.includes(value));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`ambiguous target selection: ${value} (${matches.join(', ')})`);
  throw new Error(`unknown target selection: ${value}`);
}

/**
 * Parse an fzf-like target selection. Accepts `all`, numbers (`1,3`), names
 * (`cursor,opencode`), or unique fuzzy fragments (`open`).
 *
 * @param {string} input
 * @param {import('./types.mjs').TargetTool[]} [fallback]
 * @returns {import('./types.mjs').TargetTool[]}
 */
export function parseTargetSelection(input, fallback = [...TARGET_TOOLS]) {
  const value = input.trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'all' || value === '*') return [...TARGET_TOOLS];
  if (value === 'none') throw new Error('select at least one target');
  const targets = value.split(/[\s,]+/).filter(Boolean).map(resolveTargetToken);
  return Array.from(new Set(targets));
}

/**
 * @param {ParsedArgs} args
 * @returns {string[]}
 */
function argsToArgv(args) {
  const argv = [];
  if (args.list) argv.push('--list');
  if (args.dryRun) argv.push('--dry-run');
  if (args.verify) argv.push('--verify');
  if (args.uninstall) argv.push('--uninstall');
  if (args.autoDetect) argv.push('--auto-detect');
  if (args.force) argv.push('--force');
  if (args.yes) argv.push('--yes');
  if (args.allowUnverified) argv.push('--allow-unverified');
  argv.push(args.scope === 'global' ? '--global' : '--local');
  if (args.targets) argv.push('--target', args.targets.join(','));
  if (args.only.length > 0) argv.push('--only', args.only.join(','));
  argv.push('--skills-dir', args.skillsDir);
  argv.push('--lib-dir', args.libDir);
  return argv;
}

/**
 * @param {NodeJS.ReadableStream} input
 * @returns {Promise<{ body: string, lines: string[] }>}
 */
function readPipedAnswers(input) {
  return new Promise((resolve, reject) => {
    let body = '';
    input.setEncoding?.('utf8');
    input.on('data', (chunk) => { body += chunk; });
    input.on('end', () => { resolve({ body, lines: body.split(/\r?\n/) }); });
    input.on('error', reject);
    input.resume?.();
  });
}

/**
 * Mirror `xm/lib` into the target's bundle directory so generated skills and
 * hooks can execute the CLI paths produced by expandPaths().
 *
 * @param {string} libDir
 * @param {import('./types.mjs').TargetTool} target
 * @param {'global'|'local'} scope
 * @returns {import('./types.mjs').RenderOutput[]}
 */
function renderBundleOutputs(libDir, target, scope) {
  /** @type {import('./types.mjs').RenderOutput[]} */
  const outputs = [];
  const base = join(targetDirFor(target, scope), 'xm', 'lib');
  const mode = scope === 'global' ? 0o600 : 0o644;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, entry.name);
      const rel = relative(libDir, abs);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        // Re-check via lstat right before read to close the TOCTOU window
        // between readdirSync's withFileTypes snapshot and the actual read.
        const st = lstatSync(abs);
        if (st.isSymbolicLink()) {
          throw new Error(`refusing to bundle symlink: ${abs}`);
        }
        if (!st.isFile()) continue;
        outputs.push({
          relativePath: join(base, rel),
          content: readFileSync(abs, 'utf8'),
          kind: 'overwrite',
          mode,
        });
      } else if (lstatSync(abs).isSymbolicLink()) {
        throw new Error(`refusing to bundle symlink: ${abs}`);
      }
    }
  };
  walk(libDir);
  return outputs;
}

/**
 * @param {ReturnType<typeof planTarget>} entries
 * @param {string} libDir
 * @returns {ReturnType<typeof planTarget>}
 */
function expandBundlePlanEntries(entries, libDir) {
  const expanded = [];
  for (const entry of entries) {
    if (entry.kind !== 'bundle') {
      expanded.push(entry);
      continue;
    }
    const walk = (dir) => {
      for (const child of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const abs = join(dir, child.name);
        if (child.isDirectory()) {
          walk(abs);
        } else if (child.isFile()) {
          expanded.push({
            ...entry,
            absolutePath: join(entry.absolutePath, relative(libDir, abs)),
          });
        } else if (lstatSync(abs).isSymbolicLink()) {
          throw new Error(`refusing to plan bundle symlink: ${abs}`);
        }
      }
    };
    walk(libDir);
  }
  return expanded;
}

/**
 * @param {Record<string, ReturnType<typeof planTarget>>} planMap
 * @param {string} libDir
 * @returns {Record<string, ReturnType<typeof planTarget>>}
 */
function expandBundlePlanMap(planMap, libDir) {
  return Object.fromEntries(
    Object.entries(planMap).map(([target, entries]) => [target, expandBundlePlanEntries(entries, libDir)])
  );
}

/**
 * @param {ParsedArgs} args
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} [io]
 * @returns {Promise<ParsedArgs>}
 */
export async function promptInstallOptions(args, io = {}) {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const useReadline = Boolean(/** @type {{ isTTY?: boolean }} */ (input).isTTY);
  const piped = useReadline ? { body: '', lines: [] } : await readPipedAnswers(input);
  if (!useReadline && piped.body.length === 0) {
    throw new Error('--interactive requires terminal input or newline-delimited answers on stdin');
  }
  const answers = piped.lines;
  let answerIndex = 0;
  const rl = useReadline ? createInterface({ input, output }) : null;
  const question = async (prompt) => {
    if (rl) return rl.question(prompt);
    output.write(prompt);
    return answers[answerIndex++] ?? '';
  };
  try {
    output.write('\nxm install interactive\n\n');
    output.write('Scope\n');
    output.write('  1) local  - install under the current project\n');
    output.write('  2) global - install under your home directory\n');
    const scopeAnswer = await question(`Scope [${args.scope}]: `);
    const scope = parseScopeSelection(scopeAnswer, args.scope);

    const fallbackTargets = args.targets ?? [...TARGET_TOOLS];
    output.write('\nTargets\n');
    TARGET_TOOLS.forEach((target, index) => {
      output.write(`  ${index + 1}) ${target.padEnd(12)} ${TARGET_LABELS[target]}\n`);
    });
    output.write('  all) every target\n');
    const targetAnswer = await question(`Targets [${fallbackTargets.join(',')}]: `);
    const targets = parseTargetSelection(targetAnswer, fallbackTargets);
    output.write(`\nSelected: ${scope} -> ${targets.join(', ')}\n\n`);
    return { ...args, scope, targets, interactive: false };
  } finally {
    rl?.close();
  }
}

/**
 * @param {string[]} argv
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} [io]
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
export async function runInteractive(argv, io = {}) {
  try {
    const args = parseArgs(argv);
    const prompted = await promptInstallOptions(args, io);
    return run(argsToArgv(prompted));
  } catch (err) {
    return { exitCode: 2, stdout: '', stderr: String(/** @type {Error} */ (err).message || err) + '\n' };
  }
}

/** Pretty-print --list output. */
export function renderList(planMap) {
  const lines = [];
  for (const [target, entries] of Object.entries(planMap)) {
    lines.push(`# ${target}  (${entries.length} entries)`);
    for (const e of entries) {
      lines.push(`  ${e.kind.padEnd(10)} ${e.writeMode.padEnd(13)} ${e.absolutePath}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Pretty-print --dry-run output. */
export function renderDryRun(planMap, skills) {
  const lines = [];
  lines.push(`# DRY RUN — no files modified.`);
  lines.push(`# skills: ${skills.length}, targets: ${Object.keys(planMap).length}`);
  lines.push('');
  for (const [target, entries] of Object.entries(planMap)) {
    lines.push(`## ${target}`);
    const byKind = entries.reduce((m, e) => ((m[e.kind] = (m[e.kind] ?? 0) + 1), m), /** @type {Record<string,number>} */({}));
    lines.push(`   counts: ${Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    for (const e of entries) {
      lines.push(`   ${e.skill.padEnd(20)} ${e.kind.padEnd(10)} ${e.writeMode.padEnd(13)} mode=0o${e.mode.toString(8)} ${e.absolutePath}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * @param {string[]} argv
 * @returns {{ exitCode: number, stdout: string, stderr: string }}
 */
export function run(argv) {
  /** @type {ParsedArgs} */
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    return { exitCode: 2, stdout: '', stderr: String(err.message || err) + '\n' };
  }
  if (args.help) {
    return { exitCode: 0, stdout: HELP + '\n', stderr: '' };
  }

  // --list-installed: discover installed manifests and return as JSON.
  if (args.listInstalled) {
    const entries = discoverManifests([homedir()]);
    const result = [];
    for (const entry of entries) {
      try {
        const manifest = readManifestIfExists(entry.path);
        if (!manifest) continue;
        result.push({
          target: entry.target,
          scope: entry.scope,
          installRoot: entry.installRoot,
          prdVersion: manifest.prdVersion,
          fileCount: manifest.files.length,
        });
      } catch (err) {
        result.push({
          target: entry.target,
          scope: entry.scope,
          installRoot: entry.installRoot,
          error: /** @type {Error} */ (err).message,
        });
      }
    }
    return { exitCode: 0, stdout: JSON.stringify(result, null, 2) + '\n', stderr: '' };
  }

  // --propagate: re-render every installed manifest target.
  if (args.propagate) {
    const installRoot = homedir();
    const entries = discoverManifests([installRoot]);
    if (entries.length === 0) {
      const empty = { results: [], summary: { total: 0, success: 0, skipped: 0, failed: 0, migrated: 0 } };
      return { exitCode: 0, stdout: JSON.stringify(empty, null, 2) + '\n', stderr: '' };
    }

    // Scan skills once for all targets.
    /** @type {import('./types.mjs').SkillIR[]} */
    let skills;
    try {
      skills = scanAll({ skillsDir: args.skillsDir, libDir: args.libDir, only: undefined });
    } catch (err) {
      return { exitCode: 2, stdout: '', stderr: `scan failed: ${/** @type {Error} */ (err).message}\n` };
    }

    const results = [];
    let stderrNotes = '';

    for (const entry of entries) {
      const { target, scope } = entry;

      // Check manifest validity to decide skip vs re-install.
      let manifest = null;
      let migrating = false;
      try {
        manifest = readManifestIfExists(entry.path);
      } catch (err) {
        // Schema mismatch or corrupt → safe re-install.
        migrating = true;
        manifest = null;
      }

      // Build planned files via full render to enable shouldSkipTarget comparison.
      // The recursive run() is the v1 install mechanism; this pre-check avoids it
      // when content hasn't changed.
      let plannedFileCount = 0;
      let skip = false;
      if (!migrating && manifest) {
        try {
          planAll({ skills, targets: [target], scope, cwd: process.cwd() });
          // Run through the same install path to produce rendered content, then
          // compare. Since v1 uses recursive run() anyway, we use verifyManifest
          // as a lightweight proxy: if all files on disk still match the manifest
          // SHA-256s, and manifest selfChecksum is valid, the install is a no-op.
          const verification = verifyManifest(manifest);
          plannedFileCount = manifest.files.length;
          skip = verification.ok;
        } catch {
          // Plan failure → must re-install to surface the error properly.
          skip = false;
        }
      }

      if (skip) {
        results.push({ target, scope, status: 'skipped', filesChanged: 0, filesSkipped: plannedFileCount, error: null });
        continue;
      }

      // Re-install via recursive run().
      if (migrating) {
        stderrNotes += `note: migrating ${target} from incompatible manifest schema\n`;
      }
      const subArgv = ['--target', target, scope === 'global' ? '--global' : '--local', '--force', '--yes',
                       '--skills-dir', args.skillsDir, '--lib-dir', args.libDir];
      const sub = run(subArgv);
      const subWarnings = sub.stderr.split('\n').filter((line) => line.includes('marker block content changed'));
      if (sub.exitCode === 0) {
        const status = migrating ? 'migrated' : 'updated';
        results.push({ target, scope, status, filesChanged: plannedFileCount || manifest?.files.length || 0, filesSkipped: 0, warnings: subWarnings, error: null });
      } else {
        results.push({ target, scope, status: 'failed', filesChanged: 0, filesSkipped: 0, warnings: subWarnings, error: sub.stderr.trim() });
      }
    }

    const summary = {
      total: results.length,
      success: results.filter((r) => r.status === 'updated').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      failed: results.filter((r) => r.status === 'failed').length,
      migrated: results.filter((r) => r.status === 'migrated').length,
    };
    const exitCode = (summary.success === 0 && summary.migrated === 0 && summary.failed > 0) ? 1 : 0;
    return { exitCode, stdout: JSON.stringify({ results, summary }, null, 2) + '\n', stderr: stderrNotes };
  }

  // Default --list when no flags given (planner C3 / N7).
  if (!args.list && !args.dryRun && !args.verify && !args.targets) {
    args.list = true;
  }

  // --verify: re-hash files and compare against manifest (R-SEC-13/15, SC8/SC17/SC19).
  if (args.verify) {
    const cwd = process.cwd();
    const installRoot = args.scope === 'global' ? homedir() : cwd;
    const targetsToCheck = args.targets ?? [...TARGET_TOOLS];
    const out = [];
    let ok = true;
    let anyChecked = false;
    for (const target of targetsToCheck) {
      const mp = manifestPath(target, installRoot, args.scope);
      if (!existsSync(mp)) {
        out.push(`# ${target} (${args.scope}): no manifest at ${mp} — skipping`);
        continue;
      }
      anyChecked = true;
      let manifest;
      try {
        manifest = readManifest(mp);
      } catch (err) {
        out.push(`# ${target}: manifest unreadable — ${err.message}`);
        ok = false;
        continue;
      }
      const result = verifyManifest(manifest);
      const counts = result.entries.reduce((m, e) => ((m[e.status] = (m[e.status] ?? 0) + 1), m), /** @type {Record<string,number>} */({}));
      out.push(`# ${target} (${manifest.scope}, ${manifest.files.length} files)`);
      out.push(`  selfChecksum: ${result.selfChecksumOk ? 'ok' : 'FAIL'}`);
      // H5 (errors review): treat selfChecksum failure as an explicit verdict
      // miss, not just an indirect contribution to result.ok. A FAIL means the
      // manifest itself was edited — even if every file SHA still matches a
      // recomputed-from-tampered manifest, that is exactly the scenario we
      // want to surface to the user.
      if (!result.selfChecksumOk) {
        out.push('  ⚠ manifest selfChecksum invalid — manifest.json may have been edited outside the installer.');
        ok = false;
      }
      out.push(`  status counts: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
      if (counts.unverified) {
        out.push(`  ⚠ ${counts.unverified} entry(ies) installed with --allow-unverified (R-SEC-15).`);
      }
      // R-SEC-08 / SC15 / t24: surface mode mismatches (e.g. global file not 0o600).
      const expectedGlobalMode = 0o600;
      const modeMismatches = result.entries.filter((e) => {
        if (e.status === 'missing') return false;
        if (e.mode.actual === null) return false;
        if (e.mode.expected === e.mode.actual) return false;
        // For global scope, every regular file must be 0o600 — flag downgrades to wider perms.
        if (manifest.scope === 'global' && e.mode.actual !== expectedGlobalMode) return true;
        // For local scope, only flag if mode differs from manifest record.
        return manifest.scope !== 'global';
      });
      if (modeMismatches.length > 0) {
        out.push(`  ⚠ mode mismatch: ${modeMismatches.length} entry(ies) (R-SEC-08).`);
        for (const m of modeMismatches.slice(0, 5)) {
          out.push(`    expected=0o${m.mode.expected.toString(8)} actual=0o${m.mode.actual?.toString(8)} ${m.path}`);
        }
        if (modeMismatches.length > 5) out.push(`    ...and ${modeMismatches.length - 5} more`);
        ok = false;
      }
      const bad = result.entries.filter(e => e.status === 'changed' || e.status === 'missing');
      for (const b of bad.slice(0, 10)) {
        out.push(`  ${b.status.padEnd(8)} ${b.path}`);
      }
      if (bad.length > 10) out.push(`  ...and ${bad.length - 10} more`);
      if (!result.ok) ok = false;
    }
    if (!anyChecked) {
      return { exitCode: 1, stdout: '', stderr: 'No manifests found for any of the requested targets. Did you run `xm install` first?\n' };
    }
    return { exitCode: ok ? 0 : 1, stdout: out.join('\n') + '\n', stderr: '' };
  }

  // --uninstall: remove files recorded in the manifest, leaving external content intact.
  if (args.uninstall) {
    const cwd = process.cwd();
    const installRoot = args.scope === 'global' ? homedir() : cwd;
    const targetsToRemove = args.targets ?? [...TARGET_TOOLS];
    const out = [];
    let exit = 0;
    let anyTouched = false;
    for (const target of targetsToRemove) {
      const mp = manifestPath(target, installRoot, args.scope);
      if (!existsSync(mp)) {
        out.push(`# ${target} (${args.scope}): no manifest at ${mp} — nothing to uninstall`);
        continue;
      }
      anyTouched = true;
      let manifest;
      try {
        manifest = readManifest(mp);
      } catch (err) {
        out.push(`# ${target}: manifest unreadable — ${err.message}`);
        exit = 1;
        continue;
      }
      let removed = 0;
      let preserved = 0;
      let skipped = 0;
      for (const entry of manifest.files) {
        const abs = safeJoin(manifest.installRoot, entry.relativePath);
        if (!existsSync(abs)) { skipped++; continue; }
        // merge-marker entries (AGENTS.md): peel xm region, preserve user content
        const isAgents = /(^|\/)AGENTS\.md$/.test(entry.relativePath);
        try {
          if (isAgents) {
            const r = removeMarkerBlock(abs);
            if (r.removed) removed++; else preserved++;
          } else {
            unlinkSync(abs);
            removed++;
          }
        } catch (err) {
          out.push(`  WARN failed to remove ${abs}: ${err.message}`);
          exit = 1;
        }
      }
      // Remove manifest itself.
      try { unlinkSync(mp); } catch { /* fine */ }
      out.push(`# ${target} (${manifest.scope}): removed ${removed}, preserved ${preserved}, skipped ${skipped}`);
    }
    if (!anyTouched) {
      return { exitCode: 1, stdout: '', stderr: 'No manifests found — nothing to uninstall.\n' };
    }
    return { exitCode: exit, stdout: out.join('\n') + '\n', stderr: '' };
  }

  // Scan SKILLs.
  /** @type {import('./types.mjs').SkillIR[]} */
  let skills;
  try {
    skills = scanAll({ skillsDir: args.skillsDir, libDir: args.libDir, only: args.only });
  } catch (err) {
    return { exitCode: 2, stdout: '', stderr: `scan failed: ${err.message}\n` };
  }

  // R-SEC-02 / SC13: verify SKILL.md SHA-256 against skills.checksums.json.
  // The check is bypassed only when --allow-unverified is set (R-SEC-15).
  let warnings = '';
  if (!args.allowUnverified) {
    const checksumPath = resolve(args.skillsDir, '..', 'skills.checksums.json');
    if (existsSync(checksumPath)) {
      try {
        const registry = JSON.parse(readFileSync(checksumPath, 'utf8'));
        const expected = new Map((registry.skills || []).map((s) => [s.plugin, s.sha256]));
        const mismatches = [];
        for (const s of skills) {
          const want = expected.get(s.pluginName);
          if (!want) continue; // not in registry → unknown skill, ignore
          if (want !== s.checksum) {
            mismatches.push({ plugin: s.pluginName, expected: want, actual: s.checksum });
          }
        }
        if (mismatches.length > 0) {
          let msg = `R-SEC-02: ${mismatches.length} SKILL.md file(s) differ from xm/skills.checksums.json.\n\n`;
          for (const m of mismatches) {
            msg += `  ${m.plugin.padEnd(14)} registry: ${m.expected.slice(0, 16)}...  actual: ${m.actual.slice(0, 16)}...\n`;
          }
          msg += `\nMost likely cause: the registry was not regenerated after a release that touched these SKILL.md files.\n`;
          msg += `If you ran /x-release on a version of release.mjs that pre-dates auto-regeneration, fix with:\n`;
          msg += `  node xm/scripts/skills-checksum.mjs\n`;
          msg += `  git add xm/skills.checksums.json && git commit -m "chore: update skills checksums"\n\n`;
          msg += `Treat as a supply-chain event ONLY if you did not modify these files. Inspect with:\n`;
          msg += `  git log -p -- xm/skills/<plugin>/SKILL.md\n\n`;
          msg += `Bypass for one-off testing (audited, flagged unverified=true): --allow-unverified  (R-SEC-15)\n`;
          return { exitCode: 2, stdout: '', stderr: msg };
        }
      } catch (err) {
        return { exitCode: 2, stdout: '', stderr: `failed to read ${checksumPath}: ${err.message}\n` };
      }
    } else {
      warnings += `# note: skills.checksums.json not found (R-SEC-02 advisory). Run xm/scripts/skills-checksum.mjs to enable.\n`;
    }
  }

  // Surface ghost CLI references (critic B2).
  const missing = listMissingCliRefs(skills);
  if (missing.length > 0) {
    warnings += `# warnings: ${missing.length} CLI reference(s) point to missing files\n`;
    for (const m of missing) warnings += `  ${m.plugin} → ${m.sourcePath}\n`;
    warnings += '\n';
  }

  // R-SEC-11 / SC16: secret pattern scan over every SKILL body + reference.
  // Without --allow-unverified we abort install when a likely secret slips into
  // a SKILL.md. Best-effort regex; documented as such in the install guide.
  if (!args.allowUnverified) {
    const hits = [];
    for (const s of skills) {
      for (const h of scanSecrets(s.body)) {
        hits.push({ plugin: s.pluginName, location: `body line ${h.line}`, snippet: h.snippet });
      }
      for (const ref of s.references) {
        for (const h of scanSecrets(ref.body)) {
          hits.push({ plugin: s.pluginName, location: `${ref.relativePath} line ${h.line}`, snippet: h.snippet });
        }
      }
    }
    if (hits.length > 0) {
      let msg = `R-SEC-11: secret pattern detected in source SKILL(s) (${hits.length} match).\n`;
      for (const h of hits.slice(0, 8)) msg += `  ${h.plugin} ${h.location}: ${h.snippet}\n`;
      if (hits.length > 8) msg += `  ... and ${hits.length - 8} more\n`;
      msg += `Edit the SKILL or pass --allow-unverified to bypass (audited).\n`;
      return { exitCode: 2, stdout: '', stderr: msg };
    }
  }

  // If --target is unset, plan for all known tools (overview).
  const targets = args.targets ?? [...TARGET_TOOLS];

  // Build plan.
  /** @type {Record<string, ReturnType<typeof planTarget>>} */
  let planMap;
  try {
    planMap = planAll({ skills, targets, scope: args.scope, cwd: process.cwd() });
    planMap = expandBundlePlanMap(planMap, args.libDir);
  } catch (err) {
    return { exitCode: 2, stdout: '', stderr: `plan failed: ${err.message}\n` };
  }

  if (args.list) {
    return {
      exitCode: 0,
      stdout: warnings + renderList(planMap) + '\n',
      stderr: '',
    };
  }

  if (args.dryRun) {
    return {
      exitCode: 0,
      stdout: warnings + renderDryRun(planMap, skills) + '\n',
      stderr: '',
    };
  }

  // Real install — renderers are wired per target.
  const cwd = process.cwd();
  const lines = [];
  let stderrMergeWarnings = '';
  for (const target of targets) {
    const installRoot = args.scope === 'global' ? homedir() : cwd;
    const ctx = {
      target,
      scope: args.scope,
      installRoot,
      libPath: (args.scope === 'global' ? '$HOME/' : '') + targetDirFor(target, args.scope) + '/xm/lib',
      dryRun: false,
      allowUnverified: args.allowUnverified,
    };
    /** @type {{ outputs: import('./types.mjs').RenderOutput[], warnings: string[] }} */
    let skillOuts;
    /** @type {{ outputs: import('./types.mjs').RenderOutput[], notes: string[] }} */
    let sharedOuts = { outputs: [], notes: [] };
    try {
      if (target === 'cursor') {
        skillOuts = renderCursorWithDiagnostics(skills, ctx);
        sharedOuts = renderCursorShared({
          projectRoot: cwd,
          pluginRoots: discoverPluginRoots(cwd),
          scope: args.scope,
        });
      } else if (target === 'codex') {
        const codex = renderCodexWithDiagnostics(skills, ctx);
        skillOuts = { outputs: codex.outputs, warnings: codex.warnings };
        sharedOuts = renderCodexShared({ projectRoot: cwd, scope: args.scope });
      } else if (target === 'kiro') {
        const kiro = renderKiroWithDiagnostics(skills, ctx);
        skillOuts = { outputs: kiro.outputs, warnings: kiro.warnings };
        sharedOuts = renderKiroShared({ projectRoot: cwd, scope: args.scope });
      } else if (target === 'antigravity') {
        const ag = renderAntigravityWithDiagnostics(skills, ctx);
        skillOuts = { outputs: ag.outputs, warnings: ag.warnings };
        // Antigravity has no hooks — sharedOuts stays empty.
      } else if (target === 'opencode') {
        const opencode = renderOpencodeWithDiagnostics(skills, ctx);
        skillOuts = { outputs: opencode.outputs, warnings: opencode.warnings };
        // OpenCode discovers native skills; no programmable hook API is emitted.
      } else {
        throw new Error(`internal: unhandled target ${target}`);
      }
    } catch (err) {
      return { exitCode: 2, stdout: '', stderr: `${target}: render failed: ${err.message}\n` };
    }

    let bundleOuts;
    try {
      bundleOuts = renderBundleOutputs(args.libDir, target, args.scope);
    } catch (err) {
      return { exitCode: 2, stdout: '', stderr: `${target}: bundle failed: ${/** @type {Error} */ (err).message}\n` };
    }
    const allOutputs = [...skillOuts.outputs, ...sharedOuts.outputs, ...bundleOuts];
    /** @type {{ relativePath: string, content: string|Buffer, mode: number }[]} */
    const manifestEntries = [];
    let wrote = 0, unchanged = 0, rotated = 0, updated = 0;
    let mergeWarnings = '';
    for (const out of allOutputs) {
      const abs = safeJoin(installRoot, out.relativePath);
      try {
        if (out.kind === 'merge-marker') {
          // Codex / Antigravity AGENTS.md — enforce 32 KiB headroom.
          assertAgentsBlockSize(out.content);
          const result = writeMergeMarker(abs, out.content, {
            mode: out.mode,
            maxBlockBytes: CODEX_AGENTS_MAX_BYTES,
          });
          if (result.action === 'created') wrote++;
          else if (result.action === 'unchanged') unchanged++;
          else if (result.action === 'updated') updated++;
          else if (result.action === 'rotated-and-updated') rotated++;
          if (result.warning) {
            mergeWarnings += `WARN ${target} ${out.relativePath}: ${result.warning}\n`;
          }
        } else {
          const result = writeOverwrite(abs, out.content, { mode: out.mode });
          if (result.action === 'created') wrote++;
          else if (result.action === 'unchanged') unchanged++;
          else if (result.action === 'rotated-and-updated') rotated++;
        }
      } catch (err) {
        return { exitCode: 2, stdout: '', stderr: `${target}: write failed for ${abs}: ${err.message}\n` };
      }
      // For merge-marker writes, the final on-disk file includes the BEGIN/END
      // wrapper plus any preserved user content. The manifest must record the
      // SHA of what is actually on disk so `--verify` can compare like-for-like.
      let recordedContent = out.content;
      if (out.kind === 'merge-marker') {
        try { recordedContent = readFileSync(abs, 'utf8'); } catch (e) {
          warnings += `  WARN: could not re-read ${abs} for manifest hash: ${/** @type {Error} */ (e).message}\n`;
        }
      }
      manifestEntries.push({
        relativePath: out.relativePath,
        content: recordedContent,
        mode: out.mode,
      });
    }
    // R-SEC-10 / R-SEC-13 / R-SEC-15: persist install manifest.
    // Idempotency guard: if every entry's SHA-256 matches the prior manifest,
    // skip writing — the random nonce + timestamp would otherwise produce a
    // different manifest body even when the install is a no-op.
    try {
      const newEntriesByPath = new Map();
      for (const e of manifestEntries) {
        const buf = typeof e.content === 'string' ? Buffer.from(e.content, 'utf8') : e.content;
        newEntriesByPath.set(e.relativePath, { sha256: createHash('sha256').update(buf).digest('hex'), mode: e.mode });
      }
      const existingPath = manifestPath(target, installRoot, args.scope);
      let canSkip = false;
      if (existsSync(existingPath)) {
        // E (errors review): scope catch to readManifest only — programming
        // errors inside the .every() callback below must surface, not be
        // swallowed silently as "rebuild needed".
        let prev = null;
        try { prev = readManifest(existingPath); } catch { prev = null; }
        if (
          prev &&
          prev.target === target &&
          prev.scope === args.scope &&
          prev.files.length === manifestEntries.length &&
          prev.files.every((p) => {
            const want = newEntriesByPath.get(p.relativePath);
            return want && want.sha256 === p.sha256 && want.mode === p.mode &&
                   Boolean(p.unverified) === Boolean(args.allowUnverified);
          })
        ) {
          canSkip = true;
        }
      }
      if (!canSkip) {
        const manifest = buildManifest({
          target,
          scope: args.scope,
          installRoot,
          entries: manifestEntries,
          unverified: args.allowUnverified,
        });
        writeManifest(manifest);
      }
    } catch (err) {
      return { exitCode: 2, stdout: '', stderr: `${target}: manifest write failed: ${err.message}\n` };
    }
    lines.push(`# ${target} (${args.scope})`);
    lines.push(`  files written: ${wrote}, unchanged: ${unchanged}, updated: ${updated}, rotated: ${rotated}, total: ${allOutputs.length}`);
    if (args.allowUnverified) lines.push(`  ⚠ --allow-unverified: manifest entries flagged unverified=true (R-SEC-15).`);
    for (const w of skillOuts.warnings) lines.push(`  WARN ${w}`);
    for (const n of sharedOuts.notes) lines.push(`  note: ${n}`);
    stderrMergeWarnings += mergeWarnings;
  }
  return { exitCode: 0, stdout: warnings + lines.join('\n') + '\n', stderr: stderrMergeWarnings };
}

// CLI entry guard: only exec if invoked directly.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const result = argv.includes('--interactive') ? await runInteractive(argv) : run(argv);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}

export { bundleDir };
