// @ts-check
/**
 * Codex vendor layer — emits xm-owned TOML config for Codex CLI so a codex user
 * can drive the same model/effort routing xm uses internally, WITHOUT the
 * installer ever touching `~/.codex/config.toml`.
 *
 * Two artifact families, both under xm-owned paths:
 *
 *   1. Role layers   `<.codex>/xm/agents/xm-<role>.config.toml`
 *      One per representative PHASE_ROLE_GROUPS role (planner/executor/reviewer,
 *      mapped to the plan/implement/review phases). model + optional
 *      model_reasoning_effort are derived from cost-engine VENDOR_MODELS.codex.
 *
 *   2. Profiles      `<.codex>/xm-<profile>.config.toml`
 *      economy / default / max — a single model+effort each, expressing cost
 *      intent. Consumable with `codex -p xm-<profile>` or `codex -c <file>`.
 *
 * SOURCE OF TRUTH for every model id is cost-engine VENDOR_MODELS.codex (loaded
 * from the mirrored `xm/lib/x-build/cost-engine.mjs`, a sibling of this bundle —
 * NOT the x-build source tree). It is loaded lazily (see costEngine() below) so
 * that path-only consumers stay cost-engine-free; a missing mirror at render
 * time fails loud rather than silently producing empty configs.
 *
 * The multi_agent feature gate (FM5) only decides whether we PRINT a
 * `[agents.xm-*]` wiring note. TOML generation itself is gate-independent —
 * profiles/layers are consumable via `-p`/`-c` regardless.
 */

import { join } from 'node:path';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

// cost-engine is loaded LAZILY (not a top-level import) so that path-only
// consumers — plan-paths' codexVendorRelativePaths and the feature gate — never
// pull it in. Only the model-resolving render functions need it, and those run
// only during a real install where the full mirrored lib/ tree is present. A
// missing mirror fails loud here (never silently swallowed), satisfying the
// fail-loud rule while keeping `xm install --list`/`--dry-run` working when only
// lib/install is on disk (the plugin-cache partial-copy layout).
const require = createRequire(import.meta.url);
/** @type {any} */
let _costEngine = null;
function costEngine() {
  if (_costEngine) return _costEngine;
  try {
    _costEngine = require('../../x-build/cost-engine.mjs');
  } catch (err) {
    throw new Error(
      'codex-vendor: failed to load the cost-engine mirror at ../../x-build/cost-engine.mjs ' +
      `(expected as a sibling of xm/lib/install). ${/** @type {Error} */ (err).message}`
    );
  }
  return _costEngine;
}

// Generation tag stamped into every emitted TOML header. Kept as a static
// string (not Date.now()) so re-running install produces byte-identical output —
// manifest idempotency and `--verify` depend on deterministic content.
export const CODEX_VENDOR_GEN = 'gen 2026-07 (cost-engine VENDOR_MODELS.codex)';

/**
 * Representative role per phase. Each role is a member of PHASE_ROLE_GROUPS for
 * its phase; renderCodexVendor asserts membership so a cost-engine drift fails
 * loud instead of silently emitting an off-target layer.
 * @type {ReadonlyArray<{ phase: 'plan'|'implement'|'review', role: string }>}
 */
export const CODEX_ROLE_PHASES = Object.freeze([
  { phase: 'plan', role: 'planner' },
  { phase: 'implement', role: 'executor' },
  { phase: 'review', role: 'reviewer' },
]);

/**
 * Per-profile cost-intent policy: which canonical tier represents the profile,
 * and the reasoning-effort ladder to apply when the vendor spec does not pin one
 * itself. The tier drives the model id (via VENDOR_MODELS.codex); `effort` is a
 * documented xm policy that fills in only when the spec carries no effort suffix.
 * @type {Readonly<Record<'economy'|'default'|'max', { tier: 'haiku'|'sonnet'|'opus', effort: string }>>}
 */
export const CODEX_PROFILE_POLICY = Object.freeze({
  economy: { tier: 'haiku', effort: 'low' },
  default: { tier: 'sonnet', effort: 'medium' },
  max: { tier: 'opus', effort: 'high' },
});

/**
 * Relative path (to install root) of a role layer / profile TOML. These two
 * helpers are the single source of truth for the vendor layer's on-disk layout —
 * both the renderer and the plan enumerator derive from them so they can't drift.
 * @param {string} role
 * @returns {string}
 */
export function roleLayerRelPath(role) {
  return join('.codex', 'xm', 'agents', `xm-${role}.config.toml`);
}
/**
 * @param {string} profile
 * @returns {string}
 */
