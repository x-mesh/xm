import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import {
  mkdtempSync, mkdirSync, copyFileSync, cpSync, existsSync, readFileSync, readdirSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  detectCodexFeature,
  parseCodexFeature,
  renderCodexVendor,
  resolveCodexSpec,
  renderRoleLayerToml,
  renderProfileToml,
  codexVendorRelativePaths,
  CODEX_ROLE_PHASES,
  CODEX_PROFILE_POLICY,
} from '../xm/lib/install/transform/codex-vendor.mjs';
import { renderCodexPrompt } from '../xm/lib/install/transform/codex.mjs';
import { readSkill } from '../xm/lib/install/scan.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const CLI = join(REPO, 'xm', 'lib', 'install', 'install-cli.mjs');
const SKILLS = join(REPO, 'xm', 'skills');
const LIB = join(REPO, 'xm', 'lib');

function runCli(args, opts = {}) {
  const result = spawnSync('node', [CLI, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    encoding: 'utf8',
    timeout: 30_000,
    // Merge (not replace) so the child keeps PATH etc.; opts.env layers stubs on top.
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status ?? -1 };
}

function seedTmp() {
  const tmp = mkdtempSync(join(tmpdir(), 'xm-codex-vendor-'));
  mkdirSync(join(tmp, '.claude'), { recursive: true });
  copyFileSync(join(REPO, '.claude', 'settings.json'), join(tmp, '.claude', 'settings.json'));
  cpSync(join(REPO, '.claude', 'hooks'), join(tmp, '.claude', 'hooks'), { recursive: true });
  return tmp;
}

const ENABLED_STUB = JSON.stringify({ features: [{ name: 'multi_agent', stability: 'stable', enabled: true }] });
const DISABLED_STUB = JSON.stringify({ features: [{ name: 'multi_agent', stability: 'experimental', enabled: false }] });

// ── Feature gate: parse + detect (enabled / unsupported / parse-fail / cli-absent) ──

describe('codex-vendor — parseCodexFeature', () => {
  test('stable + enabled JSON → supported', () => {
    const r = parseCodexFeature(ENABLED_STUB);
    expect(r.supported).toBe(true);
    expect(r.enabled).toBe(true);
    expect(r.reason).toBeNull();
  });

  test('experimental / disabled JSON → unsupported with reason', () => {
    const r = parseCodexFeature(DISABLED_STUB);
    expect(r.supported).toBe(false);
    expect(r.enabled).toBe(false);
    expect(r.reason).toMatch(/needs stable\+enabled/);
  });

  test('stable but disabled → unsupported', () => {
    const r = parseCodexFeature(JSON.stringify({ features: [{ name: 'multi_agent', stability: 'stable', enabled: false }] }));
    expect(r.supported).toBe(false);
  });

  test('whitespace table row → parsed', () => {
    const r = parseCodexFeature('feature       stability   status\nmulti_agent   stable      enabled\nhooks   stable   enabled');
    expect(r.supported).toBe(true);
  });

  test('real codex-cli 0.142.5 table format (literal true column) → supported', () => {
    // E2E에서 발견: 실제 CLI는 enabled 컬럼에 'enabled'가 아니라 'true'를 출력한다.
    const r = parseCodexFeature('collaboration_modes    removed            true\nmulti_agent            stable             true\nmulti_agent_v2         under development  false');
    expect(r.supported).toBe(true);
    expect(r.enabled).toBe(true);
  });

  test('real table format with false column → unsupported', () => {
    const r = parseCodexFeature('multi_agent   stable   false');
    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(/disabled/);
  });

  test('unparseable garbage → safe unsupported (parse-fail), never throws', () => {
    const r = parseCodexFeature('%%% not json and no matching row %%%');
    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(/not found/);
  });

  test('empty output → unsupported', () => {
    expect(parseCodexFeature('').supported).toBe(false);
    expect(parseCodexFeature('   ').supported).toBe(false);
  });

  test('feature absent from list → unsupported', () => {
    const r = parseCodexFeature(JSON.stringify({ features: [{ name: 'hooks', stability: 'stable', enabled: true }] }));
    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(/not listed/);
  });
});

describe('codex-vendor — detectCodexFeature', () => {
  test('env stub enabled → supported', () => {
    const r = detectCodexFeature('multi_agent', { env: { XM_CODEX_FEATURES_STUB: ENABLED_STUB } });
    expect(r.supported).toBe(true);
  });

  test('env stub disabled → unsupported', () => {
    const r = detectCodexFeature('multi_agent', { env: { XM_CODEX_FEATURES_STUB: DISABLED_STUB } });
    expect(r.supported).toBe(false);
  });

  test('env sentinel __ENOENT__ → codex not found, never throws', () => {
    const r = detectCodexFeature('multi_agent', { env: { XM_CODEX_FEATURES_STUB: '__ENOENT__' } });
    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(/not found on PATH/);
  });

  test('injected spawnSync ENOENT (codex absent) → safe unsupported', () => {
    const fake = () => ({ error: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }) });
    const r = detectCodexFeature('multi_agent', { env: {}, spawnSync: fake });
    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(/not found on PATH/);
  });

  test('injected spawnSync ETIMEDOUT → safe unsupported', () => {
    const fake = () => ({ error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) });
    const r = detectCodexFeature('multi_agent', { env: {}, spawnSync: fake, timeoutMs: 1234 });
    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(/timed out after 1234ms/);
  });

  test('injected spawnSync non-zero exit → safe unsupported', () => {
    const fake = () => ({ status: 3, stdout: '' });
    const r = detectCodexFeature('multi_agent', { env: {}, spawnSync: fake });
    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(/exited with status 3/);
  });

  test('injected spawnSync success → parses stdout', () => {
    const fake = () => ({ status: 0, stdout: ENABLED_STUB });
    const r = detectCodexFeature('multi_agent', { env: {}, spawnSync: fake });
    expect(r.supported).toBe(true);
  });
});

