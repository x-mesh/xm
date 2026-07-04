#!/usr/bin/env node
/**
 * skill-frontmatter-sync.mjs — Sync SKILL.md frontmatter `model:` field from `model_profile` config.
 *
 * Reads xm/lib/skill-model-map.json + .xm/config.json (or ~/.xm/config.json) `model_profile`,
 * then updates the source SKILL.md frontmatter `model:` field.
 *
 * Source path resolution per skill:
 *   1. x-{skill}/skills/{skill}/SKILL.md (standalone plugin source)
 *   2. xm/skills/{skill}/SKILL.md (xm-only source: handoff, handon, kit, ship, sync)
 *
 * Marker semantics (decision A — opt-out via marker):
 *   - frontmatter contains `managed: false` → skip (manual override)
 *   - otherwise (no marker or `managed: true`) → update `model:` field
 *
 * Inherit semantics ("absence = inherit"):
 *   - target 'inherit' means the skill must run on the SESSION model — the
 *     frontmatter `model:` line is REMOVED (never written as a literal
 *     `model: inherit`; Claude Code has no such value), and drift flips to
 *     "field present = drift".
 *   - Body markers on judgment roles have their `model: "X"` token REMOVED
 *     from the example (Agent tool inherits when the parameter is omitted);
 *     switching back to a concrete tier re-inserts the token after `{`.
 *
 * Body sync (P3):
 *   - Lines ending with `<!-- managed-model: <role> -->` get their `model: "X"`
 *     token rewritten based on current profile + role (via cost-engine).
 *   - Roles match cost-engine.ROLE_MODEL_MAP_HR keys: architect, reviewer,
 *     security, executor, designer, debugger, explorer, writer.
 *
 * Usage:
 *   node skill-frontmatter-sync.mjs                # apply current profile
 *   node skill-frontmatter-sync.mjs --check        # diff only, exit 1 on drift
 *   node skill-frontmatter-sync.mjs --profile economy  # override profile
 *   node skill-frontmatter-sync.mjs --repo-root /path  # alternate repo
 *   node skill-frontmatter-sync.mjs --verbose      # show all decisions including skips
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MODEL_PROFILES, resolveProfileName } from './x-build/cost-engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config / mapping load ───────────────────────────────────────────────
// LEGACY_PROFILE_MAP / resolveProfileName / MODEL_PROFILES are imported from
// cost-engine (single source of truth) rather than duplicated here.

function loadMapping(mapPath) {
  return JSON.parse(readFileSync(mapPath, 'utf8'));
}

async function loadProfile(repoRoot, override) {
  if (override) return resolveProfileName(override);
  // Load via shared-config.mjs from the repo's lib path (avoids stale cached copy)
  const shared = await import(join(repoRoot, 'xm', 'lib', 'shared-config.mjs'));
  const cfg = shared.readSharedConfig();
  return resolveProfileName(cfg.model_profile);
}

function resolveRoleModel(role, profile) {
  const map = MODEL_PROFILES[profile] || MODEL_PROFILES.default;
  return map[role] || 'sonnet';
}

// ── Frontmatter parser (line-based, no YAML dep) ────────────────────────

export function splitFrontmatter(text) {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 4);
  if (end === -1) return null;
  const fmEnd = end + 4; // includes second ---
  return {
    front: text.slice(4, end),                      // between --- markers (no delims)
    rest: text.slice(fmEnd),                        // everything after closing ---
  };
}

export function parseSimple(front) {
  // Returns { model, managed, lines } where lines is the raw split for rewriting.
  const lines = front.split('\n');
  let model = null;
  let managed = null;
  for (const line of lines) {
    const m1 = line.match(/^model:\s*(.+?)\s*$/);
    if (m1 && model === null) model = m1[1].replace(/^["']|["']$/g, '');
    const m2 = line.match(/^managed:\s*(true|false)\s*$/);
    if (m2 && managed === null) managed = m2[1] === 'true';
  }
  return { model, managed, lines };
}

// ── Body model rewriter (P3) ────────────────────────────────────────────
// Scans body lines for `<!-- managed-model: <role> -->` markers and rewrites
// the `model: "X"` token on the same line based on the role + current profile.
// target 'inherit' REMOVES the token (Agent tool inherits the session model
// when the parameter is omitted — a literal model:"inherit" is invalid);
// a concrete target re-inserts the token after the opening `{` if absent.
// Returns { newBody, changes: [{ line, role, from, to }] }.

const BODY_MODEL_TOKEN = /model:\s*"(haiku|sonnet|opus)"/;
const INHERIT = 'inherit';

export function removeBodyModelToken(line) {
  // Try token + trailing comma first ("model: "X", rest"), then a leading
  // comma (", model: "X""), then the bare token — keeps the example valid JS.
  for (const re of [
    /model:\s*"(?:haiku|sonnet|opus)"\s*,\s*/,
    /,\s*model:\s*"(?:haiku|sonnet|opus)"/,
    BODY_MODEL_TOKEN,
  ]) {
    if (re.test(line)) return line.replace(re, '');
  }
  return line;
}

