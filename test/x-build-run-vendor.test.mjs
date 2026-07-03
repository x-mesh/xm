// run --json vendor-model additive extension (R5).
//
// buildPlanEntry emits `model` (the Claude tier — the Agent-tool routing
// contract, unchanged) PLUS two additive fields: `model_vendor` ('claude') and
// `model_by_vendor` ({ claude: <tier>, codex?: <spec> }). The codex spec is
// derived from cost-engine's resolveVendorModel; on ANY warning (FM1 unmapped
// tier / FM7 non-object vendor_models / malformed override) the run must NOT
// crash — it prints the warning to stderr and emits claude-only.
//
// Style mirrors config-cli.test.mjs: an isolated X_BUILD_ROOT per case, the CLI
// spawned in a child process so no module state leaks between siblings.
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'x-build', 'lib', 'x-build-cli.mjs');

// Materialize a minimal Execute-phase project under <root>/build and a shared
// config at <root>/config.json (loadSharedConfig reads ROOT/../config.json), then
// spawn `run --json`. Returns the parsed stdout plus raw streams + exit code.
function runProject({ sharedConfig = {}, task = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'xm-run-vendor-'));
  try {
    const buildRoot = join(root, 'build');
    const name = 'demo';
    const planDir = join(buildRoot, 'projects', name, 'phases', '02-plan');
    mkdirSync(planDir, { recursive: true });

    writeFileSync(join(root, 'config.json'), JSON.stringify(sharedConfig));
    writeFileSync(
      join(buildRoot, 'projects', name, 'manifest.json'),
      JSON.stringify({ display_name: 'Demo', current_phase: '03-execute' }),
    );
    const t = { id: 't1', name: 'Implement thing', size: 'small', status: 'pending', depends_on: [], ...task };
    writeFileSync(join(planDir, 'tasks.json'), JSON.stringify({ tasks: [t] }));
    writeFileSync(join(planDir, 'steps.json'), JSON.stringify({ steps: [{ id: 1, tasks: ['t1'] }] }));

    const res = spawnSync('node', [CLI, '--project', name, 'run', '--json'], {
      env: { ...process.env, X_BUILD_ROOT: buildRoot, XM_ROOT: buildRoot, NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 15000,
    });
    let json = null;
    try { json = JSON.parse((res.stdout ?? '').trim()); } catch { json = null; }
    return { json, stdout: res.stdout ?? '', stderr: res.stderr ?? '', exitCode: res.status ?? 1 };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const firstTask = (out) => out.json?.tasks?.[0];

describe('run --json vendor-model additive fields', () => {
  test('emits model_vendor + model_by_vendor alongside the canonical claude tier', () => {
    const out = runProject({ sharedConfig: { model_overrides: { executor: 'sonnet' } } });
    expect(out.exitCode).toBe(0);
    const entry = firstTask(out);
    expect(entry).toBeDefined();

    // Existing contract untouched: task.model stays the Claude tier vocabulary.
    expect(entry.model).toBe('sonnet');
    expect(['haiku', 'sonnet', 'opus']).toContain(entry.model);

    // Additive fields present and consistent.
    expect(entry.model_vendor).toBe('claude');
    expect(entry.model_by_vendor).toBeDefined();
    expect(entry.model_by_vendor.claude).toBe(entry.model);
    // Built-in codex table maps sonnet → gpt-5.4.
    expect(entry.model_by_vendor.codex).toBe('gpt-5.4');
  });

  test('codex spec honors a vendor_models config override', () => {
    const out = runProject({
      sharedConfig: {
        model_overrides: { executor: 'sonnet' },
        vendor_models: { codex: { sonnet: 'gpt-custom-x' } },
      },
    });
    expect(out.exitCode).toBe(0);
    const entry = firstTask(out);
    expect(entry.model).toBe('sonnet');
    expect(entry.model_by_vendor.codex).toBe('gpt-custom-x');
  });

  // Pathological configs must degrade to claude-only, warn on stderr, never crash.
  test('FM7: non-object vendor_models → claude-only, no crash', () => {
    const out = runProject({
      sharedConfig: { model_overrides: { executor: 'sonnet' }, vendor_models: 'not-an-object' },
    });
    expect(out.exitCode).toBe(0);
    const entry = firstTask(out);
    expect(entry.model).toBe('sonnet'); // canonical tier still valid
    expect(entry.model_vendor).toBe('claude');
    expect(entry.model_by_vendor).toEqual({ claude: 'sonnet' }); // codex omitted
    expect(out.stderr).toContain('vendor model (codex)');
  });

  test('malformed codex mapping (non-string spec) → claude-only, no crash', () => {
    const out = runProject({
      sharedConfig: {
        model_overrides: { executor: 'sonnet' },
        vendor_models: { codex: { sonnet: 123 } },
      },
    });
    expect(out.exitCode).toBe(0);
    const entry = firstTask(out);
    expect(entry.model).toBe('sonnet');
    expect(entry.model_by_vendor).toEqual({ claude: 'sonnet' }); // codex omitted
    expect(out.stderr).toContain('vendor model (codex)');
  });

  test('FM1: unmapped tier (broken model override) → claude-only, no crash', () => {
    const out = runProject({ sharedConfig: { model_overrides: { executor: 'banana' } } });
    expect(out.exitCode).toBe(0);
    const entry = firstTask(out);
    // The broken tier flows through untouched (routing contract is verbatim)…
    expect(entry.model).toBe('banana');
    expect(entry.model_by_vendor.claude).toBe('banana');
    // …but codex has no mapping for it, so it is omitted.
    expect(entry.model_by_vendor.codex).toBeUndefined();
    expect(out.stderr).toContain('vendor model (codex)');
  });
});
