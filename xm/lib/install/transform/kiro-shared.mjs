// @ts-check
/**
 * Kiro shared-file renderer — `.kiro/hooks/<name>.kiro.hook` (JSON, one file
 * per hook).
 *
 * Kiro hook semantics (research notes):
 *   - File extension `.kiro.hook` (Markdown? No — JSON). One hook per file.
 *   - `when.type` enum: promptSubmit | agentStop | preToolUse | postToolUse |
 *     fileCreate | fileSave | fileDelete | preTaskExecution | postTaskExecution
 *     | manualTrigger
 *   - `then.type`: `askAgent` (LLM follows prompt) or `runCommand` (shell).
 *   - **Cannot block** — there is no exit-code based denial. Translating
 *     Claude's `block-marketplace-copy.mjs` (which exits 2 to block) loses
 *     the blocking behavior; we emit `runCommand` and an informational
 *     prompt note explaining the limitation (R-SEC-09).
 *   - The `Skill` matcher has no Kiro equivalent — `trace-session.mjs` hooks
 *     are skipped with a note.
 *
 * Tool-name mapping (Claude Edit|Write|MultiEdit|NotebookEdit → Kiro):
 *   write — Kiro's catch-all for file mutations.
 */

import { readClaudeSettings } from './cursor-shared.mjs';
import { assertSafeCommand } from '../security.mjs';

const KIRO_TOOL_MAP = /** @type {Record<string, string>} */ ({
  Edit: 'write',
  Write: 'write',
  MultiEdit: 'write',
  NotebookEdit: 'write',
  Bash: 'shell',
  Read: 'read',
  WebFetch: 'web',
});

/**
 * Translate a Claude matcher (regex like "Edit|Write|MultiEdit|NotebookEdit")
 * into a Kiro tool selector. We pick the *broadest* match — if any token maps
 * to `write`, we emit `write`.
 *
 * @param {string} matcher
 * @returns {string|null}
 */
function translateMatcher(matcher) {
  if (typeof matcher !== 'string' || matcher.length === 0) return '*';
  const tokens = matcher.split(/[|\s,]+/).filter(Boolean);
  if (tokens.length === 0) return '*';
  const mapped = new Set();
  let unsupported = 0;
  for (const t of tokens) {
    if (t === '*') return '*';
    const v = KIRO_TOOL_MAP[t];
    if (v) mapped.add(v); else unsupported++;
  }
  if (mapped.size === 0) return null;       // entirely unsupported (e.g. Skill)
  if (mapped.size === 1 && unsupported === 0) return [...mapped][0];
  return [...mapped].join('|');             // Kiro accepts regex matchers
}

/**
 * Translate Claude event → Kiro `when.type`.
 * @param {string} claudeEvent
 * @returns {string|null}
 */
function translateEvent(claudeEvent) {
  switch (claudeEvent) {
    case 'PreToolUse':  return 'preToolUse';
    case 'PostToolUse': return 'postToolUse';
    case 'Stop':        return 'agentStop';
    case 'UserPromptSubmit': return 'promptSubmit';
    case 'SessionStart': return null;            // no Kiro equivalent
    default: return null;
  }
}

/**
 * Build a single Kiro hook JSON from one Claude entry.
 * @param {string} hookName        Final file basename without extension.
 * @param {string} claudeEvent
 * @param {string|undefined} claudeMatcher
 * @param {{ command: string }} hookSpec
 * @returns {{ json: object|null, note: string|null }}
 */
export function buildKiroHook(hookName, claudeEvent, claudeMatcher, hookSpec) {
  const event = translateEvent(claudeEvent);
  if (event === null) {
    return { json: null, note: `kiro: skipping ${claudeEvent} (no Kiro equivalent)` };
  }
  const tool = translateMatcher(claudeMatcher ?? '*');
  if (tool === null) {
    return { json: null, note: `kiro: skipping ${claudeEvent}/${claudeMatcher} (no tool mapping; Skill etc. unsupported)` };
  }
  // Sanitize command. Strip variable references for the safety probe.
  const probe = String(hookSpec.command).replace(/\$\{[^}]+\}|\$[A-Z_]+/g, '');
  assertSafeCommand(probe);

  // Kiro `runCommand` cannot block; flag this explicitly via prompt note for
  // any hook whose Claude analogue exits 2 to block.
  const note = `Note: Kiro hooks cannot block tool execution; this hook only runs alongside the operation. ` +
               `Original Claude hook used PreToolUse blocking (exit 2). See R-SEC-09.`;
  const json = {
    enabled: true,
    name: hookName,
    description: note,
    version: '1',
    when: { type: event, tool },
    then: { type: 'runCommand', command: hookSpec.command },
  };
  return { json, note: null };
}

/**
 * Translate every hook in `.claude/settings.json` into one or more Kiro
 * `.kiro.hook` files.
 *
 * @param {Object} args
 * @param {string} args.projectRoot
 * @param {'global'|'local'} args.scope
 * @returns {{ outputs: import('../types.mjs').RenderOutput[], notes: string[] }}
 */
export function renderKiroShared({ projectRoot, scope }) {
  /** @type {import('../types.mjs').RenderOutput[]} */
  const outputs = [];
  /** @type {string[]} */
  const notes = [];

  const settings = readClaudeSettings(projectRoot);
  if (!settings || !settings.hooks) {
    notes.push('kiro: no .claude/settings.json — no hooks emitted');
    return { outputs, notes };
  }

  let counter = 0;
  for (const [event, entries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || !Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        if (!h || typeof h.command !== 'string') continue;
        // Rewrite $CLAUDE_PROJECT_DIR/.claude/hooks → .kiro/xm/hooks
        const hooksRoot = scope === 'global' ? '$HOME/.kiro/xm/hooks' : '.kiro/xm/hooks';
        const rewritten = h.command.replace(
          /"?\$\{?CLAUDE_PROJECT_DIR\}?\/\.claude\/hooks/g,
          `"${hooksRoot}`,
        );
        const baseName = `xm-${event.toLowerCase()}-${counter++}`;
        const built = buildKiroHook(baseName, event, entry.matcher, { command: rewritten });
        if (!built.json) {
          notes.push(built.note ?? '');
          continue;
        }
        outputs.push({
          relativePath: `.kiro/hooks/${baseName}.kiro.hook`,
          content: JSON.stringify(built.json, null, 2) + '\n',
          kind: 'overwrite',
          mode: scope === 'global' ? 0o600 : 0o644,
        });
      }
    }
  }

  if (outputs.length === 0) {
    notes.push('kiro: no translatable hooks — all source hooks were Skill-targeted or unsupported events');
  } else {
    notes.push(
      `kiro: emitted ${outputs.length} hook file(s). REMINDER: Kiro hooks cannot block ` +
      `(R-SEC-09); use Cursor or Codex if blocking semantics are required.`
    );
  }

  return { outputs, notes };
}

export { translateMatcher, translateEvent };