export function profileRelPath(profile) {
  return join('.codex', `xm-${profile}.config.toml`);
}

/**
 * Enumerate every relative path this vendor layer writes, without rendering
 * content or touching the feature gate. Consumed by plan-paths so `--list` /
 * `--dry-run` surface the plan against the same paths the renderer emits.
 * @returns {string[]}
 */
export function codexVendorRelativePaths() {
  return [
    ...CODEX_ROLE_PHASES.map(({ role }) => roleLayerRelPath(role)),
    ...Object.keys(CODEX_PROFILE_POLICY).map((profile) => profileRelPath(profile)),
  ];
}

/**
 * Resolve a canonical tier into a concrete codex `{ model, effort }`. Fails loud
 * on any gap rather than emitting a config with a null model.
 * @param {string} tier
 * @returns {{ model: string, effort: string|null, spec: string }}
 */
export function resolveCodexSpec(tier) {
  const { resolveVendorModel, parseModelSpec } = costEngine();
  const { spec, warning } = resolveVendorModel(tier, 'codex');
  if (!spec) {
    throw new Error(
      `codex-vendor: could not resolve a codex model for tier "${tier}" ` +
      `(${warning ?? 'no VENDOR_MODELS.codex mapping'})`
    );
  }
  const parsed = parseModelSpec(spec);
  if (!parsed.model) {
    throw new Error(`codex-vendor: parseModelSpec failed for "${spec}" (${parsed.warning ?? 'no model'})`);
  }
  return { model: parsed.model, effort: parsed.effort, spec };
}

/**
 * Approximate per-1M-token pricing string for a tier, straight from
 * MODEL_COSTS_BY_VENDOR.codex. Numbers are labeled unverified (cost-engine FM4).
 * @param {string} tier
 * @returns {string}
 */
function pricingHint(tier) {
  const { MODEL_COSTS_BY_VENDOR } = costEngine();
  const p = MODEL_COSTS_BY_VENDOR.codex?.[tier];
  if (!p) return 'approx pricing unavailable';
  return `approx (unverified) per 1M tokens: input $${p.input.toFixed(2)} / output $${p.output.toFixed(2)}`;
}

/**
 * Emit a `model` + optional `model_reasoning_effort` TOML body.
 * @param {{ model: string, effort: string|null }} spec
 * @returns {string}
 */
function tomlModelBody({ model, effort }) {
  let body = `model = ${JSON.stringify(model)}\n`;
  if (effort) body += `model_reasoning_effort = ${JSON.stringify(effort)}\n`;
  return body;
}

/**
 * Render one role-layer TOML.
 * @param {{ role: string, phase: string, tier: string, spec: { model: string, effort: string|null } }} args
 * @returns {string}
 */
export function renderRoleLayerToml({ role, phase, tier, spec }) {
  const head = [
    `# xm role layer — ${role} (${phase} phase)`,
    `# Generated by \`xm install --target codex\` — ${CODEX_VENDOR_GEN}.`,
    `# Model derived from cost-engine VENDOR_MODELS.codex[${tier}]; do NOT hand-edit,`,
    `# re-run \`xm install\` to regenerate. Lives under xm-owned .codex/xm/ — your`,
    `# ~/.codex/config.toml is never modified by the installer.`,
    `# ${pricingHint(tier)}.`,
    '',
  ].join('\n');
  return head + tomlModelBody(spec);
}

/**
 * Render one profile TOML.
 * @param {'economy'|'default'|'max'} profile
 * @returns {string}
 */
export function renderProfileToml(profile) {
  const policy = CODEX_PROFILE_POLICY[profile];
  if (!policy) throw new Error(`codex-vendor: unknown profile "${profile}"`);
  const resolved = resolveCodexSpec(policy.tier);
  // Spec-pinned effort wins (e.g. opus → gpt-5.5:high); otherwise the profile's
  // effort ladder fills in.
  const effort = resolved.effort ?? policy.effort;
  const head = [
    `# xm profile — ${profile} (cost intent)`,
    `# Generated by \`xm install --target codex\` — ${CODEX_VENDOR_GEN}.`,
    `# Model from cost-engine VENDOR_MODELS.codex[${policy.tier}] + ${profile} effort policy;`,
    `# do NOT hand-edit, re-run \`xm install\` to regenerate. Consume with`,
    `# \`codex -p xm-${profile}\` or \`codex -c <this-file>\`. The installer never`,
    `# edits your ~/.codex/config.toml.`,
    `# ${pricingHint(policy.tier)}.`,
    '',
  ].join('\n');
  return head + tomlModelBody({ model: resolved.model, effort });
}

