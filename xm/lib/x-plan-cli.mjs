#!/usr/bin/env node
// @ts-check

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPlanEnvelope, parsePlanEnvelope, validatePlanEnvelope } from './x-plan/core.mjs';
import { runUltraPlan } from './x-plan/ultra.mjs';

function parseArgs(argv) {
  const flags = { pretty: false, compact: false, validate: false, file: null, mode: 'default', models: null };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--pretty') flags.pretty = true;
    else if (arg === '--compact') flags.compact = true;
    else if (arg === '--validate') flags.validate = true;
    else if (arg === '--file' && argv[i + 1]) flags.file = argv[++i];
    else if (arg === '--mode' && argv[i + 1]) flags.mode = argv[++i];
    else if (arg === '--models' && argv[i + 1]) flags.models = argv[++i];
    else if (arg.startsWith('--')) return { error: `unknown option: ${arg}` };
    else positional.push(arg);
  }
  if (flags.pretty && flags.compact) return { error: '--pretty and --compact conflict' };
  return { flags, positional };
}

function output(value, pretty) { process.stdout.write(JSON.stringify(value, null, pretty ? 2 : 0) + '\n'); }
function errorEnvelope(code, message) { return { schema_version: 1, status: 'invalid', executable: false, errors: [{ code, path: '$', message }] }; }

export async function main(argv = process.argv.slice(2), stdin = null) {
  const parsed = parseArgs(argv);
  if (parsed.error) { output(errorEnvelope('cli.usage', parsed.error), true); return 2; }
  const { flags, positional } = parsed;
  let body = ''; let source = 'literal';
  try {
    if (flags.file) { body = readFileSync(resolve(flags.file), 'utf8'); source = 'file'; }
    else if (positional.length === 1 && existsSync(resolve(positional[0]))) { body = readFileSync(resolve(positional[0]), 'utf8'); source = 'file'; }
    else if (positional.length) body = positional.join(' ');
    else if (stdin != null) { body = String(stdin); source = 'stdin'; }
    else if (!process.stdin.isTTY) { body = readFileSync(0, 'utf8'); source = 'stdin'; }
  } catch (error) { output(errorEnvelope('cli.input', error.message), true); return 2; }
  if (!body.trim()) { output(errorEnvelope('cli.empty_input', 'requirements input is required'), true); return 2; }
  if (flags.validate) {
    const result = parsePlanEnvelope(body);
    output({ schema_version: 1, status: result.valid ? 'complete' : 'invalid', executable: Boolean(result.value?.executable) && result.valid, valid: result.valid, errors: result.errors, warnings: result.warnings, plan: result.value }, flags.pretty);
    return result.ok ? 0 : result.errors.some((entry) => entry.code === 'plan.invalid_json') ? 2 : 1;
  }
  if (!['default', 'ultra'].includes(flags.mode)) { output(errorEnvelope('cli.mode', `unknown mode: ${flags.mode}`), true); return 2; }
  if (flags.mode === 'ultra') {
    const models = String(flags.models || '').split(',').map((item) => item.trim()).filter(Boolean);
    if (new Set(models).size < 2 || new Set(models).size !== models.length) { output(errorEnvelope('cli.models', 'ultra mode requires at least 2 distinct exact model slots'), true); return 2; }
    const ultra = await runUltraPlan(body, models, { maxParallel: 3 });
    if (!ultra.ok) { output({ schema_version: 1, status: 'invalid', executable: false, error: ultra.error, candidates: ultra.candidates, errors: ultra.errors || [] }, flags.pretty); return 1; }
    output({ ...ultra.plan, candidate_provenance: ultra.candidates, validation_result: { valid: true, errors: [], warnings: [] } }, flags.pretty);
    return 0;
  }
  const plan = createPlanEnvelope(body, { source });
  const result = validatePlanEnvelope(plan);
  output({ ...plan, validation_result: { valid: result.valid, errors: result.errors, warnings: result.warnings } }, flags.pretty);
  return result.valid ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main();
