#!/usr/bin/env node
// @ts-check

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { savePlanArtifact } from './x-plan/artifact.mjs';
import { createPlanEnvelope, parsePlanEnvelope, validatePlanEnvelope } from './x-plan/core.mjs';
import { renderPlan, renderValidation } from './x-plan/render.mjs';
import { runUltraPlan } from './x-plan/ultra.mjs';

function parseArgs(argv) {
  const flags = { pretty: false, compact: false, json: false, validate: false, persist: false, noSave: false, output: null, file: null, mode: 'quick', models: null, evidence: null, questions: null, critique: null, session: null };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--pretty') flags.pretty = true;
    else if (arg === '--compact') flags.compact = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--validate') flags.validate = true;
    else if (arg === '--persist') flags.persist = true;
    else if (arg === '--no-save') flags.noSave = true;
    else if (arg === '--output') { if (!argv[i + 1] || argv[i + 1].startsWith('--')) return { error: '--output requires a path' }; flags.output = argv[++i]; }
    else if (arg === '--file') { if (!argv[i + 1] || argv[i + 1].startsWith('--')) return { error: '--file requires a path' }; flags.file = argv[++i]; }
    else if (arg === '--mode') { if (!argv[i + 1] || argv[i + 1].startsWith('--')) return { error: '--mode requires a value' }; flags.mode = argv[++i]; }
    else if (arg === '--models') { if (!argv[i + 1] || argv[i + 1].startsWith('--')) return { error: '--models requires a value' }; flags.models = argv[++i]; }
    else if (arg === '--evidence') { if (!argv[i + 1] || argv[i + 1].startsWith('--')) return { error: '--evidence requires a path' }; flags.evidence = argv[++i]; }
    else if (arg === '--questions') { if (!argv[i + 1] || argv[i + 1].startsWith('--')) return { error: '--questions requires a path' }; flags.questions = argv[++i]; }
    else if (arg === '--critique') { if (!argv[i + 1] || argv[i + 1].startsWith('--')) return { error: '--critique requires a path' }; flags.critique = argv[++i]; }
    else if (arg === '--session') { if (!argv[i + 1] || argv[i + 1].startsWith('--')) return { error: '--session requires an id' }; flags.session = argv[++i]; }
    else if (arg.startsWith('--')) return { error: `unknown option: ${arg}` };
    else positional.push(arg);
  }
  if (flags.pretty && flags.compact) return { error: '--pretty and --compact conflict' };
  if (flags.output && flags.noSave) return { error: '--output and --no-save conflict' };
  return { flags, positional };
}

function output(value, pretty) { process.stdout.write(JSON.stringify(value, null, pretty ? 2 : 0) + '\n'); }
function errorEnvelope(code, message) { return { schema_version: 1, status: 'invalid', executable: false, errors: [{ code, path: '$', message }] }; }
function reportError(flags, code, message) {
  if (flags?.json) output(errorEnvelope(code, message), true);
  else process.stderr.write('xm plan: ' + message + '\n');
}
function readArtifact(path) { return path ? JSON.parse(readFileSync(resolve(path), 'utf8')) : null; }
function validateUltraContext(flags) {
  if (!flags.session) return 'ultra mode requires the Standard interview session via --session';
  if (!flags.evidence) return 'ultra mode requires Standard inspection evidence via --evidence';
  if (!flags.questions) return 'ultra mode requires answered interview questions via --questions';
  try {
    const evidence = readArtifact(flags.evidence);
    const questions = readArtifact(flags.questions);
    if (!Array.isArray(evidence?.items) || evidence.items.length === 0) return 'ultra mode requires at least one verified evidence item';
    if (!Array.isArray(questions?.items)) return 'questions.items must be an array';
    if (questions.items.some((item) => item.status !== 'answered' || !String(item.answer || '').trim())) return 'ultra mode requires every interview question to be answered';
  } catch (error) { return 'invalid Standard interview artifact: ' + error.message; }
  return null;
}
function emitPlan(plan, validation, flags, extra = {}) {
  try {
    const artifact = flags.noSave ? null : savePlanArtifact(plan, {
      outputPath: flags.output, mode: flags.mode,
      evidence: readArtifact(flags.evidence), questions: readArtifact(flags.questions), critique: readArtifact(flags.critique),
      candidates: extra.candidates || [], sessionId: flags.session,
    });
    if (flags.json) output({ ...(artifact?.plan || plan), artifact_path: artifact?.relativePath || null, validation_result: validation }, flags.pretty);
    else process.stdout.write(renderPlan(artifact?.plan || plan, { artifactPath: artifact?.relativePath || null }));
    return true;
  } catch (error) {
    reportError(flags, 'plan.persist', error.message);
    return false;
  }
}

