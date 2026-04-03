/**
 * x-memory/core — Shared utilities, constants, and helpers
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';

// Re-export node modules
export { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync, unlinkSync };
export { join, resolve, dirname, basename };
export { fileURLToPath };
export { execSync };
export { homedir };

// ── ROOT resolution ─────────────────────────────────────────────────

export const ROOT = process.env.X_MEMORY_ROOT
  ? resolve(process.env.X_MEMORY_ROOT)
  : resolve(process.cwd(), '.xm', 'memory');

export const INDEX_PATH = join(ROOT, 'index.json');
export const MEMORIES_DIR = join(ROOT, 'memories');

// ── Constants ────────────────────────────────────────────────────────

export const MEMORY_TYPES = ['decision', 'pattern', 'failure', 'learning'];

export const DEFAULT_TTL = {
  decision: null,
  pattern: '90d',
  failure: '30d',
  learning: '30d',
};

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'];

// ── ANSI Colors ──────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY && !process.env.NO_COLOR;
export const C = isTTY ? {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
} : Object.fromEntries(['reset','bold','dim','red','green','yellow','blue','magenta','cyan'].map(k => [k, '']));

// ── TTL Parsing ──────────────────────────────────────────────────────

export function parseDuration(ttl) {
  if (!ttl) return null;
  const m = String(ttl).match(/^(\d+)d$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 86400 * 1000;
}

export function computeExpiresAt(created, ttl) {
  const ms = parseDuration(ttl);
  if (!ms) return null;
  return new Date(new Date(created).getTime() + ms).toISOString();
}

export function isExpired(entry) {
  if (!entry.expires_at) return false;
  return new Date(entry.expires_at) < new Date();
}

// ── File I/O Helpers ─────────────────────────────────────────────────

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

export function readJSON(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const bak = path + '.bak';
    if (existsSync(bak)) {
      try {
        const recovered = JSON.parse(readFileSync(bak, 'utf8'));
        console.error(`  ${C.yellow}⚠ Corrupted JSON: ${basename(path)} — recovered from .bak${C.reset}`);
        writeFileSync(path, readFileSync(bak, 'utf8'));
        return recovered;
      } catch { /* bak also corrupted */ }
    }
    console.error(`  ${C.red}⚠ Failed to parse ${basename(path)}: ${err.message}${C.reset}`);
    return null;
  }
}

export function writeJSON(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const content = JSON.stringify(data, null, 2) + '\n';
  const tmp = path + '.tmp';
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
  // Backup
  writeFileSync(path + '.bak', content, 'utf8');
}

export function modifyJSON(path, mutator) {
  const lockPath = path + '.lock';
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      try {
        const data = readJSON(path);
        const result = mutator(data);
        const out = result !== undefined ? result : data;
        writeJSON(path, out);
        return out;
      } finally {
        try { unlinkSync(lockPath); } catch { /* best effort */ }
      }
    } catch {
      const deadline = Date.now() + 50;
      while (Date.now() < deadline) { /* spin */ }
    }
  }
  // Fallback: proceed without lock
  const data = readJSON(path);
  const result = mutator(data);
  const out = result !== undefined ? result : data;
  writeJSON(path, out);
  return out;
}

export function readMD(path) {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

export function writeMD(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

// ── Frontmatter helpers ──────────────────────────────────────────────

export function quoteYAML(val) {
  if (!val) return '""';
  if (/[:#\[\]{}&*!|>'"%@`]/.test(val) || val.includes('\n')) {
    return `"${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return val;
}

export function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };
  const meta = {};
  let currentKey = null;
  let inArray = false;
  for (const line of match[1].split('\n')) {
    const kvMatch = line.match(/^(\w[\w_]*)\s*:\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      let val = kvMatch[2].trim();
      // Array on same line: [a, b]
      if (val.startsWith('[') && val.endsWith(']')) {
        meta[currentKey] = val.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
        inArray = false;
      } else if (val === '') {
        // Could be start of array block
        meta[currentKey] = [];
        inArray = true;
      } else {
        // Remove surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        meta[currentKey] = val === 'null' ? null : val;
        inArray = false;
      }
    } else if (inArray && line.match(/^\s+-\s+(.*)$/)) {
      const item = line.match(/^\s+-\s+(.*)$/)[1].trim();
      meta[currentKey].push(item);
    }
  }
  return { meta, body: match[2] };
}
