/**
 * x-recall/handoff-md — render SESSION-STATE.json as a tool-neutral HANDOFF.md.
 *
 * The handoff/handon skills are Claude-Code-only. Codex and Cursor cannot run
 * them, but they CAN read a plain markdown file. This module turns the same
 * SESSION-STATE.json that handoff already writes into HANDOFF.md so any tool
 * picks up the previous session's intent, decisions, and open questions.
 *
 * x-build's handoff also emits HANDOFF.md inline at write time (richer data);
 * this module is the standalone path: regenerate from SESSION-STATE.json on
 * demand via `xm recall handoff-md`.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

function list(items, fmt = (x) => `- ${x}`) {
  if (!items || !items.length) return '_(none)_';
  return items.map(fmt).join('\n');
}

export function sessionStateToMarkdown(state) {
  if (!state) return '# Handoff\n\n_No SESSION-STATE.json found._\n';
  const w = state.where || {};
  const ctx = state.context || {};
  const nar = state.narrative || {};
  const rem = state.what_remains || {};

  const lines = [];
  lines.push('# Session Handoff');
  lines.push('');
  lines.push(`> Tool-neutral handoff generated from \`.xm/build/SESSION-STATE.json\`. Readable by any session (Claude, Codex, Cursor).`);
  lines.push('');
  lines.push(`- **Saved:** ${state.saved_at || '—'}`);
  lines.push(`- **Branch:** ${w.branch || '—'}${w.ahead != null ? ` (+${w.ahead}/-${w.behind || 0})` : ''}`);
  if (state.why_stopped) lines.push(`- **Stopped because:** ${state.why_stopped}`);
  if (ctx.current_focus) lines.push(`- **Focus:** ${ctx.current_focus}`);
  if (ctx.test_status) lines.push(`- **Tests:** ${ctx.test_status}`);
  lines.push('');

  if (nar.intent) {
    lines.push('## Intent');
    lines.push(nar.intent);
    lines.push('');
  }

  lines.push('## Done last session');
  lines.push(list(state.what_done));
  lines.push('');

  lines.push('## Remaining');
  const active = (rem.active_projects || []).map(p =>
    typeof p === 'string' ? p : `${p.name || '?'}${p.phase ? ` (${p.phase})` : ''}${p.pending ? ` — ${p.pending} pending` : ''}`);
  lines.push('**Active projects:** ' + (active.length ? '\n' + list(active) : '_(none)_'));
  if (w.uncommitted_files && w.uncommitted_files.length) {
    lines.push('');
    lines.push('**Uncommitted:**');
    lines.push(list(w.uncommitted_files));
  }
  lines.push('');

  if (state.decisions && state.decisions.length) {
    lines.push('## Decisions carried forward');
    lines.push(list(state.decisions, d => `- **${d.what || d}**${d.why ? ` — ${d.why}` : ''}`));
    lines.push('');
  }

  if (nar.open_questions && nar.open_questions.length) {
    lines.push('## Open questions');
    lines.push(list(nar.open_questions));
    lines.push('');
  }

  if (nar.rejected_alternatives && nar.rejected_alternatives.length) {
    lines.push('## Ruled out (do not re-litigate)');
    lines.push(list(nar.rejected_alternatives));
    lines.push('');
  }

  if (nar.next_session_should_know && nar.next_session_should_know.length) {
    lines.push('## Next session should know');
    lines.push(list(nar.next_session_should_know));
    lines.push('');
  }

  if (w.last_commits && w.last_commits.length) {
    lines.push('## Recent commits');
    lines.push(list(w.last_commits.slice(0, 5)));
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Read .xm/build/SESSION-STATE.json under `root` (an .xm dir) and (re)write
 * .xm/build/HANDOFF.md. Returns { ok, path, reason }.
 */
export function writeHandoffMd(root) {
  const ssPath = join(root, 'build', 'SESSION-STATE.json');
  if (!existsSync(ssPath)) {
    return { ok: false, reason: 'no_session_state', path: ssPath };
  }
  let state;
  try {
    state = JSON.parse(readFileSync(ssPath, 'utf8'));
  } catch (err) {
    return { ok: false, reason: 'parse_error: ' + err.message, path: ssPath };
  }
  const md = sessionStateToMarkdown(state);
  const out = join(root, 'build', 'HANDOFF.md');
  const tmp = out + '.tmp';
  writeFileSync(tmp, md, 'utf8');
  try {
    renameSync(tmp, out); // atomic replace
  } catch {
    writeFileSync(out, md, 'utf8');
  }
  return { ok: true, path: out };
}
