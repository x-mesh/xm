/**
 * x-panel preflight TTL cache (t6, docs/x-panel-term-mesh-phase2.md R6).
 * Stubbed providers — no real model calls. Proves: second preflight within the
 * TTL performs ZERO live probes (the stub is swapped for a broken command and
 * the verdict must still be `live` from cache), `--fresh` bypasses, failures
 * are never cached.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'x-panel', 'lib', 'x-panel-cli.mjs');
const STUB = join(import.meta.dirname, 'fixtures', 'panel-stub-model.mjs');

let DIR;
let BROKEN; // a provider command that always fails — proves cache hits skip the probe

beforeAll(() => {
  DIR = mkdtempSync(join(tmpdir(), 'preflight-cache-'));
  BROKEN = join(DIR, 'broken-model.mjs');
  writeFileSync(BROKEN, '#!/usr/bin/env node\nprocess.stderr.write("boom\\n");\nprocess.exit(1);\n');
  chmodSync(BROKEN, 0o755);
});
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

function preflight(args, env = {}) {
  return spawnSync('node', [CLI, 'preflight', '--models', 'claude,codex', '--json', ...args], {
    cwd: DIR,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      X_PANEL_ROOT: join(DIR, '.xm'),
      X_PANEL_GLOBAL_ROOT: join(DIR, '.xm-g'),
      X_PANEL_CMD_CLAUDE: STUB,
      X_PANEL_CMD_CODEX: STUB,
      NO_COLOR: '1',
      ...env,
    },
  });
}

const parse = (r) => JSON.parse(r.stdout);

describe('preflight TTL cache', () => {
  test('first run probes live, second run is served from cache with 0 probes', () => {
    const r1 = preflight([]);
    expect(r1.status).toBe(0);
    const j1 = parse(r1);
    expect(j1.ok).toBe(2);
    expect(j1.results.every((x) => !x.cached)).toBe(true);
    expect(existsSync(join(DIR, '.xm', 'panel', 'preflight-cache.json'))).toBe(true);

    // Swap both providers for a command that ALWAYS fails: if the second run
    // made any live probe, the verdict would flip to failed. cached ⇒ 0 calls.
    const r2 = preflight([], { X_PANEL_CMD_CLAUDE: BROKEN, X_PANEL_CMD_CODEX: BROKEN });
    expect(r2.status).toBe(0);
    const j2 = parse(r2);
    expect(j2.ok).toBe(2);
    expect(j2.results.every((x) => x.cached === true)).toBe(true);
    expect(j2.results.every((x) => /cached \d+s ago/.test(x.detail))).toBe(true);
  });

  test('--fresh bypasses the cache (re-probes live)', () => {
    const r = preflight(['--fresh'], { X_PANEL_CMD_CLAUDE: BROKEN, X_PANEL_CMD_CODEX: BROKEN });
    const j = parse(r);
    expect(j.ok).toBe(0); // broken commands really probed → both fail
    expect(j.results.every((x) => !x.cached)).toBe(true);
  });

  test('failures are never cached', () => {
    // The --fresh failures above must not have been persisted as entries.
    const cache = JSON.parse(readFileSync(join(DIR, '.xm', 'panel', 'preflight-cache.json'), 'utf8'));
    expect(cache.schema).toBe(1);
    for (const v of Object.values(cache.entries)) expect(v.ok).toBe(true);
    // And a run that starts from failures caches nothing new.
    rmSync(join(DIR, '.xm', 'panel', 'preflight-cache.json'));
    const r = preflight([], { X_PANEL_CMD_CLAUDE: BROKEN, X_PANEL_CMD_CODEX: BROKEN });
    const j = parse(r);
    expect(j.ok).toBe(0);
    const cache2 = JSON.parse(readFileSync(join(DIR, '.xm', 'panel', 'preflight-cache.json'), 'utf8'));
    expect(Object.keys(cache2.entries).length).toBe(0);
  });

  test('panel.preflight_ttl_s: 0 disables the cache entirely', () => {
    const ok = preflight([]); // repopulate cache with live verdicts
    expect(parse(ok).ok).toBe(2);
    const cfgDir = join(DIR, '.xm');
    writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ panel: { preflight_ttl_s: 0 } }));
    const r = preflight([], { X_PANEL_CMD_CLAUDE: BROKEN, X_PANEL_CMD_CODEX: BROKEN });
    const j = parse(r);
    expect(j.ok).toBe(0); // TTL off ⇒ really probed ⇒ broken fails
    rmSync(join(cfgDir, 'config.json'));
  });
});
