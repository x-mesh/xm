// @ts-check
/**
 * Cursor renderer — SkillIR[] → `.cursor/rules/*.mdc` (project)
 *                              or `~/.cursor/skills/<name>/SKILL.md` (global, Cursor 2.4+).
 *
 * PRD v2.1 §5.2 (project, flat .mdc), §5.4 (path expansion).
 * Edge cases handled (Cursor research notes):
 *   - flat .mdc only (RULE.md folder format unstable in 2.2)
 *   - frontmatter limited to { description, globs?, alwaysApply }
 *   - per-skill rule + per-reference companion .mdc (alwaysApply: false)
 *   - body ≤ 500 lines (logs warning if exceeded — cursor truncation behavior)
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { CURSOR_MDC_MAX_LINES } from '../types.mjs';
import { xmName, flattenRefPath } from '../util/flatten-namespace.mjs';
import { expandPaths } from '../util/expand-paths.mjs';
import { replaceRefLinks } from '../util/inline-references.mjs';

/**
 * Render YAML-ish frontmatter for a Cursor `.mdc` file.
 * @param {Object} fm
 * @param {string} fm.description
 * @param {boolean} [fm.alwaysApply]
 * @param {string|string[]} [fm.globs]
 * @returns {string}
 */
export function renderFrontmatter(fm) {
  const lines = ['---'];
  if (fm.description !== undefined) {
    lines.push(`description: ${quoteYaml(fm.description)}`);
  }
  if (fm.globs !== undefined) {
    if (Array.isArray(fm.globs)) {
      lines.push(`globs: [${fm.globs.map((g) => quoteYaml(g)).join(', ')}]`);
    } else {
      lines.push(`globs: ${quoteYaml(fm.globs)}`);
    }
  }
  lines.push(`alwaysApply: ${fm.alwaysApply === true ? 'true' : 'false'}`);
  lines.push('---');
  return lines.join('\n') + '\n\n';
}

/**
 * Quote a string for YAML scalar position. Double-quotes when special chars
 * present; otherwise leaves bare.
 * @param {string} s
 * @returns {string}
 */
