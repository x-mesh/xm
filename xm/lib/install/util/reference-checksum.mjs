// @ts-check

import { createHash } from 'node:crypto';

/**
 * Hash reference paths and UTF-8 contents with explicit byte-length framing.
 * Sorting by normalized relative path makes the digest independent of
 * filesystem enumeration order while retaining path changes as drift.
 *
 * @param {{ relativePath: string, body: string }[]} references
 * @returns {string}
 */
export function checksumReferences(references) {
  const hash = createHash('sha256');
  const sorted = references
    .map((ref) => ({
      relativePath: ref.relativePath.replace(/\\/g, '/'),
      body: ref.body,
    }))
    .sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);

  for (const ref of sorted) {
    const pathBytes = Buffer.byteLength(ref.relativePath, 'utf8');
    const bodyBytes = Buffer.byteLength(ref.body, 'utf8');
    hash.update(`${pathBytes}:`, 'utf8');
    hash.update(ref.relativePath, 'utf8');
    hash.update(`${bodyBytes}:`, 'utf8');
    hash.update(ref.body, 'utf8');
  }
  return hash.digest('hex');
}
