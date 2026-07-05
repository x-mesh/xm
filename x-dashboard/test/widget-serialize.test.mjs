// Structured object-widget serialization/diff unit tests (t7, config-gap-close)
// — pure functions, no DOM. Mirrors app.js's inline copies 1:1; see
// public/widget-serialize.mjs header for why the logic lives in both places.
import { describe, test, expect } from 'bun:test';
import '../public/widget-serialize.mjs'; // IIFE sets globalThis.XMWidgetSerialize

const {
  GATE_POLICY_ROWS,
  SEVERITY_VALUES,
  CFG_INHERIT_TIER,
  isKnownSeverityArray,
  cfgModelOverrideTiers,
  diffFlatObjectSubkeys,
  flattenTwoLevel,
  rowsToFlatObject,
  rowsToVendorModelsObject,
  buildGatePolicyObject,
  cfgResolveScalarFieldOp,
} = globalThis.XMWidgetSerialize;

describe('isKnownSeverityArray', () => {
  test('accepts an array of only known severities, including empty', () => {
    expect(isKnownSeverityArray(['critical', 'high'])).toBe(true);
    expect(isKnownSeverityArray([])).toBe(true);
    expect(isKnownSeverityArray(SEVERITY_VALUES)).toBe(true);
  });
  test('rejects an unknown severity string, wrong type, or non-array', () => {
    expect(isKnownSeverityArray(['critical', 'weird'])).toBe(false);
    expect(isKnownSeverityArray('critical')).toBe(false);
    expect(isKnownSeverityArray({ critical: true })).toBe(false);
    expect(isKnownSeverityArray(undefined)).toBe(false);
    expect(isKnownSeverityArray(null)).toBe(false);
  });
});

describe('cfgModelOverrideTiers', () => {
  test('appends inherit to server-provided billable tiers', () => {
    expect(cfgModelOverrideTiers(['haiku', 'sonnet', 'opus'])).toEqual(['haiku', 'sonnet', 'opus', 'inherit']);
  });
  test('falls back to the 3-tier default when routing is unavailable, still appending inherit', () => {
    expect(cfgModelOverrideTiers(undefined)).toEqual(['haiku', 'sonnet', 'opus', CFG_INHERIT_TIER]);
    expect(cfgModelOverrideTiers(null)).toEqual(['haiku', 'sonnet', 'opus', 'inherit']);
  });
});

describe('diffFlatObjectSubkeys', () => {
  const prefix = 'worktree.gate_policy';

  test('unchanged leaf (matches loaded) produces no ops', () => {
    const loaded = { allow_low: true };
    const { setOps, deleteOps } = diffFlatObjectSubkeys(prefix, { allow_low: true }, loaded, {});
    expect(setOps).toEqual({});
    expect(deleteOps).toEqual([]);
  });

  test('leaf unset at this tier but matching the effective default produces no ops', () => {
    const effective = { allow_low: true };
    const { setOps, deleteOps } = diffFlatObjectSubkeys(prefix, { allow_low: true }, {}, effective);
    expect(setOps).toEqual({});
    expect(deleteOps).toEqual([]);
  });

  test('changed leaf emits a dotted _set, preserving other keys (sibling preservation)', () => {
    const loaded = { block_confirmed: ['critical'], block_unreviewed: ['critical', 'high'] };
    const edited = { block_confirmed: ['critical', 'high'], block_unreviewed: ['critical', 'high'] };
    const { setOps, deleteOps } = diffFlatObjectSubkeys(prefix, edited, loaded, {});
    expect(setOps).toEqual({ 'worktree.gate_policy.block_confirmed': ['critical', 'high'] });
    expect(deleteOps).toEqual([]);
  });

  test('leaf removed from edited (not just blanked) emits a delete', () => {
    const loaded = { allow_low: false, block_confirmed: ['critical'] };
    const edited = { block_confirmed: ['critical'] };
    const { setOps, deleteOps } = diffFlatObjectSubkeys(prefix, edited, loaded, {});
    expect(setOps).toEqual({});
    expect(deleteOps).toEqual(['worktree.gate_policy.allow_low']);
  });

  test('unknown/preserved keys diff exactly like known ones', () => {
    const loaded = { some_future_key: ['x'] };
    const edited = { some_future_key: ['x', 'y'] };
    const { setOps } = diffFlatObjectSubkeys(prefix, edited, loaded, {});
    expect(setOps).toEqual({ 'worktree.gate_policy.some_future_key': ['x', 'y'] });
  });

  test('null/undefined inputs behave as empty objects', () => {
    expect(diffFlatObjectSubkeys(prefix, undefined, undefined, undefined)).toEqual({ setOps: {}, deleteOps: [] });
    expect(diffFlatObjectSubkeys(prefix, null, null, null)).toEqual({ setOps: {}, deleteOps: [] });
  });
});

