/**
 * cost-engine.mjs — vendor abstraction layer unit tests (t1)
 *
 * Covers the opt-in vendor layer added on top of the canonical tier vocabulary:
 *   - parseModelSpec       ("model[:effort]" parsing + effort validation)
 *   - resolveVendorModel   (config → builtin → claude passthrough → null+warning)
 *   - costFromTokensVendor  (vendor-nested pricing + loud fallback)
 *   - VENDOR_MODELS / MODEL_COSTS_BY_VENDOR table shape + backward-compat
 *   - getModelForRole still returns the existing haiku/sonnet/opus vocabulary
 *
 * These functions are pure (no ROOT / filesystem dependency), but we keep the
 * dynamic-import-after-X_BUILD_ROOT pattern for parity with cost-engine.test.mjs.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORIG_X_BUILD_ROOT = process.env.X_BUILD_ROOT;
const TEST_ROOT = mkdtempSync(join(tmpdir(), 'xb-ce-vendor-'));
process.env.X_BUILD_ROOT = TEST_ROOT;

const ce = await import('../x-build/lib/x-build/cost-engine.mjs');

afterAll(() => {
  if (ORIG_X_BUILD_ROOT !== undefined) {
    process.env.X_BUILD_ROOT = ORIG_X_BUILD_ROOT;
  } else {
    delete process.env.X_BUILD_ROOT;
  }
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

// ── 1. parseModelSpec ─────────────────────────────────────────────────────────

describe('parseModelSpec', () => {
  test('no colon — whole string is the model, no effort, no warning', () => {
    expect(ce.parseModelSpec('gpt-5.4')).toEqual({ model: 'gpt-5.4', effort: null, warning: null });
  });

  test('valid effort suffix is split out', () => {
    expect(ce.parseModelSpec('gpt-5.5:high')).toEqual({ model: 'gpt-5.5', effort: 'high', warning: null });
  });

  test('every MODEL_EFFORT_LEVELS value parses as a valid effort', () => {
    for (const level of ce.MODEL_EFFORT_LEVELS) {
      const r = ce.parseModelSpec(`m:${level}`);
      expect(r.effort).toBe(level);
      expect(r.warning).toBeNull();
    }
  });

  test('typo effort — model kept, effort null, warning set (FM2)', () => {
    const r = ce.parseModelSpec('gpt-5.5:hihg');
    expect(r.model).toBe('gpt-5.5');
    expect(r.effort).toBeNull();
    expect(r.warning).toContain('unknown effort');
    expect(r.warning).toContain('hihg');
  });

  test('multiple colons — only the LAST segment is the effort candidate', () => {
    // valid trailing effort → model is everything before the last colon
    expect(ce.parseModelSpec('a:b:high')).toEqual({ model: 'a:b', effort: 'high', warning: null });
    // invalid trailing segment → model still the prefix, warning set
    const r = ce.parseModelSpec('a:b:c');
    expect(r.model).toBe('a:b');
    expect(r.effort).toBeNull();
    expect(r.warning).toContain('unknown effort');
  });

  test('empty string — safe null result with warning', () => {
    const r = ce.parseModelSpec('');
    expect(r.model).toBeNull();
    expect(r.effort).toBeNull();
    expect(r.warning).toContain('non-empty string');
  });

  test('whitespace-only string — treated as empty', () => {
    expect(ce.parseModelSpec('   ').model).toBeNull();
  });

  test('non-string inputs are handled safely', () => {
    for (const bad of [null, undefined, 123, {}, []]) {
      const r = ce.parseModelSpec(bad);
      expect(r.model).toBeNull();
      expect(r.effort).toBeNull();
      expect(typeof r.warning).toBe('string');
    }
  });

  test('leading colon — empty model is rejected with a warning', () => {
    const r = ce.parseModelSpec(':high');
    expect(r.model).toBeNull();
    expect(r.warning).toContain('empty model');
  });

  test('trailing colon — model kept, effort null, warning about trailing colon', () => {
    const r = ce.parseModelSpec('gpt-5.4:');
    expect(r.model).toBe('gpt-5.4');
    expect(r.effort).toBeNull();
    expect(r.warning).toContain("trailing ':'");
  });

  test('surrounding whitespace is trimmed before parsing', () => {
    expect(ce.parseModelSpec('  gpt-5.5:high  ')).toEqual({ model: 'gpt-5.5', effort: 'high', warning: null });
  });
});

// ── 2. resolveVendorModel ─────────────────────────────────────────────────────

describe('resolveVendorModel', () => {
  test('config override wins over the built-in table', () => {
    const cfg = { vendor_models: { codex: { opus: 'gpt-5.5:xhigh' } } };
    const r = ce.resolveVendorModel('opus', 'codex', cfg);
    expect(r.spec).toBe('gpt-5.5:xhigh');
    expect(r.source).toBe('config');
    expect(r.warning).toBeNull();
  });

  test('built-in vendor table resolves codex tiers', () => {
    expect(ce.resolveVendorModel('haiku', 'codex', {})).toMatchObject({ spec: 'gpt-5.4-mini', source: 'builtin' });
    expect(ce.resolveVendorModel('sonnet', 'codex', {})).toMatchObject({ spec: 'gpt-5.4', source: 'builtin' });
    expect(ce.resolveVendorModel('opus', 'codex', {})).toMatchObject({ spec: 'gpt-5.5:high', source: 'builtin' });
  });

  test('claude vendor maps each tier to itself via the built-in table', () => {
    for (const tier of ['haiku', 'sonnet', 'opus']) {
      const r = ce.resolveVendorModel(tier, 'claude', {});
      expect(r.spec).toBe(tier);
      expect(r.warning).toBeNull();
    }
  });

  test('claude passthrough returns an unknown tier as-is (no warning)', () => {
    const r = ce.resolveVendorModel('some-raw-model', 'claude', {});
    expect(r.spec).toBe('some-raw-model');
    expect(r.source).toBe('claude-passthrough');
    expect(r.warning).toBeNull();
  });

  test('defaults to claude vendor when vendor is omitted', () => {
    expect(ce.resolveVendorModel('sonnet').spec).toBe('sonnet');
  });

  test('FM1: unknown vendor → null spec + warning so caller can fall back to claude', () => {
    const r = ce.resolveVendorModel('opus', 'gemini', {});
    expect(r.spec).toBeNull();
    expect(r.source).toBeNull();
    expect(r.warning).toContain('gemini');
    expect(r.warning).toContain('fall back to claude');
  });

  test('FM1: known vendor but unknown tier → null spec + warning', () => {
    const r = ce.resolveVendorModel('mega', 'codex', {});
    expect(r.spec).toBeNull();
    expect(r.warning).toContain('mega');
  });

  test('FM7: non-object vendor_models is ignored with a warning, still resolves via built-in', () => {
    for (const bad of ['nope', 42, ['x']]) {
      const r = ce.resolveVendorModel('opus', 'codex', { vendor_models: bad });
      expect(r.spec).toBe('gpt-5.5:high'); // fell through to built-in
      expect(r.source).toBe('builtin');
      expect(r.warning).toContain('must be an object');
    }
  });

  test('invalid override value (non-string) is ignored and falls through to built-in', () => {
    const cfg = { vendor_models: { codex: { opus: 123 } } };
    const r = ce.resolveVendorModel('opus', 'codex', cfg);
    expect(r.spec).toBe('gpt-5.5:high');
    expect(r.source).toBe('builtin');
    expect(r.warning).toContain('not a non-empty string');
  });

  test('config override for claude vendor is honored', () => {
    const cfg = { vendor_models: { claude: { opus: 'claude-opus-custom' } } };
    expect(ce.resolveVendorModel('opus', 'claude', cfg).spec).toBe('claude-opus-custom');
  });
});

// ── 3. costFromTokensVendor ───────────────────────────────────────────────────

describe('costFromTokensVendor', () => {
  test('claude/sonnet pricing matches the flat costFromTokens path', () => {
    const { cost_usd, warning } = ce.costFromTokensVendor('claude', 'sonnet', 1_000_000, 500_000);
    expect(cost_usd).toBeCloseTo(ce.costFromTokens('sonnet', 1_000_000, 500_000), 6);
    expect(cost_usd).toBeCloseTo(10.5, 6);
    expect(warning).toBeNull();
  });

  test('codex/opus uses the vendor-nested price table', () => {
    // opus (gpt-5.5:high) approx: input 2.50, output 20.00 per 1M
    const { cost_usd, warning } = ce.costFromTokensVendor('codex', 'opus', 1_000_000, 1_000_000);
    expect(cost_usd).toBeCloseTo(2.5 + 20.0, 6);
    expect(warning).toBeNull();
  });

  test('FM4: unknown vendor falls back to claude/sonnet pricing WITH a warning', () => {
    const { cost_usd, warning } = ce.costFromTokensVendor('gemini', 'opus', 1_000_000, 0);
    expect(cost_usd).toBeCloseTo(3.0, 6); // sonnet input price
    expect(warning).toContain('unknown vendor');
  });

  test('FM4: unknown tier falls back to that vendor sonnet pricing WITH a warning', () => {
    const { cost_usd, warning } = ce.costFromTokensVendor('codex', 'mega', 1_000_000, 0);
    expect(cost_usd).toBeCloseTo(1.25, 6); // codex sonnet input price
    expect(warning).toContain('unknown tier');
  });

  test('negative token counts clamp to 0', () => {
    expect(ce.costFromTokensVendor('codex', 'opus', -5, -5).cost_usd).toBe(0);
  });
});

// ── 4. Table shape + backward compatibility ───────────────────────────────────

describe('vendor tables — shape and backward compatibility', () => {
  test('VENDOR_MODELS uses canonical tier aliases as keys for every vendor', () => {
    for (const vendor of Object.keys(ce.VENDOR_MODELS)) {
      expect(Object.keys(ce.VENDOR_MODELS[vendor]).sort()).toEqual(['haiku', 'opus', 'sonnet']);
    }
  });

  test('MODEL_COSTS_BY_VENDOR.claude mirrors the flat MODEL_COSTS (single source of numbers)', () => {
    for (const tier of ['haiku', 'sonnet', 'opus']) {
      expect(ce.MODEL_COSTS_BY_VENDOR.claude[tier]).toEqual(ce.MODEL_COSTS[tier]);
    }
  });

  test('flat MODEL_COSTS lookup path is unchanged (backward compatible)', () => {
    expect(ce.MODEL_COSTS.opus).toEqual({ input: 15.0, output: 75.0 });
    expect(ce.costFromTokens('opus', 100_000, 50_000)).toBeCloseTo(5.25, 6);
  });

  test('every codex tier has a defined price entry', () => {
    for (const tier of ['haiku', 'sonnet', 'opus']) {
      const p = ce.MODEL_COSTS_BY_VENDOR.codex[tier];
      expect(typeof p.input).toBe('number');
      expect(typeof p.output).toBe('number');
    }
  });
});

// ── 5. getModelForRole return vocabulary (DoD guard) ──────────────────────────
// 'inherit' joined the canonical vocabulary (session-model routing): it is a
// routing sentinel, NOT a billable tier — cost/vendor tables must never key it.

describe('getModelForRole — return vocabulary stays haiku/sonnet/opus/inherit', () => {
  const TIERS = new Set(['haiku', 'sonnet', 'opus', 'inherit']);

  test('every role in every profile resolves to a canonical tier string', () => {
    for (const profile of Object.keys(ce.MODEL_PROFILES)) {
      for (const role of Object.keys(ce.MODEL_PROFILES[profile])) {
        const model = ce.getModelForRole(role, 'medium', { model_profile: profile });
        expect(TIERS.has(model)).toBe(true);
      }
    }
  });

  test('model_overrides value is returned verbatim (contract unchanged)', () => {
    const model = ce.getModelForRole('executor', 'medium', {
      model_overrides: { executor: 'opus' },
      model_profile: 'economy',
    });
    expect(model).toBe('opus');
    expect(TIERS.has(model)).toBe(true);
  });

  test('the vendor layer did NOT leak vendor specs into role routing', () => {
    // A codex-configured project must still route roles by tier vocabulary;
    // vendor translation is a separate, explicit step (option A).
    const model = ce.getModelForRole('executor', 'medium', {
      model_profile: 'default',
      vendor_models: { codex: { sonnet: 'gpt-5.4' } },
    });
    expect(model).toBe('sonnet'); // NOT 'gpt-5.4'
  });
});
