import { afterEach, describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkHardCap, computeSpend, readCostEvents, recordCacheHit,
} from '../x-build/lib/cost/index.mjs';

// Cost pipeline invariants are intentionally generated from integral micro-/
// cent-units.  The production APIs accept USD floats, while integral inputs
// let this test independently calculate the expected accounting boundary.
const MICROS_PER_USD = 1_000_000;
const EPSILON_USD = 1e-9;
const tempDirs = [];

function tempCostFile() {
  const dir = mkdtempSync(join(tmpdir(), 'xm-cost-pipeline-prop-'));
  tempDirs.push(dir);
  return join(dir, 'events.jsonl');
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('cost pipeline property invariants', () => {
  test('total cost equals the sum of valid event costs within epsilon', () => {
    const costMicros = fc.integer({ min: 0, max: 5_000_000 });
    fc.assert(
      fc.property(fc.array(costMicros, { maxLength: 200 }), (costs) => {
        const events = costs.map((micros, index) => ({
          type: 'task_complete',
          cost_usd: micros / MICROS_PER_USD,
          project: index % 2 === 0 ? 'alpha' : 'beta',
        }));
        const expected = costs.reduce((sum, micros) => sum + micros, 0) / MICROS_PER_USD;
        const { spent, projectSpentMap } = computeSpend(events);

        expect(Math.abs(spent - expected)).toBeLessThanOrEqual(EPSILON_USD);
        expect(Math.abs((projectSpentMap.alpha ?? 0) + (projectSpentMap.beta ?? 0) - expected))
          .toBeLessThanOrEqual(EPSILON_USD);
      }),
      { numRuns: 300 },
    );
  });

  test('a hard cap never approves a projected spend above max_usd', () => {
    const cents = fc.integer({ min: 0, max: 1_000_000 });
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }), cents, cents,
        (capCents, spentCents, additionalCents) => {
          const result = checkHardCap({
            cap: capCents / 100,
            spent: spentCents / 100,
            additionalCost: additionalCents / 100,
          });
          const projectedCents = spentCents + additionalCents;

          expect(result.ok).toBe(projectedCents <= capCents);
          if (result.ok) expect(result.projected).toBeLessThanOrEqual(capCents / 100 + EPSILON_USD);
          else expect(result.projected).toBeGreaterThan(capCents / 100 - EPSILON_USD);
        },
      ),
      { numRuns: 500 },
    );
  });

  test('only positive finite cache-hit savings are recorded', () => {
    const filePath = tempCostFile();
    const savedUsd = fc.oneof(
      fc.integer({ min: 1, max: 5_000_000 }).map((micros) => micros / MICROS_PER_USD),
      fc.integer({ min: -5_000_000, max: 0 }).map((micros) => micros / MICROS_PER_USD),
      fc.constant(Number.NaN),
      fc.constant(Number.POSITIVE_INFINITY),
      fc.constant(Number.NEGATIVE_INFINITY),
      fc.constant(undefined),
      fc.constant(null),
    );
    fc.assert(
      fc.property(savedUsd, (input) => {
        const numericSaving = Number(input);
        const event = recordCacheHit({
          filePath,
          savedUsd: input,
          model: 'sonnet',
          hash: 'a'.repeat(64),
          timestamp: '2026-07-23T00:00:00.000Z',
        });

        if (Number.isFinite(numericSaving) && numericSaving > 0) {
          expect(event).toEqual(expect.objectContaining({ type: 'cache_hit', saved_usd: numericSaving }));
        } else {
          expect(event).toBeNull();
        }
        expect(readCostEvents({ filePath }).every((row) => row.type !== 'cache_hit' || row.saved_usd > 0)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
