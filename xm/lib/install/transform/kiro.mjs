// @ts-check
/**
 * Kiro renderer — SkillIR[] → `.kiro/steering/xm-<plug>-<skill>.md`
 *                              + `.kiro/steering/xm-<plug>-<skill>-ref-<name>.md`
 *
 * Frontmatter (Kiro research notes):
 *   inclusion: always | fileMatch | manual | auto
 *   fileMatchPattern: "<glob>"   (only when inclusion=fileMatch)
 *   name: <id>                   (required when inclusion=auto)
 *   description: "<sentence>"    (required when inclusion=auto)
 *
 * Classification policy (PRD §5.2 + Kiro edge cases):
 *   - Primary skill files default to `inclusion: auto` so the LLM picks them
 *     based on description. Avoids the `always` token-explosion risk noted in
 *     research.
 *   - Reference companion files default to `inclusion: manual` (only loaded
 *     when explicitly mentioned). They are referenced from the primary file
 *     using Kiro's `#[[file:<name>.md]]` include syntax.
 *
 * Hook block-style differs from Cursor/Codex; that goes to a sibling renderer
 * (kiro-shared.mjs / t15).
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { xmName, flattenRefPath } from '../util/flatten-namespace.mjs';
import { expandPaths } from '../util/expand-paths.mjs';
import { replaceRefLinks } from '../util/inline-references.mjs';

/**
 * Render Kiro frontmatter (subset our renderer uses).
 * @param {{ inclusion: 'always'|'fileMatch'|'manual'|'auto', name?: string, description?: string, fileMatchPattern?: string|string[] }} fm
 * @returns {string}
 */
export function renderKiroFrontmatter(fm) {
  const lines = ['---'];
  lines.push(`inclusion: ${fm.inclusion}`);
  if (fm.fileMatchPattern !== undefined) {
    if (Array.isArray(fm.fileMatchPattern)) {
      lines.push(`fileMatchPattern: [${fm.fileMatchPattern.map(quoteYaml).join(', ')}]`);
    } else {
      lines.push(`fileMatchPattern: ${quoteYaml(fm.fileMatchPattern)}`);
    }
  }
  if (fm.name !== undefined) lines.push(`name: ${fm.name}`);
  if (fm.description !== undefined) lines.push(`description: ${quoteYaml(fm.description)}`);
  lines.push('---');
  return lines.join('\n') + '\n\n';
}

/**
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
 * Build the body of a primary steering file.
 *
 * @param {import('../types.mjs').SkillIR} skill
 * @param {import('../types.mjs').RenderContext} ctx
 * @returns {string}
 */
function renderPrimaryBody(skill, ctx) {
  const ruleBase = xmName(skill.pluginName, skill.skillName);
  let body = expandPaths(skill.body, { target: 'kiro', scope: ctx.scope });
  // Rewrite references/ links → Kiro #[[file:xm-<plug>-ref-<name>.md]] include
  body = replaceRefLinks(body, (link) => `#[[file:${ruleBase}-ref-${link.flatName}.md]]`);
  return body.trimEnd() + '\n';
}

/**
 * Render Kiro outputs.
 *
 * @param {import('../types.mjs').SkillIR[]} skills
 * @param {import('../types.mjs').RenderContext} ctx
 * @returns {{ outputs: import('../types.mjs').RenderOutput[], warnings: string[], inclusionCounts: Record<string, number> }}
 */
export function renderKiroWithDiagnostics(skills, ctx) {
  /** @type {import('../types.mjs').RenderOutput[]} */
  const outputs = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {Record<string, number>} */
  const inclusionCounts = { auto: 0, manual: 0, always: 0, fileMatch: 0 };

  const steeringDir = join('.kiro', 'steering');

  for (const skill of skills) {
    const ruleBase = xmName(skill.pluginName, skill.skillName);
    const description = (skill.description || `xm ${ruleBase}`).trim();
    if (description.length < 30) {
      warnings.push(
        `kiro: ${ruleBase} description is ${description.length} chars; auto-inclusion is description-driven, prefer ≥ 30 chars.`
      );
    }
    const fm = renderKiroFrontmatter({
      inclusion: 'auto',
      name: ruleBase,
      description,
    });
    inclusionCounts.auto++;
    outputs.push({
      relativePath: join(steeringDir, `${ruleBase}.md`),
      content: fm + renderPrimaryBody(skill, ctx),
      kind: 'overwrite',
      mode: ctx.scope === 'global' ? 0o600 : 0o644,
    });
    for (const ref of skill.references) {
      const flatRef = flattenRefPath(ref.relativePath);
      const refFm = renderKiroFrontmatter({
        inclusion: 'manual',
        name: `${ruleBase}-ref-${flatRef}`,
        description: `Reference: ${ref.name} (companion to ${ruleBase}).`,
      });
      inclusionCounts.manual++;
      outputs.push({
        relativePath: join(steeringDir, `${ruleBase}-ref-${flatRef}.md`),
        content: refFm + expandPaths(ref.body, { target: 'kiro', scope: ctx.scope }).trimEnd() + '\n',
        kind: 'overwrite',
        mode: ctx.scope === 'global' ? 0o600 : 0o644,
      });
    }
  }
  return { outputs, warnings, inclusionCounts };
}

/**
 * @type {(skills: import('../types.mjs').SkillIR[], ctx: import('../types.mjs').RenderContext) => import('../types.mjs').RenderOutput[]}
 */
export const renderKiro = (skills, ctx) => renderKiroWithDiagnostics(skills, ctx).outputs;

/**
 * Compute the absolute install root for a Kiro scope.
 * @param {'global'|'local'} scope
 * @param {string} cwd
 * @returns {string}
 */
export function kiroRoot(scope, cwd) {
  return scope === 'global' ? homedir() : cwd;
}
