/**
 * shared-config.mjs — Shared config utilities for xm tools
 * Provides read/write access to .xm/config.json for x-build, x-solver, x-op.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scopeForKey, getSchemaEntry, SCHEMA_BY_KEY } from './config-schema.mjs';
import { createRL, ask, WizardEOF, menuSelect, isRawCapable, section, railLine, outro, G, P } from './cli-prompts.mjs';
import { initLang, t } from './cli-messages.mjs';
// 상대 경로는 소스(x-build/lib)와 미러(xm/lib) 양쪽 레이아웃에서 동일하게 해석된다
// (frontmatter-sync가 검증한 경로 패턴).
import { parseModelSpec } from './x-build/cost-engine.mjs';
// Single tier-merge rule shared with cost-engine/core (빌드5). config-loader only
// imports root.mjs, so this direct import adds no cycle.
import { mergeSharedTiers } from './x-build/config-loader.mjs';

// ── Defaults ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  mode: 'developer',
  agent_max_count: 4,
  pipelines: {},
};

// ── Internal helpers ──────────────────────────────────────────────────

function readJSON(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJSONAtomic(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameSync(tmp, filePath);
}

function mergeWithDefaults(data) {
  return {
    ...DEFAULT_CONFIG,
    ...data,
  };
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Resolve the .xm/ root directory.
 * Priority: XM_ROOT env var → opts.global (~/.xm/) → cwd/.xm/ → main repo .xm/ (worktree)
 *
 * When running inside a git worktree, the local cwd may not have .xm/.
 * In that case, resolve the main repo root via `git rev-parse --git-common-dir`
 * and use its .xm/ so all worktrees share a single project state.
 */
