#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { startReview, resumeReview, prepareReview, submitReview, finalizeReview, statusReview, closeReview, associateReview, reserveGateAuthoring } from './review-lifecycle.mjs';

function usage() {
  return 'Native: xm review prepare [target-file|git-ref] [--operation-id ID | --task-id ID | --pr NUMBER --repo OWNER/NAME] [--zero-findings] --json\n        xm review submit ID --report-id ID --attempt-id ID --report FILE --json\n        xm review finalize|status ID --json\n        xm review close|associate ID --reason TEXT [--operation-id ID | --task-id ID]\nGate authoring: xm review author-gate --operation-id ID --context-file FILE --scope-file FILE --reason TEXT\nVerification: --context-file FILE --gate-file FILE (prepare or run)\nNew operation: --operation-id ID --new-operation --approved-by USER --reason TEXT\nBudget exception: --exception full|delta|fix --approved-by USER --reason TEXT\nUsage: xm review run [target-file|git-ref] [--cross-vendor] [--models a,b] [--lenses a,b] [--rounds 1|2] [--run-id id] [--no-trace] [--json]\n       xm review resume <run-id> [--no-trace] [--json]';
}

const FAILURE_RECOVERY = 'Inspect the error and recover the existing lifecycle before continuing. Do not dispatch reviewers directly, reset the budget, or start another review to bypass this failure.';

// Preparation and argument errors can precede any validated terminal receipt.
const FAILURE_ACTION = { schema: 'xm.review.terminal-action.v1', decision: 'stop', reason_code: 'review_command_failed', auto_review_allowed: false, auto_fix_allowed: false, continuation: 'human_decision', operation_id: null, run_id: null, verdict: null, coverage_complete: false };

function fail(message, json) {
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: message, action: FAILURE_ACTION, recovery: FAILURE_RECOVERY }, null, 2)}\n`);
  process.stderr.write(`xm review: ${message}\n${usage()}\n`);
  if (!json) process.stderr.write(`action: stop\ncontinuation: human_decision\n${FAILURE_RECOVERY}\n`);
  return 2;
}

function parse(argv) {
  const command = argv[0];
  if (!['run', 'resume', 'prepare', 'submit', 'finalize', 'status', 'close', 'associate', 'author-gate'].includes(command)) throw new Error(`unknown command: ${command || '(missing)'}`);
  const options = { command, crossVendor: false, json: false, trace: true };
  const pos = [];
  const valueFlags = new Set(['--scope-file', '--gate-file', '--legacy-result', '--context-file', '--operation-id', '--task-id', '--repo', '--pr', '--exception', '--approved-by', '--reason', '--base-ref', '--report-id', '--attempt-id', '--report', '--models', '--lenses', '--rounds', '--run-id', '--chunk-file-budget', '--chunk-token-budget', '--max-profiles', '--max-concurrent-reports']);
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cross-vendor') options.crossVendor = true;
    else if (arg === '--new-operation') options.newOperation = true;
    else if (arg === '--zero-findings') options.zeroFindings = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--no-trace') options.trace = false;
    else if (valueFlags.has(arg)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${arg} requires a value`);
      options[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    } else if (arg.startsWith('-')) throw new Error(`unknown flag: ${arg}`);
    else pos.push(arg);
  }
  if (command === 'run' || command === 'prepare') {
    if (pos.length > 1) throw new Error('run accepts at most one target file');
    options.target = pos[0];
  } else if (command === 'author-gate') {
    if (pos.length) throw new Error('author-gate accepts flags only');
  } else {
    if (pos.length !== 1) throw new Error('resume requires exactly one run id');
    options.id = pos[0];
  }
  if (options.rounds !== undefined && !['1', '2'].includes(options.rounds)) throw new Error('--rounds must be 1 or 2');
  for (const key of ['chunkFileBudget', 'chunkTokenBudget', 'maxProfiles', 'maxConcurrentReports']) {
    if (options[key] !== undefined && (!/^\d+$/.test(options[key]) || Number(options[key]) < 1)) throw new Error(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be a positive integer`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let options;
  try { options = parse(argv); } catch (error) { return fail(error.message, argv.includes('--json')); }
  try {
    const common = {
      ...options, onPrepared: options.json ? undefined : budget => process.stderr.write(`review budget: full=1 fix=1 delta=1; used=${JSON.stringify(budget.used)}; mode=${budget.mode}\n`), env, models: options.models, rounds: options.rounds ? Number(options.rounds) : undefined,
      lenses: options.lenses ? options.lenses.split(',').map((value) => value.trim()).filter(Boolean) : undefined,
      runId: options.runId, chunkFileBudget: options.chunkFileBudget ? Number(options.chunkFileBudget) : undefined,
      chunkTokenBudget: options.chunkTokenBudget ? Number(options.chunkTokenBudget) : undefined,
      maxProfiles: options.maxProfiles ? Number(options.maxProfiles) : undefined,
      maxConcurrentReports: options.maxConcurrentReports ? Number(options.maxConcurrentReports) : undefined,
      trace: options.trace,
    };
    const commands = { resume: resumeReview, submit: submitReview, finalize: finalizeReview, status: statusReview, close: closeReview, associate: associateReview };
    const response = options.command === 'author-gate' ? await reserveGateAuthoring(common) : ['run', 'prepare'].includes(options.command) ? await (options.command === 'run' ? startReview : prepareReview)({ ...common, target: options.target }) : await commands[options.command](options.id, common);
    const output = { ok: true, run_id: response.manifest.id, operation_id: response.manifest.operation_id || null, run_dir: response.runDir, ...response.result, ...(response.manifest.verification ? { verification: response.result?.verification || response.manifest.verification } : {}), ...(response.budget ? { budget: response.budget } : {}), ...(response.workers ? { workers: response.workers } : {}), ...(response.worker ? { worker: response.worker, retry: response.retry } : {}), ...(response.status ? { status: response.status } : {}), ...(response.terminal ? { terminal: response.terminal, action: response.terminal.action } : {}) };
    const stop = response.terminal ? `action: ${response.terminal.action.decision}\ncontinuation: ${response.terminal.action.continuation}\nAutomatic review and fix are forbidden. Follow the continuation only after a human decision.\n` : '';
    if (response.authoring) output.authoring = response.authoring;
    process.stdout.write(options.json ? `${JSON.stringify(output, null, 2)}\n` : `${response.result ? `${response.result.verdict}: ${response.result.findings.length} finding(s)` : options.command}\nrun: ${response.runDir}\nbudget: ${JSON.stringify(response.budget || {})}\n${stop}`);
    return 0;
  } catch (error) {
    const action = error.terminal?.action || FAILURE_ACTION;
    const recovery = FAILURE_RECOVERY;
    if (options?.json) process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, ...(error.terminal ? { terminal: error.terminal } : {}), action, recovery }, null, 2)}\n`);
    process.stderr.write(`xm review: ${error.message}\n`);
    if (!options?.json) process.stderr.write(`action: ${action.decision}\ncontinuation: ${action.continuation}\n${recovery}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
