#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { startReview, resumeReview } from './review-lifecycle.mjs';

function usage() {
  return 'Usage: xm review run [target-file] [--cross-vendor] [--models a,b] [--lenses a,b] [--rounds 1|2] [--run-id id] [--no-trace] [--json]\n       xm review resume <run-id> [--no-trace] [--json]';
}

function fail(message) {
  process.stderr.write(`xm review: ${message}\n${usage()}\n`);
  return 2;
}

function parse(argv) {
  const command = argv[0];
  if (!['run', 'resume'].includes(command)) throw new Error(`unknown command: ${command || '(missing)'}`);
  const options = { command, crossVendor: false, json: false, trace: true };
  const pos = [];
  const valueFlags = new Set(['--models', '--lenses', '--rounds', '--run-id', '--chunk-file-budget', '--chunk-token-budget', '--max-profiles']);
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cross-vendor') options.crossVendor = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--no-trace') options.trace = false;
    else if (valueFlags.has(arg)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${arg} requires a value`);
      options[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    } else if (arg.startsWith('-')) throw new Error(`unknown flag: ${arg}`);
    else pos.push(arg);
  }
  if (command === 'run') {
    if (pos.length > 1) throw new Error('run accepts at most one target file');
    options.target = pos[0];
  } else {
    if (pos.length !== 1) throw new Error('resume requires exactly one run id');
    options.id = pos[0];
  }
  if (options.rounds !== undefined && !['1', '2'].includes(options.rounds)) throw new Error('--rounds must be 1 or 2');
  for (const key of ['chunkFileBudget', 'chunkTokenBudget', 'maxProfiles']) {
    if (options[key] !== undefined && (!/^\d+$/.test(options[key]) || Number(options[key]) < 1)) throw new Error(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be a positive integer`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let options;
  try { options = parse(argv); } catch (error) { return fail(error.message); }
  try {
    const common = {
      env, models: options.models, rounds: options.rounds ? Number(options.rounds) : undefined,
      lenses: options.lenses ? options.lenses.split(',').map((value) => value.trim()).filter(Boolean) : undefined,
      runId: options.runId, chunkFileBudget: options.chunkFileBudget ? Number(options.chunkFileBudget) : undefined,
      chunkTokenBudget: options.chunkTokenBudget ? Number(options.chunkTokenBudget) : undefined,
      maxProfiles: options.maxProfiles ? Number(options.maxProfiles) : undefined,
      trace: options.trace,
    };
    const response = options.command === 'run' ? await startReview({ ...common, target: options.target }) : await resumeReview(options.id, common);
    const output = { ok: true, run_id: response.manifest.id, run_dir: response.runDir, ...response.result };
    process.stdout.write(options.json ? `${JSON.stringify(output, null, 2)}\n` : `${response.result.verdict}: ${response.result.findings.length} finding(s)\nrun: ${response.runDir}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`xm review: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
