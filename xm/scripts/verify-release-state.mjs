#!/usr/bin/env node
// @ts-check

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

function readJSON(rel) {
  return JSON.parse(readFileSync(join(REPO, rel), 'utf8'));
}

function badgeVersion(rel) {
  const body = readFileSync(join(REPO, rel), 'utf8');
  const match = body.match(/img\.shields\.io\/badge\/version-([0-9]+\.[0-9]+\.[0-9]+)-blue/);
  return match?.[1] || null;
}

function runCheck(name, command, args) {
  const result = spawnSync(command, args, {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return {
    name,
    ok: result.status === 0,
    status: result.status ?? -1,
    output: `${result.stdout || ''}${result.stderr || ''}`.trim().split('\n').slice(-8).join('\n'),
  };
}

function checkVersions() {
  const pkg = readJSON('package.json');
  const plugin = readJSON('xm/.claude-plugin/plugin.json');
  const marketplace = readJSON('.claude-plugin/marketplace.json');
  const marketplaceXm = marketplace.plugins.find((p) => p.name === 'xm');
  const expected = pkg.version;
  const mismatches = [];
  const entries = [
    ['xm/.claude-plugin/plugin.json', plugin.version],
    ['.claude-plugin/marketplace.json:xm', marketplaceXm?.version],
    ['README.md badge', badgeVersion('README.md')],
    ['README.ko.md badge', badgeVersion('README.ko.md')],
  ];
  for (const [name, actual] of entries) {
    if (actual !== expected) mismatches.push(`${name}: ${actual || '(missing)'} != ${expected}`);
  }
  return {
    name: 'version-consistency',
    ok: mismatches.length === 0,
    output: mismatches.length ? mismatches.join('\n') : `xm version ${expected} is consistent`,
  };
}

const results = [
  checkVersions(),
  runCheck('bundle-sync', 'bash', ['scripts/sync-bundle.sh', '--check']),
];

if (existsSync(join(REPO, 'xm', 'scripts', 'skills-checksum.mjs'))) {
  results.push(runCheck('skills-checksum', 'node', ['xm/scripts/skills-checksum.mjs', '--check']));
}

const json = process.argv.includes('--json');
const ok = results.every((r) => r.ok);

if (json) {
  console.log(JSON.stringify({ ok, results }, null, 2));
} else {
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'} ${r.name}`);
    if (!r.ok || process.argv.includes('--verbose')) {
      console.log(r.output.split('\n').map((line) => `  ${line}`).join('\n'));
    }
  }
}

process.exit(ok ? 0 : 1);