// ── Model resolution derives from cost-engine VENDOR_MODELS.codex ──

describe('codex-vendor — resolveCodexSpec', () => {
  test('opus tier → gpt-5.5 + high effort (spec-pinned)', () => {
    expect(resolveCodexSpec('opus')).toEqual({ model: 'gpt-5.5', effort: 'high', spec: 'gpt-5.5:high' });
  });
  test('sonnet tier → gpt-5.4, no effort', () => {
    expect(resolveCodexSpec('sonnet')).toEqual({ model: 'gpt-5.4', effort: null, spec: 'gpt-5.4' });
  });
  test('haiku tier → gpt-5.4-mini, no effort', () => {
    expect(resolveCodexSpec('haiku')).toEqual({ model: 'gpt-5.4-mini', effort: null, spec: 'gpt-5.4-mini' });
  });
  test('unknown tier fails loud', () => {
    expect(() => resolveCodexSpec('nonsense')).toThrow(/could not resolve/);
  });
});

describe('codex-vendor — TOML rendering', () => {
  test('role layer with effort emits both keys', () => {
    const toml = renderRoleLayerToml({ role: 'planner', phase: 'plan', tier: 'opus', spec: { model: 'gpt-5.5', effort: 'high' } });
    expect(toml).toMatch(/^model = "gpt-5\.5"$/m);
    expect(toml).toMatch(/^model_reasoning_effort = "high"$/m);
    expect(toml).toMatch(/plan phase/);
  });
  test('role layer without effort omits the effort key', () => {
    const toml = renderRoleLayerToml({ role: 'executor', phase: 'implement', tier: 'sonnet', spec: { model: 'gpt-5.4', effort: null } });
    expect(toml).toMatch(/^model = "gpt-5\.4"$/m);
    expect(toml).not.toMatch(/model_reasoning_effort/);
  });
  test('profiles: economy=mini+low, default=5.4+medium, max=5.5+high', () => {
    expect(renderProfileToml('economy')).toMatch(/model = "gpt-5\.4-mini"[\s\S]*model_reasoning_effort = "low"/);
    expect(renderProfileToml('default')).toMatch(/model = "gpt-5\.4"[\s\S]*model_reasoning_effort = "medium"/);
    expect(renderProfileToml('max')).toMatch(/model = "gpt-5\.5"[\s\S]*model_reasoning_effort = "high"/);
  });
  test('every profile carries a generation + approx-pricing header', () => {
    for (const p of Object.keys(CODEX_PROFILE_POLICY)) {
      const toml = renderProfileToml(p);
      expect(toml).toMatch(/gen 2026-07/);
      expect(toml).toMatch(/approx \(unverified\)/);
    }
  });
});

