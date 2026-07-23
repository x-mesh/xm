/**
 * Prediction calibration ledger.
 *
 * This is intentionally separate from sessions.jsonl: predictions are not
 * observations, and putting them in the cost stream would let a dashboard
 * count an estimate as spend.  The log contains only bounded numeric metadata
 * and opaque ids — never task descriptions, prompts, or other raw content.
 */

import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ROOT } from './root.mjs';
import { COST_EVENT_MAX_BYTES, METRICS_MAX_BYTES, predictTaskCost } from './cost-engine.mjs';
import { appendCostEvent as appendSharedCostEvent, readCostEvents } from '../cost/index.mjs';

const LOG_SCHEMA_VERSION = 1;
export const DEFAULT_PREDICTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function predictionLogPath() {
  return join(ROOT, 'metrics', 'prediction_log.jsonl');
}

function opaqueId(prefix) {
  return `${prefix}-${randomBytes(10).toString('hex')}`;
}

function correlationKey(project, taskId) {
  return `task:${String(project)}:${String(taskId)}`;
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function readCalibrationEvents() {
  // readCostEvents is deliberately tolerant of malformed/torn JSONL rows and
  // is also the shared reader used by cost metrics.
  return readCostEvents({ filePath: predictionLogPath() });
}

/**
 * Append a prediction. A task id is optional for manual exploratory requests;
 * only task-bound predictions can later be calibrated against completion.
 */
export function appendPredictionLog({ project = null, taskId = null, prediction, query = {} } = {}) {
  if (!finiteNonNegative(prediction?.estimate_usd)) return null;
  const taskBound = typeof project === 'string' && project && typeof taskId === 'string' && taskId;
  const event = {
    schema_v: LOG_SCHEMA_VERSION,
    type: 'prediction',
    event_id: opaqueId('pred'),
    timestamp: new Date().toISOString(),
    correlation_id: taskBound ? correlationKey(project, taskId) : opaqueId('manual'),
    project: taskBound ? project : null,
    task_id: taskBound ? taskId : null,
    predicted_cost_usd: prediction.estimate_usd,
    source: typeof prediction.source === 'string' ? prediction.source : 'unknown',
    role: typeof query.role === 'string' ? query.role : 'executor',
    strategy: typeof query.strategy === 'string' ? query.strategy : null,
    size: typeof query.size === 'string' ? query.size : 'medium',
    model: typeof query.model === 'string' ? query.model : 'sonnet',
  };
  // The shared writer supplies the 4KB check, file lock, and bounded rotation.
  return appendSharedCostEvent({ filePath: predictionLogPath(), event, maxBytes: COST_EVENT_MAX_BYTES, rotateAtBytes: METRICS_MAX_BYTES });
}

function newestUsablePrediction(project, taskId, model, now, maxAgeMs) {
  const key = correlationKey(project, taskId);
  const maxAge = Number.isFinite(Number(maxAgeMs)) && Number(maxAgeMs) >= 0
    ? Number(maxAgeMs) : DEFAULT_PREDICTION_MAX_AGE_MS;
  return readCalibrationEvents()
    .filter((event) => event?.type === 'prediction'
      && event.correlation_id === key
      && event.model === model
      && finiteNonNegative(event.predicted_cost_usd))
    .map((event) => ({ event, at: Date.parse(event.timestamp) }))
    // Future/invalid timestamps never become a durable authorization to spend.
    .filter(({ at }) => Number.isFinite(at) && at <= now && now - at <= maxAge)
    .sort((left, right) => right.at - left.at
      || String(right.event.event_id || '').localeCompare(String(left.event.event_id || '')))
    .at(0)?.event ?? null;
}

/**
 * Return a current prediction for a task dispatch.  A missing, malformed, or
 * stale row is refreshed from the t6 estimator before the caller evaluates a
 * hard cap; estimates are never silently treated as $0.
 */
export function ensureTaskPrediction({ project, task, model, now = Date.now(), maxAgeMs } = {}) {
  if (typeof project !== 'string' || !project || !task || typeof task.id !== 'string' || !task.id) return null;
  if (typeof model !== 'string' || !model) return null;
  const cached = newestUsablePrediction(project, task.id, model, now, maxAgeMs);
  if (cached) {
    return {
      estimate_usd: cached.predicted_cost_usd,
      source: cached.source || 'cached',
      cached: true,
      prediction_event_id: cached.event_id,
    };
  }
  const query = {
    description: task.description || task.name || task.id,
    role: task.role || (task.size === 'large' ? 'deep-executor' : 'executor'),
    strategy: task.strategy || null,
    size: task.size || 'medium',
    model,
  };
  const prediction = predictTaskCost(query);
  const row = appendPredictionLog({ project, taskId: task.id, prediction, query });
  return row ? { ...prediction, cached: false, prediction_event_id: row.event_id } : null;
}

/**
 * Link a measured completion to its newest task-bound prediction. Estimated
 * completions never enter this ledger: MAPE must compare predictions with
 * observations, not an estimate generated by the same model.
 */
export function appendPredictionActual({ project, taskId, completedAt, actualCostUsd, costSource, completionId } = {}) {
  if (!finiteNonNegative(actualCostUsd) || costSource !== 'actual') return null;
  if (typeof project !== 'string' || !project || typeof taskId !== 'string' || !taskId) return null;
  const key = correlationKey(project, taskId);
  const prediction = readCalibrationEvents()
    .filter((event) => event?.type === 'prediction' && event.correlation_id === key
      && typeof event.event_id === 'string' && finiteNonNegative(event.predicted_cost_usd))
    .sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || ''))
      || String(a.event_id).localeCompare(String(b.event_id)))
    .at(-1);
  if (!prediction) return null;

  const timestamp = typeof completedAt === 'string' && Number.isFinite(new Date(completedAt).getTime())
    ? completedAt : new Date().toISOString();
  const eventId = `actual-${createHash('sha256').update(`${key}\0${timestamp}\0${completionId || ''}`).digest('hex').slice(0, 20)}`;
  const existing = readCalibrationEvents().some((event) => event?.event_id === eventId);
  if (existing) return null;
  return appendSharedCostEvent({ filePath: predictionLogPath(), maxBytes: COST_EVENT_MAX_BYTES, rotateAtBytes: METRICS_MAX_BYTES, event: {
    schema_v: LOG_SCHEMA_VERSION,
    type: 'actual',
    event_id: eventId,
    timestamp,
    correlation_id: key,
    prediction_event_id: prediction.event_id,
    project,
    task_id: taskId,
    actual_cost_usd: actualCostUsd,
  } });
}