describe('flattenTwoLevel', () => {
  test('flattens vendor -> tier -> spec into dotted leaves', () => {
    expect(flattenTwoLevel({ claude: { haiku: 'haiku', sonnet: 'sonnet' }, codex: { opus: 'gpt-5.5:high' } }))
      .toEqual({ 'claude.haiku': 'haiku', 'claude.sonnet': 'sonnet', 'codex.opus': 'gpt-5.5:high' });
  });
  test('skips a malformed (non-object) vendor entry instead of crashing', () => {
    expect(flattenTwoLevel({ claude: { haiku: 'haiku' }, broken: 'not-an-object' }))
      .toEqual({ 'claude.haiku': 'haiku' });
  });
  test('non-object / array / null input yields an empty object', () => {
    expect(flattenTwoLevel(null)).toEqual({});
    expect(flattenTwoLevel(undefined)).toEqual({});
    expect(flattenTwoLevel([])).toEqual({});
    expect(flattenTwoLevel('x')).toEqual({});
  });
});

describe('rowsToFlatObject (model_overrides / vendor_profiles row editors)', () => {
  test('builds an object from key/value rows', () => {
    expect(rowsToFlatObject([{ key: 'architect', value: 'opus' }, { key: 'executor', value: 'sonnet' }]))
      .toEqual({ architect: 'opus', executor: 'sonnet' });
  });
  test('drops rows with a blank key', () => {
    expect(rowsToFlatObject([{ key: '  ', value: 'opus' }, { key: 'executor', value: 'sonnet' }]))
      .toEqual({ executor: 'sonnet' });
  });
  test('drops rows with a blank/undefined/null value ("(unset)" selection)', () => {
    expect(rowsToFlatObject([
      { key: 'architect', value: '' },
      { key: 'planner', value: undefined },
      { key: 'critic', value: null },
      { key: 'executor', value: 'sonnet' },
    ])).toEqual({ executor: 'sonnet' });
  });
  test('trims whitespace around keys', () => {
    expect(rowsToFlatObject([{ key: '  executor  ', value: 'sonnet' }])).toEqual({ executor: 'sonnet' });
  });
  test('empty/missing input yields an empty object', () => {
    expect(rowsToFlatObject([])).toEqual({});
    expect(rowsToFlatObject(undefined)).toEqual({});
  });
});

describe('rowsToVendorModelsObject', () => {
  test('builds a nested vendor -> tier -> spec object', () => {
    expect(rowsToVendorModelsObject([
      { vendor: 'codex', tiers: { haiku: 'gpt-5.4-mini', sonnet: 'gpt-5.4', opus: '' } },
    ])).toEqual({ codex: { haiku: 'gpt-5.4-mini', sonnet: 'gpt-5.4' } });
  });
  test('drops a vendor row with a blank vendor name', () => {
    expect(rowsToVendorModelsObject([{ vendor: '  ', tiers: { haiku: 'x' } }])).toEqual({});
  });
  test('drops a vendor row left with zero populated tiers (round-trips a full-row delete)', () => {
    expect(rowsToVendorModelsObject([{ vendor: 'codex', tiers: { haiku: '', sonnet: '  ', opus: '' } }])).toEqual({});
  });
  test('trims whitespace around vendor name and tier specs', () => {
    expect(rowsToVendorModelsObject([{ vendor: ' codex ', tiers: { haiku: ' gpt-5.4-mini ' } }]))
      .toEqual({ codex: { haiku: 'gpt-5.4-mini' } });
  });
});

describe('buildGatePolicyObject', () => {
  test('merges known fields over preserved unknown keys', () => {
    const known = { block_confirmed: ['critical'], block_unreviewed: [], block_contested: [], allow_low: true };
    const otherRaw = { some_future_key: ['x'] };
    expect(buildGatePolicyObject(known, otherRaw)).toEqual({ ...otherRaw, ...known });
  });
  test('known fields win on key collision (should not normally happen, but merge direction is deterministic)', () => {
    const known = { allow_low: false };
    const otherRaw = { allow_low: true };
    expect(buildGatePolicyObject(known, otherRaw)).toEqual({ allow_low: false });
  });
  test('missing/non-object otherRaw degrades to just the known fields', () => {
    const known = { allow_low: true };
    expect(buildGatePolicyObject(known, undefined)).toEqual({ allow_low: true });
    expect(buildGatePolicyObject(known, null)).toEqual({ allow_low: true });
    expect(buildGatePolicyObject(known, [])).toEqual({ allow_low: true });
  });
});

