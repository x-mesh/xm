import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ROOT } from './root.mjs';

function readJSON(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (e) {
    process.stderr.write('[x-build] config parse error (' + filePath + '): ' + (e?.message || e) + '\n');
    return null;
  }
}

// Pure tiered SHALLOW merge: global (~/.xm) under local (.xm), local winning.
// The SINGLE definition of how config tiers combine — shared-config.readSharedConfig
// routes its merge through this too, so the wizard and cost-engine can never
// disagree on tier precedence. Shallow by contract: a top-level key present in
// local fully replaces global's same key (matches the historical readSharedConfig
// behavior; deep-merge would be a different, unshipped contract).
export function mergeSharedTiers(global, local) {
  return { ...(global || {}), ...(local || {}) };
}

// Read the effective shared config: global (~/.xm) → local (.xm), local winning.
//
// Was first-match (return the FIRST file found): the moment a project
// .xm/config.json existed it silently dropped EVERY global key — model_overrides,
// budget — so cost-engine model routing and budget caps and drift all read a
// truncated config (빌드5). Now it merges the tiers.
//
// X_BUILD_ROOT / XM_ROOT set = test/sandbox run: collapse to the single local file
// so the real ~/.xm global never bleeds into a hermetic run (mirrors shared-config's
// XM_ROOT collapse; cost-engine.test drives config purely via X_BUILD_ROOT).
export function loadSharedConfig() {
  const local = readJSON(join(ROOT, '..', 'config.json')) ?? {};
  if (process.env.X_BUILD_ROOT || process.env.XM_ROOT) return { ...local };
  const global = readJSON(join(homedir(), '.xm', 'config.json')) ?? {};
  return mergeSharedTiers(global, local);
}