export async function main(argv = process.argv.slice(2), stdin = null) {
  const parsed = parseArgs(argv);
  if (parsed.error) { reportError({ json: argv.includes('--json') }, 'cli.usage', parsed.error); return 2; }
  const { flags, positional } = parsed;
  let body = ''; let source = 'literal';
  try {
    if (flags.file) { body = readFileSync(resolve(flags.file), 'utf8'); source = 'file'; }
    else if (positional.length === 1 && existsSync(resolve(positional[0]))) { body = readFileSync(resolve(positional[0]), 'utf8'); source = 'file'; }
    else if (positional.length) body = positional.join(' ');
    else if (stdin != null) { body = String(stdin); source = 'stdin'; }
    else if (!process.stdin.isTTY) { body = readFileSync(0, 'utf8'); source = 'stdin'; }
  } catch (error) { reportError(flags, 'cli.input', error.message); return 2; }
  if (!body.trim()) { reportError(flags, 'cli.empty_input', 'requirements input is required'); return 2; }
  if (flags.validate || flags.persist) {
    const result = parsePlanEnvelope(body);
    if (flags.persist && result.valid) {
      if (!emitPlan(result.value, { valid: true, errors: [], warnings: result.warnings }, flags)) return 1;
      return 0;
    }
    if (flags.json) output({ schema_version: 1, status: result.valid ? 'complete' : 'invalid', executable: Boolean(result.value?.executable) && result.valid, valid: result.valid, errors: result.errors, warnings: result.warnings, plan: result.value }, flags.pretty);
    else process.stdout.write(renderValidation(result));
    return result.ok ? 0 : result.errors.some((entry) => entry.code === 'plan.invalid_json') ? 2 : 1;
  }
  if (flags.mode === 'default') flags.mode = 'quick';
  if (!['quick', 'standard', 'ultra'].includes(flags.mode)) { reportError(flags, 'cli.mode', 'unknown mode: ' + flags.mode); return 2; }
  if (flags.mode === 'ultra') {
    const models = String(flags.models || '').split(',').map((item) => item.trim()).filter(Boolean);
    if (new Set(models).size < 2 || new Set(models).size !== models.length) { reportError(flags, 'cli.models', 'ultra mode requires at least 2 distinct exact model slots'); return 2; }
    const contextError = validateUltraContext(flags);
    if (contextError) { reportError(flags, 'cli.ultra_context', contextError); return 2; }
    const ultra = await runUltraPlan(body, models, { maxParallel: 3 });
    if (!ultra.ok) {
      if (flags.json) output({ schema_version: 1, status: 'invalid', executable: false, error: ultra.error, candidates: ultra.candidates, errors: ultra.errors || [] }, flags.pretty);
      else reportError(flags, 'plan.ultra', ultra.error || 'ultra planning failed');
      return 1;
    }
    if (!emitPlan({ ...ultra.plan, provenance: { ...ultra.plan.provenance, candidates: ultra.candidates } }, { valid: true, errors: [], warnings: [] }, flags, { candidates: ultra.rawCandidates })) return 1;
    return 0;
  }
  if (flags.mode === 'standard') {
    reportError(flags, 'cli.standard_contract', 'standard mode requires an interviewed PlanEnvelope via --persist with --evidence, --questions, and --critique');
    return 2;
  }
  const plan = createPlanEnvelope(body, { source });
  plan.provenance.mode = flags.mode;
  const result = validatePlanEnvelope(plan);
  if (result.valid) {
    if (!emitPlan(plan, { valid: true, errors: [], warnings: result.warnings }, flags)) return 1;
  } else if (flags.json) output({ ...plan, validation_result: { valid: false, errors: result.errors, warnings: result.warnings } }, flags.pretty);
  else process.stdout.write(renderValidation(result));
  return result.valid ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main();