describe('codex-vendor — renderCodexVendor', () => {
  test('emits 3 role layers + 3 profiles, all kind overwrite', () => {
    const { outputs } = renderCodexVendor({ scope: 'local', feature: { supported: true, reason: null } });
    expect(outputs.length).toBe(6);
    expect(outputs.every((o) => o.kind === 'overwrite')).toBe(true);
    const paths = outputs.map((o) => o.relativePath).sort();
    expect(paths).toEqual(codexVendorRelativePaths().sort());
  });

  test('global scope → 0o600, local scope → 0o644', () => {
    const g = renderCodexVendor({ scope: 'global', feature: { supported: false, reason: 'x' } });
    const l = renderCodexVendor({ scope: 'local', feature: { supported: false, reason: 'x' } });
    expect(g.outputs.every((o) => o.mode === 0o600)).toBe(true);
    expect(l.outputs.every((o) => o.mode === 0o644)).toBe(true);
  });

  test('gate is output-independent — TOML identical regardless of feature support', () => {
    const on = renderCodexVendor({ scope: 'local', feature: { supported: true, reason: null } });
    const off = renderCodexVendor({ scope: 'local', feature: { supported: false, reason: 'disabled' } });
    expect(on.outputs).toEqual(off.outputs);
  });

  test('run --json linkage note is always present', () => {
    const { notes } = renderCodexVendor({ scope: 'local', feature: { supported: false, reason: 'x' } });
    expect(notes.some((n) => n.includes('model_by_vendor.codex'))).toBe(true);
  });

  test('supported gate prints [agents.xm-*] stanzas; unsupported prints skip reason', () => {
    const on = renderCodexVendor({ scope: 'local', feature: { supported: true, reason: null } });
    expect(on.notes.some((n) => n.includes('[agents.xm-planner]'))).toBe(true);
    const off = renderCodexVendor({ scope: 'local', feature: { supported: false, reason: 'multi_agent off' } });
    expect(off.notes.some((n) => n.includes('skipping [agents.xm-*]') && n.includes('multi_agent off'))).toBe(true);
    expect(off.notes.some((n) => n.includes('[agents.xm-planner]'))).toBe(false);
  });

  test('representative roles stay members of PHASE_ROLE_GROUPS (no cost-engine drift)', () => {
    // renderCodexVendor throws if a role drifts out of its phase group.
    expect(() => renderCodexVendor({ scope: 'local', feature: { supported: false, reason: 'x' } })).not.toThrow();
    expect(CODEX_ROLE_PHASES.map((r) => r.role)).toEqual(['planner', 'executor', 'reviewer']);
  });
});

// ── End-to-end via the CLI subprocess (isolated temp HOME/cwd) ──

