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
import { TARGET_TOOLS, TARGET_DIR, PRD_VERSION } from './types.mjs';
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
import { CODEX_AGENTS_MAX_BYTES } from './types.mjs';
import { buildManifest, writeManifest, readManifest, verifyManifest, manifestPath } from './manifest.mjs';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

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
      case '--dry-run': out.dryRun = true; break;
      case '--verify': out.verify = true; break;
      case '--uninstall': out.uninstall = true; break;
      case '--auto-detect': out.autoDetect = true; break;
      case '--force': out.force = true; break;
      case '--yes': case '-y': out.yes = true; break;
      case '--allow-unverified': out.allowUnverified = true; break;
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
  xm install --target <tool[,tool...]> [--global|--local] [--dry-run] [--force] [--yes]
  xm install --verify [--target <tool>]
  xm install --auto-detect

TARGETS
  ${TARGET_TOOLS.join(', ')}

OPTIONS
  --list                 Show planned output paths and exit (no fs writes).
  --dry-run              Show full plan with write modes (no fs writes).
  --verify               Re-check installed manifest integrity (re-hash + selfChecksum).
  --auto-detect          Pick targets from cwd signatures (.cursor/, .kiro/, AGENTS.md). (not yet implemented)
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
      const mp = manifestPath(target, installRoot);
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
      const mp = manifestPath(target, installRoot);
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
          let msg = `R-SEC-02: SKILL.md checksum mismatch (supply-chain guard).\n`;
          for (const m of mismatches) {
            msg += `  ${m.plugin}: expected ${m.expected.slice(0, 16)}... got ${m.actual.slice(0, 16)}...\n`;
          }
          msg += `Re-run skills-checksum.mjs (release flow) or pass --allow-unverified to bypass.\n`;
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

  // Real install — all four renderers wired (Phase B/C/D/E).
  const cwd = process.cwd();
  const lines = [];
  for (const target of targets) {
    const installRoot = args.scope === 'global' ? homedir() : cwd;
    const ctx = {
      target,
      scope: args.scope,
      installRoot,
      libPath: (args.scope === 'global' ? '$HOME/' : '') + TARGET_DIR[target] + '/xm/lib',
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
      } else {
        throw new Error(`internal: unhandled target ${target}`);
      }
    } catch (err) {
      return { exitCode: 2, stdout: '', stderr: `${target}: render failed: ${err.message}\n` };
    }

    const allOutputs = [...skillOuts.outputs, ...sharedOuts.outputs];
    /** @type {{ relativePath: string, content: string|Buffer, mode: number }[]} */
    const manifestEntries = [];
    let wrote = 0, unchanged = 0, rotated = 0, updated = 0;
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
      const existingPath = manifestPath(target, installRoot);
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
  }
  return { exitCode: 0, stdout: warnings + lines.join('\n') + '\n', stderr: '' };
}

// CLI entry guard: only exec if invoked directly.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const result = run(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}

export { bundleDir };
