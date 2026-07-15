// @ts-check
/**
 * Codex renderer — SkillIR[] → a native Codex plugin.
 *
 * Generated layout (both local and global installs, relative to installRoot):
 *   .agents/skills/xm-<skill>/SKILL.md  (searchable standalone aliases)
 *   plugins/xm/.codex-plugin/plugin.json
 *   plugins/xm/skills/<skill>/SKILL.md
 *   .agents/plugins/marketplace.json  (semantic entry merge by install-cli)
 *
 * A plugin named `xm` with a skill named `op` is invoked as `$xm:op`. This
 * replaces the deprecated `/prompts:xm-op` compatibility layer.
 */

import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { xmName } from '../util/flatten-namespace.mjs';
import { expandPaths } from '../util/expand-paths.mjs';

export const CODEX_PLUGIN_NAME = 'xm';
export const CODEX_PLUGIN_ROOT = join('plugins', CODEX_PLUGIN_NAME);
export const CODEX_MARKETPLACE_PATH = join('.agents', 'plugins', 'marketplace.json');
export const CODEX_STANDALONE_SKILLS_ROOT = join('.agents', 'skills');

function codexDescription(value, fallback) {
  const text = String(value || fallback || '').replace(/\s+/g, ' ').trim();
  return text.length > 240 ? `${text.slice(0, 237).trimEnd()}...` : text;
}

/**
 * The source skills intentionally retain Claude Code vocabulary because Claude
 * remains their source-of-truth host. This overlay maps those primitives for
 * Codex without rewriting the original instructions and defines `$ARGUMENTS`,
 * which is a custom-prompt placeholder rather than a native Skill variable.
 */
function renderCodexSkillOverlay(skill) {
  const standaloneName = xmName(skill.pluginName, skill.skillName);
  return `## Codex Runtime Mapping

You are running this workflow as a Codex Skill.

- \`$ARGUMENTS\` means the user text following the current Skill mention (\`$${standaloneName}\` or \`$xm:${skill.skillName}\`). Treat it as input context, not as a literal shell environment variable unless a quoted command explicitly requires one.
- Map Claude Code's \`Agent\` tool or \`subagent_type\` instructions to Codex subagents and the installed \`[agents.xm-*]\` role layers.
- Map \`AskUserQuestion\` to Codex's structured user-input tool when available; otherwise ask one concise inline question and wait.
- Map Claude Code's \`Skill\` tool delegation to the corresponding installed \`$xm:<skill>\` Skill.
- Keep CLI calls dispatcher-first: run \`xm <command>\` exactly as documented when it is available on \`PATH\`.

These mappings replace host-specific mechanics only. Preserve the workflow's gates, ordering, and output contracts.`;
}

const CODEX_BUILD_OVERLAY = `## Codex Orchestration Overlay

For parallel build tasks, read \`task.model_by_vendor.codex\` from \`xm build run --json\` and spawn one Codex subagent per parallel-safe task, preferring \`[agents.xm-executor]\`. If native subagents are unavailable, use \`codex exec -c model=<model> [-c model_reasoning_effort=<effort>] "<task prompt>"\`.

For phase continuation, exec-level flags and \`-m\`/\`-c\` must precede \`resume\`: \`codex exec [flags] -m <model> resume --last\`.`;

function isCodexBuildSkill(skill) {
  return skill.skillName === 'build';
}

/**
 * Kept for Antigravity's shared AGENTS.md renderer. Codex itself no longer
 * consumes this index because native Plugin Skills are discoverable directly.
 */
export function renderCodexIndex(skills) {
  const lines = [];
  lines.push('## xm — multi-agent orchestration toolkit');
  lines.push('');
  lines.push('The following xm workflows are available. Select the matching workflow');
  lines.push('when the user asks for it explicitly or when the description matches.');
  lines.push('');
  for (const skill of skills) {
    const slug = xmName(skill.pluginName, skill.skillName);
    const description = codexDescription(skill.description, `xm ${slug}`);
    lines.push(`- \`${slug}\` — ${description}`);
  }
  lines.push('');
  lines.push('See https://github.com/x-mesh/xm for the source-of-truth SKILL.md files.');
  return lines.join('\n');
}

