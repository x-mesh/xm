#!/usr/bin/env node
// @ts-check
/**
 * skills-checksum.mjs — generate xm/skills.checksums.json (R-SEC-02 authority).
 *
 * The output file lists SHA-256 digests for every `SKILL.md`, reference, and
 * sidecar asset under `xm/skills/<plugin>/`. The installer checks this authority
 * before rendering files. CI re-runs this generator and treats drift as a
 * release-time signal that the registry should be updated.
 *
 *   node xm/scripts/skills-checksum.mjs            # write file
 *   node xm/scripts/skills-checksum.mjs --check    # exit non-zero on mismatch
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanAll } from '../lib/install/scan.mjs';
import { checksumFiles } from '../lib/install/util/reference-checksum.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const SKILLS_DIR = resolve(REPO, 'xm', 'skills');
const LIB_DIR = resolve(REPO, 'xm', 'lib');
const CHECKSUM_PATH = resolve(REPO, 'xm', 'skills.checksums.json');

/**
 * @returns {{ generatedAt: number, version: 3, skills: { plugin: string, sha256: string, bytes: number, referencesSha256: string, referenceFiles: number, referenceBytes: number, assetsSha256: string, assetFiles: number, assetBytes: number }[] }}
 */
function build() {
  if (!existsSync(SKILLS_DIR)) {
    throw new Error(`xm/skills/ not found at ${SKILLS_DIR}`);
  }
  const skills = scanAll({ skillsDir: SKILLS_DIR, libDir: LIB_DIR }).map((skill) => ({
    plugin: skill.pluginName,
    sha256: skill.checksum,
    bytes: skill.size.bytes,
    referencesSha256: checksumFiles(skill.references),
    referenceFiles: skill.references.length,
    referenceBytes: skill.references.reduce((sum, ref) => sum + ref.bytes, 0),
    assetsSha256: checksumFiles(skill.assets || []),
    assetFiles: (skill.assets || []).length,
    assetBytes: (skill.assets || []).reduce((sum, asset) => sum + asset.bytes, 0),
  }));
  return {
    generatedAt: Date.now(),
    version: 3,
    skills,
  };
}

const argv = process.argv.slice(2);
const checkMode = argv.includes('--check');

const fresh = build();

if (checkMode) {
  if (!existsSync(CHECKSUM_PATH)) {
    process.stderr.write(`skills.checksums.json missing — run: node xm/scripts/skills-checksum.mjs\n`);
    process.exit(2);
  }
  const stored = JSON.parse(readFileSync(CHECKSUM_PATH, 'utf8'));
  const storedMap = new Map(stored.skills.map((s) => [s.plugin, s]));
  const freshMap = new Map(fresh.skills.map((s) => [s.plugin, s]));
  const drifted = [];
  const added = [];
  const removed = [];
  for (const [plugin, skill] of freshMap) {
    if (!storedMap.has(plugin)) added.push(plugin);
    else {
      const registered = storedMap.get(plugin);
      if (registered.sha256 !== skill.sha256 || registered.referencesSha256 !== skill.referencesSha256 || registered.assetsSha256 !== skill.assetsSha256) {
        drifted.push({ plugin, stored: registered, actual: skill });
      }
    }
  }
  for (const plugin of storedMap.keys()) {
    if (!freshMap.has(plugin)) removed.push(plugin);
  }
  if (stored.version !== fresh.version || drifted.length || added.length || removed.length) {
    process.stderr.write(`skills.checksums.json out of date — re-run: node xm/scripts/skills-checksum.mjs\n\n`);
    if (drifted.length) {
      process.stderr.write(`  ${drifted.length} drifted (SKILL.md, references, or assets changed since last regen):\n`);
      for (const d of drifted) {
        process.stderr.write(`    ${d.plugin.padEnd(14)} SKILL registry: ${d.stored.sha256.slice(0, 16)}...  actual: ${d.actual.sha256.slice(0, 16)}...\n`);
        process.stderr.write(`    ${''.padEnd(14)} refs  registry: ${(d.stored.referencesSha256 || '<missing>').slice(0, 16)}...  actual: ${d.actual.referencesSha256.slice(0, 16)}...\n`);
        process.stderr.write(`    ${''.padEnd(14)} assets registry: ${(d.stored.assetsSha256 || '<missing>').slice(0, 16)}...  actual: ${d.actual.assetsSha256.slice(0, 16)}...\n`);
      }
    }
    if (stored.version !== fresh.version) process.stderr.write(`  registry schema: ${stored.version ?? '<missing>'} → ${fresh.version}\n`);
    if (added.length) process.stderr.write(`  ${added.length} new skill(s) not in registry: ${added.join(', ')}\n`);
    if (removed.length) process.stderr.write(`  ${removed.length} stale registry entries: ${removed.join(', ')}\n`);
    process.exit(1);
  }
  process.stdout.write(`skills.checksums.json verified (${stored.skills.length} skills).\n`);
  process.exit(0);
}

if (existsSync(CHECKSUM_PATH)) {
  try {
    const stored = JSON.parse(readFileSync(CHECKSUM_PATH, 'utf8'));
    if (JSON.stringify(stored.skills || []) === JSON.stringify(fresh.skills)) {
      process.stdout.write(`skills.checksums.json already current (${fresh.skills.length} skills).\n`);
      process.exit(0);
    }
  } catch {
    // Fall through and rewrite malformed checksum files in normal write mode.
  }
}

writeFileSync(CHECKSUM_PATH, JSON.stringify(fresh, null, 2) + '\n');
process.stdout.write(`Wrote ${CHECKSUM_PATH}\n`);
process.stdout.write(`  ${fresh.skills.length} skills hashed\n`);
