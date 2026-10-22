/**
 * sync-config.mjs — Sync configuration for xm cross-machine sync
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The identity module lives in x-build's source tree, is flattened into xm/lib/
// by the bundle, and sits beside this file in the install.sh client, so the
// relative path differs across the three layouts.
const here = dirname(fileURLToPath(import.meta.url));
const identityPath = [
  join(here, 'mem-mesh-identity.mjs'),
  join(here, '..', 'mem-mesh-identity.mjs'),
  join(here, '..', '..', '..', 'x-build', 'lib', 'mem-mesh-identity.mjs'),
].find(existsSync);
if (!identityPath) throw new Error('mem-mesh-identity.mjs not found next to x-sync');
const { resolveMemMeshProjectId } = await import(pathToFileURL(identityPath).href);

const SYNC_CONFIG_PATH = join(homedir(), '.xm', 'sync.json');

const DEFAULT_CONFIG = {
  machine_id: null,
  server_url: null,
  api_key: null,
};

/** Read sync config, auto-generate machine_id if missing.
 *  Environment variables override file values:
 *    XM_SYNC_SERVER_URL → server_url
 *    XM_SYNC_API_KEY    → api_key
 *    XM_SYNC_MACHINE_ID → machine_id
 */
export function readSyncConfig() {
  const config = readStoredSyncConfig();
  if (!config.machine_id) {
    config.machine_id = `${hostname()}-${randomBytes(2).toString('hex')}`;
    writeSyncConfig(config);
  }
  return config;
}

// File + environment only. Never writes, so callers that merely ask "is sync
// set up?" do not leave a ~/.xm/sync.json behind on machines that never use it.
function readStoredSyncConfig() {
  let config = { ...DEFAULT_CONFIG };
  try {
    config = { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(SYNC_CONFIG_PATH, 'utf8')) };
  } catch {}

  // Environment variable overrides
  if (process.env.XM_SYNC_SERVER_URL) config.server_url = process.env.XM_SYNC_SERVER_URL;
  if (process.env.XM_SYNC_API_KEY)    config.api_key = process.env.XM_SYNC_API_KEY;
  if (process.env.XM_SYNC_MACHINE_ID) config.machine_id = process.env.XM_SYNC_MACHINE_ID;
  return config;
}

/** Write sync config */
export function writeSyncConfig(config) {
  const dir = join(homedir(), '.xm');
  mkdirSync(dir, { recursive: true });
  writeFileSync(SYNC_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
  // Contains the API key in plaintext — restrict to the owner only.
  try { chmodSync(SYNC_CONFIG_PATH, 0o600); } catch {}
}

/** Get machine_id (auto-generates if needed) */
export function getMachineId() {
  return readSyncConfig().machine_id;
}

function realOrSelf(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/**
 * Sync project id for the checkout that owns `xmDir`.
 *
 * A `.xm` at the git root follows mem-mesh's identity chain, so a committed
 * `.mem-mesh/project-id` lines up checkouts whose folder names differ across
 * machines. A nested `.xm` keeps its folder name: resolving it to the repo id
 * would merge sibling `.xm` trees, and full-snapshot pushes would tombstone
 * each other's files. MEM_MESH_PROJECT_ID is ignored because push-all and
 * pull-all run every project under one environment.
 */
export function resolveSyncProjectId(xmDir) {
  const owner = resolve(xmDir, '..');
  let toplevel = null;
  try {
    toplevel = execSync('git rev-parse --show-toplevel', {
      cwd: owner, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() || null;
  } catch {}
  if (!toplevel || realOrSelf(toplevel) !== realOrSelf(owner)) return basename(owner);
  return resolveMemMeshProjectId(owner);
}

/** Check if sync is configured (has server_url + api_key) */
export function isSyncConfigured() {
  const config = readStoredSyncConfig();
  return !!(config.server_url && config.api_key);
}
