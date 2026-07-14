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

import { existsSync, lstatSync, readFileSync } from 'node:fs';
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

const CLAUDE_HOOK_REF_RE = /\$\{?CLAUDE_PROJECT_DIR\}?\/\.claude\/hooks\/([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)/g;

/**
 * Copy project hook files referenced by translated commands into Codex's hook
 * bundle. Without this, hooks.json points at files that were never installed
 * and SessionStart exits 127.
 *
 * @param {ReturnType<typeof readClaudeSettings>} settings
 * @param {{ projectRoot: string, scope: 'global'|'local' }} ctx
 * @returns {import('../types.mjs').RenderOutput[]}
 */
function renderReferencedHookFiles(settings, ctx) {
  if (!settings?.hooks) return [];
  const refs = new Set();
  for (const [event, entries] of Object.entries(settings.hooks)) {
    if (!CODEX_EVENTS.has(event)) continue;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || !Array.isArray(entry.hooks)) continue;
      for (const hook of entry.hooks) {
        if (!hook || typeof hook.command !== 'string') continue;
        CLAUDE_HOOK_REF_RE.lastIndex = 0;
        let match;
        while ((match = CLAUDE_HOOK_REF_RE.exec(hook.command)) !== null) {
          const segments = match[1].split('/');
          if (segments.some((segment) => segment === '.' || segment === '..')) {
            throw new Error(`codex hook path rejected: ${match[1]}`);
          }
          refs.add(match[1]);
        }
      }
    }
  }

  const mode = ctx.scope === 'global' ? 0o600 : 0o644;
  return [...refs].sort().map((relativePath) => {
    const source = join(ctx.projectRoot, '.claude', 'hooks', ...relativePath.split('/'));
    if (!existsSync(source)) {
      throw new Error(`codex hook source not found: ${source}`);
    }
    const stat = lstatSync(source);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`codex hook source must be a regular file: ${source}`);
    }
    return {
      relativePath: join('.codex', 'xm', 'hooks', ...relativePath.split('/')),
      content: readFileSync(source),
      kind: 'overwrite',
      mode,
    };
  });
}

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

/** @param {unknown} value @returns {any} */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/** @param {unknown} value @returns {string} */
function stableKey(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  const object = /** @type {Record<string, unknown>} */ (value);
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableKey(object[key])}`).join(',')}}`;
}

/** @param {Record<string, any>} group @returns {string} */
function groupKey(group) {
  const { hooks: _hooks, ...selector } = group;
  return stableKey(selector);
}

/** @param {unknown} document @param {string} label @returns {{ hooks: Record<string, any[]> } & Record<string, any>} */
function requireHooksDocument(document, label) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const copy = cloneJson(document);
  if (copy.hooks === undefined) copy.hooks = {};
  if (!copy.hooks || typeof copy.hooks !== 'object' || Array.isArray(copy.hooks)) {
    throw new Error(`${label}.hooks must be a JSON object`);
  }
  return copy;
}

/**
 * Remove exactly the handlers recorded in a previous xm install manifest.
 * Groups and events owned by other tools survive unchanged.
 *
 * @param {unknown} current
 * @param {unknown} ownership
 * @returns {{ hooks: Record<string, any[]> } & Record<string, any>}
 */
export function removeOwnedCodexHooks(current, ownership) {
  const out = requireHooksDocument(current, 'existing Codex hooks');
  const owned = requireHooksDocument(ownership, 'Codex hook ownership');
  for (const [event, ownedGroups] of Object.entries(owned.hooks)) {
    if (!Array.isArray(ownedGroups) || !Array.isArray(out.hooks[event])) continue;
    const ownedByGroup = new Map();
    for (const group of ownedGroups) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) continue;
      const key = groupKey(group);
      const handlers = ownedByGroup.get(key) ?? new Set();
      for (const handler of group.hooks) handlers.add(stableKey(handler));
      ownedByGroup.set(key, handlers);
    }
    out.hooks[event] = out.hooks[event]
      .map((group) => {
        if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) return group;
        const ownedHandlers = ownedByGroup.get(groupKey(group));
        if (!ownedHandlers) return group;
        return { ...group, hooks: group.hooks.filter((handler) => !ownedHandlers.has(stableKey(handler))) };
      })
      .filter((group) => !group || typeof group !== 'object' || !Array.isArray(group.hooks) || group.hooks.length > 0);
    if (out.hooks[event].length === 0) delete out.hooks[event];
  }
  return out;
}