export function resolveSharedRoot(opts = {}) {
  if (process.env.XM_ROOT) {
    return process.env.XM_ROOT;
  }
  if (opts.global) {
    return join(homedir(), '.xm');
  }
  const localXm = join(process.cwd(), '.xm');
  if (existsSync(localXm)) {
    return localXm;
  }
  // Worktree fallback: resolve main repo's .xm/
  try {
    const commonDir = execSync('git rev-parse --git-common-dir', {
      cwd: process.cwd(), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const mainRoot = resolve(process.cwd(), commonDir, '..');
    const mainXm = join(mainRoot, '.xm');
    if (existsSync(mainXm)) {
      return mainXm;
    }
  } catch {
    // Not a git repo or git not available — fall through
  }
  return localXm;
}

/**
 * Read .xm/config.json and merge with defaults.
 * Fallback chain: project (.xm/) → global (~/.xm/) → defaults.
 * Pass opts.global to force reading from ~/.xm/ only.
 */
export function readSharedConfig(opts = {}) {
  const root = resolveSharedRoot(opts);
  const configPath = join(root, 'config.json');
  const local = readJSON(configPath) ?? {};

  // Merge: default → global → local (local wins over global wins over default)
  if (opts.global || process.env.XM_ROOT) {
    return mergeWithDefaults(local);
  }

  const globalPath = join(homedir(), '.xm', 'config.json');
  const global = readJSON(globalPath) ?? {};

  return { ...DEFAULT_CONFIG, ...mergeSharedTiers(global, local) };
}

/**
 * Set a single key in .xm/config.json.
 * Reads existing config, sets key, writes back atomically.
 */
export function writeSharedConfig(key, value, opts = {}) {
  const root = resolveSharedRoot(opts);
  const configPath = join(root, 'config.json');
  const existing = readJSON(configPath) ?? {};
  existing[key] = value;
  writeJSONAtomic(configPath, existing);
}

/**
 * Read a single key from .xm/config.json (with defaults applied).
 */
export function getSharedValue(key, opts = {}) {
  const config = readSharedConfig(opts);
  return config[key];
}

/**
 * Get the maximum agent count.
 * Reads agent_max_count from config. Default: 4.
 */
export function getAgentCount(opts = {}) {
  const config = readSharedConfig(opts);
  return config.agent_max_count ?? 4;
}

/**
 * Shorthand for getSharedValue('mode'). Defaults to 'developer'.
 */
export function getMode(opts = {}) {
  return getSharedValue('mode', opts) ?? 'developer';
}

// ── Interactive Config ──────────────────────────────────────────────

const C = {
  bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', red: '\x1b[31m',
};

// ── Frontmatter sync trigger (best-effort) ──────────────────────────────
// Locates xm/lib/skill-frontmatter-sync.mjs near this file (bundle case) or
// up the source repo. Runs it asynchronously to update SKILL.md frontmatter
// `model:` fields when model_profile changes. Failures are non-fatal.

function findFrontmatterSyncTool() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'skill-frontmatter-sync.mjs'),                // xm bundle: same dir
    join(here, '..', '..', 'xm', 'lib', 'skill-frontmatter-sync.mjs'),  // x-build source
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function triggerFrontmatterSync() {
  // XM_ROOT가 설정된 경우(테스트 샌드박스·격리 실행) 이 리포의 SKILL.md를
  // 샌드박스 config 기준으로 재작성하면 안 된다 — 조용히 건너뛰지 않고 알린다.
  if (process.env.XM_ROOT) {
    console.log(`  ${C.dim}↻ ${t('fm.skip_xmroot')}${C.reset}`);
    return;
  }
  const tool = findFrontmatterSyncTool();
  if (!tool) {
    console.log(`  ${C.dim}↻ ${t('fm.tool_not_found')}${C.reset}`);
    return;
  }
  try {
    const r = spawnSync('node', [tool], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status === 0) {
      const summary = (r.stdout.split('\n').find(l => l.startsWith('summary:')) || '').trim();
      console.log(`  ${C.green}↻${C.reset} ${t('fm.sync_done')} ${C.dim}${summary}${C.reset}`);
    } else {
      console.log(`  ${C.yellow}⚠${C.reset} ${t('fm.sync_failed', r.status)}`);
      if (r.stderr) console.log(`  ${C.dim}${r.stderr.trim()}${C.reset}`);
    }
  } catch (e) {
    console.log(`  ${C.dim}↻ ${t('fm.skip_err', e.message)}${C.reset}`);
  }
}

// Resolve the write/read target for a key when no explicit --local/--global flag
// is given. The default target comes from the config-schema registry scope: only
// 'local'-scoped keys (budget.*) go to the project .xm/; everything else — plus
// unregistered keys and the build-local worktree tier — resolves to global, which
// preserves the historical LOCAL_DEFAULT_KEYS=Set(['budget']) behavior. (The
// worktree category owns real 3-tier writes; this shared resolver is 2-tier only.)
function resolveScope(key, opts) {
  if (opts.local) return { global: false };
  if (opts.global) return { global: true };
  return { global: scopeForKey(key) !== 'local' };
}

// Line-queued readline for the wizard. A persistent 'line' listener buffers every
// line into rl._xmLines, so lines that arrive faster than ask() calls (all of a
// piped stdin's lines can be emitted synchronously in one chunk) are NOT dropped —
// the plain rl.question() one-callback-at-a-time model loses them. ask() drains
// the buffer, then parks a waiter; 'close' (EOF / Ctrl-D / SIGINT→close) rejects
// all waiters with WizardEOF so the wizard unwinds while keeping saved items (FM3).
// createRL / ask / WizardEOF는 cli-prompts.mjs가 소유한다 (위저드 IO 단일 관문).

export function setNestedKey(obj, key, value) {
  const parts = key.split('.');
  const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
  if (parts.some(p => forbidden.has(p))) throw new Error(`Invalid config key: ${key}`);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

export function getNestedKey(obj, key) {
  return key.split('.').reduce((o, k) => o?.[k], obj);
}

// Loads cost-engine for role/profile data. Relative path resolves identically
// in both trees (x-build/lib/ and the xm/lib/ bundle); dynamic import avoids a
// static shared-config → cost-engine → config-loader cycle.
function loadCostEngine() {
  return import('./x-build/cost-engine.mjs');
}

/**
 * expandPhaseAssignments — expand "slot=model" phase assignments into
 * model_overrides entries. Pure UX sugar: no new config key.
 * model "default" removes the slot's role keys (back to profile default).
 */
export function expandPhaseAssignments(assignments, phaseGroups, existingOverrides) {
  // 'inherit' = run on the session model (routing sentinel, not a billable
  // tier). Valid here because phase presets expand into model_overrides, whose
  // consumer (getModelForRole) already guards the economy-profile case.
  const MODELS = new Set(['haiku', 'sonnet', 'opus', 'inherit', 'default']);
  const overrides = { ...(existingOverrides || {}) };
  const errors = [];
  for (const a of assignments) {
    const [slot, model] = String(a).split('=').map(s => s?.trim());
    if (!phaseGroups[slot]) {
      errors.push(t('phase.unknown', slot));
      continue;
    }
    if (!MODELS.has(model)) {
      errors.push(t('phase.model_choice', a));
      continue;
    }
    for (const role of phaseGroups[slot]) {
      if (model === 'default') delete overrides[role];
      else overrides[role] = model;
    }
  }
  return { overrides, errors };
}

/**
 * cmdConfig — Interactive and CLI config management.
 *
 * Usage:
 *   cmdConfig([])                    → interactive wizard
 *   cmdConfig(['show'])              → show current config
 *   cmdConfig(['set', key, value])   → set a key
 *   cmdConfig(['get', key])          → get a key
 *   cmdConfig(['phase', ...])        → phase-based model presets (sugar over model_overrides)
 *   cmdConfig(['reset'])             → reset to defaults
 *
 * Flags: --local (project .xm/), --global (~/.xm/)
 * Default scope: global (except budget → local)
 */
// Language override chain is set once per invocation. _flagLang preserves the
// --lang flag so a lang change inside the wizard can re-resolve with the correct
// precedence (flag > env > config > locale) instead of blindly using config.
let _flagLang;

export async function cmdConfig(args = [], flags = {}) {
  _flagLang = flags.lang;
  initLang({ flagLang: flags.lang, configLang: readSharedConfig().lang });

  const sub = args[0];

  if (!sub) return interactiveConfig(flags);
  if (sub === 'show') return showConfig(flags);
  if (sub === 'get' && args[1]) return getConfig(args[1], flags);
  if (sub === 'set' && args[1] != null && args[2] != null) return setConfig(args[1], args[2], flags);
  if (sub === 'phase') return configPhase(args.slice(1), flags);
  if (sub === 'reset') return resetConfig(flags);

  console.log(`${C.red}${t('cmd.unknown', sub)}${C.reset}`);
  console.log(`Usage: config [show|set <key> <value>|get <key>|phase [plan=M implement=M review=M]|reset]`);
}

// Language-aware phase labels. Built per call so the resolved language (set by
// initLang before any render) is reflected. `|| slot` keeps the defensive
// fallback for a hypothetical unknown slot.
function phaseLabels() {
  return {
    plan: t('phase.label.plan'),
    implement: t('phase.label.implement'),
    review: t('phase.label.review'),
  };
}

function printPhaseMatrix(ce, cfg) {
  const profile = ce.resolveProfileName(cfg.model_profile);
  const overrides = cfg.model_overrides || {};
  const PL = phaseLabels();
  console.log(`\n${C.bold}${G.section} ${t('phase.matrix_title')}${C.reset} ${C.dim}(profile: ${profile})${C.reset}\n`);
  for (const [slot, roles] of Object.entries(ce.PHASE_ROLE_GROUPS)) {
    console.log(`  ${C.bold}${PL[slot] || slot}${C.reset}`);
    for (const role of roles) {
      const model = ce.getModelForRole(role, 'medium', cfg);
      const src = overrides[role] ? `${C.yellow}override${C.reset}` : `${C.dim}profile${C.reset}`;
      console.log(`    ${role.padEnd(14)} ${C.cyan}${model.padEnd(7)}${C.reset} ${src}`);
    }
  }
  console.log(`\n  ${C.dim}${t('phase.hint_set')}${C.reset}`);
  console.log(`  ${C.dim}${t('phase.hint_restore')}${C.reset}\n`);
}

function writePhaseAssignments(ce, assignments, scope) {
  const root = resolveSharedRoot(scope);
  const configPath = join(root, 'config.json');
  const existing = readJSON(configPath) ?? {};
  const { overrides, errors } = expandPhaseAssignments(assignments, ce.PHASE_ROLE_GROUPS, existing.model_overrides || {});
  if (errors.length) {
    for (const e of errors) console.log(`${C.red}${e}${C.reset}`);
    process.exitCode = 1;
    return false;
  }
  existing.model_overrides = overrides;
  writeJSONAtomic(configPath, existing);

  const scopeLabel = scope.global ? 'global' : 'local';
  const PL = phaseLabels();
  for (const a of assignments) {
    const [slot, model] = a.split('=').map(s => s.trim());
    const roles = ce.PHASE_ROLE_GROUPS[slot].join(', ');
    const label = model === 'default' ? t('phase.profile_default') : model;
    console.log(`${C.green}${G.ok}${C.reset} ${PL[slot] || slot} → ${C.cyan}${label}${C.reset} ${C.dim}(${roles}) (${scopeLabel})${C.reset}`);
  }
  return true;
}

async function configPhase(assignments, flags) {
  const ce = await loadCostEngine();
  if (!assignments.length) {
    printPhaseMatrix(ce, readSharedConfig(flags.local ? {} : flags));
    return;
  }
  writePhaseAssignments(ce, assignments, resolveScope('model_overrides', flags));
}

function showConfig(flags) {
  const globalCfg = readSharedConfig({ global: true });
  const localPath = join(resolveSharedRoot(), 'config.json');
  const localCfg = readJSON(localPath);

  console.log(`\n${C.bold}${G.section} ${t('common.xm_config')}${C.reset}\n`);

  console.log(`${C.dim}Global (~/.xm/config.json):${C.reset}`);
  const globalPath = join(homedir(), '.xm', 'config.json');
  const rawGlobal = readJSON(globalPath) ?? {};
  if (Object.keys(rawGlobal).length === 0) {
    console.log(`  ${C.dim}${t('show.none_default')}${C.reset}`);
  } else {
    for (const [k, v] of Object.entries(rawGlobal)) {
      console.log(`  ${C.cyan}${k}${C.reset}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }
  }

  console.log(`\n${C.dim}Local (.xm/config.json):${C.reset}`);
  if (!localCfg || Object.keys(localCfg).length === 0) {
    console.log(`  ${C.dim}${t('show.none')}${C.reset}`);
  } else {
    for (const [k, v] of Object.entries(localCfg)) {
      console.log(`  ${C.cyan}${k}${C.reset}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }
  }

  console.log(`\n${C.dim}Effective (merged):${C.reset}`);
  const effective = readSharedConfig();
  for (const [k, v] of Object.entries(effective)) {
    console.log(`  ${C.cyan}${k}${C.reset}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }

  // Cross-vendor provider config lives under the `panel.*` key — the shared multi-
  // vendor provider setup that x-review/op/solver/eval/build all reuse. It is now
  // editable from BOTH `xm panel setup` and the `xm config` wizard's panel category
  // (models/judge delegate to setup; timeout_s/model_overrides are direct writes),
  // so point users at either entry instead of framing it as read-only (PMC-1).
  const hasPanel = effective && effective.panel && typeof effective.panel === 'object'
    && Object.keys(effective.panel).length > 0;
  console.log(`\n${C.dim}Cross-vendor providers${hasPanel ? ' (see panel.* above)' : ''}:${C.reset}`);
  console.log(`  ${C.dim}edit:${C.reset} xm config (panel) 또는 xm panel setup   ${C.dim}·  check (install+auth):${C.reset} xm panel doctor   ${C.dim}·  models:${C.reset} xm panel models <vendor>`);
  console.log('');
}

// Determine which tier supplies the effective value for a key, mirroring the
// shallow merge order of readSharedConfig(): local > global > default. Source is
// decided by the top-level segment because the merge is shallow (a dotted key's
// owner is whichever tier owns its first segment). Only called when the value is
// defined, so the final `default` fallback is always correct.
function resolveValueSource(key) {
  const top = key.split('.')[0];
  const localRaw = readJSON(join(resolveSharedRoot(), 'config.json')) ?? {};
  if (Object.prototype.hasOwnProperty.call(localRaw, top)) return 'local';
  // XM_ROOT collapses the tiers into a single file — there is no global layer.
  if (!process.env.XM_ROOT) {
    const globalRaw = readJSON(join(homedir(), '.xm', 'config.json')) ?? {};
    if (Object.prototype.hasOwnProperty.call(globalRaw, top)) return 'global';
  }
  return 'default';
}

function printGetResult(val, source) {
  if (val === undefined) {
    console.log(`${C.dim}(not set)${C.reset}`);
    return;
  }
  console.log(typeof val === 'object' ? JSON.stringify(val, null, 2) : val);
  // Source annotation goes to stderr so the value on stdout stays machine-parseable
  // (scripts can do `xm config get mode` without stripping a suffix).
  if (source) console.error(`${C.dim}(${source})${C.reset}`);
}

function getConfig(key, flags) {
  // Explicit --global/--local keeps the historical tier-only read (back-compat):
  // print just the value from that layer, no source annotation.
  if (flags.global || flags.local) {
    const config = readSharedConfig(resolveScope(key, flags));
    printGetResult(getNestedKey(config, key), null);
    return;
  }
  // No flag: report the merged effective value — the same read `show` uses for its
  // Effective block — annotated with the tier it resolved from. This fixes the
  // long-standing split where `get mode` read global-only while `show` showed the
  // merged value (a repo with local mode=normal, global mode=developer disagreed).
  const effective = readSharedConfig();
  const val = getNestedKey(effective, key);
  printGetResult(val, val === undefined ? null : resolveValueSource(key));
}

function describeType(value) {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

// Return a human-readable type-mismatch message, or null when the value matches
// the schema entry's declared type. `nullable` entries accept null.
function schemaTypeError(entry, value) {
  if (value === null) {
    return entry.nullable ? null : t('type.null_not_allowed', entry.type);
  }
  const actual = describeType(value);
  switch (entry.type) {
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) return t('type.expected_integer', actual);
      return null;
    case 'number':
      if (typeof value !== 'number') return t('type.expected_number', actual);
      return null;
    case 'boolean':
      if (typeof value !== 'boolean') return t('type.expected_boolean', actual);
      return null;
    case 'string':
      if (typeof value !== 'string') return t('type.expected_string', actual);
      return null;
    case 'array':
      if (!Array.isArray(value)) return t('type.expected_array', actual);
      return null;
    case 'object':
      if (actual !== 'object') return t('type.expected_object', actual);
      return null;
    default:
      return null;
  }
}

// Build one validateSet finding. severity is 'error' for enum/type/min/max/
// vendor-model-spec violations, 'warn' for unregistered keys. CLI callers print
// .message for every finding regardless of severity and still save the value
// (back-compat — a warning never blocks a write). x-dashboard-server (t5) is
// expected to treat severity === 'error' as blocking (422); this is a deliberate
// divergence from the CLI's always-warn-and-save behavior, not an oversight.
function finding(code, severity, message) {
  return { code, severity, message };
}

// Validate a set against the config-schema registry. Returns a list of
// findings ({ code, severity, message }) — never throws, never blocks the write
// (back-compat: unknown/invalid values still save). An empty list means the
// value is clean.
export function validateSet(key, value) {
  const findings = [];
  const entry = getSchemaEntry(key);
  if (!entry) {
    findings.push(finding('unregistered', 'warn', t('validate.unregistered', key)));
    return findings;
  }
  // vendor_models.<vendor>.<tier> — dotted leaf라 exact 스키마가 없어 값 검증이
  // 통째로 건너뛰어졌다(cross-vendor 리뷰 F2). "model[:effort]" 스펙을 set 시점에도
  // parseModelSpec으로 경고한다(FM2 — 소비 시점 경고와 동일 규칙, 저장은 허용).
  const vm = key.match(/^vendor_models\.[^.]+\.([^.]+)$/);
  if (vm) {
    const VENDOR_TIERS = ['haiku', 'sonnet', 'opus'];
    if (!VENDOR_TIERS.includes(vm[1])) {
      findings.push(finding('enum', 'error', t('validate.enum', key, VENDOR_TIERS.join(', '), vm[1])));
    } else if (typeof value !== 'string' || String(value).trim() === '') {
      findings.push(finding('type', 'error', t('validate.type', key, describeType(value))));
    } else {
      const parsed = parseModelSpec(value);
      if (parsed.warning) findings.push(finding('vendor_model_spec', 'error', parsed.warning));
    }
    return findings;
  }

  // panel.* — owned by x-panel but editable via the `xm config` panel category.
  // panel.timeout_s is a registered leaf → falls through to the exact-match checks
  // below (integer + min). panel.model_overrides must be an object. Any other
  // panel.<dotted> key is not a managed leaf, so it keeps the historical
  // unregistered warning (the bare `panel` parent entry alone would suppress it).
  if (key.startsWith('panel.') && key !== 'panel.timeout_s') {
    if (key === 'panel.model_overrides') {
      const actual = describeType(value);
      if (actual !== 'object') findings.push(finding('type', 'error', t('validate.type', key, t('type.expected_object', actual))));
    } else {
      findings.push(finding('unregistered', 'warn', t('validate.unregistered', key)));
    }
    return findings;
  }

  // Enum/type/range checks need an exact key match. A bare parent key (e.g.
  // `budget`) resolves to its first child for scope purposes but carries no value
  // schema of its own, so skip value checks for it.
  const exact = SCHEMA_BY_KEY.get(key);
  if (!exact) return findings;

  if (exact.enum && !exact.enum.includes(value)) {
    findings.push(finding('enum', 'error', t('validate.enum', key, exact.enum.join(', '), value)));
  }
  const typeErr = schemaTypeError(exact, value);
  if (typeErr) findings.push(finding('type', 'error', t('validate.type', key, typeErr)));

  if (typeof value === 'number') {
    if (exact.min !== undefined && value < exact.min) findings.push(finding('min', 'error', t('validate.min', key, exact.min, value)));
    if (exact.max !== undefined && value > exact.max) findings.push(finding('max', 'error', t('validate.max', key, exact.max, value)));
  }
  return findings;
}

// Coerce a raw string arg to its JSON-ish value: JSON objects/arrays, booleans,
// finite numbers, else the string unchanged. Shared by the `set` subcommand and
// the interactive wizard so both parse user input identically.
function coerceValue(rawValue) {
  if (typeof rawValue !== 'string') return rawValue;
  if (rawValue.startsWith('{') || rawValue.startsWith('[')) {
    try { return JSON.parse(rawValue); } catch { return rawValue; }
  }
  if (rawValue === 'true') return true;
  if (rawValue === 'false') return false;
  if (rawValue.trim() !== '' && !isNaN(rawValue) && isFinite(Number(rawValue))) return Number(rawValue);
  return rawValue;
}

function setConfig(key, rawValue, flags) {
  const value = coerceValue(rawValue);

  // Registry validation — warn but do not block (back-compat). Warnings are
  // user-visible on stdout (L6: never silence); exit stays 0 since a warning is
  // not a failure. The CLI shows every finding regardless of severity — only
  // x-dashboard-server (t5) is expected to branch on severity === 'error'.
  for (const w of validateSet(key, value)) {
    console.log(`${C.yellow}⚠${C.reset} ${w.message}`);
  }

  const scope = resolveScope(key, flags);
  const root = resolveSharedRoot(scope);
  const configPath = join(root, 'config.json');
  const existing = readJSON(configPath) ?? {};
  setNestedKey(existing, key, value);
  writeJSONAtomic(configPath, existing);

  const scopeLabel = scope.global ? 'global' : 'local';
  console.log(`${C.green}${G.ok}${C.reset} ${C.cyan}${key}${C.reset} = ${typeof value === 'object' ? JSON.stringify(value) : value} ${C.dim}(${scopeLabel})${C.reset}`);

  // Auto-sync SKILL.md frontmatter when model_profile changes
  if (key === 'model_profile') triggerFrontmatterSync();
}

function resetConfig(flags) {
  const scope = flags.local ? {} : { global: true };
  const root = resolveSharedRoot(scope);
  const configPath = join(root, 'config.json');
  writeJSONAtomic(configPath, {});
  const scopeLabel = scope.global ? 'global' : 'local';
  console.log(`${C.green}${G.ok}${C.reset} ${t('reset.done')} ${C.dim}(${scopeLabel})${C.reset}`);
}

/**
 * Guard the interactive wizard against a non-interactive stdin.
 *
 * The wizard drives readline's question() which never resolves on EOF. Under a
 * piped or redirected stdin (`< /dev/null`, a non-interactive parent) the entry
 * point's top-level `await cmdConfig(...)` is then left unsettled and Node exits
 * with code 13 — a silent failure (L6). This guard converts that into an
 * explicit exit 1 plus a usage message pointing at the non-interactive
 * subcommands (`show` / `get` / `set` / `phase`).
 *
 * Test escape hatch: set env `XM_CONFIG_WIZARD_STDIN=1` to bypass the guard so a
 * test can pipe scripted input (e.g. '0\n' to pick the "나가기/exit" menu item)
 * into the wizard's readline. This flag is for tests only — real non-interactive
 * invocations must get the guard, not a wizard reading from a dead pipe. It is
 * the shared basis for the wizard-stdin scenarios in t4/t5/t9.
 *
 * @returns {boolean} true when the guard fired (caller must not enter the wizard).
 */
function guardNonTTY() {
  if (process.env.XM_CONFIG_WIZARD_STDIN === '1') return false;
  if (process.stdin.isTTY) return false;

  console.log(`\n${C.bold}${G.section} ${t('common.xm_config')}${C.reset} ${C.dim}${t('guard.tty_only')}${C.reset}\n`);
  console.log(`  ${t('guard.use_subcommands')}\n`);
  console.log(`  ${C.cyan}xm config show${C.reset}                                     ${t('guard.desc_show')}`);
  console.log(`  ${C.cyan}xm config get <key>${C.reset}                                ${t('guard.desc_get')}`);
  console.log(`  ${C.cyan}xm config set <key> <value> [--local|--global]${C.reset}     ${t('guard.desc_set')}`);
  console.log(`  ${C.cyan}xm config phase plan=opus${C.reset}                          ${t('guard.desc_phase')}`);
  console.log('');
  return true;
}

// ── Wizard scope engine ─────────────────────────────────────────────────
//
// The wizard writes each item to a user-chosen tier. The schema's scopeForKey()
// supplies the DEFAULT proposal (mirroring resolveScope: only 'local' keys →
// local, everything else → global), but the user may override to global/local per
// item — the old wizard hard-coded { global: true } for every model write, which
// this replaces (DoD: "global 하드코딩 제거").

// True when the top-level segment is present in the project (.xm) config file.
function localHasKey(topKey) {
  const localRaw = readJSON(join(resolveSharedRoot(), 'config.json')) ?? {};
  return Object.prototype.hasOwnProperty.call(localRaw, topKey);
}

// True when the top-level segment is present in the global (~/.xm) config file.
// XM_ROOT collapses the tiers into one file, so there is no distinct global layer.
function globalHasKey(topKey) {
  if (process.env.XM_ROOT) return false;
  const globalRaw = readJSON(join(homedir(), '.xm', 'config.json')) ?? {};
  return Object.prototype.hasOwnProperty.call(globalRaw, topKey);
}

// Render "<effective value> (<source tier>)" for a key, reusing t2's
// resolveValueSource. Undefined → "(미설정)".
function describeEffective(key) {
  const eff = getNestedKey(readSharedConfig(), key);
  if (eff === undefined) return `${C.dim}${t('common.unset')}${C.reset}`;
  const src = resolveValueSource(key);
  const shown = eff === null ? 'null' : (typeof eff === 'object' ? JSON.stringify(eff) : eff);
  return `${C.cyan}${shown}${C.reset} ${C.dim}(${src})${C.reset}`;
}

// Ask which tier to write. Proposes the schema scope; accepts 1=global, 2=local,
// Enter=proposed. Returns { global: boolean } consumed by resolveSharedRoot().
async function chooseScope(rl, key) {
  const proposedGlobal = scopeForKey(key) !== 'local';
  const proposedLabel = proposedGlobal ? 'global' : 'local';
  if (isRawCapable()) {
    const ch = await menuSelect(rl, {
      title: t('scope.choose_title', key),
      options: [
        { key: '1', label: 'global', hint: '~/.xm/config.json' },
        { key: '2', label: 'local', hint: t('scope.local_hint') },
      ],
      initialKey: proposedGlobal ? '1' : '2',
      backKey: proposedGlobal ? '1' : '2',
    });
    return { global: ch !== '2' };
  }
  const ans = (await ask(rl, t('scope.line_prompt', proposedLabel))).trim();
  if (ans === '1') return { global: true };
  if (ans === '2') return { global: false };
  if (ans !== '') console.log(`  ${C.dim}${t('scope.using_proposed', proposedLabel)}${C.reset}`);
  return { global: proposedGlobal };
}

// Warn (before writing) when the chosen tier will NOT reach the effective value —
// i.e. writing to global while local shadows the same top-level key. Returns true
// to proceed, false to cancel. Writing to local always takes effect (local wins),
// so that path only prints an informational note (FM4 override warning engine).
async function confirmShadow(rl, key, scope) {
  const top = key.split('.')[0];
  if (scope.global && localHasKey(top)) {
    console.log(`  ${C.yellow}⚠${C.reset} ${t('shadow.local_override', top)}`);
    const cont = (await ask(rl, t('shadow.confirm_global'))).trim().toLowerCase();
    if (cont !== 'y' && cont !== 'yes') {
      console.log(`  ${C.dim}${t('common.cancelled_nosave')}${C.reset}`);
      return false;
    }
  } else if (!scope.global && globalHasKey(top)) {
    console.log(`  ${C.dim}${G.rail} ${t('shadow.local_wins', top)}${C.reset}`);
  }
  return true;
}

// Persist one key to the chosen tier: choose scope → show target path → shadow
// warning → write → echo path → record for the exit summary (FM3 item-level save).
// Returns true when written, false when cancelled.
async function saveKey(rl, session, key, value) {
  const scope = await chooseScope(rl, key);
  const scopeLabel = scope.global ? 'global' : 'local';
  const targetPath = join(resolveSharedRoot(scope), 'config.json');
  console.log(`  ${C.dim}${t('common.save_target', targetPath, scopeLabel)}${C.reset}`);

  if (!(await confirmShadow(rl, key, scope))) return false;

  const existing = readJSON(targetPath) ?? {};
  setNestedKey(existing, key, value);
  writeJSONAtomic(targetPath, existing);
  const shown = typeof value === 'object' ? JSON.stringify(value) : value;
  console.log(`  ${C.green}${G.ok}${C.reset} ${C.cyan}${key}${C.reset} = ${shown} ${C.dim}(${scopeLabel}) → ${targetPath}${C.reset}`);
  session.saved.push({ key, value, scope: scopeLabel, path: targetPath });

  if (key === 'model_profile') triggerFrontmatterSync();
  return true;
}

// Prompt for a scalar value validated against the config-schema entry. Enum keys
// render numbered options (accepting the number or the literal); numeric keys show
// their range. Invalid input replays validateSet's allowed-value/type message and
// re-asks; after 3 failures the item is cancelled (FM4). Enter keeps the current
// value. Returns { value } or { cancelled: true }.
async function promptSchemaValue(rl, key) {
  const entry = SCHEMA_BY_KEY.get(key);

  // raw TTY: enum 키는 화살표 select (현재값이 초기 하이라이트, '0'=유지)
  if (entry?.enum && isRawCapable()) {
    const effective = getNestedKey(readSharedConfig(), key);
    const ch = await menuSelect(rl, {
      title: `${key}`,
      header: [`${t('common.current')} ${describeEffective(key)}`],
      options: [
        ...entry.enum.map((v, i) => ({ key: String(i + 1), label: v })),
        { key: '0', label: t('common.keep_current') },
      ],
      initialKey: (() => {
        const i = entry.enum.indexOf(effective);
        return i === -1 ? '1' : String(i + 1);
      })(),
    });
    if (ch === '0' || ch === '') return { cancelled: true };
    const value = coerceValue(entry.enum[Number(ch) - 1] ?? ch);
    const errs = validateSet(key, value);
    if (errs.length === 0) return { value };
    for (const e of errs) console.log(`  ${C.red}${G.warn} ${e.message}${C.reset}`);
    return { cancelled: true };
  }

  console.log(`  ${t('common.current')} ${describeEffective(key)}`);

  let promptText;
  let enumMap = null;
  if (entry?.enum) {
    enumMap = {};
    entry.enum.forEach((v, i) => { enumMap[String(i + 1)] = v; });
    const opts = entry.enum.map((v, i) => `${i + 1}) ${v}`).join('  ');
    promptText = t('prompt.select_enum', opts);
  } else if (entry?.type === 'integer' || entry?.type === 'number') {
    const range = [
      entry.min !== undefined ? `≥${entry.min}` : null,
      entry.max !== undefined ? `≤${entry.max}` : null,
    ].filter(Boolean).join(' ');
    promptText = t('prompt.enter_value_suffix', range ? ` (${range})` : '');
  } else {
    promptText = t('prompt.enter_value_suffix', '');
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw = (await ask(rl, promptText)).trim();
    if (raw === '') return { cancelled: true };
    const candidate = enumMap && enumMap[raw] ? enumMap[raw] : raw;
    const value = coerceValue(candidate);
    const errs = validateSet(key, value);
    if (errs.length === 0) return { value };
    for (const e of errs) console.log(`  ${C.red}⚠ ${e.message}${C.reset}`);
    if (attempt < 3) console.log(`  ${C.dim}${t('common.retry_check_allowed', attempt)}${C.reset}`);
  }
  console.log(`  ${C.yellow}${t('common.max_attempts')}${C.reset}`);
  return { cancelled: true };
}

// ── Wizard categories ───────────────────────────────────────────────────

async function categoryModel(rl, session) {
  while (true) {
    const cfg = readSharedConfig();
    const ch = await menuSelect(rl, {
      title: t('cat.model.title'),
      options: [
        { key: '1', label: t('cat.model.profile'), hint: `${t('common.current')} ${describeEffective('model_profile')}` },
        { key: '2', label: t('cat.model.overrides'), hint: `${t('common.current')} ${describeOverrides(cfg)}` },
        { key: '3', label: t('cat.model.phase') },
        { key: '4', label: t('menu.vendor'), hint: `${t('common.current')} ${describeVendorModels(cfg)}` },
        { key: '0', label: t('common.back') },
      ],
    });
    if (ch === '0' || ch === '') return;
    if (ch === '1') await editProfile(rl, session);
    else if (ch === '2') await editOverrides(rl, session);
    else if (ch === '3') await editPhaseModels(rl, session);
    else if (ch === '4') await categoryVendor(rl, session);
    else console.log(`  ${C.dim}${t('common.enter_range', '0-4')}${C.reset}`);
  }
}

function describeOverrides(cfg) {
  const o = cfg.model_overrides || {};
  const n = Object.keys(o).length;
  if (n === 0) return `${C.dim}${t('common.none')}${C.reset}`;
  return `${C.cyan}${t('count.roles', n)}${C.reset} ${C.dim}(${resolveValueSource('model_overrides')})${C.reset}`;
}

// Count of user tier→model overrides across every vendor (builtin defaults are NOT
// counted — they live in cost-engine's VENDOR_MODELS, not the config).
function describeVendorModels(cfg) {
  const vm = (cfg.vendor_models && typeof cfg.vendor_models === 'object') ? cfg.vendor_models : {};
  let n = 0;
  for (const v of Object.keys(vm)) {
    if (vm[v] && typeof vm[v] === 'object') n += Object.keys(vm[v]).length;
  }
  if (n === 0) return `${C.dim}${t('common.none')}${C.reset}`;
  return `${C.cyan}${t('count.items', n)}${C.reset} ${C.dim}(${resolveValueSource('vendor_models')})${C.reset}`;
}

async function editProfile(rl, session) {
  const r = await promptSchemaValue(rl, 'model_profile');
  if (r.cancelled) { console.log(`  ${C.dim}${t('common.no_change')}${C.reset}`); return; }
  await saveKey(rl, session, 'model_profile', r.value);
}

async function editOverrides(rl, session) {
  const ce = await loadCostEngine();
  const roles = Object.keys(ce.MODEL_PROFILES.default);
  const models = ['haiku', 'sonnet', 'opus', 'inherit'];
  const current = readSharedConfig().model_overrides || {};

  console.log(`\n  ${t('overrides.header')}\n`);
  for (const role of roles) {
    const o = current[role];
    console.log(`    ${role.padEnd(14)} ${o ? `${C.yellow}${o}${C.reset}` : `${C.dim}${t('overrides.profile_default_paren')}${C.reset}`}`);
  }
  console.log(`\n  ${t('overrides.format')}\n`);

  const scope = await chooseScope(rl, 'model_overrides');
  const scopeLabel = scope.global ? 'global' : 'local';
  const targetPath = join(resolveSharedRoot(scope), 'config.json');
  console.log(`  ${C.dim}${t('common.save_target', targetPath, scopeLabel)}${C.reset}`);
  if (!(await confirmShadow(rl, 'model_overrides', scope))) return;

  let changed = false;
  while (true) {
    const input = (await ask(rl, '  > ')).trim();
    if (!input) break;
    if (input === 'clear') {
      const existing = readJSON(targetPath) ?? {};
      existing.model_overrides = {};
      writeJSONAtomic(targetPath, existing);
      console.log(`  ${C.green}${G.ok}${C.reset} ${t('overrides.cleared')} ${C.dim}(${scopeLabel}) → ${targetPath}${C.reset}`);
      session.saved.push({ key: 'model_overrides', value: {}, scope: scopeLabel, path: targetPath });
      changed = true;
      continue;
    }
    const [role, model] = input.split('=').map(s => s?.trim());
    if (!roles.includes(role)) { console.log(`  ${C.red}${t('overrides.unknown_role', role)}${C.reset}`); continue; }
    if (!models.includes(model)) { console.log(`  ${C.red}${t('overrides.model_choice')}${C.reset}`); continue; }
    const existing = readJSON(targetPath) ?? {};
    existing.model_overrides = { ...(existing.model_overrides || {}), [role]: model };
    writeJSONAtomic(targetPath, existing);
    console.log(`  ${C.green}${G.ok}${C.reset} ${role} → ${C.cyan}${model}${C.reset} ${C.dim}(${scopeLabel})${C.reset}`);
    session.saved.push({ key: `model_overrides.${role}`, value: model, scope: scopeLabel, path: targetPath });
    changed = true;
  }
  if (!changed) console.log(`  ${C.dim}${t('common.no_change')}${C.reset}`);
}

async function editPhaseModels(rl, session) {
  const ce = await loadCostEngine();
  printPhaseMatrix(ce, readSharedConfig());
  // The phase prompt is a GROUP bulk-set; single-role edits live in the
  // overrides editor — say so up front, or users assume per-role control here.
  console.log(`  ${C.dim}${t('phase.per_role_hint')}${C.reset}\n`);

  const SHORT_LABELS = {
    plan: t('phase.short.plan'),
    implement: t('phase.short.implement'),
    review: t('phase.short.review'),
  };
  const choices = { '1': 'default', '2': 'haiku', '3': 'sonnet', '4': 'opus', '5': 'inherit' };
  const assignments = [];
  for (const slot of Object.keys(ce.PHASE_ROLE_GROUPS)) {
    // Show exactly which roles this one answer overwrites (their current
    // values can differ — e.g. implement = opus/inherit/sonnet/inherit).
    console.log(`${C.dim}${t('phase.slot_roles', ce.PHASE_ROLE_GROUPS[slot].join(' · '))}${C.reset}`);
    const input = (await ask(rl, t('phase.model_prompt', SHORT_LABELS[slot]))).trim();
    if (!input) continue;
    const model = choices[input];
    if (!model) { console.log(`  ${C.red}${t('phase.enter_1_4')}${C.reset}`); continue; }
    assignments.push(`${slot}=${model}`);
  }
  if (!assignments.length) { console.log(`  ${C.dim}${t('common.no_change')}${C.reset}`); return; }

  // Phase presets expand into model_overrides — pick scope like any override.
  const scope = await chooseScope(rl, 'model_overrides');
  const scopeLabel = scope.global ? 'global' : 'local';
  const targetPath = join(resolveSharedRoot(scope), 'config.json');
  console.log(`  ${C.dim}${t('common.save_target', targetPath, scopeLabel)}${C.reset}`);
  if (!(await confirmShadow(rl, 'model_overrides', scope))) return;

  if (writePhaseAssignments(ce, assignments, scope)) {
    session.saved.push({ key: 'model_overrides (phase)', value: assignments.join(' '), scope: scopeLabel, path: targetPath });
  }
}

// ── Vendor model mapping category (t4) ──────────────────────────────────
//
// Adds a vendor (harness) tier→model override editor to the model category. The
// builtin tier→model table (claude/codex) is OWNED by cost-engine's VENDOR_MODELS;
// this edits only USER overrides under vendor_models.<vendor>.<tier>, which
// resolveVendorModel layers on top. Install detection reuses x-panel's isAvailable
// via a dual-path dynamic import (bundle + source), mirroring x-dashboard-server's
// getPanelEngine. When adapters can't be loaded, detection degrades to 'unknown'
// (never a silent skip — the row still renders and stays editable).

// Dual-path import of x-panel adapters for cheap PATH-based install detection.
// Resolves across the bundle (xm/lib/x-panel/) and the source tree
// (x-panel/lib/x-panel/). Returns the module, or null when neither candidate loads
// — the caller then treats detection as unavailable rather than crashing.
async function loadPanelAdapters() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'x-panel', 'adapters.mjs'),                                // xm bundle: xm/lib/x-panel/adapters.mjs
    join(here, '..', '..', 'x-panel', 'lib', 'x-panel', 'adapters.mjs'),  // source: x-build/lib → x-panel/lib/x-panel/adapters.mjs
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try { return await import(p); } catch { /* try next candidate */ }
    }
  }
  return null;
}

// Detect install state for each vendor via isAvailable (a light `command -v` PATH
// check — NOT checkAuth, which spawns an auth-status subprocess and is slow).
// Returns vendor→('detected'|'not_detected'|'unknown'); 'unknown' means the
// adapters module couldn't be imported so detection is unavailable for that run.
async function detectVendors(vendors) {
  const adapters = await loadPanelAdapters();
  const state = {};
  for (const v of vendors) {
    if (!adapters || typeof adapters.isAvailable !== 'function') { state[v] = 'unknown'; continue; }
    try { state[v] = adapters.isAvailable(v) ? 'detected' : 'not_detected'; }
    catch { state[v] = 'unknown'; }
  }
  return state;
}

// Detection status line for a vendor. 'unknown' reuses the not_detected message
// (no dedicated "감지 불가" key exists in cli-messages); the row stays editable
// regardless — detection only annotates, it never gates.
function vendorDetectHint(vendor, status) {
  return status === 'detected'
    ? `${G.ok} ${t('vendor.detected', vendor)}`
    : t('vendor.not_detected', vendor);
}

// Effective tier→model for a vendor with its source ('vendor.user_mapping' when a
// config override wins, otherwise 'vendor.using_builtin'). Reuses cost-engine's
// resolveVendorModel so the wizard never re-implements the priority chain.
function vendorTierHint(ce, tier, vendor, cfg) {
  const r = ce.resolveVendorModel(tier, vendor, cfg);
  const srcLabel = r.source === 'config' ? t('vendor.user_mapping') : t('vendor.using_builtin');
  const spec = r.spec ?? t('common.none');
  return `${spec} · ${srcLabel}`;
}

// Prompt for a "model[:effort]" spec, validated via parseModelSpec. An unknown
// effort suffix warns with vendor.effort_unknown and RE-asks (the mapping is not
// saved with a bad effort); 3 failures cancel the item (FM4). Enter keeps the
// current value; 'clear' removes the override. Returns { value } | { clear:true } |
// { cancelled:true }. The valid spec is stored verbatim (effort suffix included).
async function promptVendorSpec(rl, ce, vendor, tier, cfg) {
  console.log(`  ${t('common.current')} ${C.cyan}${vendorTierHint(ce, tier, vendor, cfg)}${C.reset}`);
  const levels = ce.MODEL_EFFORT_LEVELS.join(', ');
  console.log(`  ${C.dim}${t('vendor.format')}${t('vendor.effort_hint', levels)}${C.reset}`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw = (await ask(rl, t('prompt.enter_value_suffix', ''))).trim();
    if (raw === '') return { cancelled: true };
    if (raw.toLowerCase() === 'clear') return { clear: true };
    const parsed = ce.parseModelSpec(raw);
    if (parsed.warning) {
      const colonIdx = raw.lastIndexOf(':');
      const effortCand = colonIdx >= 0 ? raw.slice(colonIdx + 1) : '';
      if (parsed.model !== null && effortCand && !ce.MODEL_EFFORT_LEVELS.includes(effortCand)) {
        console.log(`  ${C.red}⚠ ${t('vendor.effort_unknown', effortCand, levels)}${C.reset}`);
      } else {
        console.log(`  ${C.red}⚠ ${parsed.warning}${C.reset}`);
      }
      if (attempt < 3) console.log(`  ${C.dim}${t('common.retry_check_allowed', attempt)}${C.reset}`);
      continue;
    }
    return { value: raw };
  }
  console.log(`  ${C.yellow}${t('common.max_attempts')}${C.reset}`);
  return { cancelled: true };
}

// Remove a single vendor_models.<vendor>.<tier> override from a chosen tier. Prunes
// an emptied vendor sub-object so the config never accumulates `{ codex: {} }`.
async function clearVendorKey(rl, session, vendor, tier) {
  const key = `vendor_models.${vendor}.${tier}`;
  const scope = await chooseScope(rl, 'vendor_models');
  const scopeLabel = scope.global ? 'global' : 'local';
  const targetPath = join(resolveSharedRoot(scope), 'config.json');
  console.log(`  ${C.dim}${t('common.save_target', targetPath, scopeLabel)}${C.reset}`);

  const existing = readJSON(targetPath) ?? {};
  const vm = existing.vendor_models;
  if (vm && vm[vendor] && Object.prototype.hasOwnProperty.call(vm[vendor], tier)) {
    delete vm[vendor][tier];
    if (Object.keys(vm[vendor]).length === 0) delete vm[vendor];
    writeJSONAtomic(targetPath, existing);
    console.log(`  ${C.green}${G.ok}${C.reset} ${t('vendor.cleared')} ${C.dim}${key} (${scopeLabel}) → ${targetPath}${C.reset}`);
    session.saved.push({ key, value: t('common.deleted_marker'), scope: scopeLabel, path: targetPath });
  } else {
    console.log(`  ${C.dim}${t('common.no_change')}${C.reset}`);
  }
}

// Per-vendor tier editor (while-loop): pick a tier (haiku/sonnet/opus, shown with
// their light/standard/max display labels + effective spec/source), then enter a
// "model[:effort]" spec (saved via the shared scope engine) or 'clear' to remove it.
async function editVendorTiers(rl, session, ce, vendor, detectStatus) {
  const TIERS = ['haiku', 'sonnet', 'opus'];
  while (true) {
    const cfg = readSharedConfig();
    const ch = await menuSelect(rl, {
      title: t('cat.vendor.title'),
      header: [`${vendor} — ${vendorDetectHint(vendor, detectStatus)}`],
      options: [
        ...TIERS.map((tier, i) => ({
          key: String(i + 1),
          label: t(`vendor.tier.${tier}`),
          hint: vendorTierHint(ce, tier, vendor, cfg),
        })),
        { key: '0', label: t('common.back') },
      ],
    });
    if (ch === '0' || ch === '') return;
    const tier = TIERS[Number(ch) - 1];
    if (!tier) { console.log(`  ${C.dim}${t('common.enter_range', '0-3')}${C.reset}`); continue; }
    const r = await promptVendorSpec(rl, ce, vendor, tier, cfg);
    if (r.cancelled) { console.log(`  ${C.dim}${t('common.no_change')}${C.reset}`); continue; }
    if (r.clear) { await clearVendorKey(rl, session, vendor, tier); continue; }
    await saveKey(rl, session, `vendor_models.${vendor}.${tier}`, r.value);
  }
}

// One-line summary of vendor_profiles for the category menu: count + source tier.
function describeVendorProfiles(cfg) {
  const vp = (cfg.vendor_profiles && typeof cfg.vendor_profiles === 'object') ? cfg.vendor_profiles : {};
  const n = Object.keys(vp).length;
  if (n === 0) return `${C.dim}${t('common.none')}${C.reset}`;
  return `${C.cyan}${t('count.items', n)}${C.reset} ${C.dim}(${resolveValueSource('vendor_profiles')})${C.reset}`;
}

// Row-by-row editor for vendor_profiles ({ vendor: economy|default|max }). Scope is
// chosen once (like editOverrides), then each line sets `vendor=profile` or deletes
// with `del <vendor>`; an unset vendor inherits model_profile.
async function editVendorProfiles(rl, session) {
  const key = 'vendor_profiles';
  const PROFILES = ['economy', 'default', 'max'];
  const current = getNestedKey(readSharedConfig(), key) || {};
  console.log(`\n  ${t('vendor.profile_header')}`);
  console.log(`  ${C.dim}${t('vendor.profile_inherit')}${C.reset}`);
  const names = Object.keys(current);
  if (names.length === 0) console.log(`    ${C.dim}${t('common.none')}${C.reset}`);
  else for (const v of names) console.log(`    ${v.padEnd(16)} ${C.cyan}${current[v]}${C.reset}`);
  console.log(`\n  ${t('vendor.profile_format')}\n`);

  const scope = await chooseScope(rl, key);
  const scopeLabel = scope.global ? 'global' : 'local';
  const targetPath = join(resolveSharedRoot(scope), 'config.json');
  console.log(`  ${C.dim}${t('common.save_target', targetPath, scopeLabel)}${C.reset}`);
  if (!(await confirmShadow(rl, key, scope))) return;

  let changed = false;
  while (true) {
    const input = (await ask(rl, '  > ')).trim();
    if (!input) break;
    const existing = readJSON(targetPath) ?? {};
    const profiles = { ...(getNestedKey(existing, key) || {}) };
    if (input.startsWith('del ')) {
      const name = input.slice(4).trim();
      if (!(name in profiles)) { console.log(`  ${C.red}${t('budget.no_such_project', name)}${C.reset}`); continue; }
      delete profiles[name];
      setNestedKey(existing, key, profiles);
      writeJSONAtomic(targetPath, existing);
      console.log(`  ${C.green}${G.ok}${C.reset} ${t('budget.deleted', name)} ${C.dim}(${scopeLabel})${C.reset}`);
      session.saved.push({ key: `${key}.${name}`, value: t('common.deleted_marker'), scope: scopeLabel, path: targetPath });
      changed = true;
      continue;
    }
    const [name, prof] = input.split('=').map(s => s?.trim());
    if (!name || !PROFILES.includes(prof)) { console.log(`  ${C.red}${t('vendor.profile_format')}${C.reset}`); continue; }
    profiles[name] = prof;
    setNestedKey(existing, key, profiles);
    writeJSONAtomic(targetPath, existing);
    console.log(`  ${C.green}${G.ok}${C.reset} ${name} → ${C.cyan}${prof}${C.reset} ${C.dim}(${scopeLabel})${C.reset}`);
    session.saved.push({ key: `${key}.${name}`, value: prof, scope: scopeLabel, path: targetPath });
    changed = true;
  }
  if (!changed) console.log(`  ${C.dim}${t('common.no_change')}${C.reset}`);
}

// Vendor mapping category (while-loop menu). Install detection runs once on entry
// (state can't change mid-session), then each render lists vendors with their
// detection hint. Selecting a vendor opens its tier editor; the last row edits
// per-vendor profiles.
async function categoryVendor(rl, session) {
  const ce = await loadCostEngine();
  const vendors = Object.keys(ce.VENDOR_MODELS);
  const detected = await detectVendors(vendors);
  const profileKey = String(vendors.length + 1);
  while (true) {
    const cfg = readSharedConfig();
    console.log(`\n  ${t('vendor.header')}`);
    const ch = await menuSelect(rl, {
      title: t('cat.vendor.title'),
      options: [
        ...vendors.map((v, i) => ({
          key: String(i + 1),
          label: v,
          hint: vendorDetectHint(v, detected[v]),
        })),
        { key: profileKey, label: t('vendor.profile_header'), hint: describeVendorProfiles(cfg) },
        { key: '0', label: t('common.back') },
      ],
    });
    if (ch === '0' || ch === '') return;
    if (ch === profileKey) { await editVendorProfiles(rl, session); continue; }
    const idx = Number(ch);
    if (Number.isInteger(idx) && idx >= 1 && idx <= vendors.length) {
      await editVendorTiers(rl, session, ce, vendors[idx - 1], detected[vendors[idx - 1]]);
    } else {
      console.log(`  ${C.dim}${t('common.enter_range', `0-${profileKey}`)}${C.reset}`);
    }
  }
}

async function categoryExecution(rl, session) {
  section(t('cat.exec.title'));
  const r = await promptSchemaValue(rl, 'agent_max_count');
  if (r.cancelled) { console.log(`  ${C.dim}${t('common.no_change')}${C.reset}`); return; }
  await saveKey(rl, session, 'agent_max_count', r.value);
}

// ── Budget category (local-default 2-tier) ──────────────────────────────
//
// budget.* keys are scope 'local' in config-schema, so chooseScope proposes local
// (Enter=local) and saveKey lands them in the project .xm by default. max_usd and
// window_hours reuse the shared saveKey/chooseScope/confirmShadow engine; projects
// is an object edited row-by-row like editOverrides.

// One-line summary of budget.projects for the category menu: a count + source tier.
function describeBudgetProjects() {
  const p = getNestedKey(readSharedConfig(), 'budget.projects') || {};
  const n = Object.keys(p).length;
  if (n === 0) return `${C.dim}${t('common.none')}${C.reset}`;
  return `${C.cyan}${t('count.projects', n)}${C.reset} ${C.dim}(${resolveValueSource('budget.projects')})${C.reset}`;
}

// Prompt for a nullable numeric budget value. Enter keeps current; 'null' (and,
// when zeroUnlimited, a literal 0) clears to null (unlimited). Non-numeric input
// replays guidance and re-asks; 3 failures cancel the item (FM4). Returns { value }
// (value may be null) or { cancelled: true }.
async function promptBudgetNumber(rl, key, { zeroUnlimited = false } = {}) {
  console.log(`  ${t('common.current')} ${describeEffective(key)}`);
  const hint = zeroUnlimited ? t('budget.hint_zero_unlimited') : t('budget.hint_null_unset');
  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw = (await ask(rl, t('prompt.enter_value_suffix', hint))).trim();
    if (raw === '') return { cancelled: true };
    if (raw.toLowerCase() === 'null') return { value: null };
    const num = coerceValue(raw);
    if (typeof num !== 'number') {
      console.log(`  ${C.red}⚠ ${t('budget.enter_num_or_null')}${C.reset}`);
      if (attempt < 3) console.log(`  ${C.dim}${t('common.retry_generic', attempt)}${C.reset}`);
      continue;
    }
    if (zeroUnlimited && num === 0) return { value: null };
    const errs = validateSet(key, num);
    if (errs.length === 0) return { value: num };
    for (const e of errs) console.log(`  ${C.red}⚠ ${e.message}${C.reset}`);
    if (attempt < 3) console.log(`  ${C.dim}${t('common.retry_check_allowed', attempt)}${C.reset}`);
  }
  console.log(`  ${C.yellow}${t('common.max_attempts')}${C.reset}`);
  return { cancelled: true };
}

// Row-by-row editor for budget.projects ({ project: { max_usd } }). Scope is chosen
// once (like editOverrides), then a loop adds/updates (`name=max_usd`) or deletes
// (`del <name>`) one project per line, each written per-key so siblings survive.
async function editBudgetProjects(rl, session) {
  const key = 'budget.projects';
  const current = getNestedKey(readSharedConfig(), key) || {};
  console.log(`\n  ${t('budget.projects_header')}\n`);
  const names = Object.keys(current);
  if (names.length === 0) console.log(`    ${C.dim}${t('common.none')}${C.reset}`);
  else for (const p of names) console.log(`    ${p.padEnd(20)} ${C.cyan}${current[p]?.max_usd ?? '?'}${C.reset} USD`);
  console.log(`\n  ${t('budget.projects_format')}\n`);

  const scope = await chooseScope(rl, key);
  const scopeLabel = scope.global ? 'global' : 'local';
  const targetPath = join(resolveSharedRoot(scope), 'config.json');
  console.log(`  ${C.dim}${t('common.save_target', targetPath, scopeLabel)}${C.reset}`);
  if (!(await confirmShadow(rl, key, scope))) return;

  let changed = false;
  while (true) {
    const input = (await ask(rl, '  > ')).trim();
    if (!input) break;
    const existing = readJSON(targetPath) ?? {};
    const projects = { ...(getNestedKey(existing, key) || {}) };
    if (input.startsWith('del ')) {
      const name = input.slice(4).trim();
      if (!(name in projects)) { console.log(`  ${C.red}${t('budget.no_such_project', name)}${C.reset}`); continue; }
      delete projects[name];
      setNestedKey(existing, key, projects);
      writeJSONAtomic(targetPath, existing);
      console.log(`  ${C.green}${G.ok}${C.reset} ${t('budget.deleted', name)} ${C.dim}(${scopeLabel})${C.reset}`);
      session.saved.push({ key: `${key}.${name}`, value: t('common.deleted_marker'), scope: scopeLabel, path: targetPath });
      changed = true;
      continue;
    }
    const [name, rawMax] = input.split('=').map(s => s?.trim());
    if (!name || rawMax == null || rawMax === '') { console.log(`  ${C.red}${t('budget.projects_format_short')}${C.reset}`); continue; }
    const max = coerceValue(rawMax);
    if (typeof max !== 'number' || max < 0) { console.log(`  ${C.red}${t('budget.max_usd_nonneg')}${C.reset}`); continue; }
    projects[name] = { max_usd: max };
    setNestedKey(existing, key, projects);
    writeJSONAtomic(targetPath, existing);
    console.log(`  ${C.green}${G.ok}${C.reset} ${name} → ${C.cyan}${max}${C.reset} USD ${C.dim}(${scopeLabel})${C.reset}`);
    session.saved.push({ key: `${key}.${name}`, value: { max_usd: max }, scope: scopeLabel, path: targetPath });
    changed = true;
  }
  if (!changed) console.log(`  ${C.dim}${t('common.no_change')}${C.reset}`);
}

async function categoryBudget(rl, session) {
  while (true) {
    const ch = await menuSelect(rl, {
      title: t('cat.budget.title'),
      options: [
        { key: '1', label: t('cat.budget.max_usd'), hint: `${t('common.current')} ${describeEffective('budget.max_usd')}` },
        { key: '2', label: t('cat.budget.window'), hint: `${t('common.current')} ${describeEffective('budget.window_hours')}` },
        { key: '3', label: t('cat.budget.projects'), hint: `${t('common.current')} ${describeBudgetProjects()}` },
        { key: '0', label: t('common.back') },
      ],
    });
    if (ch === '0' || ch === '') return;
    if (ch === '1') {
      const r = await promptBudgetNumber(rl, 'budget.max_usd', { zeroUnlimited: true });
      if (r.cancelled) { console.log(`  ${C.dim}${t('common.no_change')}${C.reset}`); continue; }
      await saveKey(rl, session, 'budget.max_usd', r.value);
    } else if (ch === '2') {
      const r = await promptBudgetNumber(rl, 'budget.window_hours');
      if (r.cancelled) { console.log(`  ${C.dim}${t('common.no_change')}${C.reset}`); continue; }
      await saveKey(rl, session, 'budget.window_hours', r.value);
    } else if (ch === '3') {
      await editBudgetProjects(rl, session);
    } else {
      console.log(`  ${C.dim}${t('common.enter_range', '0-3')}${C.reset}`);
    }
  }
}

// ── Gates category (global-default enum) ────────────────────────────────
//
// The five phase-exit gates are enum keys (auto / human-verify / quality) with
// scope 'global'. Each reuses promptSchemaValue (numbered enum) + saveKey, so the
// current value + source tier is shown before the edit and the scope is chosen per
// item like every other scalar.
const GATE_KEYS = ['research-exit', 'plan-exit', 'execute-exit', 'verify-exit', 'close-exit'];

async function categoryGates(rl, session) {
  while (true) {
    const ch = await menuSelect(rl, {
      title: t('cat.gates.title'),
      options: [
        ...GATE_KEYS.map((g, i) => ({
          key: String(i + 1), label: g, hint: `${t('common.current')} ${describeEffective(`gates.${g}`)}`,
        })),
        { key: '0', label: t('common.back') },
      ],
    });
    if (ch === '0' || ch === '') return;
    const idx = Number(ch);
    if (Number.isInteger(idx) && idx >= 1 && idx <= GATE_KEYS.length) {
      const key = `gates.${GATE_KEYS[idx - 1]}`;
      const r = await promptSchemaValue(rl, key);
      if (r.cancelled) { console.log(`  ${C.dim}${t('common.no_change')}${C.reset}`); continue; }
      await saveKey(rl, session, key, r.value);
    } else {
      console.log(`  ${C.dim}${t('common.enter_range', `0-${GATE_KEYS.length}`)}${C.reset}`);
    }
  }
}
// ── Worktree category (build-local > shared > global > defaults 3-tier) ───
//
// The worktree.* keys resolve through worktree-shared.mjs's loadWorktreeConfig
// (build-local `.xm/build/config.json` > shared `.xm/config.json` > global
// `~/.xm/config.json` > WORKTREE_CONFIG_DEFAULTS). The wizard REUSES that resolver
// for every effective value (never re-implements the merge). worktree-shared.mjs
// statically imports readSharedConfig from THIS file, so a static import back would
// be a cycle — the resolver is pulled in via dynamic import() at call time instead
// (same pattern as loadCostEngine), matching the module's DAG invariant.

// Scalar keys editable in the wizard, in config-schema order. gate_policy is edited
// through its own submenu (per-key severity lists), so it is excluded here.
const WORKTREE_SCALAR_KEYS = [
  'enabled', 'base', 'branch_prefix', 'max_parallel', 'gate', 'gate_phase',
  'preflight', 'cleanup', 'gate_lock_backoff_ms', 'review_integration_max_bytes',
];

// gate_phase's config-schema enum is stale (before/after only). The RUNTIME
// consumer — gate-panel.mjs VALID_PHASES — also accepts 'release', so the wizard
// offers all three and validates against this list, not the schema enum.
const WORKTREE_GATE_PHASES = ['before', 'after', 'release'];

const GATE_POLICY_SEVERITY_KEYS = ['block_confirmed', 'block_unreviewed', 'block_contested'];
const SEVERITY_VALUES = ['critical', 'high', 'medium', 'low'];
const SEV_SHORT = { critical: 'C', high: 'H', medium: 'M', low: 'L' };

async function loadWorktreeResolver() {
  return import('./x-build/worktree-shared.mjs');
}

// Raw `worktree` sub-object from a single tier file (no defaults, no merge).
function readWorktreeSub(path) {
  const raw = readJSON(path) ?? {};
  return (raw.worktree && typeof raw.worktree === 'object') ? raw.worktree : {};
}

// Resolve the three tier files' paths + raw values, the resolver's effective
// merge, and enough provenance to annotate each value's source tier. Under
// XM_ROOT the global layer collapses into the shared file (the historical
// convention shared with resolveValueSource/globalHasKey), so globalRaw is empty.
async function buildWorktreeCtx() {
  const { loadWorktreeConfig } = await loadWorktreeResolver();
  const localRoot = resolveSharedRoot();
  const buildLocalPath = join(localRoot, 'build', 'config.json');
  const sharedPath = join(localRoot, 'config.json');
  const globalPath = process.env.XM_ROOT ? sharedPath : join(homedir(), '.xm', 'config.json');

  const effective = loadWorktreeConfig({ buildRootDir: join(localRoot, 'build') });
  const buildLocalRaw = readWorktreeSub(buildLocalPath);
  const localXmFull = readJSON(sharedPath) ?? {};
  const sharedRaw = (localXmFull.worktree && typeof localXmFull.worktree === 'object') ? localXmFull.worktree : {};
  const globalRaw = process.env.XM_ROOT ? {} : readWorktreeSub(globalPath);

  // The resolver's "shared" layer = readSharedConfig().worktree, which shallow-
  // merges global+local (local .xm wins wholesale on the worktree object). Using
  // it for source detection inherently accounts for that wholesale replacement.
  const sc = readSharedConfig();
  const sharedLayer = (sc && typeof sc.worktree === 'object' && sc.worktree) ? sc.worktree : {};
  const sharedFromLocal = Object.prototype.hasOwnProperty.call(localXmFull, 'worktree');

  return {
    localRoot, buildLocalPath, sharedPath, globalPath,
    effective, buildLocalRaw, sharedRaw, globalRaw, sharedLayer, sharedFromLocal,
  };
}

function hasKey(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

// True when obj has the dotted worktree path (e.g. 'gate_policy.block_confirmed').
function hasWorktreePath(obj, keyPath) {
  let cur = obj;
  for (const p of keyPath.split('.')) {
    if (!cur || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, p)) return false;
    cur = cur[p];
  }
  return true;
}

// Which tier supplies a scalar key's effective value (build-local > shared >
// global > default), following the resolver's real precedence.
function worktreeKeySource(key, ctx) {
  if (hasKey(ctx.buildLocalRaw, key)) return 'build-local';
  if (hasKey(ctx.sharedLayer, key)) return ctx.sharedFromLocal ? 'shared' : 'global';
  return 'default';
}

// Same, for a gate_policy subkey (the resolver merges gate_policy per-key).
function gatePolicySource(subkey, ctx) {
  if (hasKey(ctx.buildLocalRaw.gate_policy, subkey)) return 'build-local';
  if (hasKey(ctx.sharedLayer.gate_policy, subkey)) return ctx.sharedFromLocal ? 'shared' : 'global';
  return 'default';
}

function sevShort(s) { return SEV_SHORT[s] || s; }

// ANSI-free value renderer for aligned table cells (severity arrays abbreviated).
function plainWtVal(v) {
  if (v === undefined) return t('common.unset');
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? v.map(sevShort).join(',') : '[]';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// Full (non-abbreviated) renderer for prompts and the exit summary.
function fmtWtVal(v) {
  if (v === undefined) return `${C.dim}${t('common.unset')}${C.reset}`;
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.join(', ')}]`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// Raw gate_policy.<sub> cell for the table, or '·' when the tier doesn't set it.
function gpRawCell(tierRaw, sub) {
  if (hasKey(tierRaw.gate_policy, sub)) return plainWtVal(tierRaw.gate_policy[sub]);
  return '·';
}

// The 3-tier value/source table: every scalar key + gate_policy subkeys, showing
// the resolver's effective value with its source tier and each tier's raw value.
function printWorktreeTable(ctx) {
  console.log(`\n${C.bold}🌳 ${t('worktree.title')}${C.reset} ${C.dim}${t('worktree.priority')}${C.reset}`);
  if (process.env.XM_ROOT) console.log(`  ${C.dim}${t('worktree.xmroot_note')}${C.reset}`);
  console.log('');
  const row = (num, key, eff, bl, sh, gl) =>
    `  ${String(num).padStart(2)}  ${key.padEnd(30)}${eff.padEnd(24)}${bl.padEnd(13)}${sh.padEnd(9)}${gl.padEnd(9)}`;
  console.log(`  ${C.dim}${row('#', 'key', 'effective (source)', 'build-local', 'shared', 'global').trim()}${C.reset}`);

  WORKTREE_SCALAR_KEYS.forEach((key, i) => {
    const eff = `${plainWtVal(ctx.effective[key])} (${worktreeKeySource(key, ctx)})`;
    const bl = hasKey(ctx.buildLocalRaw, key) ? plainWtVal(ctx.buildLocalRaw[key]) : '·';
    const sh = hasKey(ctx.sharedRaw, key) ? plainWtVal(ctx.sharedRaw[key]) : '·';
    const gl = hasKey(ctx.globalRaw, key) ? plainWtVal(ctx.globalRaw[key]) : '·';
    console.log(row(i + 1, key, eff, bl, sh, gl));
  });

  console.log(`  ${C.dim}    ${t('worktree.gate_policy_merge')}${C.reset}`);
  const gp = ctx.effective.gate_policy || {};
  for (const sub of [...GATE_POLICY_SEVERITY_KEYS, 'allow_low']) {
    const eff = `${plainWtVal(gp[sub])} (${gatePolicySource(sub, ctx)})`;
    const bl = gpRawCell(ctx.buildLocalRaw, sub);
    const sh = gpRawCell(ctx.sharedRaw, sub);
    const gl = gpRawCell(ctx.globalRaw, sub);
    console.log(`      ${('  ' + sub).padEnd(30)}${eff.padEnd(24)}${bl.padEnd(13)}${sh.padEnd(9)}${gl.padEnd(9)}`);
  }
  console.log('');
}

// Validate a scalar worktree value. Reuses validateSet against the config-schema
// entry, except gate_phase (schema enum is stale — see WORKTREE_GATE_PHASES).
function validateWorktreeValue(key, value) {
  if (key === 'gate_phase') {
    if (!WORKTREE_GATE_PHASES.includes(value)) {
      return [finding('enum', 'error', t('worktree.gate_phase_enum', WORKTREE_GATE_PHASES.join(', '), value))];
    }
    return [];
  }
  return validateSet(`worktree.${key}`, value);
}

// Prompt for one scalar worktree value against its schema entry: booleans render
// a 1/2 toggle, enums (incl. gate_phase) a numbered list, numbers show their range
// (and null for nullable). Enter keeps the current value. Invalid input replays the
// guidance and re-asks; 3 failures cancel the item (FM4). Returns { value } or
// { cancelled: true }.
async function promptWorktreeScalar(rl, key, ctx) {
  const entry = SCHEMA_BY_KEY.get(`worktree.${key}`);
  console.log(`  ${t('common.current')} ${fmtWtVal(ctx.effective[key])} ${C.dim}(${worktreeKeySource(key, ctx)})${C.reset}`);

  const isBool = entry?.type === 'boolean';
  const enumVals = key === 'gate_phase' ? WORKTREE_GATE_PHASES : entry?.enum;
  let promptText;
  let optMap = null;
  if (isBool) {
    optMap = { '1': true, '2': false };
    promptText = t('prompt.bool_toggle');
  } else if (enumVals) {
    optMap = {};
    enumVals.forEach((v, i) => { optMap[String(i + 1)] = v; });
    promptText = t('prompt.select_enum', enumVals.map((v, i) => `${i + 1}) ${v}`).join('  '));
  } else if (entry?.type === 'integer' || entry?.type === 'number') {
    const range = [
      entry.min !== undefined ? `≥${entry.min}` : null,
      entry.max !== undefined ? `≤${entry.max}` : null,
    ].filter(Boolean).join(' ');
    const nullHint = entry?.nullable ? t('worktree.null_hint') : '';
    promptText = t('prompt.enter_value_suffix', `${range ? ` (${range})` : ''}${nullHint}`);
  } else {
    promptText = t('prompt.enter_value_suffix', '');
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw = (await ask(rl, promptText)).trim();
    if (raw === '') return { cancelled: true };
    let value;
    if (optMap && optMap[raw] !== undefined) value = optMap[raw];
    else if (entry?.nullable && raw.toLowerCase() === 'null') value = null;
    else value = coerceValue(raw);
    const errs = validateWorktreeValue(key, value);
    if (errs.length === 0) return { value };
    for (const e of errs) console.log(`  ${C.red}⚠ ${e.message}${C.reset}`);
    if (attempt < 3) console.log(`  ${C.dim}${t('common.retry_check_allowed', attempt)}${C.reset}`);
  }
  console.log(`  ${C.yellow}${t('common.max_attempts')}${C.reset}`);
  return { cancelled: true };
}

// Prompt for a severity subset (block_* lists). Numbers or names, space/comma
// separated; 'none' → empty list; Enter keeps current. 3 failures cancel (FM4).
async function promptSeverityArray(rl, subkey, current) {
  const opts = SEVERITY_VALUES.map((v, i) => `${i + 1}) ${v}`).join('  ');
  console.log(`\n  ${C.bold}${subkey}${C.reset} ${t('sev.title_suffix')}`);
  console.log(`  ${t('common.current')} ${fmtWtVal(current)}`);
  console.log(`  ${C.dim}${t('sev.hint')}${C.reset}`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw = (await ask(rl, `  [${opts}]: `)).trim();
    if (raw === '') return { cancelled: true };
    if (raw.toLowerCase() === 'none') return { value: [] };
    const tokens = raw.split(/[\s,]+/).filter(Boolean);
    const picked = [];
    let bad = false;
    for (const tok of tokens) {
      let sev = null;
      if (/^[1-4]$/.test(tok)) sev = SEVERITY_VALUES[Number(tok) - 1];
      else if (SEVERITY_VALUES.includes(tok.toLowerCase())) sev = tok.toLowerCase();
      if (!sev) { bad = true; break; }
      if (!picked.includes(sev)) picked.push(sev);
    }
    if (!bad && picked.length) return { value: SEVERITY_VALUES.filter(s => picked.includes(s)) };
    console.log(`  ${C.red}⚠ ${t('sev.enter_valid')}${C.reset}`);
    if (attempt < 3) console.log(`  ${C.dim}${t('common.retry_generic', attempt)}${C.reset}`);
  }
  console.log(`  ${C.yellow}${t('common.max_attempts')}${C.reset}`);
  return { cancelled: true };
}

// 1/2 boolean toggle for allow_low. Enter keeps current; 3 failures cancel (FM4).
async function promptBoolean(rl, label, current) {
  if (isRawCapable()) {
    const ch = await menuSelect(rl, {
      title: label,
      header: [`${t('common.current')} ${fmtWtVal(current)}`],
      options: [
        { key: '1', label: 'true' },
        { key: '2', label: 'false' },
        { key: '0', label: t('common.keep_current') },
      ],
      initialKey: current === false ? '2' : '1',
    });
    if (ch === '0' || ch === '') return { cancelled: true };
    return { value: ch === '1' };
  }
  console.log(`  ${t('common.current')} ${fmtWtVal(current)}`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw = (await ask(rl, t('prompt.bool_labeled', label))).trim();
    if (raw === '') return { cancelled: true };
    if (raw === '1' || raw.toLowerCase() === 'true') return { value: true };
    if (raw === '2' || raw.toLowerCase() === 'false') return { value: false };
    console.log(`  ${C.red}⚠ ${t('bool.enter_valid')}${C.reset}`);
    if (attempt < 3) console.log(`  ${C.dim}${t('common.retry_generic', attempt)}${C.reset}`);
  }
  console.log(`  ${C.yellow}${t('common.max_attempts')}${C.reset}`);
  return { cancelled: true };
}

// Ask which of the 3 tiers to write. Enter defaults to build-local (worktree.*
// keys are scope 'build-local'). Returns { tier, path } or null on invalid input.
async function chooseWorktreeTier(rl, ctx) {
  if (isRawCapable()) {
    const ch = await menuSelect(rl, {
      title: t('worktree.tier_title'),
      options: [
        { key: '1', label: 'build-local', hint: ctx.buildLocalPath },
        { key: '2', label: 'shared', hint: ctx.sharedPath },
        { key: '3', label: 'global', hint: ctx.globalPath },
      ],
      initialKey: '1',
      backKey: '1',
    });
    if (ch === '2') return { tier: 'shared', path: ctx.sharedPath };
    if (ch === '3') return { tier: 'global', path: ctx.globalPath };
    return { tier: 'build-local', path: ctx.buildLocalPath };
  }
  const ans = (await ask(rl, t('worktree.tier_prompt'))).trim();
  if (ans === '' || ans === '1') return { tier: 'build-local', path: ctx.buildLocalPath };
  if (ans === '2') return { tier: 'shared', path: ctx.sharedPath };
  if (ans === '3') return { tier: 'global', path: ctx.globalPath };
  return null;
}

// Priority order (build-local highest) of tiers that outrank a given write tier.
// build-local outranks nothing, so writing there is never shadowed.
const WORKTREE_TIER_PRIORITY = {
  global: ['build-local', 'shared'],
  shared: ['build-local'],
  'build-local': [],
};

// Pure decision: which higher-priority tiers already set `keyPath`, if any, when
// about to write to `tier`. No I/O. `layers` is a plain per-tier map of each
// tier's raw (un-merged) worktree sub-object — { 'build-local': obj, shared: obj,
// global: obj } — mirroring the raw-layer shape worktree-shared.mjs's
// readWorktreeLayers produces per tier. Order follows WORKTREE_TIER_PRIORITY
// (highest priority first); callers that only need the top shadowing tier (for a
// single warning message) can take result[0].
export function shadowingTiers(keyPath, tier, layers) {
  const higher = WORKTREE_TIER_PRIORITY[tier] || [];
  return higher.filter(label => hasWorktreePath(layers?.[label], keyPath));
}

// Warn (before writing) when a higher-priority tier already sets keyPath, so the
// write would not reach the effective value. build-local is highest, so a
// build-local write is never shadowed. Returns true to proceed, false to cancel.
async function confirmWorktreeShadow(rl, keyPath, tier, ctx) {
  const layers = { 'build-local': ctx.buildLocalRaw, shared: ctx.sharedRaw, global: ctx.globalRaw };
  const shadowedBy = shadowingTiers(keyPath, tier, layers);
  if (shadowedBy.length === 0) return true;

  const label = shadowedBy[0];
  console.log(`  ${C.yellow}⚠${C.reset} ${t('worktree.tier_override', label, keyPath)}`);
  const cont = (await ask(rl, t('worktree.confirm_tier', tier))).trim().toLowerCase();
  if (cont !== 'y' && cont !== 'yes') {
    console.log(`  ${C.dim}${t('common.cancelled_nosave')}${C.reset}`);
    return false;
  }
  return true;
}

// Persist worktree.<keyPath> to a chosen tier: choose tier → show target path →
// shadow warning → write (build-local dir auto-created via writeJSONAtomic's
// mkdirSync, FM2) → echo path → record for the exit summary (FM3 item-level save).
async function saveWorktreeKey(rl, session, ctx, keyPath, value) {
  const choice = await chooseWorktreeTier(rl, ctx);
  if (!choice) { console.log(`  ${C.dim}${t('worktree.cancel_tier')}${C.reset}`); return false; }
  const { tier, path } = choice;
  console.log(`  ${C.dim}${t('common.save_target', path, tier)}${C.reset}`);

  if (!(await confirmWorktreeShadow(rl, keyPath, tier, ctx))) return false;

  const existing = readJSON(path) ?? {};
  setNestedKey(existing, `worktree.${keyPath}`, value);
  writeJSONAtomic(path, existing);
  console.log(`  ${C.green}${G.ok}${C.reset} ${C.cyan}worktree.${keyPath}${C.reset} = ${fmtWtVal(value)} ${C.dim}(${tier}) → ${path}${C.reset}`);
  session.saved.push({ key: `worktree.${keyPath}`, value, scope: tier, path });
  return true;
}

// gate_policy submenu: edit one severity list or allow_low. Each subkey merges
// per-key across tiers (not wholesale-replaced), so editing one leaves the others
// intact — surfaced to the user before they pick.
async function editGatePolicy(rl, session, ctx) {
  const gp = ctx.effective.gate_policy || {};
  console.log(`\n${C.bold}${t('gp.title')}${C.reset}`);
  console.log(`  ${C.dim}${t('gp.merge_note')}${C.reset}\n`);
  GATE_POLICY_SEVERITY_KEYS.forEach((sub, i) => {
    console.log(`  ${C.bold}${i + 1})${C.reset} ${sub.padEnd(16)} ${t('common.current')} ${fmtWtVal(gp[sub])} ${C.dim}(${gatePolicySource(sub, ctx)})${C.reset}`);
  });
  console.log(`  ${C.bold}4)${C.reset} ${'allow_low'.padEnd(16)} ${t('common.current')} ${fmtWtVal(gp.allow_low)} ${C.dim}(${gatePolicySource('allow_low', ctx)})${C.reset}`);
  console.log(`  ${C.bold}0)${C.reset} ${t('common.back')}\n`);

  const ch = (await ask(rl, '  ' + t('prompt.select'))).trim();
  if (ch === '0' || ch === '') return;
  if (ch === '1' || ch === '2' || ch === '3') {
    const sub = GATE_POLICY_SEVERITY_KEYS[Number(ch) - 1];
    const r = await promptSeverityArray(rl, sub, gp[sub]);
    if (r.cancelled) { console.log(`  ${C.dim}${t('common.no_change')}${C.reset}`); return; }
    await saveWorktreeKey(rl, session, ctx, `gate_policy.${sub}`, r.value);
  } else if (ch === '4') {
    const r = await promptBoolean(rl, 'allow_low', gp.allow_low);
    if (r.cancelled) { console.log(`  ${C.dim}${t('common.no_change')}${C.reset}`); return; }
    await saveWorktreeKey(rl, session, ctx, 'gate_policy.allow_low', r.value);
  } else {
    console.log(`  ${C.dim}${t('common.enter_range', '0-4')}${C.reset}`);
  }
}

async function categoryWorktree(rl, session) {
  while (true) {
    const ctx = await buildWorktreeCtx();
    printWorktreeTable(ctx);
    const ch = await menuSelect(rl, {
      title: t('cat.worktree.title'),
      options: [
        ...WORKTREE_SCALAR_KEYS.map((k, i) => ({ key: String(i + 1), label: k })),
        { key: '11', label: 'gate_policy', hint: t('worktree.gate_policy_hint') },
        { key: '0', label: t('common.back') },
      ],
    });
    if (ch === '0' || ch === '') return;
    if (ch === '11') { await editGatePolicy(rl, session, ctx); continue; }
    const idx = Number(ch);
    if (Number.isInteger(idx) && idx >= 1 && idx <= WORKTREE_SCALAR_KEYS.length) {
      const key = WORKTREE_SCALAR_KEYS[idx - 1];
      const r = await promptWorktreeScalar(rl, key, ctx);
      if (r.cancelled) { console.log(`  ${C.dim}${t('common.no_change')}${C.reset}`); continue; }
      await saveWorktreeKey(rl, session, ctx, key, r.value);
    } else {
      console.log(`  ${C.dim}${t('common.enter_range', '0-11')}${C.reset}`);
    }
  }
}
// ── Misc category (global) ──────────────────────────────────────────────
//
// mode + drift.drift_threshold reuse promptSchemaValue (enum / ranged number);
// scan_roots is a string array edited row-by-row; pipelines is a JSON object that
// is JSON.parse-validated BEFORE saving (coerceValue silently swallows parse
// errors, so it is deliberately NOT used here — a broken paste must re-ask, FM4).

function describeScanRoots() {
  const arr = getNestedKey(readSharedConfig(), 'scan_roots');
  if (!Array.isArray(arr) || arr.length === 0) return `${C.dim}${t('common.none')}${C.reset}`;
  return `${C.cyan}${t('count.items', arr.length)}${C.reset} ${C.dim}(${resolveValueSource('scan_roots')})${C.reset}`;
}

function describePipelines() {
  const p = getNestedKey(readSharedConfig(), 'pipelines') || {};
  const n = Object.keys(p).length;
  if (n === 0) return `${C.dim}${t('common.none')}${C.reset}`;
  return `${C.cyan}${t('count.items', n)}${C.reset} ${C.dim}(${resolveValueSource('pipelines')})${C.reset}`;
}

// Row-by-row editor for scan_roots (string[]). Scope chosen once, then each line
// adds a path or `del <번호>` removes one from the CHOSEN tier's own array (so the
// index always matches what is written, not the merged effective view).
async function editScanRoots(rl, session) {
  const key = 'scan_roots';
  console.log(`\n  ${t('scan.header')}`);
  console.log(`  ${t('scan.current_effective')} ${describeScanRoots()}\n`);

  const scope = await chooseScope(rl, key);
  const scopeLabel = scope.global ? 'global' : 'local';
  const targetPath = join(resolveSharedRoot(scope), 'config.json');
  console.log(`  ${C.dim}${t('common.save_target', targetPath, scopeLabel)}${C.reset}`);
  if (!(await confirmShadow(rl, key, scope))) return;

  console.log(`\n  ${t('scan.format')}`);
  let changed = false;
  while (true) {
    const existing = readJSON(targetPath) ?? {};
    const roots = Array.isArray(existing[key]) ? existing[key] : [];
    if (roots.length) roots.forEach((p, i) => console.log(`    ${C.dim}${i + 1})${C.reset} ${p}`));
    else console.log(`    ${C.dim}${t('scan.empty')}${C.reset}`);
    const input = (await ask(rl, '  > ')).trim();
    if (!input) break;
    if (input.startsWith('del ')) {
      const n = Number(input.slice(4).trim());
      if (!Number.isInteger(n) || n < 1 || n > roots.length) { console.log(`  ${C.red}${t('scan.enter_range', roots.length)}${C.reset}`); continue; }
      const removed = roots[n - 1];
      const next = roots.filter((_, i) => i !== n - 1);
      existing[key] = next;
      writeJSONAtomic(targetPath, existing);
      console.log(`  ${C.green}${G.ok}${C.reset} ${t('scan.deleted', removed)} ${C.dim}(${scopeLabel})${C.reset}`);
      session.saved.push({ key, value: next, scope: scopeLabel, path: targetPath });
      changed = true;
      continue;
    }
    if (roots.includes(input)) { console.log(`  ${C.dim}${t('scan.already', input)}${C.reset}`); continue; }
    const next = [...roots, input];
    existing[key] = next;
    writeJSONAtomic(targetPath, existing);
    console.log(`  ${C.green}${G.ok}${C.reset} ${t('scan.added', input)} ${C.dim}(${scopeLabel})${C.reset}`);
    session.saved.push({ key, value: next, scope: scopeLabel, path: targetPath });
    changed = true;
  }
  if (!changed) console.log(`  ${C.dim}${t('common.no_change')}${C.reset}`);
}

// Edit pipelines as a whole JSON object. The pasted line is JSON.parsed directly
// (NOT via coerceValue, which returns the raw string on parse failure and would
// silently save garbage). A parse error or non-object replays guidance and re-asks;
// 3 failures cancel with nothing written (FM4). Enter keeps the current value.
async function editPipelines(rl, session) {
  const key = 'pipelines';
  const current = getNestedKey(readSharedConfig(), key) || {};
  console.log(`\n  ${t('pipe.header')}`);
  console.log(`  ${t('common.current')} ${C.cyan}${JSON.stringify(current)}${C.reset} ${C.dim}(${resolveValueSource(key)})${C.reset}`);
  console.log(`  ${C.dim}${t('pipe.hint')}${C.reset}\n`);

  let value;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw = (await ask(rl, t('pipe.prompt'))).trim();
    if (raw === '') { console.log(`  ${C.dim}${t('common.no_change')}${C.reset}`); return; }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.log(`  ${C.red}⚠ ${t('pipe.parse_failed', e.message)}${C.reset}`);
      if (attempt < 3) console.log(`  ${C.dim}${t('pipe.retry_valid_object', attempt)}${C.reset}`);
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.log(`  ${C.red}⚠ ${t('pipe.must_object')}${C.reset}`);
      if (attempt < 3) console.log(`  ${C.dim}${t('common.retry_generic', attempt)}${C.reset}`);
      continue;
    }
    value = parsed;
    break;
  }
  if (value === undefined) {
    console.log(`  ${C.yellow}${t('common.max_attempts')}${C.reset}`);
    return;
  }
  await saveKey(rl, session, key, value);
}

async function categoryMisc(rl, session) {
  while (true) {
    const ch = await menuSelect(rl, {
      title: t('cat.misc.title'),
      options: [
        { key: '1', label: t('cat.misc.mode'), hint: `${t('common.current')} ${describeEffective('mode')}` },
        { key: '2', label: t('cat.misc.drift'), hint: `${t('common.current')} ${describeEffective('drift.drift_threshold')}` },
        { key: '3', label: t('cat.misc.scan'), hint: `${t('common.current')} ${describeScanRoots()}` },
        { key: '4', label: t('cat.misc.pipe'), hint: `${t('common.current')} ${describePipelines()}` },
        { key: '5', label: t('cat.misc.lang'), hint: `${t('common.current')} ${describeEffective('lang')}` },
        { key: '0', label: t('common.back') },
      ],
    });
    if (ch === '0' || ch === '') return;
    if (ch === '1') {
      const r = await promptSchemaValue(rl, 'mode');
      if (r.cancelled) { console.log(`  ${C.dim}${t('common.no_change')}${C.reset}`); continue; }
      await saveKey(rl, session, 'mode', r.value);
    } else if (ch === '2') {
      const r = await promptSchemaValue(rl, 'drift.drift_threshold');
      if (r.cancelled) { console.log(`  ${C.dim}${t('common.no_change')}${C.reset}`); continue; }
      await saveKey(rl, session, 'drift.drift_threshold', r.value);
    } else if (ch === '3') {
      await editScanRoots(rl, session);
    } else if (ch === '4') {
      await editPipelines(rl, session);
    } else if (ch === '5') {
      const r = await promptSchemaValue(rl, 'lang');
      if (r.cancelled) { console.log(`  ${C.dim}${t('common.no_change')}${C.reset}`); continue; }
      if (await saveKey(rl, session, 'lang', r.value)) {
        // Reflect the new language immediately: re-resolve with the same
        // precedence (flag > env > config), so the very next menu render is
        // localized without needing a re-run. --lang / XM_LANG still win.
        initLang({ flagLang: _flagLang, configLang: readSharedConfig().lang });
      }
    } else {
      console.log(`  ${C.dim}${t('common.enter_range', '0-5')}${C.reset}`);
    }
  }
}

// ── Panel category (editable — owned by x-panel, edited both here + `xm panel setup`) ──
//
// panel.* is the cross-vendor provider config owned by x-panel. It is now editable
// from BOTH `xm panel setup` and this wizard, WITHOUT duplicating panel's validation:
//   • models / judge → DELEGATED to `xm panel setup` (panel owns the validation +
//     autodetect semantics; we only collect input and spawn it).
//   • timeout_s → direct write (registered config-schema leaf: integer, min 30).
//   • model_overrides → direct write (row-by-row { vendor: model }).
// panel's OWN merge is per-key project(.xm) > global(~/.xm) — different from
// shared-config's wholesale top-level replacement — so the category surfaces that
// before any edit (panel.merge_note).

// Locate the x-panel CLI for the `xm`-absent fallback. Dual-path: bundle mirror
// (xm/lib/x-panel-cli.mjs) then source (x-panel/lib/x-panel-cli.mjs). Returns the
// path, or null when neither exists (caller surfaces this — never a silent skip).
function findPanelCli() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'x-panel-cli.mjs'),                                 // xm bundle: xm/lib/x-panel-cli.mjs
    join(here, '..', '..', 'x-panel', 'lib', 'x-panel-cli.mjs'),   // source: x-build/lib → x-panel/lib
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

// Delegate a models/judge write to `xm panel setup` so panel's validation + merge
// stay the single source of truth (no duplicated validation here). Scope maps to
// the --global flag. Under XM_ROOT (collapsed tiers) both panel roots point at that
// one file so the delegated write lands where the wizard reads it back. Resolution:
// XM_PANEL_SETUP_STUB (tests) → `xm panel setup` → direct x-panel-cli.mjs fallback
// when `xm` is not on PATH (ENOENT). Returns spawnSync's result object.
function runPanelSetup(setupArgs, scope) {
  const env = { ...process.env };
  if (process.env.XM_ROOT) {
    env.X_PANEL_ROOT = process.env.XM_ROOT;
    env.X_PANEL_GLOBAL_ROOT = process.env.XM_ROOT;
  }
  const args = ['setup', ...setupArgs];
  if (scope.global) args.push('--global');

  const stub = process.env.XM_PANEL_SETUP_STUB;
  if (stub) return spawnSync('node', [stub, ...args], { env, encoding: 'utf8' });

  const viaXm = spawnSync('xm', ['panel', ...args], { env, encoding: 'utf8' });
  if (!(viaXm.error && viaXm.error.code === 'ENOENT')) return viaXm;

  const cli = findPanelCli();
  if (!cli) return { error: new Error(t('panel.setup_not_found')), status: null, stdout: '', stderr: '' };
  return spawnSync('node', [cli, ...args], { env, encoding: 'utf8' });
}

// Surface the delegated setup's outcome (L6: never silence a failure). On success,
// echo setup's own output (it prints the saved path), parse that path for the exit
// summary, and record the item. On failure, print exit code + any stdout/stderr.
function reportPanelSetup(r, session, key, value, scopeLabel) {
  const stdout = (r.stdout || '').trim();
  const stderr = (r.stderr || '').trim();
  if (r.status !== 0) {
    if (r.error && r.status == null) {
      console.log(`  ${C.red}${G.warn} ${t('panel.setup_not_found')}${C.reset}`);
      console.log(`  ${C.dim}${r.error.message}${C.reset}`);
    } else {
      console.log(`  ${C.red}${G.warn} ${t('panel.setup_failed', r.status)}${C.reset}`);
    }
    if (stdout) console.log(`  ${C.dim}${stdout}${C.reset}`);
    if (stderr) console.log(`  ${C.dim}${stderr}${C.reset}`);
    return;
  }
  if (stdout) for (const line of stdout.split('\n')) console.log(`  ${line}`);
  const m = stdout.match(/→\s*(\S+)/);
  const path = m ? m[1] : t('panel.via_setup');
  session.saved.push({ key, value, scope: scopeLabel, path });
}

// Detected-provider header for the panel category. Reuses x-panel adapters'
// autodetectModels (dual-path loader shared with the vendor category). Returns a
// localized line; detection unavailable → "(감지 안내 없음)" rather than a crash.
async function detectPanelProviders() {
  const adapters = await loadPanelAdapters();
  if (!adapters || typeof adapters.autodetectModels !== 'function') return t('panel.detect_unavailable');
  try {
    const found = adapters.autodetectModels();
    return Array.isArray(found) && found.length
      ? t('panel.detected_providers', found.join(', '))
      : t('panel.none_detected');
  } catch {
    return t('panel.detect_unavailable');
  }
}

function describePanelModels(panel) {
  return Array.isArray(panel.models) && panel.models.length
    ? `${C.cyan}${panel.models.join(', ')}${C.reset}` : `${C.dim}(autodetect)${C.reset}`;
}

function describePanelOverrides(panel) {
  const o = (panel.model_overrides && typeof panel.model_overrides === 'object') ? panel.model_overrides : {};
  const n = Object.keys(o).length;
  if (n === 0) return `${C.dim}${t('common.none')}${C.reset}`;
  return `${C.cyan}${t('count.items', n)}${C.reset} ${C.dim}(${resolveValueSource('panel')})${C.reset}`;
}

// models edit — collect a comma-separated model list, then delegate to `xm panel
// setup --models <list>`. panel owns the validation, so we do NOT parse/validate here.
async function editPanelModels(rl, session) {
  const panel = getNestedKey(readSharedConfig(), 'panel') || {};
  console.log(`  ${t('common.current')} ${describePanelModels(panel)}`);
  console.log(`  ${C.dim}${t('panel.delegate_note')}${C.reset}`);
  console.log(`  ${C.dim}${t('panel.models_format')}${C.reset}`);
  const raw = (await ask(rl, t('prompt.enter_value_suffix', ''))).trim();
  if (raw === '') { console.log(`  ${C.dim}${t('common.no_change')}${C.reset}`); return; }
  const scope = await chooseScope(rl, 'panel');
  const scopeLabel = scope.global ? 'global' : 'local';
  const r = runPanelSetup(['--models', raw], scope);
  reportPanelSetup(r, session, 'panel.models', raw, scopeLabel);
}

// judge edit — free input, but anything other than 'rule' (the only implemented
// judge) asks for confirmation first, then delegates to `xm panel setup --judge`.
async function editPanelJudge(rl, session) {
  const panel = getNestedKey(readSharedConfig(), 'panel') || {};
  console.log(`  ${t('common.current')} ${C.cyan}${panel.judge || t('panel.rule_default')}${C.reset}`);
  console.log(`  ${C.dim}${t('panel.judge_format')}${C.reset}`);
  const raw = (await ask(rl, t('prompt.enter_value_suffix', ''))).trim();
  if (raw === '') { console.log(`  ${C.dim}${t('common.no_change')}${C.reset}`); return; }
  if (raw !== 'rule') {
    const cont = (await ask(rl, t('panel.judge_confirm_nonrule', raw))).trim().toLowerCase();
    if (cont !== 'y' && cont !== 'yes') { console.log(`  ${C.dim}${t('common.cancelled_nosave')}${C.reset}`); return; }
  }
  const scope = await chooseScope(rl, 'panel');
  const scopeLabel = scope.global ? 'global' : 'local';
  const r = runPanelSetup(['--judge', raw], scope);
  reportPanelSetup(r, session, 'panel.judge', raw, scopeLabel);
}

// timeout_s edit — direct write via the shared schema-value + saveKey engine
// (registered leaf: integer, min 30). No delegation: it is a plain config key.
async function editPanelTimeout(rl, session) {
  const r = await promptSchemaValue(rl, 'panel.timeout_s');
  if (r.cancelled) { console.log(`  ${C.dim}${t('common.no_change')}${C.reset}`); return; }
  await saveKey(rl, session, 'panel.timeout_s', r.value);
}

// model_overrides edit — direct row-by-row editor for { vendor: model }. A bare
// vendor name in --models resolves to this model (panel's resolveModelSpec). Scope
// chosen once (like editOverrides); each line sets `vendor=model` or deletes with
// `del <vendor>`, written per-key so sibling overrides survive.
async function editPanelOverrides(rl, session) {
  const key = 'panel.model_overrides';
  const current = getNestedKey(readSharedConfig(), key) || {};
  console.log(`\n  ${t('panel.overrides_header')}`);
  const names = Object.keys(current);
  if (names.length === 0) console.log(`    ${C.dim}${t('common.none')}${C.reset}`);
  else for (const v of names) console.log(`    ${v.padEnd(16)} ${C.cyan}${current[v]}${C.reset}`);
  console.log(`\n  ${t('panel.overrides_format')}\n`);

  const scope = await chooseScope(rl, 'panel');
  const scopeLabel = scope.global ? 'global' : 'local';
  const targetPath = join(resolveSharedRoot(scope), 'config.json');
  console.log(`  ${C.dim}${t('common.save_target', targetPath, scopeLabel)}${C.reset}`);
  if (!(await confirmShadow(rl, key, scope))) return;

  let changed = false;
  while (true) {
    const input = (await ask(rl, '  > ')).trim();
    if (!input) break;
    const existing = readJSON(targetPath) ?? {};
    const overrides = { ...(getNestedKey(existing, key) || {}) };
    if (input.startsWith('del ')) {
      const name = input.slice(4).trim();
      if (!(name in overrides)) { console.log(`  ${C.red}${t('budget.no_such_project', name)}${C.reset}`); continue; }
      delete overrides[name];
      setNestedKey(existing, key, overrides);
      writeJSONAtomic(targetPath, existing);
      console.log(`  ${C.green}${G.ok}${C.reset} ${t('budget.deleted', name)} ${C.dim}(${scopeLabel})${C.reset}`);
      session.saved.push({ key: `${key}.${name}`, value: t('common.deleted_marker'), scope: scopeLabel, path: targetPath });
      changed = true;
      continue;
    }
    const [vendor, model] = input.split('=').map(s => s?.trim());
    if (!vendor || !model) { console.log(`  ${C.red}${t('panel.overrides_format_short')}${C.reset}`); continue; }
    overrides[vendor] = model;
    setNestedKey(existing, key, overrides);
    writeJSONAtomic(targetPath, existing);
    console.log(`  ${C.green}${G.ok}${C.reset} ${vendor} → ${C.cyan}${model}${C.reset} ${C.dim}(${scopeLabel})${C.reset}`);
    session.saved.push({ key: `${key}.${vendor}`, value: model, scope: scopeLabel, path: targetPath });
    changed = true;
  }
  if (!changed) console.log(`  ${C.dim}${t('common.no_change')}${C.reset}`);
}

// Panel category menu (while-loop). Detection runs once on entry (state can't change
// mid-session). Each render shows the panel-specific merge note + detected providers,
// then routes to the delegated (models/judge) or direct (timeout_s/model_overrides)
// editors.
async function categoryPanel(rl, session) {
  const providers = await detectPanelProviders();
  while (true) {
    const panel = getNestedKey(readSharedConfig(), 'panel') || {};
    console.log(`\n  ${C.dim}${t('panel.merge_note')}${C.reset}`);
    console.log(`  ${C.dim}${providers}${C.reset}`);
    const ch = await menuSelect(rl, {
      title: t('cat.panel.title'),
      options: [
        { key: '1', label: t('cat.panel.models'), hint: describePanelModels(panel) },
        { key: '2', label: t('cat.panel.judge'), hint: panel.judge ? `${C.cyan}${panel.judge}${C.reset}` : `${C.dim}${t('panel.rule_default')}${C.reset}` },
        { key: '3', label: t('cat.panel.timeout'), hint: `${t('common.current')} ${describeEffective('panel.timeout_s')}` },
        { key: '4', label: t('cat.panel.overrides'), hint: describePanelOverrides(panel) },
        { key: '0', label: t('common.back') },
      ],
    });
    if (ch === '0' || ch === '') return;
    if (ch === '1') await editPanelModels(rl, session);
    else if (ch === '2') await editPanelJudge(rl, session);
    else if (ch === '3') await editPanelTimeout(rl, session);
    else if (ch === '4') await editPanelOverrides(rl, session);
    else console.log(`  ${C.dim}${t('common.enter_range', '0-4')}${C.reset}`);
  }
}

// ── Wizard core (while-loop menu) ───────────────────────────────────────

// Built per call so the resolved language is reflected on every wizard entry.
function mainMenuOptions() {
  return [
    { key: '1', label: t('menu.model'), hint: t('menu.model_hint') },
    { key: '2', label: t('menu.budget'), hint: t('menu.budget_hint') },
    { key: '3', label: t('menu.exec'), hint: t('menu.exec_hint') },
    { key: '4', label: t('menu.gates'), hint: t('menu.gates_hint') },
    { key: '5', label: 'worktree', hint: t('menu.worktree_hint') },
    { key: '6', label: t('menu.misc'), hint: 'mode · drift · scan_roots · pipelines' },
    { key: '7', label: 'panel', hint: t('menu.panel_hint') },
    { key: '0', label: t('common.exit') },
  ];
}

function printSessionSummary(session) {
  if (session.saved.length === 0) {
    outro(`${t('summary.title')} — ${P.dim(t('summary.no_items'))}`);
    return;
  }
  console.log(`\n${P.cyan(G.section)} ${P.bold(t('summary.title'))} ${P.dim(t('summary.saved_count', session.saved.length))}`);
  for (const s of session.saved) {
    const shown = typeof s.value === 'object' ? JSON.stringify(s.value) : s.value;
    railLine(`${P.green(G.ok)} ${P.cyan(s.key)} = ${shown} ${P.dim(`(${s.scope}) → ${s.path}`)}`);
  }
  outro(t('summary.done'));
}

async function interactiveConfig(flags) { // eslint-disable-line no-unused-vars
  if (guardNonTTY()) {
    process.exitCode = 1;
    return;
  }
  const rl = createRL();
  const session = { saved: [] };
  section(t('common.xm_config'), t('wizard.subtitle'));
  try {
    let running = true;
    while (running) {
      const choice = await menuSelect(rl, {
        title: t('wizard.main_title'),
        header: [
          `${t('wizard.hdr_profile')} ${describeEffective('model_profile')}`,
          `${t('wizard.hdr_agents')} ${describeEffective('agent_max_count')}`,
        ],
        options: mainMenuOptions(),
      });
      switch (choice) {
        case '1': await categoryModel(rl, session); break;
        case '2': await categoryBudget(rl, session); break;
        case '3': await categoryExecution(rl, session); break;
        case '4': await categoryGates(rl, session); break;
        case '5': await categoryWorktree(rl, session); break;
        case '6': await categoryMisc(rl, session); break;
        case '7': await categoryPanel(rl, session); break;
        case '0': case '': running = false; break;
        default: console.log(`  ${C.dim}${t('common.enter_range', '0-7')}${C.reset}`);
      }
    }
  } catch (e) {
    if (!(e instanceof WizardEOF)) throw e;
    // Piped stdin exhausted / Ctrl-D / Ctrl-C — items saved so far are already on
    // disk (item-level save); fall through to the summary (FM3).
    console.log(`\n  ${C.dim}${t('wizard.eof')}${C.reset}`);
  } finally {
    rl.close();
  }
  printSessionSummary(session);
}