export function rewriteBodyModels(body, profile) {
  const lines = body.split('\n');
  const changes = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/<!--\s*managed-model:\s*([\w-]+)\s*-->\s*$/);
    if (!m) continue;
    const role = m[1];
    const target = resolveRoleModel(role, profile);
    const modelMatch = lines[i].match(BODY_MODEL_TOKEN);

    if (target === INHERIT) {
      if (!modelMatch) continue; // already omitted — absence IS the target state
      const newLine = removeBodyModelToken(lines[i]);
      if (newLine === lines[i]) continue;
      lines[i] = newLine;
      changes.push({ line: i + 1, role, from: modelMatch[1], to: '(omit — session model)' });
      continue;
    }

    if (modelMatch) {
      if (modelMatch[1] === target) continue;
      lines[i] = lines[i].replace(BODY_MODEL_TOKEN, `model: "${target}"`);
      changes.push({ line: i + 1, role, from: modelMatch[1], to: target });
    } else if (lines[i].includes('{')) {
      // Token was removed by an earlier inherit pass — re-insert after `{`.
      lines[i] = lines[i].replace(/\{\s*/, `{ model: "${target}", `);
      changes.push({ line: i + 1, role, from: '(omitted)', to: target });
    }
    // No token and no `{` anchor: nothing safe to rewrite — leave untouched.
  }
  return { newBody: lines.join('\n'), changes };
}

export function rewriteFrontmatter(front, newModel) {
  const lines = front.split('\n');
  let modelLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^model:\s*/.test(lines[i])) { modelLineIdx = i; break; }
  }
  if (modelLineIdx >= 0) {
    lines[modelLineIdx] = `model: ${newModel}`;
  } else {
    // Insert after `description:` if present, else at end (before trailing empty).
    let descIdx = lines.findIndex(l => /^description:\s*/.test(l));
    if (descIdx >= 0) lines.splice(descIdx + 1, 0, `model: ${newModel}`);
    else lines.push(`model: ${newModel}`);
  }
  return lines.join('\n');
}

// target 'inherit' → the model: line must not exist at all.
export function removeModelLine(front) {
  return front.split('\n').filter(l => !/^model:\s*/.test(l)).join('\n');
}

// ── Skill source resolution ─────────────────────────────────────────────

function resolveSourcePath(repoRoot, skill) {
  const standalone = join(repoRoot, `x-${skill}`, 'skills', skill, 'SKILL.md');
  if (existsSync(standalone)) return standalone;
  const xmOnly = join(repoRoot, 'xm', 'skills', skill, 'SKILL.md');
  if (existsSync(xmOnly)) return xmOnly;
  return null;
}

// ── Atomic write ────────────────────────────────────────────────────────

function writeAtomic(filePath, data) {
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, filePath);
}