describe('cfgResolveScalarFieldOp (review-fix F2: blank string/array vs. never-set ambiguity)', () => {
  const stringEntry = { key: 'worktree.branch_prefix', type: 'string' };
  const arrayEntry = { key: 'scan_roots', type: 'array' };
  const boolEntry = { key: 'worktree.enabled', type: 'boolean' };

  test('wasSet + unchanged blank string is preserved — no _delete, no _set (regression: reset used to wipe it)', () => {
    const op = cfgResolveScalarFieldOp(stringEntry, {
      wasSet: true, unsetFlagged: false, value: '', loadedValue: '', effectiveValue: null,
    });
    expect(op).toEqual({ kind: 'skip' });
  });

  test('wasSet + unchanged empty array is preserved — no _delete, no _set', () => {
    const op = cfgResolveScalarFieldOp(arrayEntry, {
      wasSet: true, unsetFlagged: false, value: [], loadedValue: [], effectiveValue: null,
    });
    expect(op).toEqual({ kind: 'skip' });
  });

  test('reset sentinel on a previously-set field emits a delete regardless of the (also blank) control value', () => {
    const op = cfgResolveScalarFieldOp(stringEntry, {
      wasSet: true, unsetFlagged: true, value: '', loadedValue: 'was-set', effectiveValue: null,
    });
    expect(op).toEqual({ kind: 'delete' });
  });

  test('reset sentinel on a field that was never set is a no-op (nothing to delete)', () => {
    const op = cfgResolveScalarFieldOp(stringEntry, {
      wasSet: false, unsetFlagged: true, value: '', loadedValue: undefined, effectiveValue: null,
    });
    expect(op).toEqual({ kind: 'skip' });
  });

  test('never-set field left blank stays unset (no spurious empty-string override)', () => {
    const op = cfgResolveScalarFieldOp(stringEntry, {
      wasSet: false, unsetFlagged: false, value: '', loadedValue: undefined, effectiveValue: null,
    });
    expect(op).toEqual({ kind: 'skip' });
  });

  test('never-set array left blank stays unset', () => {
    const op = cfgResolveScalarFieldOp(arrayEntry, {
      wasSet: false, unsetFlagged: false, value: [], loadedValue: undefined, effectiveValue: null,
    });
    expect(op).toEqual({ kind: 'skip' });
  });

  test('never-set field given a real value is set (normal new-override path still works)', () => {
    const op = cfgResolveScalarFieldOp(stringEntry, {
      wasSet: false, unsetFlagged: false, value: 'feature/', loadedValue: undefined, effectiveValue: null,
    });
    expect(op).toEqual({ kind: 'set', value: 'feature/' });
  });

  test('wasSet string explicitly changed to a new value is set', () => {
    const op = cfgResolveScalarFieldOp(stringEntry, {
      wasSet: true, unsetFlagged: false, value: 'new-value', loadedValue: 'old-value', effectiveValue: null,
    });
    expect(op).toEqual({ kind: 'set', value: 'new-value' });
  });

  test('non-string/array blank value (e.g. integer/enum "unset" reading) still deletes/skips via the undefined path', () => {
    const numEntry = { key: 'agent_max_count', type: 'integer' };
    expect(cfgResolveScalarFieldOp(numEntry, { wasSet: true, unsetFlagged: false, value: undefined, loadedValue: 5, effectiveValue: null }))
      .toEqual({ kind: 'delete' });
    expect(cfgResolveScalarFieldOp(numEntry, { wasSet: false, unsetFlagged: false, value: undefined, loadedValue: undefined, effectiveValue: null }))
      .toEqual({ kind: 'skip' });
  });

  test('untouched non-nullable checkbox showing the effective default is skipped (pre-existing behavior, unaffected by F2)', () => {
    const op = cfgResolveScalarFieldOp(boolEntry, {
      wasSet: false, unsetFlagged: false, value: true, loadedValue: undefined, effectiveValue: true,
    });
    expect(op).toEqual({ kind: 'skip' });
  });

  test('checkbox toggled away from the effective default is set', () => {
    const op = cfgResolveScalarFieldOp(boolEntry, {
      wasSet: false, unsetFlagged: false, value: false, loadedValue: undefined, effectiveValue: true,
    });
    expect(op).toEqual({ kind: 'set', value: false });
  });
});

describe('GATE_POLICY_ROWS / SEVERITY_VALUES constants', () => {
  test('mirror the CLI vocabulary (shared-config.mjs GATE_POLICY_SEVERITY_KEYS / SEVERITY_VALUES)', () => {
    expect(GATE_POLICY_ROWS).toEqual(['block_confirmed', 'block_unreviewed', 'block_contested']);
    expect(SEVERITY_VALUES).toEqual(['critical', 'high', 'medium', 'low']);
  });
});
