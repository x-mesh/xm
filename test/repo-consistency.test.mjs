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

  test('dashboard no longer hardcodes the role list (config-gap-close: roles come from /api/config/model-routing)', () => {
    // The old guard asserted the CFG_ROLE_NAMES hardcode stayed in sync with
    // MODEL_PROFILES. config-gap-close removed the hardcode entirely — the UI
    // derives roles at runtime — so the guard now prevents reintroduction.
    const appJs = readFileSync(join(REPO, 'x-dashboard', 'public', 'app.js'), 'utf8');
    expect(appJs).not.toContain('CFG_ROLE_NAMES');
    expect(appJs).not.toContain('CFG_ROLE_MODELS');
  });
});
