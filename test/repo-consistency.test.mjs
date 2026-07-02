import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');

function readJSON(path) {
  return JSON.parse(readFileSync(join(REPO, path), 'utf8'));
}

function readBadgeVersion(path) {
  const body = readFileSync(join(REPO, path), 'utf8');
  const match = body.match(/img\.shields\.io\/badge\/version-([0-9]+\.[0-9]+\.[0-9]+)-blue/);
  return match?.[1] || null;
}

describe('repo consistency', () => {
  test('xm version is consistent across package, plugin metadata, marketplace, and README badges', () => {
    const pkg = readJSON('package.json');
    const plugin = readJSON('xm/.claude-plugin/plugin.json');
    const marketplace = readJSON('.claude-plugin/marketplace.json');
    const marketplaceXm = marketplace.plugins.find((p) => p.name === 'xm');

    expect(plugin.version).toBe(pkg.version);
    expect(marketplaceXm?.version).toBe(pkg.version);
    expect(readBadgeVersion('README.md')).toBe(pkg.version);
    expect(readBadgeVersion('README.ko.md')).toBe(pkg.version);
  });

  test('dashboard CFG_ROLE_NAMES matches the canonical MODEL_PROFILES role set', async () => {
    const ce = await import(join(REPO, 'x-build', 'lib', 'x-build', 'cost-engine.mjs'));
    const appJs = readFileSync(join(REPO, 'x-dashboard', 'public', 'app.js'), 'utf8');
    const match = appJs.match(/const CFG_ROLE_NAMES = (\[[^\]]*\])/);
    expect(match).not.toBeNull();
    const uiRoles = JSON.parse(match[1].replace(/'/g, '"'));
    expect([...uiRoles].sort()).toEqual(Object.keys(ce.MODEL_PROFILES.default).sort());
  });
});
