// @ts-check
/**
 * plan-paths.mjs — given a SkillIR[] and a (target, scope), enumerate the
 * output files an installer would create. Renderers (B/C/D/E) consume this
 * plan; --list / --dry-run print it.
 *
 * Path conventions are derived from research notes (Cursor / Codex / Kiro /
 * Antigravity / OpenCode) and PRD §5.2.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { TARGET_TOOLS, targetDirFor } from './types.mjs';
import { xmName, flattenRefPath } from './util/flatten-namespace.mjs';
import { codexVendorRelativePaths } from './transform/codex-vendor.mjs';

/**
 * @typedef {Object} PlanEntry
 * @property {string} absolutePath
 * @property {'rule'|'command'|'hook'|'index'|'prompt'|'plugin-manifest'|'marketplace'|'steering'|'skill-doc'|'reference'|'bundle'|'vendor-config'} kind
 * @property {string} skill           Owning skill identifier (e.g. xm-build).
 * @property {'overwrite'|'merge-marker'} writeMode
 * @property {0o600|0o644} mode
 */

/**
 * @param {import('./types.mjs').TargetTool} target
 * @param {'global'|'local'} scope
 * @param {string} cwd
 * @returns {string}
 */
function rootFor(target, scope, cwd) {
  if (scope === 'local') {
    return cwd;
  }
  // global → user-home anchored
  return homedir();
}

/**
 * @param {'global'|'local'} scope
 * @returns {0o600|0o644}
 */
function modeFor(scope) {
  return scope === 'global' ? 0o600 : 0o644;
}

/**
 * @param {import('./types.mjs').SkillIR} s
 * @param {'global'|'local'} scope
 * @param {string} root
 * @returns {PlanEntry[]}
 */
function planCursor(s, scope, root) {
  const base = scope === 'global' ? join(root, '.cursor', 'skills', xmName(s.pluginName, s.skillName))
                                  : join(root, '.cursor', 'rules');
  /** @type {PlanEntry[]} */
  const out = [];
  if (scope === 'global') {
    // Cursor 2.4+ Skills layout: ~/.cursor/skills/<name>/SKILL.md
    out.push({
      absolutePath: join(base, 'SKILL.md'),
      kind: 'skill-doc',
      skill: xmName(s.pluginName, s.skillName),
      writeMode: 'overwrite',
      mode: modeFor(scope),
    });
  } else {
    // Project rules: flat .mdc per skill + per-reference
    out.push({
      absolutePath: join(base, `${xmName(s.pluginName, s.skillName)}.mdc`),
      kind: 'rule',
      skill: xmName(s.pluginName, s.skillName),
      writeMode: 'overwrite',
      mode: modeFor(scope),
    });
    for (const ref of s.references) {
      out.push({
        absolutePath: join(base, `${xmName(s.pluginName, s.skillName)}-ref-${flattenRefPath(ref.relativePath)}.mdc`),
        kind: 'reference',
        skill: xmName(s.pluginName, s.skillName),
        writeMode: 'overwrite',
        mode: modeFor(scope),
      });
    }
  }
  return out;
}

/**
 * @param {import('./types.mjs').SkillIR} s
 * @param {'global'|'local'} scope
 * @param {string} root
 * @returns {PlanEntry[]}
 */
function planCodex(s, scope, root) {
  return [
    {
      absolutePath: join(root, 'plugins', 'xm', 'skills', s.skillName, 'SKILL.md'),
      kind: 'skill-doc',
      skill: xmName(s.pluginName, s.skillName),
      writeMode: 'overwrite',
      mode: modeFor(scope),
    },
  ];
}

/**
 * @param {import('./types.mjs').SkillIR} s
 * @param {'global'|'local'} scope
 * @param {string} root
 * @returns {PlanEntry[]}
 */
function planKiro(s, scope, root) {
  const steeringDir = join(root, '.kiro', 'steering');
  /** @type {PlanEntry[]} */
  const out = [
    {
      absolutePath: join(steeringDir, `${xmName(s.pluginName, s.skillName)}.md`),
      kind: 'steering',
      skill: xmName(s.pluginName, s.skillName),
      writeMode: 'overwrite',
      mode: modeFor(scope),
    },
  ];
  for (const ref of s.references) {
    out.push({
      absolutePath: join(steeringDir, `${xmName(s.pluginName, s.skillName)}-ref-${flattenRefPath(ref.relativePath)}.md`),
      kind: 'reference',
      skill: xmName(s.pluginName, s.skillName),
      writeMode: 'overwrite',
      mode: modeFor(scope),
    });
  }
  return out;
}

/**
 * @param {import('./types.mjs').SkillIR} s
 * @param {'global'|'local'} scope
 * @param {string} root
 * @returns {PlanEntry[]}
 */
function planAntigravity(s, scope, root) {
  const skillsDir = scope === 'global'
    ? join(root, '.gemini', 'antigravity', 'skills')
    : join(root, '.agent', 'skills');
  return [
    {
      absolutePath: join(skillsDir, `${xmName(s.pluginName, s.skillName)}.md`),
      kind: 'skill-doc',
      skill: xmName(s.pluginName, s.skillName),
      writeMode: 'overwrite',
      mode: modeFor(scope),
    },
  ];
}

/**
 * @param {import('./types.mjs').SkillIR} s
 * @param {'global'|'local'} scope
 * @param {string} root
 * @returns {PlanEntry[]}
 */