function quoteYaml(s) {
  if (typeof s !== 'string') s = String(s);
  if (/[:#\[\]{},&*!|>'"%@`\n]/.test(s) || s.startsWith(' ') || s.endsWith(' ') || s.length === 0) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

/**
 * Build the rule body for one skill. Expands Claude tokens, rewrites
 * `references/<x>.md` mentions to flat companion file names so Cursor can
 * resolve them via `@xm-<plug>-<skill>-ref-<x>` mention.
 *
 * @param {import('../types.mjs').SkillIR} skill
 * @param {import('../types.mjs').RenderContext} ctx
 * @returns {string}
 */
function renderRuleBody(skill, ctx) {
  let body = expandPaths(skill.body, { target: 'cursor', scope: ctx.scope });
  const ruleBase = xmName(skill.pluginName, skill.skillName);
  body = replaceRefLinks(body, (link) => `@${ruleBase}-ref-${link.flatName}`);
  return body.trimEnd() + '\n';
}

/**
 * Build a companion `.mdc` for a single reference file (alwaysApply: false).
 * @param {import('../types.mjs').SkillIR} skill
 * @param {import('../types.mjs').ReferenceFile} ref
 * @param {import('../types.mjs').RenderContext} ctx
 * @returns {{ relativePath: string, content: string }}
 */
function renderReferenceMdc(skill, ref, ctx) {
  const ruleBase = xmName(skill.pluginName, skill.skillName);
  const flatRef = flattenRefPath(ref.relativePath);
  const fm = renderFrontmatter({
    description: `Reference: ${ref.name} (companion to ${ruleBase}).`,
    alwaysApply: false,
  });
  const body = expandPaths(ref.body, { target: 'cursor', scope: ctx.scope }).trimEnd() + '\n';
  return {
    relativePath: `.cursor/rules/${ruleBase}-ref-${flatRef}.mdc`,
    content: fm + body,
  };
}

/**
 * Build the primary `.mdc` for a skill.
 * @param {import('../types.mjs').SkillIR} skill
 * @param {import('../types.mjs').RenderContext} ctx
 * @returns {{ relativePath: string, content: string, lines: number }}
 */
function renderSkillMdc(skill, ctx) {
  const ruleBase = xmName(skill.pluginName, skill.skillName);
  const description = (skill.description || `xm ${ruleBase} skill`).trim();
  const fm = renderFrontmatter({
    description: description.length > 240 ? description.slice(0, 237) + '...' : description,
    alwaysApply: false,
  });
  const body = renderRuleBody(skill, ctx);
  const content = fm + body;
  const lines = content.split(/\r?\n/).length;
  return {
    relativePath: `.cursor/rules/${ruleBase}.mdc`,
    content,
    lines,
  };
}

/**
 * Render Cursor outputs for project (local) scope.
 * @param {import('../types.mjs').SkillIR[]} skills
 * @param {import('../types.mjs').RenderContext} ctx
 * @returns {{ outputs: import('../types.mjs').RenderOutput[], warnings: string[] }}
 */
export function renderCursorLocal(skills, ctx) {
  /** @type {import('../types.mjs').RenderOutput[]} */
  const outputs = [];
  /** @type {string[]} */
  const warnings = [];
  for (const skill of skills) {
    const main = renderSkillMdc(skill, ctx);
    if (main.lines > CURSOR_MDC_MAX_LINES) {
      warnings.push(
        `cursor: ${main.relativePath} body has ${main.lines} lines (> ${CURSOR_MDC_MAX_LINES}). Cursor may truncate.`
      );
    }
    outputs.push({
      relativePath: main.relativePath,
      content: main.content,
      kind: 'overwrite',
      mode: ctx.scope === 'global' ? 0o600 : 0o644,
    });
    for (const ref of skill.references) {
      const compd = renderReferenceMdc(skill, ref, ctx);
      outputs.push({
        relativePath: compd.relativePath,
        content: compd.content,
        kind: 'overwrite',
        mode: ctx.scope === 'global' ? 0o600 : 0o644,
      });
    }
  }
  return { outputs, warnings };
}

/**
 * Render Cursor outputs for global scope (Cursor 2.4+ Skills directory).
 * Each skill becomes `~/.cursor/skills/<xm-name>/SKILL.md`.
 *
 * @param {import('../types.mjs').SkillIR[]} skills
 * @param {import('../types.mjs').RenderContext} ctx
 * @returns {{ outputs: import('../types.mjs').RenderOutput[], warnings: string[] }}
 */
export function renderCursorGlobal(skills, ctx) {
  /** @type {import('../types.mjs').RenderOutput[]} */
  const outputs = [];
  /** @type {string[]} */
  const warnings = [];
  for (const skill of skills) {
    const ruleBase = xmName(skill.pluginName, skill.skillName);
    const fm = renderFrontmatter({
      description: skill.description || `xm ${ruleBase}`,
      alwaysApply: false,
    });
    const body = renderRuleBody(skill, ctx);
    outputs.push({
      relativePath: join('.cursor', 'skills', ruleBase, 'SKILL.md'),
      content: fm + body,
      kind: 'overwrite',
      mode: 0o600,
    });
    for (const ref of skill.references) {
      const flatRef = flattenRefPath(ref.relativePath);
      outputs.push({
        relativePath: join('.cursor', 'skills', ruleBase, `${flatRef}.md`),
        content: expandPaths(ref.body, { target: 'cursor', scope: 'global' }).trimEnd() + '\n',
        kind: 'overwrite',
        mode: 0o600,
      });
    }
  }
  return { outputs, warnings };
}

/**
 * Public Renderer entry point. Dispatches local vs global.
 * @type {(skills: import('../types.mjs').SkillIR[], ctx: import('../types.mjs').RenderContext) => import('../types.mjs').RenderOutput[]}
 */
export const renderCursor = (skills, ctx) => {
  const r = ctx.scope === 'global' ? renderCursorGlobal(skills, ctx) : renderCursorLocal(skills, ctx);
  return r.outputs;
};

/**
 * Same as renderCursor but returns warnings too (used by --dry-run).
 * @param {import('../types.mjs').SkillIR[]} skills
 * @param {import('../types.mjs').RenderContext} ctx
 */
export function renderCursorWithDiagnostics(skills, ctx) {
  return ctx.scope === 'global' ? renderCursorGlobal(skills, ctx) : renderCursorLocal(skills, ctx);
}

/**
 * Compute the absolute install root for a Cursor scope.
 * @param {'global'|'local'} scope
 * @param {string} cwd
 * @returns {string}
 */
export function cursorRoot(scope, cwd) {
  return scope === 'global' ? homedir() : cwd;
}
