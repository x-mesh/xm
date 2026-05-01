// @ts-check
/**
 * Security utilities for xm install CLI.
 * Implements R-SEC-04 (input validation, path traversal),
 *            R-SEC-11 (secret scan),
 *            R-SEC-14 helpers (lock file metadata).
 *
 * No external dependencies — Node stdlib only (PRD §6 constraints).
 */

import { resolve as resolvePath, sep } from 'node:path';
import { lstatSync } from 'node:fs';
import {
  PLUGIN_NAME_RE,
  SKILL_NAME_RE,
  TARGET_TOOLS,
  SECRET_PATTERNS,
  SHELL_METACHARS_RE,
} from './types.mjs';

/**
 * Validate --target argument: must be subset of known tools.
 * @param {string} input  Comma-separated value, e.g. "cursor,codex".
 * @returns {import('./types.mjs').TargetTool[]}
 * @throws {Error} On unknown / malformed input. (R-SEC-04)
 */
export function parseTargets(input) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('--target must be a non-empty string');
  }
  if (input.length > 200) {
    throw new Error('--target value exceeds 200 chars');
  }
  if (SHELL_METACHARS_RE.test(input)) {
    throw new Error('--target contains forbidden shell metacharacters');
  }
  const parts = input.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error('--target list is empty after parsing');
  }
  const out = [];
  for (const part of parts) {
    if (!TARGET_TOOLS.includes(/** @type {any} */ (part))) {
      throw new Error(`unknown target: ${JSON.stringify(part)} (allowed: ${TARGET_TOOLS.join(', ')})`);
    }
    out.push(/** @type {import('./types.mjs').TargetTool} */ (part));
  }
  return Array.from(new Set(out));
}

/**
 * Validate plugin or skill name: lowercase alnum + dash, 1-31 chars.
 * @param {string} name
 * @param {'plugin'|'skill'} kind
 * @returns {string} The validated name.
 * @throws {Error} (R-SEC-04)
 */
export function validateName(name, kind) {
  const re = kind === 'plugin' ? PLUGIN_NAME_RE : SKILL_NAME_RE;
  if (typeof name !== 'string' || !re.test(name)) {
    throw new Error(`invalid ${kind} name: ${JSON.stringify(name)} (must match ${re})`);
  }
  return name;
}

/**
 * Resolve a path inside a permitted base directory and ensure it stays inside.
 * Defends against `../`, absolute, and symlink-escape traversal. (R-SEC-04)
 * @param {string} baseDir   Trusted absolute directory.
 * @param {string} relative  Untrusted relative path.
 * @returns {string} Absolute resolved path inside baseDir.
 * @throws {Error} If resolved path escapes baseDir.
 */
export function safeJoin(baseDir, relative) {
  if (typeof baseDir !== 'string' || !baseDir.startsWith(sep)) {
    throw new Error(`baseDir must be absolute: ${JSON.stringify(baseDir)}`);
  }
  if (typeof relative !== 'string') {
    throw new Error('relative path must be string');
  }
  if (relative.includes('\0')) {
    throw new Error('null byte in path');
  }
  const base = resolvePath(baseDir);
  const target = resolvePath(base, relative);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`path traversal detected: ${JSON.stringify(relative)} escapes ${baseDir}`);
  }
  return target;
}

/**
 * Check whether a filesystem entry is a symbolic link.
 * Used before .bak rotation to avoid TOCTOU symlink escapes (R-SEC-05).
 * Missing files return false (nothing to follow).
 * @param {string} absolutePath
 * @returns {boolean}
 */
export function isSymlink(absolutePath) {
  try {
    return lstatSync(absolutePath).isSymbolicLink();
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Reject a hooks.json command string that contains shell metacharacters.
 * Allowlist-by-rejection: if any forbidden char appears, throw. (R-SEC-01)
 * @param {string} command
 * @returns {string}
 * @throws {Error}
 */
export function assertSafeCommand(command) {
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error('hook command must be a non-empty string');
  }
  if (command.length > 1024) {
    throw new Error('hook command exceeds 1024 chars');
  }
  if (SHELL_METACHARS_RE.test(command)) {
    throw new Error(`hook command contains forbidden shell metacharacter: ${JSON.stringify(command)}`);
  }
  return command;
}

/**
 * Scan body text for likely secrets.
 * Best-effort regex; documented as such. (R-SEC-11)
 * @param {string} body
 * @returns {{ pattern: string, line: number, snippet: string }[]} matches
 */
export function scanSecrets(body) {
  if (typeof body !== 'string') return [];
  const lines = body.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(line)) {
        hits.push({
          pattern: pattern.toString(),
          line: i + 1,
          snippet: line.length > 120 ? line.slice(0, 117) + '...' : line,
        });
      }
    }
  }
  return hits;
}

/**
 * Build lock-file payload (R-SEC-14).
 * @param {{ pid?: number, hostname?: string, now?: number }} [opts]
 * @returns {{ pid: number, timestamp: number, hostname: string }}
 */
export function lockPayload(opts = {}) {
  return {
    pid: opts.pid ?? process.pid,
    timestamp: opts.now ?? Date.now(),
    hostname: opts.hostname ?? process.env.HOSTNAME ?? 'unknown',
  };
}

/**
 * Determine whether an existing lock is stale (older than TTL).
 * @param {{ timestamp?: number } | null | undefined} payload  Parsed lock JSON.
 * @param {number} ttlMs
 * @param {number} [now]
 * @returns {boolean}
 */
export function isStaleLock(payload, ttlMs, now = Date.now()) {
  if (!payload || typeof payload.timestamp !== 'number') return true;
  return now - payload.timestamp > ttlMs;
}