// ── Main ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { check: false, profile: null, repoRoot: null, verbose: false };
  const requireValue = (flag, i) => {
    if (i + 1 >= argv.length) throw new Error(`${flag} requires a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') args.check = true;
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--profile') { args.profile = requireValue('--profile', i); i++; }
    else if (a === '--repo-root') { args.repoRoot = requireValue('--repo-root', i); i++; }
  }
  return args;
}

function findRepoRoot(startDir) {
  // Walk up from startDir until we find xm/lib/skill-model-map.json
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'xm', 'lib', 'skill-model-map.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = args.repoRoot || findRepoRoot(__dirname) || process.cwd();
  const mapPath = join(repoRoot, 'xm', 'lib', 'skill-model-map.json');

  if (!existsSync(mapPath)) {
    console.error(`❌ skill-model-map.json not found at ${mapPath}`);
    process.exit(2);
  }

  const mapping = loadMapping(mapPath);
  const profile = await loadProfile(repoRoot, args.profile);
  const profileMap = {};
  for (const [skill, entry] of Object.entries(mapping.skills)) {
    if (!entry[profile]) {
      console.warn(`⚠ ${skill}: no entry for profile "${profile}", skipping`);
      continue;
    }
    profileMap[skill] = entry[profile];
  }

  console.log(`profile: ${profile} (${args.check ? 'check' : 'apply'})`);

  const results = { updated: [], skipped: [], unchanged: [], missing: [], drift: [] };

  for (const [skill, targetModel] of Object.entries(profileMap)) {
    const path = resolveSourcePath(repoRoot, skill);
    if (!path) {
      results.missing.push({ skill });
      continue;
    }

    const text = readFileSync(path, 'utf8');
    const split = splitFrontmatter(text);
    if (!split) {
      results.skipped.push({ skill, path, reason: 'no frontmatter' });
      continue;
    }

    const parsed = parseSimple(split.front);

    // Marker check: managed:false = opt out
    if (parsed.managed === false) {
      results.skipped.push({ skill, path, reason: 'managed: false' });
      if (args.verbose) console.log(`  skip   ${skill}  (managed: false)`);
      continue;
    }

    // Frontmatter check. target 'inherit' means "no model: field at all"
    // (absence = inherit) — drift flips to "field present = drift".
    const targetIsInherit = targetModel === INHERIT;
    const frontmatterDrift = targetIsInherit
      ? parsed.model !== null
      : parsed.model !== targetModel;

    // Body markers — always evaluate
    const bodyResult = rewriteBodyModels(split.rest, profile);
    const bodyDrift = bodyResult.changes.length > 0;

    if (!frontmatterDrift && !bodyDrift) {
      results.unchanged.push({ skill, path, model: targetModel });
      if (args.verbose) console.log(`  ok     ${skill}  ${targetModel}`);
      continue;
    }

    const targetLabel = targetIsInherit ? '(remove — session model)' : targetModel;

    if (args.check) {
      results.drift.push({ skill, path, current: parsed.model, target: targetModel, body: bodyResult.changes });
      const bodyMsg = bodyDrift ? ` + ${bodyResult.changes.length} body markers` : '';
      console.log(`  DRIFT  ${skill}  ${parsed.model || '(none)'} → ${targetLabel}${bodyMsg}`);
      continue;
    }

    const newFront = frontmatterDrift
      ? (targetIsInherit ? removeModelLine(split.front) : rewriteFrontmatter(split.front, targetModel))
      : split.front;
    const newRest = bodyDrift ? bodyResult.newBody : split.rest;
    const newText = `---\n${newFront}\n---${newRest}`;
    writeAtomic(path, newText);
    results.updated.push({ skill, path, from: parsed.model, to: targetModel, bodyChanges: bodyResult.changes.length });
    const bodyMsg = bodyDrift ? ` + ${bodyResult.changes.length} body` : '';
    console.log(`  update ${skill}  ${parsed.model || '(none)'} → ${targetLabel}${bodyMsg}`);
  }

  console.log(`\nsummary: ${results.updated.length} updated, ${results.unchanged.length} unchanged, ${results.skipped.length} skipped, ${results.missing.length} missing, ${results.drift.length} drift`);

  if (args.check && results.drift.length > 0) {
    console.error('❌ drift detected — run without --check to apply');
    process.exit(1);
  }
  if (results.missing.length > 0) {
    console.error(`⚠ ${results.missing.length} skills missing source SKILL.md: ${results.missing.map(m => m.skill).join(', ')}`);
  }
}

// Run only as a CLI — guarded so tests can import the exported helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
