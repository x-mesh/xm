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
  const a = stored.skills.map((s) => `${s.plugin}:${s.sha256}`).sort().join('\n');
  const b = fresh.skills.map((s) => `${s.plugin}:${s.sha256}`).sort().join('\n');
  if (a !== b) {
    process.stderr.write(`skills.checksums.json out of date. Re-run without --check.\n`);
    process.stderr.write(`  expected entries: ${stored.skills.length}\n`);
    process.stderr.write(`  current entries:  ${fresh.skills.length}\n`);
    process.exit(1);
  }
  process.stdout.write(`skills.checksums.json verified (${stored.skills.length} skills).\n`);
  process.exit(0);
}

writeFileSync(CHECKSUM_PATH, JSON.stringify(fresh, null, 2) + '\n');
process.stdout.write(`Wrote ${CHECKSUM_PATH}\n`);
process.stdout.write(`  ${fresh.skills.length} skills hashed\n`);
