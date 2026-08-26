/**
 * x-eval/cases — the persistent case set under `.xm/eval/cases/`.
 *
 * A case is a fixed input the same strategies get re-run against: prompt text
 * (user-authored — this is the one place x-eval stores text on purpose),
 * rubric, tags, a risk level, executable/judge assertions, and the pass bar.
 * Its id is a hash of prompt+rubric+tags, so `case add` is idempotent and two
 * machines adding the same case produce the same file.
 *
 * `xm trace replay --promote-to-eval` writes `replay-*` cases into the same
 * directory with metadata only. They are listed here but never planned into a
 * bench run: they carry no prompt, so there is nothing to re-run.
 *
 * Zero-dependency: node builtins + sibling modules only.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, linkSync, unlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { evalDir } from './root.mjs';
import { ASSERTION_KINDS, parseSpec } from './assert.mjs';

export const CASE_SCHEMA_V = 1;
export const RISK_LEVELS = ['normal', 'high'];
/** Ng: "testing effort calibrated relative to the risk of a mistake" — high-risk cases get more trials by default. */
export const DEFAULT_TRIALS = { normal: 3, high: 5 };
/** references/rubrics.md: every rubric's pass bar defaults to 7.0; a case can pin its own via expected.min_overall. */
export const DEFAULT_PASS_THRESHOLD = 7.0;
const ID_RE = /^(case|replay)-[0-9a-f]{24}$/;
const RUBRIC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;
const MAX_PROMPT_CHARS = 20_000;

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');

export function casesDir() {
  return evalDir('cases');
}

export function caseId({ prompt, rubric, tags }) {
  return `case-${sha256(`${prompt}\0${rubric}\0${[...tags].sort().join(',')}`).slice(0, 24)}`;
}

export function passThresholdFor({ rubric, expected }) {
  if (expected && Number.isFinite(Number(expected.min_overall))) return Number(expected.min_overall);
  return DEFAULT_PASS_THRESHOLD;
}

function normalizeAssertion(item) {
  if (!item || typeof item !== 'object') throw new Error('assertion must be an object');
  if (item.kind === 'judge') {
    const text = String(item.text || '').trim();
    if (!text) throw new Error('judge assertion needs text');
    return { kind: 'judge', text };
  }
  if (!ASSERTION_KINDS.includes(item.kind)) throw new Error(`unknown assertion kind "${item.kind}"`);
  const { name, spec } = parseSpec(`${item.name}=${item.spec ?? item.command ?? ''}`, item.kind);
  return { kind: item.kind, name, spec };
}

/** Build and validate a task case payload. Throws on anything malformed. */
export function buildCase({ prompt, rubric = 'general', tags = [], risk = 'normal', assertions = [], minOverall = null, source = null, createdAt = new Date().toISOString() }) {
  const text = String(prompt ?? '').trim();
  if (!text) throw new Error('case prompt must not be empty');
  if (text.length > MAX_PROMPT_CHARS) throw new Error(`case prompt exceeds ${MAX_PROMPT_CHARS} characters`);
  if (!RUBRIC_RE.test(String(rubric))) throw new Error(`rubric must be a safe rubric identifier (got "${rubric}")`);
  const tagList = [...new Set((tags || []).map(t => String(t).trim()).filter(Boolean))];
  for (const tag of tagList) if (!TAG_RE.test(tag)) throw new Error(`tag "${tag}" must match ${TAG_RE}`);
  if (!RISK_LEVELS.includes(risk)) throw new Error(`risk must be one of ${RISK_LEVELS.join('|')}`);
  const expected = {};
  if (minOverall != null) {
    const n = Number(minOverall);
    if (!(n >= 0 && n <= 10)) throw new Error('--min-overall must be between 0 and 10');
    expected.min_overall = n;
  }
  const payload = {
    v: CASE_SCHEMA_V,
    type: 'task',
    id: caseId({ prompt: text, rubric, tags: tagList }),
    prompt: text,
    rubric,
    tags: tagList,
    risk,
    assertions: assertions.map(normalizeAssertion),
    expected,
    created_at: createdAt,
    source: source && typeof source === 'object' ? { plugin: String(source.plugin || 'manual'), ref: source.ref ?? null } : { plugin: 'manual', ref: null },
  };
  return payload;
}

