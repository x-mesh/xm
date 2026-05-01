// @ts-check
/**
 * Codex renderer — SkillIR[] → AGENTS.md index (merge-marker block, ≤ 16 KiB)
 *                              + ~/.codex/prompts/xm-<plug>-<skill>.md per skill body.
 *
 * Codex CLI auto-loads AGENTS.md but does NOT auto-load prompts/ files. Prompts
 * are user-invoked via `/prompts:<filename>` (Codex research notes). The index
 * therefore tells the LLM which slash invocations exist, and the prompt files
 * carry the full body. This mirrors Claude Code's `/xm:foo` UX.
 *
 * Codex hard limit: project_doc_max_bytes = 32 KiB; we cap our block at 16 KiB
 * (PRD §5.2, 50% headroom).
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { CODEX_AGENTS_MAX_BYTES } from '../types.mjs';
import { xmName } from '../util/flatten-namespace.mjs';
import { expandPaths } from '../util/expand-paths.mjs';

/**
 * Build the AGENTS.md xm block body (without BEGIN/END markers — merge.mjs adds those).
 * @param {import('../types.mjs').SkillIR[]} skills
 * @returns {string}
 */
export function renderCodexIndex(skills) {
  const lines = [];
  lines.push('## xm — multi-agent orchestration toolkit');
  lines.push('');
  lines.push('Each entry below corresponds to a saved prompt under `~/.codex/prompts/`');
  lines.push('(or `.codex/prompts/` for project-local installs). Invoke with');
  lines.push('`/prompts:<filename>` followed by any required arguments.');
  lines.push('');
  for (const skill of skills) {
    const slug = xmName(skill.pluginName, skill.skillName);
    const description = (skill.description || `xm ${slug}`).trim().replace(/\s+/g, ' ');
    const trimmed = description.length > 200 ? description.slice(0, 197) + '...' : description;
    lines.push(`- \`/prompts:${slug}\` — ${trimmed}`);
  }
  lines.push('');
  lines.push('See https://github.com/x-mesh/xm for the source-of-truth SKILL.md files.');
  return lines.join('\n');
}

/**
 * Build the body of a single Codex prompt file. Same body as the SKILL, with
 * Claude tokens expanded to Codex bundle paths. No frontmatter is required by
 * Codex prompt format, but optional `description:` is supported — we include
 * one for `/prompts` listing UX.
 *
 * @param {import('../types.mjs').SkillIR} skill
 * @param {import('../types.mjs').RenderContext} ctx
 * @returns {string}
 */
export function renderCodexPrompt(skill, ctx) {
  const description = (skill.description || `xm ${xmName(skill.pluginName, skill.skillName)}`).trim();
  const head = [
    '---',
    `description: ${JSON.stringify(description)}`,
    '---',
    '',
  ].join('\n');
  let body = expandPaths(skill.body, { target: 'codex', scope: ctx.scope });
  // Inline references: Codex does not auto-fetch sibling files, so we append
  // each reference body as a sub-section, separated by `[See: <name>]`.
  if (skill.references.length > 0) {
    body = body.trimEnd() + '\n\n';
    for (const ref of skill.references) {
      body += '---\n';
      body += `<!-- [See: ${ref.name}] -->\n\n`;
      body += expandPaths(ref.body, { target: 'codex', scope: ctx.scope }).trimEnd() + '\n\n';
    }
  }
  return head + body.trimEnd() + '\n';
}

/**
 * Render Codex outputs.
 *
 *   AGENTS.md (merge-marker block)
 *   .codex/prompts/xm-<plug>-<skill>.md (project) or
 *   ~/.codex/prompts/xm-<plug>-<skill>.md (global)
 *
 * @param {import('../types.mjs').SkillIR[]} skills
 * @param {import('../types.mjs').RenderContext} ctx
 * @returns {{ outputs: import('../types.mjs').RenderOutput[], warnings: string[], indexBytes: number }}
 */
export function renderCodexWithDiagnostics(skills, ctx) {
  /** @type {import('../types.mjs').RenderOutput[]} */
  const outputs = [];
  /** @type {string[]} */
  const warnings = [];

  const indexBody = renderCodexIndex(skills);
  const indexBytes = Buffer.byteLength(indexBody, 'utf8') + 50; // BEGIN/END markers
  if (indexBytes > CODEX_AGENTS_MAX_BYTES) {
    warnings.push(
      `codex: AGENTS.md block ${indexBytes} bytes exceeds ${CODEX_AGENTS_MAX_BYTES} (50% of 32 KiB). Trim descriptions.`
    );
  }

  // The AGENTS.md path differs by scope; project-local writes ./AGENTS.md,
  // global writes ~/.codex/AGENTS.md. Renderer reports relative-to-installRoot
  // paths so the install-cli composes absolute via safeJoin.
  const agentsRel = ctx.scope === 'global' ? join('.codex', 'AGENTS.md') : 'AGENTS.md';
  outputs.push({
    relativePath: agentsRel,
    content: indexBody,                  // merge.mjs writeMergeMarker wraps in markers
    kind: 'merge-marker',
    mode: ctx.scope === 'global' ? 0o600 : 0o644,
  });

  // Per-skill prompt bodies.
  const promptsDir = join('.codex', 'prompts');
  for (const skill of skills) {
    const slug = xmName(skill.pluginName, skill.skillName);
    outputs.push({
      relativePath: join(promptsDir, `${slug}.md`),
      content: renderCodexPrompt(skill, ctx),
      kind: 'overwrite',
      mode: ctx.scope === 'global' ? 0o600 : 0o644,
    });
  }

  return { outputs, warnings, indexBytes };
}

/**
 * Renderer entry point (matches the `Renderer` type).
 * @type {(skills: import('../types.mjs').SkillIR[], ctx: import('../types.mjs').RenderContext) => import('../types.mjs').RenderOutput[]}
 */
export const renderCodex = (skills, ctx) => renderCodexWithDiagnostics(skills, ctx).outputs;

/**
 * Compute the absolute install root for a Codex scope.
 * @param {'global'|'local'} scope
 * @param {string} cwd
 * @returns {string}
 */
export function codexRoot(scope, cwd) {
  return scope === 'global' ? homedir() : cwd;
}
