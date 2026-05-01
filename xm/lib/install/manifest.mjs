// @ts-check
/**
 * manifest.mjs — install record persistence (PRD §14 R-SEC-10 / R-SEC-13 / R-SEC-15).
 *
 * Each install run writes one JSON manifest per (target, scope) combo at:
 *   global → `~/.<tool>/xm/manifest.json`
 *   local  → `<cwd>/.<tool>/xm/manifest.json`
 *
 * The manifest is consumed by:
 *   - `xm install --verify` (t17)   — re-hashes files and compares.
 *   - `xm uninstall --target` (t18)  — knows which files to remove.
 *
 * Threat-model notes:
 *   - Manifest itself is local user-owned; no cryptographic signing.
 *   - `selfChecksum` is HMAC of the body fields keyed by an install-time
 *     nonce. Tampering with files OR with the manifest body is detectable.
 *   - `--allow-unverified` flips `unverified: true` on every entry, surfaced
 *     via `--verify` (R-SEC-15 audit trail).
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync, statSync, existsSync, lstatSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { writeOverwrite } from './merge.mjs';
import { PRD_VERSION, TARGET_DIR } from './types.mjs';
import { safeJoin } from './security.mjs';

const MANIFEST_KIND = 'xm-install-manifest';
const MANIFEST_VERSION = 1;

/**
 * Compute SHA-256 hex of a buffer or string.
 * @param {string | Buffer} data
 * @returns {string}
 */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Compute SHA-256 of a file's contents. Returns null when file missing.
 * @param {string} absolutePath
 * @returns {string|null}
 */
export function fileSha256(absolutePath) {
  if (!existsSync(absolutePath)) return null;
  if (lstatSync(absolutePath).isSymbolicLink()) return null;
  return sha256(readFileSync(absolutePath));
}

/**
 * @typedef {Object} ManifestEntry
 * @property {string} relativePath        Path relative to manifest's installRoot.
 * @property {string} sha256              SHA-256 of file contents at install time.
 * @property {number} bytes
 * @property {number} mode
 * @property {number} installedAt
 * @property {boolean} [unverified]       True when checksum verification was skipped (R-SEC-15).
 */

/**
 * @typedef {Object} Manifest
 * @property {'xm-install-manifest'} kind
 * @property {1} schemaVersion
 * @property {string} prdVersion
 * @property {import('./types.mjs').TargetTool} target
 * @property {'global'|'local'} scope
 * @property {string} installRoot         Absolute path the entries are relative to.
 * @property {number} installedAt
 * @property {ManifestEntry[]} files
 * @property {Record<string,string>} [bundleChecksums]   xm/lib/<file>.mjs → SHA-256 (R-SEC-13).
 * @property {string} nonce               Hex random; HMAC key salt.
 * @property {string} selfChecksum        HMAC of canonicalized fields keyed by nonce.
 */

/**
 * Build a manifest from a list of installed (path, content, mode) tuples.
 *
 * @param {Object} args
 * @param {import('./types.mjs').TargetTool} args.target
 * @param {'global'|'local'} args.scope
 * @param {string} args.installRoot
 * @param {{ relativePath: string, content: string|Buffer, mode: number }[]} args.entries
 * @param {Record<string,string>} [args.bundleChecksums]
 * @param {boolean} [args.unverified]
 * @param {number} [args.now]
 * @returns {Manifest}
 */
export function buildManifest({
  target,
  scope,
  installRoot,
  entries,
  bundleChecksums,
  unverified = false,
  now = Date.now(),
}) {
  const files = entries.map((e) => {
    const buf = typeof e.content === 'string' ? Buffer.from(e.content, 'utf8') : e.content;
    /** @type {ManifestEntry} */
    const entry = {
      relativePath: e.relativePath,
      sha256: sha256(buf),
      bytes: buf.length,
      mode: e.mode,
      installedAt: now,
    };
    if (unverified) entry.unverified = true;
    return entry;
  });
  const nonce = randomBytes(16).toString('hex');
  const body = {
    kind: MANIFEST_KIND,
    schemaVersion: MANIFEST_VERSION,
    prdVersion: PRD_VERSION,
    target,
    scope,
    installRoot: resolvePath(installRoot),
    installedAt: now,
    files,
    ...(bundleChecksums ? { bundleChecksums } : {}),
    nonce,
  };
  const selfChecksum = computeSelfChecksum(body, nonce);
  return /** @type {Manifest} */ ({ ...body, selfChecksum });
}

/**
 * Stable string serialization: keys sorted at every depth.
 * @param {any} v
 * @returns {string}
 */
