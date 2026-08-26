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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, linkSync, unlinkSync, lstatSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { evalDir } from './root.mjs';
import { ASSERTION_KINDS, parseSpec } from './assert.mjs';

export const CASE_SCHEMA_V = 1;
export const RISK_LEVELS = ['normal', 'high'];
/** Ng: "testing effort calibrated relative to the risk of a mistake" — high-risk cases get more trials by default. */
export const DEFAULT_TRIALS = { normal: 3, high: 5 };
/** references/rubrics.md: every rubric's pass bar defaults to 7.0; a case can pin its own via expected.min_overall. */
export const DEFAULT_PASS_THRESHOLD = 7.0;
export const BUILTIN_PASS_THRESHOLDS = {
  'code-quality': 7.0,
  'review-quality': 7.0,
  'plan-quality': 7.0,
  general: 7.0,
  'api-design': 7.0,
  'frontend-design': 7.0,
  'data-pipeline': 7.0,
  'security-audit': 8.0,
  'architecture-review': 7.0,
};
const ID_RE = /^(case|replay)-[0-9a-f]{24}$/;
const RUBRIC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;
const MAX_PROMPT_CHARS = 20_000;
const MAX_CASE_BYTES = 256 * 1024;
const MAX_TAGS = 64;
const MAX_ASSERTIONS = 128;
const MAX_ASSERTION_CHARS = 20_000;
const MAX_JUDGE_ASSERTION_CHARS = 2_000;

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function casesDir() {
  return evalDir('cases');
}

export function caseId({ prompt, rubric, tags }) {
  return `case-${sha256(`${prompt}\0${rubric}\0${[...tags].sort().join(',')}`).slice(0, 24)}`;
}

export function passThresholdFor({ rubric, expected }) {
  if (expected && Number.isFinite(Number(expected.min_overall))) return Number(expected.min_overall);
  if (Object.hasOwn(BUILTIN_PASS_THRESHOLDS, rubric)) return BUILTIN_PASS_THRESHOLDS[rubric];
  const customPath = join(evalDir('rubrics'), `${rubric}.json`);
  if (existsSync(customPath)) {
    if (lstatSync(customPath).isSymbolicLink()) throw new Error(`custom rubric "${rubric}" must not be a symlink`);
    let custom;
    try { custom = JSON.parse(readFileSync(customPath, 'utf8')); } catch (error) { throw new Error(`custom rubric "${rubric}" is invalid JSON: ${error.message}`); }
    if (custom.pass_threshold != null) {
      if (typeof custom.pass_threshold !== 'number' || !Number.isFinite(custom.pass_threshold) || custom.pass_threshold < 0 || custom.pass_threshold > 10) {
        throw new Error(`custom rubric "${rubric}" pass_threshold must be a number between 0 and 10`);
      }
      return custom.pass_threshold;
    }
  }
  return DEFAULT_PASS_THRESHOLD;
}

export function caseFingerprint(payload) {
  return sha256(canonicalJson(payload));
}

function normalizeAssertion(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('assertion must be an object');
  if (item.kind === 'judge') {
    if (typeof item.text !== 'string') throw new Error('judge assertion text must be a string');
    const text = item.text.trim();
    if (!text) throw new Error('judge assertion needs text');
    if (text.length > MAX_JUDGE_ASSERTION_CHARS) throw new Error(`judge assertion exceeds ${MAX_JUDGE_ASSERTION_CHARS} characters`);
    return { kind: 'judge', text };
  }
  if (!ASSERTION_KINDS.includes(item.kind)) throw new Error(`unknown assertion kind "${item.kind}"`);
  const { name, spec } = parseSpec(`${item.name}=${item.spec ?? item.command ?? ''}`, item.kind);
  if (spec.length > MAX_ASSERTION_CHARS) throw new Error(`assertion spec exceeds ${MAX_ASSERTION_CHARS} characters`);
  return { kind: item.kind, name, spec };
}

