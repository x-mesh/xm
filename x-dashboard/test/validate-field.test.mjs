// validateField unit tests (t6, config-gap-close) — pure function, no DOM.
// Mirrors app.js's inline copy 1:1; see public/validate-field.mjs header for
// why the logic lives in both places.
import { describe, test, expect } from 'bun:test';
import '../public/validate-field.mjs'; // IIFE sets globalThis.XMValidate

const { validateField, cfgFieldSupportsUnset } = globalThis.XMValidate;

describe('validateField', () => {
  test('undefined ("unset") is always valid, regardless of entry', () => {
    expect(validateField({ key: 'mode', type: 'string', enum: ['developer', 'normal'] }, undefined)).toBeNull();
    expect(validateField({ key: 'agent_max_count', type: 'integer', min: 1, max: 10 }, undefined)).toBeNull();
    expect(validateField(null, undefined)).toBeNull();
  });

  test('enum — accepts a listed value, rejects anything else', () => {
    const entry = { key: 'mode', type: 'string', enum: ['developer', 'normal'] };
    expect(validateField(entry, 'developer')).toBeNull();
    expect(validateField(entry, 'normal')).toBeNull();
    expect(validateField(entry, 'bogus')).not.toBeNull();
  });

  test('type — integer rejects non-integers and wrong JS type', () => {
    const entry = { key: 'agent_max_count', type: 'integer', min: 1, max: 10 };
    expect(validateField(entry, 4)).toBeNull();
    expect(validateField(entry, 4.5)).not.toBeNull();
    expect(validateField(entry, '4')).not.toBeNull();
  });

  test('type — number accepts floats, rejects non-numbers', () => {
    const entry = { key: 'drift.drift_threshold', type: 'number', min: 0, max: 1 };
    expect(validateField(entry, 0.7)).toBeNull();
    expect(validateField(entry, 'x')).not.toBeNull();
    expect(validateField(entry, NaN)).not.toBeNull();
  });

  test('min/max bounds are inclusive', () => {
    const entry = { key: 'agent_max_count', type: 'integer', min: 1, max: 10 };
    expect(validateField(entry, 1)).toBeNull();
    expect(validateField(entry, 10)).toBeNull();
    expect(validateField(entry, 0)).not.toBeNull();
    expect(validateField(entry, 11)).not.toBeNull();
  });

  test('nullable — null is valid only when entry.nullable is true', () => {
    const nullableEntry = { key: 'lang', type: 'string', nullable: true, enum: ['ko', 'en'] };
    const nonNullableEntry = { key: 'mode', type: 'string', enum: ['developer', 'normal'] };
    expect(validateField(nullableEntry, null)).toBeNull();
    expect(validateField(nonNullableEntry, null)).not.toBeNull();
  });

  test('boolean nullable 3-state — unset/true/false all valid, non-boolean rejected', () => {
    const entry = { key: 'cross_vendor.default', type: 'boolean', nullable: true };
    expect(validateField(entry, undefined)).toBeNull();
    expect(validateField(entry, true)).toBeNull();
    expect(validateField(entry, false)).toBeNull();
    expect(validateField(entry, null)).toBeNull();
    expect(validateField(entry, 'true')).not.toBeNull();
  });

  test('boolean non-nullable rejects null', () => {
    const entry = { key: 'worktree.enabled', type: 'boolean' };
    expect(validateField(entry, true)).toBeNull();
    expect(validateField(entry, false)).toBeNull();
    expect(validateField(entry, null)).not.toBeNull();
  });

  test('array type', () => {
    const entry = { key: 'scan_roots', type: 'array' };
    expect(validateField(entry, [])).toBeNull();
    expect(validateField(entry, ['a', 'b'])).toBeNull();
    expect(validateField(entry, 'a')).not.toBeNull();
    expect(validateField(entry, {})).not.toBeNull();
  });

  test('object type rejects arrays and primitives', () => {
    const entry = { key: 'model_overrides', type: 'object' };
    expect(validateField(entry, {})).toBeNull();
    expect(validateField(entry, { architect: 'opus' })).toBeNull();
    expect(validateField(entry, [])).not.toBeNull();
    expect(validateField(entry, 'x')).not.toBeNull();
  });

  test('unregistered/unknown type falls through as valid (defensive default)', () => {
    expect(validateField({ key: 'x', type: 'weird-future-type' }, 'anything')).toBeNull();
  });
});

// cfgFieldSupportsUnset gates renderSchemaField's resetBtn string directly
// (`isSet && cfgFieldSupportsUnset(entry) ? '<button ...>reset</button>' : ''`
// in app.js) — asserting on the predicate is equivalent to asserting the
// button never appears in the rendered markup for a non-nullable boolean
// (review-fix F1: clicking it previously showed "will be removed on save"
// for a field save could never actually clear).
describe('cfgFieldSupportsUnset', () => {
  test('non-nullable boolean cannot represent unset — no reset button (F1)', () => {
    expect(cfgFieldSupportsUnset({ key: 'worktree.enabled', type: 'boolean' })).toBe(false);
    expect(cfgFieldSupportsUnset({ key: 'worktree.enabled', type: 'boolean', nullable: false })).toBe(false);
  });

  test('nullable boolean and every other field type support unset (reset button stays)', () => {
    expect(cfgFieldSupportsUnset({ key: 'cross_vendor.default', type: 'boolean', nullable: true })).toBe(true);
    expect(cfgFieldSupportsUnset({ key: 'mode', type: 'string', enum: ['developer', 'normal'] })).toBe(true);
    expect(cfgFieldSupportsUnset({ key: 'agent_max_count', type: 'integer' })).toBe(true);
    expect(cfgFieldSupportsUnset({ key: 'scan_roots', type: 'array' })).toBe(true);
    expect(cfgFieldSupportsUnset({ key: 'model_overrides', type: 'object' })).toBe(true);
  });

  test('missing/null entry defaults to supporting unset (defensive default, matches renderSchemaField never calling this without an entry)', () => {
    expect(cfgFieldSupportsUnset(null)).toBe(true);
    expect(cfgFieldSupportsUnset(undefined)).toBe(true);
  });
});