describe('install-cli — codex vendor layer (dry-run / install / verify / uninstall)', () => {
  test('--dry-run codex lists 6 vendor-config entries (no fs writes)', () => {
    const tmp = seedTmp();
    const r = runCli(['--dry-run', '--target', 'codex', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/vendor-config=6/);
    expect((r.stdout.match(/vendor-config overwrite/g) || []).length).toBe(6);
    expect(existsSync(join(tmp, '.codex', 'xm', 'agents'))).toBe(false);
  });

  test('install writes TOMLs + prints gate stanzas when multi_agent enabled', () => {
    const tmp = seedTmp();
    const r = runCli(['--target', 'codex', '--skills-dir', SKILLS, '--lib-dir', LIB], {
      cwd: tmp, env: { XM_CODEX_FEATURES_STUB: ENABLED_STUB },
    });
    expect(r.status).toBe(0);
    for (const rel of codexVendorRelativePaths()) {
      expect(existsSync(join(tmp, rel))).toBe(true);
    }
    const planner = readFileSync(join(tmp, '.codex', 'xm', 'agents', 'xm-planner.config.toml'), 'utf8');
    expect(planner).toMatch(/model = "gpt-5\.5"/);
    expect(planner).toMatch(/model_reasoning_effort = "high"/);
    expect(r.stdout).toContain('[agents.xm-planner]');
    expect(r.stdout).toContain('model_by_vendor.codex');
  });

  test('install still writes TOMLs (gate-independent) when multi_agent disabled', () => {
    const tmp = seedTmp();
    const r = runCli(['--target', 'codex', '--skills-dir', SKILLS, '--lib-dir', LIB], {
      cwd: tmp, env: { XM_CODEX_FEATURES_STUB: DISABLED_STUB },
    });
    expect(r.status).toBe(0);
    expect(existsSync(join(tmp, '.codex', 'xm-economy.config.toml'))).toBe(true);
    expect(r.stdout).toContain('skipping [agents.xm-*]');
    expect(r.stdout).not.toContain('[agents.xm-planner]');
  });

  test('install → --verify passes on the vendor TOMLs', () => {
    const tmp = seedTmp();
    runCli(['--target', 'codex', '--skills-dir', SKILLS, '--lib-dir', LIB], {
      cwd: tmp, env: { XM_CODEX_FEATURES_STUB: '__ENOENT__' },
    });
    const r = runCli(['--verify', '--target', 'codex'], { cwd: tmp });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('selfChecksum: ok');
    expect(r.stdout).not.toMatch(/\bchanged\b/);
    expect(r.stdout).not.toMatch(/\bmissing\b/);
  });

  test('--uninstall removes every vendor TOML and drops the manifest', () => {
    const tmp = seedTmp();
    runCli(['--target', 'codex', '--skills-dir', SKILLS, '--lib-dir', LIB], {
      cwd: tmp, env: { XM_CODEX_FEATURES_STUB: '__ENOENT__' },
    });
    const r = runCli(['--uninstall', '--target', 'codex'], { cwd: tmp });
    expect(r.status).toBe(0);
    for (const rel of codexVendorRelativePaths()) {
      expect(existsSync(join(tmp, rel))).toBe(false);
    }
    expect(existsSync(join(tmp, '.codex', 'xm', 'manifest.json'))).toBe(false);
  });

  test('re-install is idempotent — vendor TOMLs report unchanged', () => {
    const tmp = seedTmp();
    const env = { XM_CODEX_FEATURES_STUB: '__ENOENT__' };
    runCli(['--target', 'codex', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp, env });
    const r = runCli(['--target', 'codex', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp, env });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/files written: 0/);
  });

  test('global scope writes vendor TOMLs at 0o600', () => {
    const home = mkdtempSync(join(tmpdir(), 'xm-codex-home-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
    copyFileSync(join(REPO, '.claude', 'settings.json'), join(home, '.claude', 'settings.json'));
    cpSync(join(REPO, '.claude', 'hooks'), join(home, '.claude', 'hooks'), { recursive: true });
    const r = runCli(['--target', 'codex', '--global', '--skills-dir', SKILLS, '--lib-dir', LIB], {
      cwd: home, env: { HOME: home, XM_CODEX_FEATURES_STUB: '__ENOENT__' },
    });
    expect(r.status).toBe(0);
    const planner = join(home, '.codex', 'xm', 'agents', 'xm-planner.config.toml');
    expect(existsSync(planner)).toBe(true);
    expect(statSync(planner).mode & 0o777).toBe(0o600);
    const installedHook = join(home, '.codex', 'xm', 'hooks', 'xm-last-inject.sh');
    expect(existsSync(installedHook)).toBe(true);
    expect(statSync(installedHook).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8'))
      .toContain('bash \\"$HOME/.codex/xm/hooks/xm-last-inject.sh\\"');
  });
});

// ── x-build codex prompt overlay (t8) ──
// The x-build SKILL.md body is written in Claude Code's orchestration vocabulary
// (Agent tool / subagent_type / AskUserQuestion). Under Codex those primitives
// don't exist, so renderCodexPrompt appends a Codex Orchestration Overlay ONLY to
// the x-build prompt, re-mapping each instruction onto the Codex mechanisms this
// project already ships. Other skills' prompts must stay overlay-free.

describe('codex prompt — x-build orchestration overlay (t8)', () => {
  const ctx = { scope: 'local' };
  const loadPrompt = (pluginName) =>
    renderCodexPrompt(readSkill({ pluginName, skillsDir: SKILLS, libDir: LIB }), ctx);
  const buildPrompt = loadPrompt('build');
  const overlayOf = (prompt) => {
    const idx = prompt.indexOf('Codex Orchestration Overlay');
    return idx === -1 ? '' : prompt.slice(idx);
  };

  test('x-build prompt appends the Codex Orchestration Overlay section', () => {
    expect(buildPrompt).toContain('## Codex Orchestration Overlay');
  });

  test('overlay names the Claude-only primitives it is replacing', () => {
    const overlay = overlayOf(buildPrompt);
    // The Agent-tool / subagent_type spawning the body assumes is called out as absent.
    expect(overlay).toContain('subagent_type');
    expect(overlay).toContain('`Agent` tool');
    expect(overlay).toMatch(/DO NOT EXIST/);
  });

  test('overlay supplies the Codex substitute for parallel task spawning', () => {
    const overlay = overlayOf(buildPrompt);
    // Native subagent spawn + installed role layer + run --json model spec.
    expect(overlay).toMatch(/spawn one Codex subagent/i);
    expect(overlay).toContain('multi_agent');
    expect(overlay).toContain('[agents.xm-executor]');
    expect(overlay).toContain('task.model_by_vendor.codex');
  });

  test('overlay carries the codex exec … resume phase-transition contract with the flag-order caveat', () => {
    const overlay = overlayOf(buildPrompt);
    expect(overlay).toContain('resume --last');
    // t6 buildCodexResumeArgs contract: exec flags + model precede the subcommand.
    expect(overlay).toMatch(/MUST precede the `resume` subcommand/);
  });

  test('overlay re-maps AskUserQuestion to a Codex substitute', () => {
    const overlay = overlayOf(buildPrompt);
    expect(overlay).toContain('AskUserQuestion');
    expect(overlay).toMatch(/structured-question tool/);
  });

  test('overlay is append-only — the original body precedes it untouched', () => {
    const idx = buildPrompt.indexOf('Codex Orchestration Overlay');
    // A stable marker from the real x-build body must appear before the overlay.
    const bodyMarker = 'x-build manages the full project lifecycle';
    const markerIdx = buildPrompt.indexOf(bodyMarker);
    expect(markerIdx).toBeGreaterThan(-1);
    expect(markerIdx).toBeLessThan(idx);
  });

  test('overlay introduces no raw (unescaped) $ tokens', () => {
    // install.test.mjs enforces this repo-wide; assert it here for the appended text.
    const overlay = overlayOf(buildPrompt);
    expect([...overlay.matchAll(/(?<!\$)\$(?!ARGUMENTS\b|\$)/g)]).toEqual([]);
  });

  test('non-build skills get no overlay', () => {
    for (const plugin of ['solver', 'op', 'review']) {
      expect(loadPrompt(plugin)).not.toContain('Codex Orchestration Overlay');
    }
  });
});
