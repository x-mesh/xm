// @ts-check
/**
 * Cursor shared-file renderer — produces `.cursor/commands/*.md` and
 * `.cursor/hooks.json` from the host project's Claude assets.
 *
 * Slash-command source: `.claude-plugin/plugin.json` `commands` field.
 *   Phase-A scan confirms current xm plugins do NOT register commands here
 *   (planner C3/N2). When commands[] is null/missing, this renderer emits
 *   no command files — slash invocation falls back to Cursor's
 *   agent-requested mode driven by the per-skill .mdc rule.
 *
 * Hook source: project's `.claude/settings.json` `hooks` table. Each hook
 * command is validated with assertSafeCommand (R-SEC-01).
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertSafeCommand } from '../security.mjs';

/**
 * @typedef {Object} ClaudeHookEntry
 * @property {string} matcher
 * @property {{ type: string, command: string, timeout?: number }[]} hooks
 */

/**
 * @typedef {Object} ClaudeHooksFile
 * @property {Record<string, ClaudeHookEntry[]>} hooks
 */

const EVENT_MAP = /** @type {Record<string, string>} */ ({
  PreToolUse: 'preToolUse',
  PostToolUse: 'postToolUse',
  Stop: 'stop',
  SessionStart: 'sessionStart',
  SessionEnd: 'sessionEnd',
});

/**
 * Substitute `$CLAUDE_PROJECT_DIR` with a Cursor-friendly variable.
 * Cursor uses `${workspaceFolder}` for the project root; install places
 * .claude/hooks/ inside `.cursor/xm/hooks/` (bundled alongside lib/).
 *
 * @param {string} command
 * @param {{ scope: 'global'|'local' }} ctx
 * @returns {string}
 */
