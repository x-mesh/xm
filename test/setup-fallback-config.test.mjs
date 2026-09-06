/**
 * setup.mjs's fallback config must not drift from the shipped defaults.
 *
 * Both `xm/scripts/setup.mjs` and `x-build/scripts/setup.mjs` copy
 * `lib/default-config.json` into `.xm/config.json`, and hand-write an
 * equivalent object only when that file is missing. That fallback is a second
 * copy of the defaults with no mechanism keeping it in step, and it had already
 * drifted three ways: it wrote `execution.*` (a dead key with no runtime
 * consumer, deliberately unregistered in config-schema.mjs), it weakened
 * `research-exit` from `human-verify` to `auto` in both files, and it weakened
 * `plan-exit` from `decision` to `human-verify` in the xm copy.
 *
 * Silently downgrading a gate is the damaging half: a project initialized
 * through the fallback would skip confirmations the real defaults require.
 *
 * These tests run the actual script against a plugin root with no `lib/`, so
 * they exercise the fallback branch itself rather than re-reading its source.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Plugins whose setup.mjs owns a hand-written fallback copy of the defaults. */
const PLUGINS = [
  { name: 'xm', script: join(ROOT, 'xm', 'scripts', 'setup.mjs'), defaults: join(ROOT, 'xm', 'lib', 'default-config.json') },
  { name: 'x-build', script: join(ROOT, 'x-build', 'scripts', 'setup.mjs'), defaults: join(ROOT, 'x-build', 'lib', 'default-config.json') },
];

/** Keys config-schema.mjs deliberately leaves unregistered — nothing reads them. */
const DEAD_KEYS = ['execution', 'workflow', 'granularity', 'discussion', 'research'];

/**
 * Run setup.mjs from a plugin root that has no lib/, forcing the fallback
 * branch, and return the .xm/config.json it wrote.
 * @param {string} script
 * @param {{ withDefaults?: string }} [opts] copy this default-config.json into
 *   the fake plugin root's lib/ to take the normal copy path instead
 */
function runSetup(script, opts = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'xm-setup-fallback-'));
  try {
    const pluginRoot = join(tmp, 'plugin');
    mkdirSync(join(pluginRoot, 'scripts'), { recursive: true });
    copyFileSync(script, join(pluginRoot, 'scripts', 'setup.mjs'));
    if (opts.withDefaults) {
      mkdirSync(join(pluginRoot, 'lib'), { recursive: true });
      copyFileSync(opts.withDefaults, join(pluginRoot, 'lib', 'default-config.json'));
    }
    const cwd = join(tmp, 'work');
    mkdirSync(cwd, { recursive: true });
    const r = spawnSync(process.execPath, [join(pluginRoot, 'scripts', 'setup.mjs')], { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`setup.mjs exited ${r.status}: ${r.stderr}`);
    return JSON.parse(readFileSync(join(cwd, '.xm', 'config.json'), 'utf8'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('setup.mjs fallback config', () => {
  for (const { name, script, defaults } of PLUGINS) {
    const authority = JSON.parse(readFileSync(defaults, 'utf8'));

    test(`${name}: fallback gates match default-config.json`, () => {
      const written = runSetup(script);
      expect(written.gates).toEqual(authority.gates);
    });

    test(`${name}: fallback writes no dead keys`, () => {
      const written = runSetup(script);
      for (const key of DEAD_KEYS) expect(written).not.toHaveProperty(key);
    });

    test(`${name}: copies default-config.json verbatim when it exists`, () => {
      const written = runSetup(script, { withDefaults: defaults });
      expect(written).toEqual(authority);
    });
  }
});
