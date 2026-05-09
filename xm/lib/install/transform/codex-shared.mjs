// @ts-check
/**
 * Codex shared-file renderer — `~/.codex/hooks.json` (or `.codex/hooks.json`
 * for local installs) translated from the project's `.claude/settings.json`.
 *
 * Differences from Cursor:
 *   - Codex hooks.json keeps PascalCase event names (PreToolUse, PostToolUse,
 *     Stop, SessionStart, ...). Same shape as Claude's settings.hooks block.
 *   - Codex CLI requires the `hooks` feature flag. Modern Codex exposes this
 *     as `codex features enable hooks`; we emit a note instructing the user to
 *     set it once.
 *   - Currently only Bash/shell tools fire PreToolUse/PostToolUse reliably
 *     (research note); we still emit all matchers so any future stabilization
 *     will pick them up.
 *   - 32 KiB AGENTS.md guard is enforced when install-cli.mjs writes the
 *     index via `writeMergeMarker(..., { maxBlockBytes: CODEX_AGENTS_MAX_BYTES })`.
 *     This module exposes the constant for callers and verifies the guard
 *     activates when an over-budget block is supplied.
 */

import { join } from 'node:path';
import { CODEX_AGENTS_MAX_BYTES } from '../types.mjs';
import { readClaudeSettings } from './cursor-shared.mjs';
import { assertSafeCommand } from '../security.mjs';

const CODEX_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
]);

/**
 * Substitute `$CLAUDE_PROJECT_DIR/.claude/hooks` with the Codex bundle path.
 * Codex does not natively expand `${workspaceFolder}` — we emit `$HOME/.codex/...`
 * for global installs and a literal `.codex/...` for local (Codex resolves
 * relative paths from the cwd at session start).
 *
 * @param {string} command
 * @param {{ scope: 'global'|'local' }} ctx
 * @returns {string}
 */
function rewriteHookCommand(command, ctx) {
  const hooksRoot = ctx.scope === 'global' ? '$HOME/.codex/xm/hooks' : '.codex/xm/hooks';
  return command.replace(/"?\$\{?CLAUDE_PROJECT_DIR\}?\/\.claude\/hooks/g, `"${hooksRoot}`);
}

/**
 * Build Codex hooks.json from a Claude settings file.
 * Output shape matches Codex's documented schema (`hooks.<Event>` array of
 * { matcher, hooks: [{ type, command, timeout? }] }).
 *
 * @param {Parameters<typeof readClaudeSettings>[0] extends string ? ReturnType<typeof readClaudeSettings> : never} settings
 * @param {{ scope: 'global'|'local' }} ctx
 * @returns {{ hooks: Record<string, { matcher?: string, hooks: { type: 'command', command: string, timeout?: number }[] }[]> }}
 */
export function buildCodexHooks(settings, ctx) {
  /** @type {Record<string, { matcher?: string, hooks: { type: 'command', command: string, timeout?: number }[] }[]>} */
  const out = {};
  if (!settings || !settings.hooks) return { hooks: out };
  for (const [event, entries] of Object.entries(settings.hooks)) {
    if (!CODEX_EVENTS.has(event)) continue;
    if (!Array.isArray(entries)) continue;
    out[event] = [];
    for (const entry of entries) {
      if (!entry || !Array.isArray(entry.hooks)) continue;
      const block = { matcher: entry.matcher, hooks: /** @type {any[]} */ ([]) };
      for (const h of entry.hooks) {
        if (!h || typeof h.command !== 'string') continue;
        const rewritten = rewriteHookCommand(h.command, ctx);
        const probe = rewritten.replace(/\$\{[^}]+\}|\$[A-Z_]+/g, '');
        try {
          assertSafeCommand(probe);
        } catch (err) {
          throw new Error(`codex hooks.json: ${event} command rejected: ${err.message}`);
        }
        const item = /** @type {{ type: 'command', command: string, timeout?: number }} */ ({
          type: 'command',
          command: rewritten,
        });
        if (typeof h.timeout === 'number') item.timeout = h.timeout;
        block.hooks.push(item);
      }
      if (block.hooks.length > 0) out[event].push(block);
    }
    if (out[event].length === 0) delete out[event];
  }
  return { hooks: out };
}

/**
 * Render Codex shared outputs.
 * @param {Object} args
 * @param {string} args.projectRoot   cwd of the install (for reading Claude settings).
 * @param {'global'|'local'} args.scope
 * @returns {{ outputs: import('../types.mjs').RenderOutput[], notes: string[] }}
 */
export function renderCodexShared({ projectRoot, scope }) {
  /** @type {import('../types.mjs').RenderOutput[]} */
  const outputs = [];
  /** @type {string[]} */
  const notes = [];

  const settings = readClaudeSettings(projectRoot);
  const hooksJson = buildCodexHooks(settings, { scope });
  const hooksPath = join('.codex', 'hooks.json');
  outputs.push({
    relativePath: hooksPath,
    content: JSON.stringify(hooksJson, null, 2) + '\n',
    kind: 'overwrite',
    mode: scope === 'global' ? 0o600 : 0o644,
  });
  if (Object.keys(hooksJson.hooks).length === 0) {
    notes.push('codex: no hooks discovered — emitted empty .codex/hooks.json shell');
  } else {
    notes.push(
      'codex: enable hooks once with `codex features enable hooks` ' +
      '(or add `[features] hooks = true` to ~/.codex/config.toml).'
    );
    notes.push(
      'codex: research notes report PreToolUse/PostToolUse stable only for Bash/shell ' +
      '(issue openai/codex#16732); other matchers may be silently ignored until upstream stabilizes.'
    );
  }
  return { outputs, notes };
}

/**
 * Verify that a proposed AGENTS.md block fits Codex's 32 KiB project_doc cap
 * (PRD §5.2 enforces 16 KiB headroom = CODEX_AGENTS_MAX_BYTES).
 * Throws if oversize. Caller passes the raw block (without BEGIN/END markers).
 *
 * @param {string} block
 * @returns {{ bytes: number, limit: number }}
 */
export function assertAgentsBlockSize(block) {
  const bytes = Buffer.byteLength(block, 'utf8');
  if (bytes > CODEX_AGENTS_MAX_BYTES) {
    throw new Error(
      `codex: AGENTS.md xm block is ${bytes} bytes, exceeds ${CODEX_AGENTS_MAX_BYTES} ` +
      `(PRD §5.2: 16 KiB headroom of Codex's 32 KiB project_doc_max_bytes). ` +
      `Trim per-skill descriptions or split the index.`
    );
  }
  return { bytes, limit: CODEX_AGENTS_MAX_BYTES };
}

export { CODEX_AGENTS_MAX_BYTES };
