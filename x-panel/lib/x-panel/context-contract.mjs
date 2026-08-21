// Keep this module byte-for-byte aligned with x-review/skills/review/scripts/context-contract.mjs.
// x-panel is independently packaged, so it cannot import a sibling plugin at runtime.
import { createHash } from 'node:crypto';

export const REVIEW_CONTEXT_SCHEMA_VERSION = 1;
export const REVIEW_CONTEXT_MAX_BYTES = 64 * 1024;
const ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const TOP_LEVEL_KEYS = new Set(['schema_version', 'goal', 'invariants', 'constraints', 'non_goals', 'acceptance_checks', 'provenance']);
const PROVENANCE_KEYS = new Set(['source', 'created_by', 'created_at']);

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function cleanText(value, field, { max = 4000 } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`review context ${field} must be a non-empty string`);
  const text = value.trim();
  if (text.length > max) throw new Error(`review context ${field} exceeds ${max} characters`);
  return text;
}

function cleanItems(value, field, { required = false } = {}) {
  if (!Array.isArray(value) || (required && value.length === 0)) throw new Error(`review context ${field} must be ${required ? 'a non-empty' : 'an'} array`);
  if (value.length > 100) throw new Error(`review context ${field} exceeds 100 items`);
  const ids = new Set();
  return value.map((item, index) => {
    if (!plainObject(item)) throw new Error(`review context ${field}[${index}] must be an object`);
    if (Object.keys(item).some((key) => !['id', 'text'].includes(key))) throw new Error(`review context ${field}[${index}] contains unknown fields`);
    const id = cleanText(item.id, `${field}[${index}].id`, { max: 64 });
    if (!ID_RE.test(id) || ids.has(id)) throw new Error(`review context ${field}[${index}].id is invalid or duplicate`);
    ids.add(id);
    return { id, text: cleanText(item.text, `${field}[${index}].text`) };
  });
}

function cleanAcceptanceChecks(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('review context acceptance_checks must be a non-empty array');
  if (value.length > 100) throw new Error('review context acceptance_checks exceeds 100 items');
  const ids = new Set();
  return value.map((item, index) => {
    if (!plainObject(item)) throw new Error(`review context acceptance_checks[${index}] must be an object`);
    if (Object.keys(item).some((key) => !['id', 'description', 'command'].includes(key))) throw new Error(`review context acceptance_checks[${index}] contains unknown fields`);
    const id = cleanText(item.id, `acceptance_checks[${index}].id`, { max: 64 });
    if (!ID_RE.test(id) || ids.has(id)) throw new Error(`review context acceptance_checks[${index}].id is invalid or duplicate`);
    ids.add(id);
    const result = { id, description: cleanText(item.description, `acceptance_checks[${index}].description`) };
    if (item.command !== undefined) result.command = cleanText(item.command, `acceptance_checks[${index}].command`, { max: 2000 });
    return result;
  });
}

export function normalizeReviewContext(value) {
  if (!plainObject(value)) throw new Error('review context must be a JSON object');
  const unknown = Object.keys(value).filter((key) => !TOP_LEVEL_KEYS.has(key));
  if (unknown.length) throw new Error(`review context contains unknown fields: ${unknown.join(', ')}`);
  if (value.schema_version !== REVIEW_CONTEXT_SCHEMA_VERSION) throw new Error('review context schema_version must be 1');
  const normalized = {
    schema_version: REVIEW_CONTEXT_SCHEMA_VERSION,
    goal: cleanText(value.goal, 'goal'),
    invariants: cleanItems(value.invariants, 'invariants', { required: true }),
    constraints: cleanItems(value.constraints, 'constraints'),
    non_goals: cleanItems(value.non_goals, 'non_goals'),
    acceptance_checks: cleanAcceptanceChecks(value.acceptance_checks),
  };
  if (value.provenance !== undefined) {
    if (!plainObject(value.provenance) || Object.keys(value.provenance).some((key) => !PROVENANCE_KEYS.has(key))) throw new Error('review context provenance must contain only source, created_by, and created_at');
    normalized.provenance = {};
    for (const key of ['source', 'created_by', 'created_at']) {
      if (value.provenance[key] !== undefined) normalized.provenance[key] = cleanText(value.provenance[key], `provenance.${key}`, { max: 500 });
    }
  }
  if (Buffer.byteLength(JSON.stringify(normalized)) > REVIEW_CONTEXT_MAX_BYTES) throw new Error(`review context exceeds ${REVIEW_CONTEXT_MAX_BYTES} bytes`);
  return normalized;
}

function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortCanonical(value[key])]));
}

export function canonicalReviewContext(value) {
  return JSON.stringify(sortCanonical(normalizeReviewContext(value)));
}

export function hashReviewContext(value) {
  return `sha256:${createHash('sha256').update(canonicalReviewContext(value)).digest('hex')}`;
}