/** Create-only write (link(2)): identical concurrent adds are idempotent, never torn. */
export function writeCase(payload) {
  const dir = casesDir();
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${payload.id}.json`);
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error('x-eval case path must not be a symlink');
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    try {
      linkSync(tmp, target);
      return { id: payload.id, path: target, created: true };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile()) throw new Error('x-eval case path is not a regular file');
      try { JSON.parse(readFileSync(target, 'utf8')); } catch { throw new Error('existing x-eval case is corrupt'); }
      return { id: payload.id, path: target, created: false };
    }
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

export function readCase(id) {
  if (!ID_RE.test(String(id))) throw new Error(`invalid case id "${id}"`);
  const path = join(casesDir(), `${id}.json`);
  if (!existsSync(path)) return null;
  if (lstatSync(path).isSymbolicLink()) throw new Error('x-eval case path must not be a symlink');
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Every case on disk, malformed files reported instead of thrown away silently. */
export function listCases({ tag = null } = {}) {
  const dir = casesDir();
  if (!existsSync(dir)) return { cases: [], invalid: [] };
  const cases = [];
  const invalid = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (!ID_RE.test(id)) { invalid.push({ file: name, reason: 'unexpected file name' }); continue; }
    let payload;
    try { payload = readCase(id); } catch (error) { invalid.push({ file: name, reason: error.message }); continue; }
    if (!payload || payload.v !== CASE_SCHEMA_V) { invalid.push({ file: name, reason: 'unsupported schema' }); continue; }
    const type = payload.type === 'replay' ? 'replay' : 'task';
    const tags = Array.isArray(payload.tags) ? payload.tags : [];
    if (tag && !tags.includes(tag)) continue;
    cases.push({
      id: payload.id,
      type,
      rubric: payload.rubric || 'general',
      tags,
      risk: payload.risk || 'normal',
      status: type === 'replay' ? (payload.status || 'awaiting_result') : 'ready',
      created_at: payload.created_at || null,
      prompt_preview: type === 'task' ? String(payload.prompt || '').slice(0, 80) : null,
      assertions: Array.isArray(payload.assertions) ? payload.assertions.length : 0,
    });
  }
  return { cases, invalid };
}

/**
 * Resolve `--set` for bench plan: `all`, a tag, or a comma list of ids.
 * Only task cases are runnable; replay cases are reported as skipped.
 */
export function selectCases(set) {
  const value = String(set || '').trim();
  if (!value) throw new Error('--set is required: all | <tag> | <case-id>,<case-id>');
  const { cases, invalid } = listCases();
  let picked;
  if (value === 'all') picked = cases;
  else if (value.split(',').every(part => ID_RE.test(part.trim()))) {
    const wanted = value.split(',').map(part => part.trim());
    const byId = new Map(cases.map(c => [c.id, c]));
    const missing = wanted.filter(id => !byId.has(id));
    if (missing.length) throw new Error(`unknown case id(s): ${missing.join(', ')}`);
    picked = wanted.map(id => byId.get(id));
  } else picked = cases.filter(c => c.tags.includes(value));
  const skipped = picked.filter(c => c.type !== 'task').map(c => ({ id: c.id, reason: 'replay case has no prompt' }));
  const runnable = picked.filter(c => c.type === 'task').map(c => readCase(c.id));
  if (!runnable.length) throw new Error(`no runnable task cases match --set ${value}${skipped.length ? ` (${skipped.length} replay case(s) skipped)` : ''}`);
  return { cases: runnable, skipped, invalid };
}
