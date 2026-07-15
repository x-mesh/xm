/**
 * x-panel/core — shared I/O, colors, and .xm/panel paths.
 *
 * Self-contained (no cross-plugin imports) so it survives the versioned
 * plugin-cache layout. Mirrors the x-recall/core conventions.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

export { readFileSync, writeFileSync, existsSync, join, dirname };

// Resolve the .xm/ state dir — subdirectory/worktree-aware. Mirrors x-build's
// resolveXmRoot. Rule: a local .xm/ wins → else THIS working tree's root via
// `git rev-parse --show-toplevel`, so running from a subdirectory reuses the
// repo's .xm instead of spawning a stray one → else cwd/.xm (created on
// demand). show-toplevel stays inside the current checkout: a linked worktree
// returns itself (not the main repo, so worktree state stays independent), and
// a bare repo errors → cwd fallback. It never escapes into a separate parent repo.
function resolveXmDir() {
  const localXm = resolve(process.cwd(), '.xm');
  if (existsSync(localXm)) return localXm;
  try {
    const top = execSync('git rev-parse --show-toplevel', {
      cwd: process.cwd(), encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (top) {
      const topXm = join(top, '.xm');
      if (existsSync(topXm)) return topXm;
    }
  } catch {}
  return localXm;
}

export const XM_ROOT = process.env.X_PANEL_ROOT
  ? resolve(process.env.X_PANEL_ROOT)
  : resolveXmDir();

export const PANEL_DIR = join(XM_ROOT, 'panel');

const isTTY = process.stdout.isTTY && !process.env.NO_COLOR;
export const C = isTTY ? {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
} : Object.fromEntries(['reset', 'bold', 'dim', 'red', 'green', 'yellow', 'cyan'].map(k => [k, '']));

// Per-provider name colors for the live board: distinct 256-color hues so each vendor is
// scannable at a glance. Deliberately avoid red/green/yellow — those carry state meaning
// (done/failed/running), so reusing them on the name would blur the signal. Non-TTY → empty.
export const PROVIDER_COLOR = isTTY ? {
  claude: '\x1b[38;5;208m', // orange
  codex:  '\x1b[38;5;45m',  // cyan
  agy:    '\x1b[38;5;111m', // sky blue (gemini)
  cursor: '\x1b[38;5;207m', // magenta
  kiro:   '\x1b[38;5;180m', // tan (AWS)
} : {};

// Color a vendor label by its provider, keyed on the leading token (`codex` in
// `codex:gpt-5.5`). Unknown vendors fall through uncolored. Bold makes the hue read
// clearly against the dim metadata around it.
export function provColor(vendor) {
  const key = String(vendor || '').toLowerCase().split(/[:\s]/)[0];
  const c = PROVIDER_COLOR[key];
  return c ? `${C.bold}${c}` : '';
}

export function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

export function writeJSON(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const content = JSON.stringify(data, null, 2) + '\n';
  const tmp = path + '.tmp';
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

export function readText(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

/** runId built from a caller-supplied timestamp string (e.g. 20260626-011319). */
export function runId(stamp) {
  return `panel-${stamp}`;
}

// ── config (3-tier: flag > project .xm/config.json > global ~/.xm/config.json) ──

function loadConfigFile(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

// Global xm dir — overridable so tests stay hermetic (a real ~/.xm/config.json can't leak in).
function globalXmDir() {
  return process.env.X_PANEL_GLOBAL_ROOT ? resolve(process.env.X_PANEL_GLOBAL_ROOT) : join(homedir(), '.xm');
}

/** Merge the `panel` section from global then project config (project wins). */
export function loadPanelConfig() {
  const global = loadConfigFile(join(globalXmDir(), 'config.json'));
  const project = loadConfigFile(join(XM_ROOT, 'config.json'));
  const g = (global && global.panel) || {};
  const p = (project && project.panel) || {};
  return { ...g, ...p, presets: { ...(g.presets || {}), ...(p.presets || {}) } };
}

/** Persist a `panel` config patch to project (.xm) or global (~/.xm). Returns the path. */
export function savePanelConfig(patch, { global = false } = {}) {
  const dir = global ? globalXmDir() : XM_ROOT;
  const path = join(dir, 'config.json');
  const cur = loadConfigFile(path) || {};
  cur.panel = { ...(cur.panel || {}), ...patch };
  mkdirSync(dir, { recursive: true });
  const content = JSON.stringify(cur, null, 2) + '\n';
  const tmp = path + '.tmp';
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
  return path;
}