function validateTaskCase(payload, expectedId) {
  if (payload.v !== CASE_SCHEMA_V) throw new Error('unsupported case schema');
  if (payload.type !== 'task') throw new Error(`case ${expectedId} must have type "task"`);
  if (payload.id !== expectedId || !ID_RE.test(String(payload.id))) throw new Error(`case id does not match file name: ${expectedId}`);
  if (typeof payload.prompt !== 'string' || !payload.prompt.trim()) throw new Error('case prompt must not be empty');
  if (payload.prompt !== payload.prompt.trim()) throw new Error('case prompt must be normalized');
  if (payload.prompt.length > MAX_PROMPT_CHARS) throw new Error(`case prompt exceeds ${MAX_PROMPT_CHARS} characters`);
  if (typeof payload.rubric !== 'string' || !RUBRIC_RE.test(payload.rubric)) throw new Error('case rubric must be a safe rubric identifier');
  if (!Array.isArray(payload.tags) || payload.tags.length > MAX_TAGS) throw new Error(`case tags must be an array of at most ${MAX_TAGS} items`);
  if (new Set(payload.tags).size !== payload.tags.length) throw new Error('case tags must not contain duplicates');
  for (const tag of payload.tags) if (typeof tag !== 'string' || !TAG_RE.test(tag)) throw new Error(`case tag "${tag}" is invalid`);
  if (!RISK_LEVELS.includes(payload.risk)) throw new Error(`case risk must be one of ${RISK_LEVELS.join('|')}`);
  if (!Array.isArray(payload.assertions) || payload.assertions.length > MAX_ASSERTIONS) throw new Error(`case assertions must be an array of at most ${MAX_ASSERTIONS} items`);
  for (const item of payload.assertions) {
    const normalized = normalizeAssertion(item);
    if (canonicalJson(normalized) !== canonicalJson(item)) throw new Error('case assertion is not in canonical schema');
  }
  if (!payload.expected || typeof payload.expected !== 'object' || Array.isArray(payload.expected)) throw new Error('case expected must be an object');
  const expectedKeys = Object.keys(payload.expected);
  if (expectedKeys.some(key => key !== 'min_overall')) throw new Error('case expected contains an unsupported field');
  if (Object.hasOwn(payload.expected, 'min_overall')) {
    const min = payload.expected.min_overall;
    if (typeof min !== 'number' || !Number.isFinite(min) || min < 0 || min > 10) throw new Error('case expected.min_overall must be a number between 0 and 10');
  }
  if (caseId(payload) !== payload.id) throw new Error(`case identity does not match prompt, rubric, and tags: ${payload.id}`);
  return payload;
}

function validateReplayCase(payload, expectedId) {
  if (payload.v !== CASE_SCHEMA_V) throw new Error('unsupported case schema');
  if (payload.type !== 'replay') throw new Error(`case ${expectedId} has an unsupported type`);
  if (payload.id !== expectedId || !ID_RE.test(String(payload.id))) throw new Error(`case id does not match file name: ${expectedId}`);
  if (typeof payload.rubric !== 'string' || !RUBRIC_RE.test(payload.rubric)) throw new Error('replay case rubric must be a safe rubric identifier');
  return payload;
}

export function validateCase(payload, expectedId = payload?.id) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('case must be a JSON object');
  return payload.type === 'replay' ? validateReplayCase(payload, expectedId) : validateTaskCase(payload, expectedId);
}

/** Build and validate a task case payload. Throws on anything malformed. */
export function buildCase({ prompt, rubric = 'general', tags = [], risk = 'normal', assertions = [], minOverall = null, source = null, createdAt = new Date().toISOString() }) {
  const text = String(prompt ?? '').trim();
  if (!text) throw new Error('case prompt must not be empty');
  if (text.length > MAX_PROMPT_CHARS) throw new Error(`case prompt exceeds ${MAX_PROMPT_CHARS} characters`);
  if (!RUBRIC_RE.test(String(rubric))) throw new Error(`rubric must be a safe rubric identifier (got "${rubric}")`);
  if (!Array.isArray(tags)) throw new Error('tags must be an array');
  const tagList = [...new Set(tags.map(t => String(t).trim()).filter(Boolean))].sort();
  if (tagList.length > MAX_TAGS) throw new Error(`case tags exceed ${MAX_TAGS} items`);
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
    assertions: (() => {
      if (!Array.isArray(assertions) || assertions.length > MAX_ASSERTIONS) throw new Error(`case assertions must be an array of at most ${MAX_ASSERTIONS} items`);
      return assertions.map(normalizeAssertion);
    })(),
    expected,
    created_at: createdAt,
    source: source && typeof source === 'object' ? { plugin: String(source.plugin || 'manual'), ref: source.ref ?? null } : { plugin: 'manual', ref: null },
  };
  return validateCase(payload, payload.id);
}

/** Create-only write (link(2)): identical concurrent adds are idempotent, never torn. */
export function writeCase(payload) {
  validateCase(payload, payload?.id);
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
      let existing;
      try { existing = JSON.parse(readFileSync(target, 'utf8')); } catch { throw new Error('existing x-eval case is corrupt'); }
      validateCase(existing, payload.id);
      const comparable = value => caseFingerprint({ ...value, created_at: null });
      if (comparable(existing) !== comparable(payload)) throw new Error(`case id collision for ${payload.id}: existing payload differs`);
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
  if (!statSync(path).isFile()) throw new Error('x-eval case path is not a regular file');
  if (statSync(path).size > MAX_CASE_BYTES) throw new Error(`x-eval case exceeds ${MAX_CASE_BYTES} bytes`);
  let payload;
  try { payload = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { throw new Error(`x-eval case is invalid JSON: ${error.message}`); }
  return validateCase(payload, id);
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
    const type = payload.type;
    const tags = Array.isArray(payload.tags) ? payload.tags : [];
    const requestedTags = Array.isArray(tag) ? tag : (tag ? [tag] : []);
    if (requestedTags.some(requested => !tags.includes(requested))) continue;
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
