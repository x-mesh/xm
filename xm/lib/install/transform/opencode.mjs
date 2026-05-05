// @ts-check
/**
 * OpenCode renderer — SkillIR[] → `.opencode/skills/<name>/SKILL.md`
 *                              or `~/.config/opencode/skills/<name>/SKILL.md`.
 *
 * OpenCode natively discovers SKILL.md files in project-local `.opencode/skills`
 * and global `~/.config/opencode/skills` directories.
 * References are inlined so each generated skill remains self-contained.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { xmName } from '../util/flatten-namespace.mjs';
import { expandPaths } from '../util/expand-paths.mjs';

/**
 * @param {string} value
 * @returns {string}
 */
function quoteYaml(value) {
  return JSON.stringify(String(value));
}

/**
 * @param {import('../types.mjs').SkillIR} skill
 * @param {import('../types.mjs').RenderContext} ctx
 * @returns {string}
 */
export function renderOpencodeSkill(skill, ctx) {
  const slug = xmName(skill.pluginName, skill.skillName);
  const description = (skill.description || `xm ${slug}`).trim();
  const frontmatter = [
    '---',
    `name: ${quoteYaml(slug)}`,
    `description: ${quoteYaml(description)}`,
    'compatibility: opencode',
    '---',
    '',
  ].join('\n');

  let body = expandPaths(skill.body, { target: 'opencode', scope: ctx.scope });
  if (skill.references.length > 0) {
    body = body.trimEnd() + '\n\n';
    for (const ref of skill.references) {
      body += '---\n';
      body += `<!-- [See: ${ref.name}] -->\n\n`;
      body += expandPaths(ref.body, { target: 'opencode', scope: ctx.scope }).trimEnd() + '\n\n';
    }
  }

  return frontmatter + body.trimEnd() + '\n';
}

/**
 * @param {import('../types.mjs').SkillIR[]} skills
 * @param {import('../types.mjs').RenderContext} ctx
 * @returns {{ outputs: import('../types.mjs').RenderOutput[], warnings: string[] }}
 */
export function renderOpencodeWithDiagnostics(skills, ctx) {
  /** @type {import('../types.mjs').RenderOutput[]} */
  const outputs = [];
  const skillsDir = ctx.scope === 'global'
    ? join('.config', 'opencode', 'skills')
    : join('.opencode', 'skills');

  for (const skill of skills) {
    const slug = xmName(skill.pluginName, skill.skillName);
    outputs.push({
      relativePath: join(skillsDir, slug, 'SKILL.md'),
      content: renderOpencodeSkill(skill, ctx),
      kind: 'overwrite',
      mode: ctx.scope === 'global' ? 0o600 : 0o644,
    });
  }

  return { outputs, warnings: [] };
}

/**
 * @type {(skills: import('../types.mjs').SkillIR[], ctx: import('../types.mjs').RenderContext) => import('../types.mjs').RenderOutput[]}
 */
export const renderOpencode = (skills, ctx) => renderOpencodeWithDiagnostics(skills, ctx).outputs;

/**
 * @param {'global'|'local'} scope
 * @param {string} cwd
 * @returns {string}
 */
export function opencodeRoot(scope, cwd) {
  return scope === 'global' ? homedir() : cwd;
}