function canonicalize(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
}

/**
 * HMAC-SHA256 over canonical body, keyed by nonce.
 * @param {Omit<Manifest,'selfChecksum'>} body
 * @param {string} nonce
 * @returns {string}
 */
export function computeSelfChecksum(body, nonce) {
  return createHmac('sha256', nonce).update(canonicalize(body)).digest('hex');
}

/**
 * Verify a manifest's selfChecksum.
 * @param {Manifest} manifest
 * @returns {boolean}
 */
export function verifySelfChecksum(manifest) {
  const { selfChecksum, ...rest } = manifest;
  if (!rest.nonce || typeof selfChecksum !== 'string') return false;
  const expected = computeSelfChecksum(rest, rest.nonce);
  return timingSafeEqualHex(expected, selfChecksum);
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Compute the absolute manifest path for (target, installRoot).
 * Layout: `<installRoot>/.<tool>/xm/manifest.json`
 * @param {import('./types.mjs').TargetTool} target
 * @param {string} installRoot
 * @returns {string}
 */
export function manifestPath(target, installRoot) {
  return resolvePath(installRoot, TARGET_DIR[target], 'xm', 'manifest.json');
}

/**
 * Persist a manifest to disk via writeOverwrite (atomic + backup-aware).
 * @param {Manifest} manifest
 * @returns {{ path: string, action: import('./merge.mjs').MergeResult['action'] }}
 */
export function writeManifest(manifest) {
  const path = manifestPath(manifest.target, manifest.installRoot);
  const result = writeOverwrite(path, JSON.stringify(manifest, null, 2) + '\n', { mode: manifest.scope === 'global' ? 0o600 : 0o644 });
  return { path, action: result.action };
}

/**
 * Read & parse a manifest. Throws when missing or unparseable.
 * @param {string} absolutePath
 * @returns {Manifest}
 */
export function readManifest(absolutePath) {
  if (!existsSync(absolutePath)) {
    throw new Error(`manifest not found: ${absolutePath}`);
  }
  const raw = readFileSync(absolutePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed.kind !== MANIFEST_KIND) {
    throw new Error(`not an xm install manifest: ${absolutePath}`);
  }
  if (parsed.schemaVersion !== MANIFEST_VERSION) {
    throw new Error(`unsupported manifest schemaVersion: ${parsed.schemaVersion}`);
  }
  return /** @type {Manifest} */ (parsed);
}

/**
 * Walk every entry in a manifest, returning per-file verification results.
 * @param {Manifest} manifest
 * @returns {{ ok: boolean, entries: { path: string, status: 'ok'|'missing'|'changed'|'unverified', expected: string, actual: string|null, mode: { expected: number, actual: number|null } }[], selfChecksumOk: boolean }}
 */
export function verifyManifest(manifest) {
  const selfChecksumOk = verifySelfChecksum(manifest);
  /** @type {{ path: string, status: 'ok'|'missing'|'changed'|'unverified', expected: string, actual: string|null, mode: { expected: number, actual: number|null } }[]} */
  const entries = [];
  let allOk = selfChecksumOk;
  for (const e of manifest.files) {
    let abs;
    try {
      abs = safeJoin(manifest.installRoot, e.relativePath);
    } catch (err) {
      // R-SEC-04 / H1 (security review): a tampered manifest may carry an
      // entry whose relativePath escapes installRoot (e.g. "../../etc/x").
      // Rather than calling fileSha256 on the escaped path (which would let
      // verifyManifest probe arbitrary files), surface this entry as
      // 'missing' with the manifest's recorded sha256 as the expected value.
      entries.push({
        path: `(refused: ${e.relativePath})`,
        status: 'missing',
        expected: e.sha256,
        actual: null,
        mode: { expected: e.mode, actual: null },
      });
      allOk = false;
      continue;
    }
    const actual = fileSha256(abs);
    /** @type {'ok'|'missing'|'changed'|'unverified'} */
    let status;
    let actualMode = null;
    if (existsSync(abs)) {
      try { actualMode = statSync(abs).mode & 0o777; } catch { actualMode = null; }
    }
    if (e.unverified) {
      status = 'unverified';
    } else if (actual === null) {
      status = 'missing';
      allOk = false;
    } else if (actual !== e.sha256) {
      status = 'changed';
      allOk = false;
    } else {
      status = 'ok';
    }
    entries.push({
      path: abs,
      status,
      expected: e.sha256,
      actual,
      mode: { expected: e.mode, actual: actualMode },
    });
  }
  return { ok: allOk, entries, selfChecksumOk };
}
