/**
 * x-panel/adapters — provider headless invocation + JSON extraction.
 *
 * Each provider is called non-interactively in the shell and its stdout is
 * scanned for a JSON object. Tests override a provider's command via
 * X_PANEL_CMD_<MODEL> (a path to a node stub) so the flow runs without real
 * model calls.
 *
 * Failures are surfaced, never swallowed (Lesson L6): a missing CLI or a
 * non-zero exit returns { ok:false, error } and the caller logs it.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const BUILTIN = {
  claude: (prompt) => ['claude', ['-p', prompt]],
  codex: (prompt) => ['codex', ['exec', prompt]],
  agy: (prompt) => ['agy', ['-p', prompt]], // Antigravity CLI (formerly gemini), claude-style -p
  // cursor / kiro can be added here later.
};

export function knownProviders() {
  return Object.keys(BUILTIN);
}

function overridePath(name) {
  return process.env[`X_PANEL_CMD_${name.toUpperCase()}`] || null;
}

function resolveCommand(name, prompt) {
  const override = overridePath(name);
  if (override) {
    // override is a node script invoked as: node <script> <model> <prompt>
    return ['node', [override, name, prompt]];
  }
  const fn = BUILTIN[name];
  return fn ? fn(prompt) : null;
}

export function isAvailable(name) {
  const override = overridePath(name);
  if (override) return existsSync(override);
  if (!(name in BUILTIN)) return false;
  const [bin] = BUILTIN[name]('');
  const r = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  return r.status === 0;
}

/** Invoke a provider with a prompt; capture stdout and extract a JSON object. */
export function invokeProvider(name, prompt, { timeout = 180_000 } = {}) {
  const resolved = resolveCommand(name, prompt);
  if (!resolved) return { ok: false, error: `unknown provider: ${name}`, raw: '', json: null };
  const [cmd, args] = resolved;
  const res = spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  if (res.error) {
    return { ok: false, error: String(res.error.message || res.error), raw: '', json: null };
  }
  if (res.status !== 0) {
    return { ok: false, error: `exit ${res.status}: ${(res.stderr || '').trim().slice(0, 300)}`, raw: res.stdout || '', json: null };
  }
  const raw = res.stdout || '';
  return { ok: true, error: null, raw, json: extractJSON(raw) };
}

/** Extract the first balanced top-level JSON object from text. */
export function extractJSON(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}
