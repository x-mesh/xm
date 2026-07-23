import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)), 'x-build', 'lib', 'x-build', 'prediction-calibration.mjs');

describe('prediction calibration ledger', () => {
  test('correlates only measured task completions, deduplicates a completion, and stores no task text', () => {
    const temp = mkdtempSync(join(tmpdir(), 'xm-prediction-calibration-'));
    const script = `
      import { appendPredictionLog, appendPredictionActual, predictionLogPath } from ${JSON.stringify(pathToFileURL(ROOT).href)};
      const prediction = appendPredictionLog({
        project: 'demo', taskId: 't1',
        prediction: { estimate_usd: 0.5, source: 'exact' },
        query: { description: 'sensitive prompt text must never persist', role: 'executor', strategy: 'direct', size: 'small', model: 'sonnet' },
      });
      const estimated = appendPredictionActual({ project: 'demo', taskId: 't1', completedAt: '2026-07-23T00:00:00.000Z', actualCostUsd: 0.4, costSource: 'estimated', completionId: 'one' });
      const actual = appendPredictionActual({ project: 'demo', taskId: 't1', completedAt: '2026-07-23T00:00:00.000Z', actualCostUsd: 0, costSource: 'actual', completionId: 'one' });
      const duplicate = appendPredictionActual({ project: 'demo', taskId: 't1', completedAt: '2026-07-23T00:00:00.000Z', actualCostUsd: 0, costSource: 'actual', completionId: 'one' });
      console.log(JSON.stringify({ prediction, estimated, actual, duplicate, path: predictionLogPath() }));
    `;
    try {
      const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
        encoding: 'utf8', env: { ...process.env, X_BUILD_ROOT: temp },
      });
      expect(result.status).toBe(0);
      const resultRow = JSON.parse(result.stdout.trim());
      expect(resultRow.prediction.correlation_id).toBe('task:demo:t1');
      expect(resultRow.estimated).toBeNull();
      expect(resultRow.actual.actual_cost_usd).toBe(0);
      expect(resultRow.duplicate).toBeNull();
      const log = readFileSync(resultRow.path, 'utf8');
      expect(log).not.toContain('sensitive prompt text');
      const rows = log.trim().split('\n').map(JSON.parse);
      expect(rows.map((row) => row.type)).toEqual(['prediction', 'actual']);
      expect(rows[1].prediction_event_id).toBe(rows[0].event_id);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test('refreshes missing or stale task prediction instead of authorizing it as zero cost', () => {
    const temp = mkdtempSync(join(tmpdir(), 'xm-prediction-preblock-'));
    const script = `
      import { ensureTaskPrediction, predictionLogPath } from ${JSON.stringify(pathToFileURL(ROOT).href)};
      import { readFileSync } from 'node:fs';
      const task = { id: 't1', name: 'private task text', size: 'small', role: 'executor' };
      const now = Date.now();
      const first = ensureTaskPrediction({ project: 'demo', task, model: 'sonnet', now, maxAgeMs: 50 });
      const cached = ensureTaskPrediction({ project: 'demo', task, model: 'sonnet', now: now + 1, maxAgeMs: 50 });
      const stale = ensureTaskPrediction({ project: 'demo', task, model: 'sonnet', now: now + 1000, maxAgeMs: 50 });
      console.log(JSON.stringify({ first, cached, stale, rows: readFileSync(predictionLogPath(), 'utf8').trim().split('\\n').length }));
    `;
    try {
      const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
        encoding: 'utf8', env: { ...process.env, X_BUILD_ROOT: temp },
      });
      expect(result.status).toBe(0);
      const row = JSON.parse(result.stdout.trim());
      expect(row.first.cached).toBe(false);
      expect(row.cached.cached).toBe(true);
      expect(row.stale.cached).toBe(false);
      expect(row.first.estimate_usd).toBeGreaterThan(0);
      expect(row.rows).toBe(2);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