function planOpencode(s, scope, root) {
  const skillsDir = join(root, targetDirFor('opencode', scope), 'skills', xmName(s.pluginName, s.skillName));
  return [
    {
      absolutePath: join(skillsDir, 'SKILL.md'),
      kind: 'skill-doc',
      skill: xmName(s.pluginName, s.skillName),
      writeMode: 'overwrite',
      mode: modeFor(scope),
    },
  ];
}

/**
 * Per-target shared file: AGENTS.md / hooks.json. One entry per target/scope.
 * @param {import('./types.mjs').TargetTool} target
 * @param {'global'|'local'} scope
 * @param {string} root
 * @returns {PlanEntry[]}
 */
function planSharedFiles(target, scope, root) {
  /** @type {PlanEntry[]} */
  const out = [];
  if (target === 'codex') {
    out.push({
      absolutePath: join(root, '.agents', 'skills', 'xm', 'SKILL.md'),
      kind: 'skill-doc',
      skill: 'xm',
      writeMode: 'overwrite',
      mode: modeFor(scope),
    });
    out.push({
      absolutePath: join(root, 'plugins', 'xm', '.codex-plugin', 'plugin.json'),
      kind: 'plugin-manifest',
      skill: '*',
      writeMode: 'overwrite',
      mode: modeFor(scope),
    });
    out.push({
      absolutePath: join(root, '.agents', 'plugins', 'marketplace.json'),
      kind: 'marketplace',
      skill: '*',
      writeMode: 'overwrite',
      mode: modeFor(scope),
    });
    out.push({
      absolutePath: join(root, '.codex', 'hooks.json'),
      kind: 'hook',
      skill: '*',
      writeMode: 'overwrite',
      mode: modeFor(scope),
    });
    // Vendor layer (t7): role layers + profile TOMLs, xm-owned. Rendered as
    // kind:'overwrite' + recorded in the manifest; enumerated here so --list /
    // --dry-run show the plan against the exact paths the renderer writes.
    for (const rel of codexVendorRelativePaths()) {
      out.push({
        absolutePath: join(root, rel),
        kind: 'vendor-config',
        skill: '*',
        writeMode: 'overwrite',
        mode: modeFor(scope),
      });
    }
  }
  if (target === 'antigravity') {
    const agents = scope === 'global' ? join(root, '.gemini', 'AGENTS.md') : join(root, 'AGENTS.md');
    out.push({
      absolutePath: agents,
      kind: 'index',
      skill: '*',
      writeMode: 'merge-marker',
      mode: modeFor(scope),
    });
  }
  if (target === 'kiro') {
    out.push({
      absolutePath: join(root, '.kiro', 'hooks', 'xm.kiro.hook'),
      kind: 'hook',
      skill: '*',
      writeMode: 'overwrite',
      mode: modeFor(scope),
    });
  }
  if (target === 'cursor') {
    out.push({
      absolutePath: join(root, '.cursor', 'hooks.json'),
      kind: 'hook',
      skill: '*',
      writeMode: 'overwrite',
      mode: modeFor(scope),
    });
  }
  return out;
}

/**
 * Bundled xm/lib/ destination (PRD §5.4).
 * @param {import('./types.mjs').TargetTool} target
 * @param {'global'|'local'} scope
 * @param {string} root
 * @returns {string}
 */
export function bundleDir(target, scope, root) {
  return join(root, targetDirFor(target, scope), 'xm', 'lib');
}

/**
 * @typedef {Object} PlanInput
 * @property {import('./types.mjs').SkillIR[]} skills
 * @property {import('./types.mjs').TargetTool} target
 * @property {'global'|'local'} scope
 * @property {string} [cwd]
 */

/**
 * Build a full plan for one (target, scope).
 * @param {PlanInput} input
 * @returns {PlanEntry[]}
 */
export function planTarget({ skills, target, scope, cwd = process.cwd() }) {
  if (!TARGET_TOOLS.includes(target)) {
    throw new Error(`unknown target: ${target}`);
  }
  const root = rootFor(target, scope, cwd);
  /** @type {PlanEntry[]} */
  const out = [];
  for (const s of skills) {
    if (target === 'cursor') out.push(...planCursor(s, scope, root));
    else if (target === 'codex') out.push(...planCodex(s, scope, root));
    else if (target === 'kiro') out.push(...planKiro(s, scope, root));
    else if (target === 'antigravity') out.push(...planAntigravity(s, scope, root));
    else if (target === 'opencode') out.push(...planOpencode(s, scope, root));
  }
  out.push(...planSharedFiles(target, scope, root));
  // Bundle entry (single representative; renderer expands actual file list).
  out.push({
    absolutePath: bundleDir(target, scope, root),
    kind: 'bundle',
    skill: '*',
    writeMode: 'overwrite',
    mode: scope === 'global' ? 0o600 : 0o644,
  });
  return out;
}

/**
 * Build a multi-target plan.
 * @param {{ skills: import('./types.mjs').SkillIR[], targets: import('./types.mjs').TargetTool[], scope: 'global'|'local', cwd?: string }} input
 * @returns {Record<string, PlanEntry[]>}
 */
export function planAll({ skills, targets, scope, cwd = process.cwd() }) {
  /** @type {Record<string, PlanEntry[]>} */
  const out = {};
  for (const t of targets) {
    out[t] = planTarget({ skills, target: t, scope, cwd });
  }
  return out;
}