/**
 * Migrate installs made before hook ownership was recorded. Only handlers
 * executing from Codex's xm hook bundle are considered legacy xm-owned.
 *
 * @param {unknown} current
 * @returns {{ hooks: Record<string, any[]> } & Record<string, any>}
 */
export function removeLegacyXmCodexHooks(current) {
  const out = requireHooksDocument(current, 'existing Codex hooks');
  for (const [event, groups] of Object.entries(out.hooks)) {
    if (!Array.isArray(groups)) continue;
    out.hooks[event] = groups
      .map((group) => {
        if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) return group;
        return {
          ...group,
          hooks: group.hooks.filter((handler) =>
            typeof handler?.command !== 'string' || !handler.command.includes('.codex/xm/hooks/')),
        };
      })
      .filter((group) => !group || typeof group !== 'object' || !Array.isArray(group.hooks) || group.hooks.length > 0);
    if (out.hooks[event].length === 0) delete out.hooks[event];
  }
  return out;
}

/**
 * Merge newly rendered xm handlers into a shared hooks.json document. A prior
 * ownership record makes updates replace old xm handlers without touching
 * handlers installed by mem-mesh or other tools.
 *
 * @param {unknown} current
 * @param {unknown} desired
 * @param {unknown} [previousOwnership]
 * @returns {{ hooks: Record<string, any[]> } & Record<string, any>}
 */
export function mergeCodexHooks(current, desired, previousOwnership) {
  const wanted = requireHooksDocument(desired, 'rendered Codex hooks');
  const out = previousOwnership
    ? removeOwnedCodexHooks(current, previousOwnership)
    : removeLegacyXmCodexHooks(current);
  for (const [event, desiredGroups] of Object.entries(wanted.hooks)) {
    if (!Array.isArray(desiredGroups)) continue;
    const groups = Array.isArray(out.hooks[event]) ? out.hooks[event] : [];
    for (const desiredGroup of desiredGroups) {
      if (!desiredGroup || typeof desiredGroup !== 'object' || !Array.isArray(desiredGroup.hooks)) continue;
      const selector = groupKey(desiredGroup);
      let target = groups.find((group) => group && typeof group === 'object' && groupKey(group) === selector);
      if (!target) {
        const { hooks: _hooks, ...rest } = cloneJson(desiredGroup);
        target = { ...rest, hooks: [] };
        groups.push(target);
      }
      if (!Array.isArray(target.hooks)) target.hooks = [];
      const existing = new Set(target.hooks.map((handler) => stableKey(handler)));
      for (const handler of desiredGroup.hooks) {
        const key = stableKey(handler);
        if (!existing.has(key)) {
          target.hooks.push(cloneJson(handler));
          existing.add(key);
        }
      }
    }
    if (groups.length > 0) out.hooks[event] = groups;
  }
  return out;
}

/**
 * @param {unknown} current
 * @param {unknown} ownership
 * @returns {Array<{ event: string, group: string, handler: unknown }>}
 */
export function missingOwnedCodexHooks(current, ownership) {
  const installed = requireHooksDocument(current, 'existing Codex hooks');
  const owned = requireHooksDocument(ownership, 'Codex hook ownership');
  const missing = [];
  for (const [event, ownedGroups] of Object.entries(owned.hooks)) {
    if (!Array.isArray(ownedGroups)) continue;
    const currentGroups = Array.isArray(installed.hooks[event]) ? installed.hooks[event] : [];
    for (const group of ownedGroups) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) continue;
      const selector = groupKey(group);
      const candidates = currentGroups.filter((candidate) =>
        candidate && typeof candidate === 'object' && groupKey(candidate) === selector);
      const handlers = new Set(candidates.flatMap((candidate) => candidate.hooks ?? []).map(stableKey));
      for (const handler of group.hooks) {
        if (!handlers.has(stableKey(handler))) missing.push({ event, group: selector, handler });
      }
    }
  }
  return missing;
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
    kind: 'hook-merge',
    mode: scope === 'global' ? 0o600 : 0o644,
  });
  const hookFiles = renderReferencedHookFiles(settings, { projectRoot, scope });
  outputs.push(...hookFiles);
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
    if (hookFiles.length > 0) {
      notes.push(`codex: mirrored ${hookFiles.length} referenced hook file(s) into .codex/xm/hooks/.`);
    }
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