/**
 * Parse `codex features list` output (JSON or whitespace table) for one feature.
 * Returns supported:true only when the feature is BOTH stable AND enabled.
 * Any unparseable / missing case is a safe supported:false with a reason —
 * never a throw (FM5: the gate must never block TOML generation).
 *
 * @param {string} stdout
 * @param {string} [featureName='multi_agent']
 * @returns {{ feature: string, enabled: boolean, supported: boolean, reason: string|null }}
 */
export function parseCodexFeature(stdout, featureName = 'multi_agent') {
  const text = String(stdout ?? '').trim();
  if (!text) {
    return { feature: featureName, enabled: false, supported: false, reason: 'codex features list returned no output' };
  }

  // 1. JSON shape: array of feature records, or { features: [...] }.
  try {
    const json = JSON.parse(text);
    const list = Array.isArray(json) ? json : (Array.isArray(json?.features) ? json.features : null);
    if (list) {
      const hit = list.find((f) => f && (f.name ?? f.id ?? f.feature) === featureName);
      if (!hit) {
        return { feature: featureName, enabled: false, supported: false, reason: `feature "${featureName}" not listed by codex` };
      }
      const stable = /^stable$/i.test(String(hit.stability ?? hit.stage ?? ''));
      const enabled = hit.enabled === true || /^(enabled|on|true)$/i.test(String(hit.status ?? hit.state ?? ''));
      if (stable && enabled) {
        return { feature: featureName, enabled: true, supported: true, reason: null };
      }
      return {
        feature: featureName,
        enabled,
        supported: false,
        reason: `feature "${featureName}" is ${stable ? 'stable' : 'not-stable'}/${enabled ? 'enabled' : 'disabled'} — needs stable+enabled`,
      };
    }
  } catch {
    // Not JSON — fall through to text-table parsing.
  }

  // 2. Whitespace table: match the row whose first token is the feature name.
  const row = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.split(/\s+/)[0] === featureName);
  if (!row) {
    return { feature: featureName, enabled: false, supported: false, reason: `feature "${featureName}" not found in codex features output` };
  }
  const lower = row.toLowerCase();
  const stable = /\bstable\b/.test(lower);
  // 실제 codex CLI(0.142.5) 테이블은 enabled 컬럼에 리터럴 true/false를 쓴다
  // (`multi_agent  stable  true`) — E2E에서 발견. enabled/on 표기도 함께 수용.
  const enabled = /\b(enabled|true|on)\b/.test(lower) && !/\b(disabled|false|off)\b/.test(lower);
  if (stable && enabled) {
    return { feature: featureName, enabled: true, supported: true, reason: null };
  }
  return {
    feature: featureName,
    enabled,
    supported: false,
    reason: `feature "${featureName}" is ${stable ? 'stable' : 'not-stable'}/${enabled ? 'enabled' : 'disabled'} — needs stable+enabled`,
  };
}

/**
 * Run `codex features list` and report whether `featureName` is stable+enabled.
 * Never throws: a missing codex CLI, timeout, non-zero exit, or unparseable
 * output all collapse to supported:false + reason.
 *
 * Testability: `opts.env.XM_CODEX_FEATURES_STUB` short-circuits the spawn —
 * its value is used as raw stdout, or the sentinel `__ENOENT__` simulates codex
 * being absent. `opts.spawnSync` injects a fake child_process.spawnSync.
 *
 * @param {string} [featureName='multi_agent']
 * @param {{ env?: Record<string,string|undefined>, spawnSync?: typeof nodeSpawnSync, timeoutMs?: number }} [opts]
 * @returns {{ feature: string, enabled: boolean, supported: boolean, reason: string|null }}
 */
