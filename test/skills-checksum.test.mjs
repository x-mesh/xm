import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = resolve(import.meta.dirname, '..');
const SANDBOX = mkdtempSync(join(tmpdir(), 'xm-skills-checksum-'));
const XM_DIR = join(SANDBOX, 'xm');
const SCRIPT = join(XM_DIR, 'scripts', 'skills-checksum.mjs');
const REGISTRY = join(XM_DIR, 'skills.checksums.json');
let baseline;

function run(args = []) {
  return spawnSync('node', [SCRIPT, ...args], { cwd: SANDBOX, encoding: 'utf8' });
}

function writeRegistry(document) {
  writeFileSync(REGISTRY, JSON.stringify(document, null, 2) + '\n');
}

beforeAll(() => {
  cpSync(join(REPO, 'xm'), XM_DIR, { recursive: true });
  baseline = JSON.parse(readFileSync(REGISTRY, 'utf8'));
});

beforeEach(() => writeRegistry(baseline));
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

describe('skills-checksum registry validation', () => {
  test('accepts the generated registry', () => {
    const result = run(['--check']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('skills.checksums.json verified');
  });

  test.each([
    ['skills array', (doc) => ({ ...doc, skills: {} }), 'registry skills must be an array'],
    ['schema version', (doc) => ({ ...doc, version: 2 }), 'registry schema must be version 3'],
    ['plugin identifier', (doc) => ({ ...doc, skills: doc.skills.map((row, index) => index === 0 ? { ...row, plugin: '../bad' } : row) }), 'invalid registry plugin identifier'],
    ['duplicate row', (doc) => ({ ...doc, skills: [...doc.skills, { ...doc.skills[0] }] }), 'duplicate registry plugin'],
    ['row count', (doc) => ({ ...doc, skills: doc.skills.slice(0, -1) }), 'registry row count'],
    ['plugin set', (doc) => ({ ...doc, skills: doc.skills.map((row, index) => index === 0 ? { ...row, plugin: 'ghost' } : row) }), 'registry plugin set does not match'],
  ])('rejects an invalid %s before checksum maps are built', (_label, mutate, message) => {
    writeRegistry(mutate(structuredClone(baseline)));
    const result = run(['--check']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
  });

  test('normal generation rewrites a stale schema version even when rows match', () => {
    writeRegistry({ ...structuredClone(baseline), version: 2 });
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Wrote');
    expect(JSON.parse(readFileSync(REGISTRY, 'utf8')).version).toBe(3);
  });
});
