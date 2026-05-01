// @ts-check
/**
 * Antigravity renderer — SkillIR[] → AGENTS.md index (merge-marker block)
 *                                    + .agent/skills/xm-<plug>-<skill>.md per skill
 *                                    (project) or
 *                                    ~/.gemini/antigravity/skills/<…> (global).
 *
 * Per E0 gate decision (phases/02-plan/E0-gate.md):
 *   - AGENTS.md is the primary surface (auto-loaded since v1.20.3).
 *   - `.agent/skills/*.md` are agent-requested secondary docs.
 *   - **No hooks** — Antigravity does not expose a programmable hook API.
 *   - Global path uses `~/.gemini/AGENTS.md`, not `GEMINI.md`, to avoid the
 *     gemini-cli conflict reported in google-gemini/gemini-cli#16058.
 *   - Plain Markdown — no frontmatter required.
 *
 * The index body is intentionally identical to Codex's so a single AGENTS.md
 * can serve both readers when both targets are installed in the same project.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { renderCodexIndex } from './codex.mjs';
import { xmName } from '../util/flatten-namespace.mjs';
import { expandPaths } from '../util/expand-paths.mjs';

/**
 * Build the body of one Antigravity skill file (plain Markdown, no
 * frontmatter). References are inlined since Antigravity's `.agent/skills/`
 * does not define a sibling-include syntax.
 *
 * @param {import('../types.mjs').SkillIR} skill
 * @param {import('../types.mjs').RenderContext} ctx
 * @returns {string}
 */
export function renderAntigravitySkill(skill, ctx) {
  const slug = xmName(skill.pluginName, skill.skillName);
  const description = (skill.description || `xm ${slug}`).trim();
  let body = expandPaths(skill.body, { target: 'antigravity', scope: ctx.scope });
  if (skill.references.length > 0) {
    body = body.trimEnd() + '\n\n';
    for (const ref of skill.references) {
      body += '---\n';
      body += `<!-- [See: ${ref.name}] -->\n\n`;
      body += expandPaths(ref.body, { target: 'antigravity', scope: ctx.scope }).trimEnd() + '\n\n';
    }
  }
  // Plain Markdown header so the .agent/skills/ entry stays self-describing.
  return `# ${slug}\n\n> ${description}\n\n${body.trimEnd()}\n`;
}

/**
 * Render Antigravity outputs.
 *
 *   AGENTS.md (merge-marker block, shared body with Codex index)
 *   .agent/skills/xm-<plug>-<skill>.md  (project)
 *   .gemini/antigravity/skills/xm-<plug>-<skill>.md  (global)
 *
 * @param {import('../types.mjs').SkillIR[]} skills
 * @param {import('../types.mjs').RenderContext} ctx
 * @returns {{ outputs: import('../types.mjs').RenderOutput[], warnings: string[], indexBytes: number }}
 */
export function renderAntigravityWithDiagnostics(skills, ctx) {
  /** @type {import('../types.mjs').RenderOutput[]} */
  const outputs = [];
  /** @type {string[]} */
  const warnings = [];

  // Reuse the Codex index — Antigravity reads AGENTS.md the same way.
  const indexBody = renderCodexIndex(skills);
  const indexBytes = Buffer.byteLength(indexBody, 'utf8') + 50;

  // AGENTS.md path:
  //   global → ~/.gemini/AGENTS.md (avoid GEMINI.md per gemini-cli #16058)
  //   local  → ./AGENTS.md
  const agentsRel = ctx.scope === 'global' ? join('.gemini', 'AGENTS.md') : 'AGENTS.md';
  outputs.push({
    relativePath: agentsRel,
    content: indexBody,
    kind: 'merge-marker',
    mode: ctx.scope === 'global' ? 0o600 : 0o644,
  });

  // Per-skill bodies.
  const skillsDir = ctx.scope === 'global'
    ? join('.gemini', 'antigravity', 'skills')
    : join('.agent', 'skills');
  for (const skill of skills) {
    const slug = xmName(skill.pluginName, skill.skillName);
    outputs.push({
      relativePath: join(skillsDir, `${slug}.md`),
      content: renderAntigravitySkill(skill, ctx),
      kind: 'overwrite',
      mode: ctx.scope === 'global' ? 0o600 : 0o644,
    });
  }

  // Note: no hooks emitted (E0 gate decision). Caller can read this from
  // warnings if they want to surface it.
  warnings.push('antigravity: hooks intentionally omitted (no programmable hook API; see E0-gate.md).');

  return { outputs, warnings, indexBytes };
}

/**
 * Renderer entry point.
 * @type {(skills: import('../types.mjs').SkillIR[], ctx: import('../types.mjs').RenderContext) => import('../types.mjs').RenderOutput[]}
 */
export const renderAntigravity = (skills, ctx) => renderAntigravityWithDiagnostics(skills, ctx).outputs;

/**
 * Compute the absolute install root for an Antigravity scope.
 * @param {'global'|'local'} scope
 * @param {string} cwd
 * @returns {string}
 */
export function antigravityRoot(scope, cwd) {
  return scope === 'global' ? homedir() : cwd;
}