/** Render one Codex-native SKILL.md. */
export function renderCodexSkill(skill, ctx, name = skill.skillName) {
  const description = codexDescription(skill.description, `xm ${skill.skillName}`);
  const head = [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    '---',
    '',
  ].join('\n');
  let body = expandPaths(skill.body, { target: 'codex', scope: ctx.scope });
  if (skill.references.length > 0) {
    body = body.trimEnd() + '\n\n';
    for (const ref of skill.references) {
      body += '---\n';
      body += `<!-- [See: ${ref.name}] -->\n\n`;
      body += expandPaths(ref.body, { target: 'codex', scope: ctx.scope }).trimEnd() + '\n\n';
    }
  }
  body = body.trimEnd() + '\n\n' + renderCodexSkillOverlay(skill);
  if (isCodexBuildSkill(skill)) body += '\n\n' + CODEX_BUILD_OVERLAY;
  return head + body.trimEnd() + '\n';
}

// Backward-compatible export for focused renderer tests and downstream imports.
export const renderCodexPrompt = renderCodexSkill;

export function renderCodexPluginManifest(version) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version || '')) {
    throw new Error(`codex plugin version must be semver, got ${JSON.stringify(version)}`);
  }
  return JSON.stringify({
    name: CODEX_PLUGIN_NAME,
    version,
    description: 'x-mesh structured orchestration toolkit for Codex',
    author: { name: 'x-mesh' },
    homepage: 'https://github.com/x-mesh/xm',
    repository: 'https://github.com/x-mesh/xm',
    license: 'MIT',
    keywords: ['orchestration', 'multi-agent', 'review', 'planning'],
    skills: './skills/',
    interface: {
      displayName: 'xm',
      shortDescription: 'Structured orchestration workflows for Codex',
      longDescription: 'Planning, review, problem solving, tracing, and multi-agent orchestration workflows.',
      developerName: 'x-mesh',
      category: 'Developer Tools',
      capabilities: ['Interactive', 'Write'],
      websiteURL: 'https://github.com/x-mesh/xm',
      defaultPrompt: [
        '$xm:op debate two implementation options',
        '$xm:review review the current branch',
        '$xm:probe test whether this feature is worth building',
      ],
    },
  }, null, 2) + '\n';
}

export function codexMarketplaceEntry() {
  return {
    name: CODEX_PLUGIN_NAME,
    source: { source: 'local', path: './plugins/xm' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Developer Tools',
  };
}

export function codexMarketplaceName(ctx) {
  if (ctx.scope === 'global') return 'personal';
  const project = basename(ctx.installRoot).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  const pathHash = createHash('sha256').update(resolve(ctx.installRoot)).digest('hex').slice(0, 8);
  return `xm-${project.slice(0, 51)}-${pathHash}`;
}

export function renderCodexWithDiagnostics(skills, ctx) {
  const outputs = [];
  const warnings = [];
  const version = ctx.pluginVersion;
  outputs.push({
    relativePath: join(CODEX_PLUGIN_ROOT, '.codex-plugin', 'plugin.json'),
    content: renderCodexPluginManifest(version),
    kind: 'overwrite',
    mode: ctx.scope === 'global' ? 0o600 : 0o644,
  });
  outputs.push({
    relativePath: CODEX_MARKETPLACE_PATH,
    content: JSON.stringify(codexMarketplaceEntry()),
    kind: 'marketplace-merge',
    marketplaceName: codexMarketplaceName(ctx),
    mode: ctx.scope === 'global' ? 0o600 : 0o644,
  });
  for (const skill of skills) {
    const standaloneName = xmName(skill.pluginName, skill.skillName);
    outputs.push({
      relativePath: join(CODEX_STANDALONE_SKILLS_ROOT, standaloneName, 'SKILL.md'),
      content: renderCodexSkill(skill, ctx, standaloneName),
      kind: 'overwrite',
      mode: ctx.scope === 'global' ? 0o600 : 0o644,
    });
    outputs.push({
      relativePath: join(CODEX_PLUGIN_ROOT, 'skills', skill.skillName, 'SKILL.md'),
      content: renderCodexSkill(skill, ctx),
      kind: 'overwrite',
      mode: ctx.scope === 'global' ? 0o600 : 0o644,
    });
  }
  return { outputs, warnings, indexBytes: 0 };
}

export const renderCodex = (skills, ctx) => renderCodexWithDiagnostics(skills, ctx).outputs;
