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
 *   - The `Skill` matcher has no direct Kiro equivalent — `trace-session.mjs`
 *     hooks are converted best-effort with `toolTypes: ["*"]` and a
 *     descriptive note explaining the approximation.
 *
 * Tool-name mapping (Claude Edit|Write|MultiEdit|NotebookEdit → Kiro):
 *   write — Kiro's catch-all for file mutations.
 */

import { readClaudeSettings } from './cursor-shared.mjs';
import { assertSafeCommand } from '../security.mjs';

/** Events that use `when.patterns` (file glob arrays). */
const FILE_EVENTS = new Set(['fileEdited', 'fileCreated', 'fileDeleted']);
/** Events that use `when.toolTypes` (tool category arrays). */
const TOOL_EVENTS = new Set(['preToolUse', 'postToolUse']);

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
 * into a Kiro toolTypes array with an optional best-effort flag.
 *
 * Returns `{ toolTypes, bestEffort }` on success, or `null` when no mapping
 * is possible (entirely unsupported tokens, excluding Skill).
 *
 * The `Skill` token has no Kiro equivalent. When it is the only token (or
 * combined only with other unsupported tokens that all fail mapping), we
 * return `{ toolTypes: ['*'], bestEffort: true }` so the caller can annotate
 * the hook description accordingly.
 *
 * @param {string} matcher
 * @returns {{ toolTypes: string[], bestEffort: boolean }|null}
 */
function translateMatcher(matcher) {
  if (typeof matcher !== 'string' || matcher.length === 0) return { toolTypes: ['*'], bestEffort: false };
  const tokens = matcher.split(/[|\s,]+/).filter(Boolean);
  if (tokens.length === 0) return { toolTypes: ['*'], bestEffort: false };
  const mapped = new Set();
  let unsupported = 0;
  let hasSkill = false;
  for (const t of tokens) {
    if (t === '*') return { toolTypes: ['*'], bestEffort: false };
    if (t === 'Skill') { hasSkill = true; continue; }
    const v = KIRO_TOOL_MAP[t];
    if (v) mapped.add(v); else unsupported++;
  }
  // If we have mapped tools, propagate Skill loss as best-effort so the
  // caller can annotate the description that Skill semantics were dropped.
  if (mapped.size > 0) return { toolTypes: [...mapped], bestEffort: hasSkill };
  // If only Skill token(s) and nothing else mapped → best-effort wildcard
  if (hasSkill) return { toolTypes: ['*'], bestEffort: true };
  // Entirely unsupported (no Skill, no mapped tools)
  return null;
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
    case 'FileCreate':  return 'fileCreated';
    case 'FileSave':    return 'fileEdited';
    case 'FileDelete':  return 'fileDeleted';
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

  // Determine `when` based on event category:
  //   - Tool events  → translateMatcher() → when.toolTypes
  //   - File events  → parse matcher as glob patterns → when.patterns
  //   - Other events → no toolTypes, no patterns
  /** @type {{ type: string, toolTypes?: string[], patterns?: string[] }} */
  let when;

  let bestEffort = false;

  if (TOOL_EVENTS.has(event)) {
    const result = translateMatcher(claudeMatcher ?? '*');
    if (result === null) {
      return { json: null, note: `kiro: skipping ${claudeEvent}/${claudeMatcher} (no tool mapping; unsupported)` };
    }
    when = { type: event, toolTypes: result.toolTypes };
    if (result.bestEffort) {
      bestEffort = true;
    }
  } else if (FILE_EVENTS.has(event)) {
    // For file events, treat the matcher string as file glob patterns
    // (split on pipe, whitespace, or comma). Default to ['*'] if empty.
    const patterns = (claudeMatcher && typeof claudeMatcher === 'string')
      ? claudeMatcher.split(/[|\s,]+/).filter(Boolean)
      : ['*'];
    when = { type: event, patterns: patterns.length > 0 ? patterns : ['*'] };
  } else {
    // agentStop, promptSubmit — no toolTypes, no patterns
    when = { type: event };
  }

  // Sanitize command. Strip variable references for the safety probe.
  const probe = String(hookSpec.command).replace(/\$\{[^}]+\}|\$[A-Z_]+/g, '');
  assertSafeCommand(probe);

  // Kiro `runCommand` cannot block. The exit-2 blocking caveat only applies
  // to hooks whose Claude analogue used PreToolUse (where exit 2 denied the
  // tool call). For other events, surface only the tool-agnostic note.
  const baseNote = `Note: Kiro hooks cannot block tool execution; this hook only runs alongside the operation. See R-SEC-09.`;
  let description = event === 'preToolUse'
    ? `Note: Kiro hooks cannot block tool execution; this hook only runs alongside the operation. ` +
      `Original Claude hook used PreToolUse blocking (exit 2). See R-SEC-09.`
    : baseNote;
  if (bestEffort) {
    description = `best-effort adaptation — Kiro has no Skill matcher equivalent. Original Claude hook targeted Skill matcher. ${description}`;
  }
  const json = {
    name: hookName,
    description,
    version: '1.0.0',
    when,
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