function rewriteHookCommand(command, ctx) {
  // After install we mirror .claude/hooks/* into .<tool>/xm/hooks/. So:
  //   $CLAUDE_PROJECT_DIR/.claude/hooks/foo.mjs → .cursor/xm/hooks/foo.mjs (local)
  //                                              → $HOME/.cursor/xm/hooks/foo.mjs (global)
  const hooksRoot = ctx.scope === 'global' ? '$HOME/.cursor/xm/hooks' : '${workspaceFolder}/.cursor/xm/hooks';
  return command
    .replace(/"?\$\{?CLAUDE_PROJECT_DIR\}?\/\.claude\/hooks/g, `"${hooksRoot}`)
    .replace(/\\\\\$/g, '$');
}

/**
 * Build the Cursor hooks.json payload from a Claude settings.json.
 * @param {ClaudeHooksFile | null} settings
 * @param {{ scope: 'global'|'local' }} ctx
 * @returns {{ version: 1, hooks: Record<string, { command: string, matcher?: string, timeout?: number }[]> }}
 */
export function buildHooksJson(settings, ctx) {
  /** @type {Record<string, { command: string, matcher?: string, timeout?: number }[]>} */
  const out = {};
  if (!settings || !settings.hooks) {
    return { version: 1, hooks: out };
  }
  for (const [event, entries] of Object.entries(settings.hooks)) {
    const cursorEvent = EVENT_MAP[event];
    if (!cursorEvent) continue;        // unknown / unsupported event — skip silently
    if (!Array.isArray(entries)) continue;
    out[cursorEvent] = [];
    for (const entry of entries) {
      if (!entry || !Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        if (!h || typeof h.command !== 'string') continue;
        const rewritten = rewriteHookCommand(h.command, ctx);
        // SC14: command must not introduce shell metachars beyond what we wrote in.
        // Allow the variable expansion characters {} $ that we just inserted.
        // Validate the substring AFTER variable references are stripped.
        const probe = rewritten.replace(/\$\{[^}]+\}|\$[A-Z_]+/g, '');
        try {
          assertSafeCommand(probe);
        } catch (err) {
          throw new Error(`hooks.json: command rejected for ${cursorEvent}: ${err.message}`);
        }
        const item = /** @type {{ command: string, matcher?: string, timeout?: number }} */ ({
          command: rewritten,
        });
        if (entry.matcher) item.matcher = entry.matcher;
        if (h.timeout !== undefined) item.timeout = h.timeout;
        out[cursorEvent].push(item);
      }
    }
    if (out[cursorEvent].length === 0) delete out[cursorEvent];
  }
  return { version: 1, hooks: out };
}

/**
 * Read the project's `.claude/settings.json` if present.
 * @param {string} projectRoot
 * @returns {ClaudeHooksFile | null}
 */
export function readClaudeSettings(projectRoot) {
  const path = join(projectRoot, '.claude', 'settings.json');
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`.claude/settings.json is not valid JSON: ${err.message}`);
  }
}

/**
 * Discover slash commands defined in plugin.json files.
 * Scans every `<plugin>/.claude-plugin/plugin.json` in `pluginRoots`. When a
 * `commands` array is present, each entry becomes a `.cursor/commands/<name>.md`.
 *
 * Returns commands plus a list of warnings — H6 (errors review): a malformed
 * plugin.json must NOT be silently skipped, otherwise a contributor cannot
 * tell why their command is missing from the rendered Cursor install.
 *
 * Today the commands list is empty for every xm plugin (planner C3/N2 finding).
 *
 * @param {string[]} pluginRoots Absolute paths to `<plugin>/` dirs.
 * @returns {{ commands: { commandName: string, body: string, source: string }[], warnings: string[] }}
 */
export function scanPluginCommands(pluginRoots) {
  /** @type {{ commandName: string, body: string, source: string }[]} */
  const commands = [];
  /** @type {string[]} */
  const warnings = [];
  for (const root of pluginRoots) {
    const manifest = join(root, '.claude-plugin', 'plugin.json');
    if (!existsSync(manifest)) continue;
    let json;
    try {
      json = JSON.parse(readFileSync(manifest, 'utf8'));
    } catch (err) {
      warnings.push(`scanPluginCommands: ${manifest} is not valid JSON: ${/** @type {Error} */(err).message}`);
      continue;
    }
    if (!Array.isArray(json.commands)) continue;
    for (const cmd of json.commands) {
      if (!cmd || typeof cmd.name !== 'string') {
        warnings.push(`scanPluginCommands: ${manifest} has a commands[] entry with no string name; skipping`);
        continue;
      }
      commands.push({
        commandName: cmd.name,
        body: cmd.body ?? cmd.prompt ?? '',
        source: manifest,
      });
    }
  }
  return { commands, warnings };
}

/**
 * Render Cursor shared outputs.
 * @param {Object} args
 * @param {string} args.projectRoot
 * @param {string[]} args.pluginRoots
 * @param {'global'|'local'} args.scope
 * @returns {{ outputs: import('../types.mjs').RenderOutput[], notes: string[] }}
 */
export function renderCursorShared({ projectRoot, pluginRoots, scope }) {
  /** @type {import('../types.mjs').RenderOutput[]} */
  const outputs = [];
  /** @type {string[]} */
  const notes = [];

  // hooks.json
  const settings = readClaudeSettings(projectRoot);
  const hooksJson = buildHooksJson(settings, { scope });
  outputs.push({
    relativePath: '.cursor/hooks.json',
    content: JSON.stringify(hooksJson, null, 2) + '\n',
    kind: 'overwrite',
    mode: scope === 'global' ? 0o600 : 0o644,
  });
  if (Object.keys(hooksJson.hooks).length === 0) {
    notes.push('no hooks discovered — emitted empty .cursor/hooks.json shell');
  }

  // commands (currently empty for all xm plugins)
  const { commands: cmds, warnings: cmdWarnings } = scanPluginCommands(pluginRoots);
  for (const w of cmdWarnings) notes.push(w);
  if (cmds.length === 0 && cmdWarnings.length === 0) {
    notes.push('no slash commands discovered in plugin.json files (PRD §15 Q5).');
  }
  for (const c of cmds) {
    outputs.push({
      relativePath: `.cursor/commands/xm-${c.commandName}.md`,
      content: c.body.endsWith('\n') ? c.body : c.body + '\n',
      kind: 'overwrite',
      mode: scope === 'global' ? 0o600 : 0o644,
    });
  }

  return { outputs, notes };
}

/**
 * Find every plugin root (`<repo>/<plugin>/.claude-plugin/plugin.json`).
 * Used as input to renderCursorShared.
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function discoverPluginRoots(repoRoot) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(repoRoot, entry.name);
    if (existsSync(join(path, '.claude-plugin', 'plugin.json'))) {
      out.push(path);
    }
  }
  return out.sort();
}
