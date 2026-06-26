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

import { spawnSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

// Each builds [bin, args]. `model` (optional) maps to that CLI's --model flag;
// when null the CLI uses its own default model.
const BUILTIN = {
  claude: (prompt, model) => ['claude', ['-p', ...(model ? ['--model', model] : []), prompt]],
  codex: (prompt, model) => ['codex', ['exec', ...(model ? ['--model', model] : []), prompt]],
  agy: (prompt, model) => ['agy', ['-p', ...(model ? ['--model', model] : []), prompt]], // Antigravity CLI (formerly gemini)
  cursor: (prompt, model) => ['cursor-agent', ['-p', '-f', ...(model ? ['--model', model] : []), prompt]], // -f bypasses workspace-trust
  // kiro can be added once its headless command is confirmed.
};

export function knownProviders() {
  return Object.keys(BUILTIN);
}

/** Known providers that are actually installed on PATH (or overridden via env). */
export function autodetectModels() {
  return knownProviders().filter(isAvailable);
}

function overridePath(name) {
  return process.env[`X_PANEL_CMD_${name.toUpperCase()}`] || null;
}

function resolveCommand(name, prompt, model) {
  const override = overridePath(name);
  if (override) {
    // override is a node script invoked as: node <script> <name> <prompt>
    return ['node', [override, name, prompt]];
  }
  const fn = BUILTIN[name];
  return fn ? fn(prompt, model || null) : null;
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
export function invokeProvider(name, prompt, { timeout = 180_000, model = null } = {}) {
  const resolved = resolveCommand(name, prompt, model);
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

/** Async variant of invokeProvider — non-blocking so multiple models run in parallel. */
export function invokeProviderAsync(name, prompt, { timeout = 180_000, model = null } = {}) {
  return new Promise((resolve) => {
    const resolved = resolveCommand(name, prompt, model);
    if (!resolved) return resolve({ ok: false, error: `unknown provider: ${name}`, raw: '', json: null });
    const [cmd, args] = resolved;
    let child;
    try {
      // stdin must be closed (ignore) or non-interactive CLIs like codex/agy hang
      // waiting for input — spawnSync closes it automatically, spawn does not.
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, error: String(e.message || e), raw: '', json: null });
    }
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ ok: false, error: `timeout ${timeout}ms`, raw: stdout, json: null }); }, timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e.message || e), raw: '', json: null }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ ok: false, error: `exit ${code}: ${stderr.trim().slice(0, 300)}`, raw: stdout, json: null });
      resolve({ ok: true, error: null, raw: stdout, json: extractJSON(stdout) });
    });
  });
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
