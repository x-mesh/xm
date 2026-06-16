#!/usr/bin/env node
// @ts-check
/**
 * skills-checksum.mjs — generate xm/skills.checksums.json (R-SEC-02 authority).
 *
 * The output file lists SHA-256 of every `xm/skills/<plugin>/SKILL.md`. The
 * `xm install` CLI compares each SKILL.md it scans against this file to
 * detect supply-chain tampering. CI re-runs this generator and treats a diff
 * as a release-time signal that the file should be updated.
 *
 *   node xm/scripts/skills-checksum.mjs            # write file
 *   node xm/scripts/skills-checksum.mjs --check    # exit non-zero on mismatch
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const SKILLS_DIR = resolve(REPO, 'xm', 'skills');
const CHECKSUM_PATH = resolve(REPO, 'xm', 'skills.checksums.json');

/**
 * @returns {{ generatedAt: number, version: 1, skills: { plugin: string, sha256: string, bytes: number }[] }}
 */
function build() {
  if (!existsSync(SKILLS_DIR)) {
    throw new Error(`xm/skills/ not found at ${SKILLS_DIR}`);
  }
  const plugins = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => /^[a-z][a-z0-9-]{0,30}$/.test(n))
    .sort();
  const skills = [];
  for (const name of plugins) {
    const skillFile = join(SKILLS_DIR, name, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    const buf = readFileSync(skillFile);
    skills.push({
      plugin: name,
      sha256: createHash('sha256').update(buf).digest('hex'),
      bytes: buf.length,
    });
  }
  return {
    generatedAt: Date.now(),
    version: 1,
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
  const storedMap = new Map(stored.skills.map((s) => [s.plugin, s.sha256]));
  const freshMap = new Map(fresh.skills.map((s) => [s.plugin, s.sha256]));
  const drifted = [];
  const added = [];
  const removed = [];
  for (const [plugin, sha] of freshMap) {
    if (!storedMap.has(plugin)) added.push(plugin);
    else if (storedMap.get(plugin) !== sha) drifted.push({ plugin, stored: storedMap.get(plugin), actual: sha });
  }
  for (const plugin of storedMap.keys()) {
    if (!freshMap.has(plugin)) removed.push(plugin);
  }
  if (drifted.length || added.length || removed.length) {
    process.stderr.write(`skills.checksums.json out of date — re-run: node xm/scripts/skills-checksum.mjs\n\n`);
    if (drifted.length) {
      process.stderr.write(`  ${drifted.length} drifted (SKILL.md changed since last regen):\n`);
      for (const d of drifted) {
        process.stderr.write(`    ${d.plugin.padEnd(14)} registry: ${d.stored.slice(0, 16)}...  actual: ${d.actual.slice(0, 16)}...\n`);
      }
    }
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