export function detectCodexFeature(featureName = 'multi_agent', opts = {}) {
  const env = opts.env ?? process.env;
  const runner = opts.spawnSync ?? nodeSpawnSync;
  const timeoutMs = opts.timeoutMs ?? 2500;

  const stub = env.XM_CODEX_FEATURES_STUB;
  if (stub !== undefined) {
    if (stub === '__ENOENT__') {
      return { feature: featureName, enabled: false, supported: false, reason: 'codex CLI not found on PATH (stub)' };
    }
    return parseCodexFeature(stub, featureName);
  }

  let res;
  try {
    res = runner('codex', ['features', 'list'], { encoding: 'utf8', timeout: timeoutMs });
  } catch (err) {
    return { feature: featureName, enabled: false, supported: false, reason: `codex features list threw: ${/** @type {Error} */ (err).message}` };
  }
  if (res && res.error) {
    const code = /** @type {any} */ (res.error).code;
    const reason = code === 'ENOENT'
      ? 'codex CLI not found on PATH'
      : code === 'ETIMEDOUT'
        ? `codex features list timed out after ${timeoutMs}ms`
        : `codex features list failed: ${res.error.message}`;
    return { feature: featureName, enabled: false, supported: false, reason };
  }
  if (res && typeof res.status === 'number' && res.status !== 0) {
    return { feature: featureName, enabled: false, supported: false, reason: `codex features list exited with status ${res.status}` };
  }
  return parseCodexFeature(res ? (res.stdout ?? '') : '', featureName);
}

/**
 * Render the codex vendor layer (role TOMLs + profile TOMLs) plus install notes.
 * Every output is `kind: 'overwrite'` so it flows through the existing
 * manifest / --verify / --uninstall pipeline unchanged.
 *
 * @param {{ scope: 'global'|'local', feature?: ReturnType<typeof detectCodexFeature> }} args
 * @returns {{ outputs: import('../types.mjs').RenderOutput[], notes: string[] }}
 */
export function renderCodexVendor({ scope, feature } = /** @type {any} */ ({})) {
  /** @type {import('../types.mjs').RenderOutput[]} */
  const outputs = [];
  /** @type {string[]} */
  const notes = [];
  const mode = scope === 'global' ? 0o600 : 0o644;
  const { ROLE_MODEL_MAP_HR, PHASE_ROLE_GROUPS } = costEngine();

  // Role layers — one per representative phase role.
  /** @type {{ role: string, relativePath: string }[]} */
  const roleEntries = [];
  for (const { phase, role } of CODEX_ROLE_PHASES) {
    const group = PHASE_ROLE_GROUPS[phase] || [];
    if (!group.includes(role)) {
      throw new Error(
        `codex-vendor: representative role "${role}" is no longer a member of ` +
        `PHASE_ROLE_GROUPS.${phase} (${group.join(', ')}) — cost-engine drift, update CODEX_ROLE_PHASES.`
      );
    }
    const tier = ROLE_MODEL_MAP_HR[role];
    if (!tier) {
      throw new Error(`codex-vendor: no ROLE_MODEL_MAP_HR tier for role "${role}"`);
    }
    const spec = resolveCodexSpec(tier);
    const relativePath = roleLayerRelPath(role);
    outputs.push({
      relativePath,
      content: renderRoleLayerToml({ role, phase, tier, spec }),
      kind: 'overwrite',
      mode,
    });
    roleEntries.push({ role, relativePath });
  }

  // Profiles — economy / default / max.
  for (const profile of /** @type {('economy'|'default'|'max')[]} */ (Object.keys(CODEX_PROFILE_POLICY))) {
    outputs.push({
      relativePath: profileRelPath(profile),
      content: renderProfileToml(profile),
      kind: 'overwrite',
      mode,
    });
  }

  // run --json linkage (t5): explain how model_by_vendor.codex feeds these layers.
  notes.push(
    'codex: `xm build run --json` emits task.model_by_vendor.codex as a "model[:effort]" ' +
    'string (e.g. "gpt-5.4" or "gpt-5.5:high") from the same VENDOR_MODELS.codex table these ' +
    'layers pin — pass it to codex via `-c model=<model>` (+ `-c model_reasoning_effort=<effort>`) ' +
    'or match it to a [agents.xm-*] stanza.'
  );

  // Feature gate (FM5) — only decides whether to print the wiring note.
  const feat = feature ?? detectCodexFeature('multi_agent');
  if (feat.supported) {
    const stanzas = roleEntries
      .map(({ role, relativePath }) => {
        const configPath = scope === 'global' ? `~/${relativePath}` : relativePath;
        return `    [agents.xm-${role}]\n    config_file = ${JSON.stringify(configPath)}`;
      })
      .join('\n');
    notes.push(
      'codex: multi_agent is stable+enabled — wire the xm role layers by adding these stanzas ' +
      'to ~/.codex/config.toml ONCE (the installer never edits config.toml):\n' + stanzas
    );
  } else {
    notes.push(
      `codex: skipping [agents.xm-*] wiring note — multi_agent not usable (${feat.reason}). ` +
      'The role/profile TOMLs are still installed; consume them with `codex -p xm-<profile>` or `codex -c <file>`.'
    );
  }

  return { outputs, notes };
}
