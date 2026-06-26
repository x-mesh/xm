/**
 * x-panel/core — shared I/O, colors, and .xm/panel paths.
 *
 * Self-contained (no cross-plugin imports) so it survives the versioned
 * plugin-cache layout. Mirrors the x-recall/core conventions.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';

export { readFileSync, writeFileSync, existsSync, join, dirname };

export const XM_ROOT = process.env.X_PANEL_ROOT
  ? resolve(process.env.X_PANEL_ROOT)
  : resolve(process.cwd(), '.xm');

export const PANEL_DIR = join(XM_ROOT, 'panel');

const isTTY = process.stdout.isTTY && !process.env.NO_COLOR;
export const C = isTTY ? {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
} : Object.fromEntries(['reset', 'bold', 'dim', 'red', 'green', 'yellow', 'cyan'].map(k => [k, '']));

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
