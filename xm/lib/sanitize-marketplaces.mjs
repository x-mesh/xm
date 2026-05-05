#!/usr/bin/env node
// sanitize-marketplaces.mjs
//
// Pre-flight cleanup for `~/.claude/plugins/known_marketplaces.json` before
// `claude plugin update`. The CLI validates every entry up-front and aborts
// the whole run on a single malformed one — typically v1.x → v2.x leftovers
// (`x-mesh-x-kit`, `x-kit`, `xm-kit`) from before the marketplace rename to
// `xm:kit`.
//
// Removal is conservative: an entry is auto-removed only when `source` is
// missing AND its `installLocation` is absent or empty on disk. Anything
// else with a non-empty install dir is flagged for manual inspection so we
// never delete a directory that may contain a user's working clone.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const STALE_NAME_HINTS = new Set([
  'x-mesh-x-kit',
  'x-kit',
  'xm-kit',
]);

export function defaultKnownPath() {
  return path.join(os.homedir(), '.claude/plugins/known_marketplaces.json');
}

function isEntryHealthy(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const src = entry.source;
  if (!src) return false;
  // `source` may be a string (legacy) or an object like { type, repo, ... } (current).
  if (typeof src === 'string') return src.length > 0;
  if (typeof src === 'object') return Object.keys(src).length > 0;
  return false;
}

function dirIsEmpty(loc) {
  if (!loc) return true;
  if (!fs.existsSync(loc)) return true;
  try {
    return fs.readdirSync(loc).length === 0;
  } catch {
    return false;
  }
}

// Guard rmdirSync against arbitrary `installLocation` values from the JSON.
// Only allow paths resolving under the same parent dir as `knownPath`
// (i.e. `~/.claude/plugins/`).
function isWithinPluginsRoot(loc, knownPath) {
  if (!loc || typeof loc !== 'string') return false;
  const root = path.resolve(path.dirname(knownPath));
  const target = path.resolve(loc);
  const rel = path.relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * @param {{ knownPath?: string, dryRun?: boolean }} [opts]
 * @returns {{ status: 'absent'|'clean'|'cleaned'|'flagged', removed: string[], flagged: Array<{name:string, loc:string|null}> }}
 */
export function sanitizeMarketplaces(opts = {}) {
  const knownPath = opts.knownPath ?? defaultKnownPath();
  const dryRun = !!opts.dryRun;

  if (!fs.existsSync(knownPath)) {
    return { status: 'absent', removed: [], flagged: [] };
  }

  const raw = fs.readFileSync(knownPath, 'utf8');
  let registry;
  try {
    registry = JSON.parse(raw);
  } catch (e) {
    const err = new Error(`known_marketplaces.json parse error: ${e.message}`);
    err.code = 'EPARSE';
    err.path = knownPath;
    throw err;
  }

  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    const err = new Error(`known_marketplaces.json must be a JSON object, got ${Array.isArray(registry) ? 'array' : typeof registry}`);
    err.code = 'ESHAPE';
    err.path = knownPath;
    throw err;
  }

  // Fast-path: every entry healthy → no work, no write.
  const entries = Object.entries(registry);
  if (entries.every(([, e]) => isEntryHealthy(e))) {
    return { status: 'clean', removed: [], flagged: [] };
  }

  const removed = [];
  const flagged = [];
  for (const [name, entry] of entries) {
    if (isEntryHealthy(entry)) continue;
    const loc = entry && typeof entry === 'object' ? entry.installLocation ?? null : null;
    if (dirIsEmpty(loc)) {
      removed.push(name);
      delete registry[name];
      if (!dryRun && loc && fs.existsSync(loc)) {
        if (isWithinPluginsRoot(loc, knownPath)) {
          try {
            fs.rmdirSync(loc);
          } catch (e) {
            console.warn(`  note: could not remove empty dir ${loc}: ${e.message}`);
          }
        } else {
          console.warn(`  note: skipping rmdir on out-of-scope path: ${loc}`);
        }
      }
    } else {
      flagged.push({ name, loc });
    }
  }

  if (removed.length > 0 && !dryRun) {
    fs.writeFileSync(knownPath, JSON.stringify(registry, null, 2) + '\n');
  }

  if (removed.length === 0 && flagged.length > 0) return { status: 'flagged', removed, flagged };
  if (removed.length === 0) return { status: 'clean', removed, flagged };
  return { status: 'cleaned', removed, flagged };
}

function formatNames(names) {
  return names.map((n) => JSON.stringify(n)).join(', ');
}

function main() {
  let result;
  try {
    result = sanitizeMarketplaces();
  } catch (e) {
    const where = e.path ? ` (${e.path})` : '';
    console.error(`✗ ${e.message}${where}`);
    console.error('  Fix or remove the file, then re-run `xm update`.');
    process.exit(1);
  }

  switch (result.status) {
    case 'absent':
      console.log('✅ known_marketplaces.json absent — nothing to sanitize');
      break;
    case 'clean':
      if (result.flagged.length === 0) {
        console.log('✅ known_marketplaces.json clean');
      }
      break;
    case 'cleaned':
      console.log(`🧹 Cleaned ${result.removed.length} stale marketplace entr${result.removed.length === 1 ? 'y' : 'ies'}: ${formatNames(result.removed)}`);
      break;
    case 'flagged':
      // handled below
      break;
  }

  if (result.flagged.length > 0) {
    console.log('⚠ Malformed entries with non-empty install dirs (skipped — inspect manually):');
    for (const f of result.flagged) {
      console.log(`  - ${JSON.stringify(f.name)} → ${f.loc ?? '(no installLocation)'}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
