import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// Static imports load these modules before X_BUILD_ROOT is set, the same way an
// earlier test file in one bun process loads them before cost-engine.test.mjs runs.
import { metricsPath, spendCachePath } from '../x-build/lib/x-build/cost-engine.mjs';
import { loadSharedConfig } from '../x-build/lib/x-build/config-loader.mjs';
import { predictionLogPath } from '../x-build/lib/x-build/prediction-calibration.mjs';

describe('x-build root after the modules are loaded', () => {
  test('paths and the local config follow each X_BUILD_ROOT change', () => {
    const original = process.env.X_BUILD_ROOT;
    const base = mkdtempSync(join(tmpdir(), 'xb-root-'));
    try {
      for (const [name, maxUsd] of [['first', 1], ['second', 2]]) {
        const root = join(base, name, 'build');
        mkdirSync(root, { recursive: true });
        writeFileSync(join(base, name, 'config.json'), JSON.stringify({ budget: { max_usd: maxUsd } }));
        process.env.X_BUILD_ROOT = root;

        expect(metricsPath()).toBe(join(root, 'metrics', 'sessions.jsonl'));
        expect(spendCachePath()).toBe(join(root, 'metrics', 'spend-cache.json'));
        expect(predictionLogPath()).toBe(join(root, 'metrics', 'prediction_log.jsonl'));
        expect(loadSharedConfig().budget.max_usd).toBe(maxUsd);
      }
    } finally {
      if (original === undefined) delete process.env.X_BUILD_ROOT;
      else process.env.X_BUILD_ROOT = original;
      rmSync(base, { recursive: true, force: true });
    }
  });
});
