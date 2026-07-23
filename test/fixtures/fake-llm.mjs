/**
 * Deterministic LLM adapter for cost-pipeline tests.
 *
 * A fixture maps an exact prompt to its provider-observed result. `latency_ms`
 * is reported and accumulated, but never slept, so tests remain fast and
 * network-free.
 *
 * @example
 * const llm = createFakeLLM({
 *   prompts: {
 *     'summarize this': {
 *       content: 'summary', input_tokens: 12, output_tokens: 4,
 *       cost_usd: 0.000096, latency_ms: 25,
 *     },
 *   },
 * });
 */

function clone(value) {
  return { ...value };
}

function requiredNonNegativeNumber(value, field, prompt) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`FakeLLM fixture for ${JSON.stringify(prompt)} requires non-negative ${field}`);
  }
  return value;
}

function normalizeFixture(fixture) {
  const prompts = fixture?.prompts ?? fixture;
  if (!prompts || typeof prompts !== 'object' || Array.isArray(prompts)) {
    throw new TypeError('FakeLLM fixture must be a prompt map or { prompts: promptMap }');
  }

  const normalized = new Map();
  for (const [prompt, value] of Object.entries(prompts)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(`FakeLLM fixture for ${JSON.stringify(prompt)} must be an object`);
    }
    if (typeof value.content !== 'string') {
      throw new TypeError(`FakeLLM fixture for ${JSON.stringify(prompt)} requires string content`);
    }
    normalized.set(prompt, Object.freeze({
      content: value.content,
      input_tokens: requiredNonNegativeNumber(value.input_tokens, 'input_tokens', prompt),
      output_tokens: requiredNonNegativeNumber(value.output_tokens, 'output_tokens', prompt),
      cost_usd: requiredNonNegativeNumber(value.cost_usd, 'cost_usd', prompt),
      latency_ms: requiredNonNegativeNumber(value.latency_ms, 'latency_ms', prompt),
      model: value.model ?? 'fake-llm',
    }));
  }
  return normalized;
}

/**
 * Create an async LLM-shaped adapter backed only by an in-memory fixture.
 * Exact prompts are intentional: cache and cost tests must not hide a key
 * mismatch behind a fuzzy test double.
 */
export function createFakeLLM(fixture) {
  const responses = normalizeFixture(fixture);
  const calls = [];
  let totalLatencyMs = 0;

  async function complete(prompt) {
    if (typeof prompt !== 'string') {
      throw new TypeError('FakeLLM.complete requires a string prompt');
    }
    const fixtureResponse = responses.get(prompt);
    if (!fixtureResponse) {
      throw new Error(`FakeLLM: no fixture for prompt ${JSON.stringify(prompt)}`);
    }

    const response = {
      prompt,
      ...fixtureResponse,
      call_index: calls.length,
    };
    calls.push(response);
    totalLatencyMs += response.latency_ms;
    return clone(response);
  }

  return Object.freeze({
    complete,
    get calls() { return calls.map(clone); },
    get callCount() { return calls.length; },
    get totalLatencyMs() { return totalLatencyMs; },
    reset() {
      calls.length = 0;
      totalLatencyMs = 0;
    },
  });
}
