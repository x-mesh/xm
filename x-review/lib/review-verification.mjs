import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { atomicJson, digest, readState } from './review-budget.mjs';

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

function keys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`invalid verification gate ${name}`);
}

function command(value, name) {
  keys(value, ['argv', 'timeout_ms'], name);
  if (!Array.isArray(value.argv) || !value.argv.length || value.argv.length > 100
    || value.argv.some(arg => typeof arg !== 'string' || !arg || arg.includes('\0'))
    || !Number.isSafeInteger(value.timeout_ms) || value.timeout_ms < 1 || value.timeout_ms > MAX_TIMEOUT_MS) {
    throw new Error(`verification gate ${name} requires argv and timeout_ms (1-${MAX_TIMEOUT_MS})`);
  }
  if ((!value.argv[0].startsWith('/') && value.argv[0].includes('/')) || value.argv.slice(1).some(arg => arg.startsWith('/'))) throw new Error('verification gate commands require an installed program and repository-relative arguments');
  return { argv: value.argv, timeout_ms: value.timeout_ms };
}

export function verificationConfig(value, context) {
  keys(value, ['schema_version', 'files', 'baseline', 'mutation', 'mutants', 'measurement'], 'configuration');
  if (value.schema_version !== 1 || !context?.invariants?.length) throw new Error('verification gate requires schema_version 1 and a bound review context');
  if (!Array.isArray(value.files) || !value.files.length || value.files.length > 10000
    || value.files.some(file => typeof file !== 'string' || !file || file.startsWith('/') || file.includes('\\') || file.includes('\0')
      || file.split('/').some(part => !part || part === '.' || part === '..' || part === '.git' || part === '.xm' || /^\.env(?:\.|$)/.test(part)))) {
    throw new Error('verification gate files must be explicit repository-relative source, test, and script paths');
  }
  if (new Set(value.files).size !== value.files.length) throw new Error('verification gate files must be unique');
  if (!Array.isArray(value.mutants) || !value.mutants.length || value.mutants.length > 1000) throw new Error('verification gate requires an expected mutant list');
  const ids = new Set();
  const invariants = new Set(context.invariants.map(item => item.id));
  const mutants = value.mutants.map(item => {
    keys(item, ['id', 'invariant_id', 'violation'], 'mutant');
    if (typeof item.id !== 'string' || !ID.test(item.id) || ids.has(item.id) || !invariants.has(item.invariant_id)
      || typeof item.violation !== 'string' || !item.violation.trim() || item.violation.length > 1000) throw new Error('invalid verification gate mutant identity, invariant, or violation');
    ids.add(item.id);
    return { id: item.id, invariant_id: item.invariant_id, violation: item.violation };
  });
  let measurement;
  if (value.measurement !== undefined) {
    keys(value.measurement, ['file', 'sha256'], 'measurement');
    if (!value.files.includes(value.measurement.file) || !/^[a-f0-9]{64}$/.test(value.measurement.sha256 || '')) throw new Error('verification gate measurement requires a declared file and trusted SHA-256');
    measurement = { file: value.measurement.file, sha256: value.measurement.sha256 };
  }
  return { schema_version: 1, files: [...value.files].sort(), baseline: command(value.baseline, 'baseline'), mutation: command(value.mutation, 'mutation'), mutants, ...(measurement ? { measurement } : {}) };
}

function validateMeasurement(config, work, inputs) {
  if (!config.measurement) return null;
  const bytes = readFileSync(join(work, config.measurement.file));
  if (digest(bytes) !== `sha256:${config.measurement.sha256}`) throw new Error('verification gate measurement report hash mismatch');
  const report = JSON.parse(bytes), evidence = report.evidence;
  if (report.schema_v !== 3 || report.measurement?.status !== 'complete' || evidence?.stable !== true
    || !Array.isArray(evidence.inputs) || !evidence.inputs.length || digest(JSON.stringify(evidence.inputs)) !== `sha256:${evidence.input_sha256}`
    || !Array.isArray(report.mutants) || !report.mutants.length || report.mutants.some(item => !['killed', 'survived'].includes(item.status))) throw new Error('verification gate measurement is incomplete or invalid');
  const seen = new Set();
  for (const input of evidence.inputs) {
    if (seen.has(input.file) || !/^[a-f0-9]{64}$/.test(input.sha256 || '') || !inputs.some(item => item.file === input.file && item.sha256 === `sha256:${input.sha256}`)) throw new Error(`verification gate measurement input differs from frozen files: ${input.file}`);
    seen.add(input.file);
  }
  return { run_id: report.run_id, sha256: config.measurement.sha256, status: 'complete', survivors: report.mutants.filter(item => item.status === 'survived').length };
}

function inputBytes(manifest, file) {
  if (manifest.snapshot.kind === 'commits') {
    const entry = spawnSync('git', ['ls-tree', '-z', manifest.snapshot.commit, '--', file], { cwd: manifest.cwd, encoding: 'utf8' });
    const row = entry.stdout?.split('\0').find(item => item.split('\t')[1] === file);
    if (entry.status !== 0 || !/^100(?:644|755) blob /.test(row || '')) throw new Error(`verification gate input is not a committed regular file: ${file}`);
    const blob = spawnSync('git', ['cat-file', 'blob', row.split(' ')[2].split('\t')[0]], { cwd: manifest.cwd, maxBuffer: 64 * 1024 * 1024 });
    if (blob.status !== 0) throw new Error(`unable to read verification gate input: ${file}`);
    return blob.stdout;
  }
  const value = manifest.snapshot.files[file];
  if (typeof value !== 'string') throw new Error(`verification gate input is absent from the frozen workspace: ${file}`);
  const mode = spawnSync('git', ['ls-files', '--stage', '-z', '--', file], { cwd: manifest.cwd, encoding: 'utf8' });
  if (mode.status !== 0 || mode.stdout.split('\0').some(row => row.split('\t')[1] === file && !/^100(?:644|755) /.test(row))) throw new Error(`verification gate input is not a regular file: ${file}`);
  if (!value.startsWith('git-blob:')) return Buffer.from(value, 'base64');
  const blob = spawnSync('git', ['cat-file', 'blob', value.slice('git-blob:'.length)], { cwd: manifest.cwd, maxBuffer: 64 * 1024 * 1024 });
  if (blob.status !== 0) throw new Error(`unable to read verification gate input: ${file}`);
  return blob.stdout;
}

async function executeCommand(spec, work, logs, name) {
  const output = await new Promise(resolveResult => {
    const child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: work, detached: process.platform !== 'win32',
      env: { PATH: process.env.PATH, LANG: process.env.LANG || 'C', HOME: join(work, '.home'), TMPDIR: join(work, '.tmp'), GIT_CEILING_DIRECTORIES: dirname(work) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let stdout = '', stderr = '', failure = null;
    const terminate = reason => {
      failure ||= reason;
      // Timed-out gates can leave mutation descendants running after their parent exits.
      try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') failure += `; ${error.message}`; }
    };
    const timer = setTimeout(() => terminate('timeout'), spec.timeout_ms);
    child.stdout.on('data', data => { if (Buffer.byteLength(stdout) + Buffer.byteLength(data) > MAX_OUTPUT_BYTES) terminate('output limit'); else stdout += data; });
    child.stderr.on('data', data => { if (Buffer.byteLength(stderr) + Buffer.byteLength(data) > MAX_OUTPUT_BYTES) terminate('output limit'); else stderr += data; });
    child.on('error', error => { failure ||= error.message; });
    child.on('close', (status, signal) => { clearTimeout(timer); resolveResult({ status, signal, failure, stdout, stderr }); });
  });
  writeFileSync(join(logs, `${name}.stdout`), output.stdout);
  writeFileSync(join(logs, `${name}.stderr`), output.stderr);
  if (output.failure || output.status !== 0) throw new Error(`verification gate ${name} failed: ${output.failure || `exit ${output.status}, signal ${output.signal}`}`);
  try { return JSON.parse(output.stdout); } catch { throw new Error(`verification gate ${name} did not return one JSON result`); }
}

export async function runVerificationGate(runDir, manifest) {
  const config = readState(join(runDir, 'verification-gate.json'));
  const work = join(runDir, 'verification-work');
  const logs = join(runDir, 'verification-logs');
  mkdirSync(work); mkdirSync(logs);
  mkdirSync(join(work, '.home')); mkdirSync(join(work, '.tmp'));
  const receipt = { schema_version: 1, status: 'failed', target_hash: manifest.target_hash, context_hash: manifest.context_hash,
    config_hash: manifest.verification.config_hash, inputs: [], baseline: null, mutants: [], isolation: 'frozen-files', error: null };
  try {
    for (const spec of [config.baseline, config.mutation]) {
      if (spec.argv[0].startsWith(`${manifest.cwd}/`)) throw new Error('verification gate must not execute a program from the live repository');
    }
    for (const file of config.files) {
      const bytes = inputBytes(manifest, file);
      const path = resolve(work, file);
      if (!path.startsWith(`${work}/`)) throw new Error('unsafe verification gate input path');
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes);
      receipt.inputs.push({ file, sha256: digest(bytes) });
    }
    const restored = () => {
      for (const input of receipt.inputs) {
        const path = join(work, input.file);
        if (!existsSync(path) || digest(readFileSync(path)) !== input.sha256) throw new Error(`verification gate did not restore input: ${input.file}`);
      }
    };
    if (config.measurement) receipt.measurement = validateMeasurement(config, work, receipt.inputs);
    const baseline = await executeCommand(config.baseline, work, logs, 'baseline');
    keys(baseline, ['schema_version', 'status', 'tests_run'], 'baseline result');
    if (baseline.schema_version !== 1 || baseline.status !== 'passed' || !Number.isSafeInteger(baseline.tests_run) || baseline.tests_run < 1) throw new Error('verification gate baseline requires passed tests with tests_run > 0');
    restored(); receipt.baseline = baseline;
    const mutation = await executeCommand(config.mutation, work, logs, 'mutation');
    keys(mutation, ['schema_version', 'mutants'], 'mutation result');
    if (mutation.schema_version !== 1 || !Array.isArray(mutation.mutants) || mutation.mutants.length !== config.mutants.length) throw new Error('verification gate mutant coverage is incomplete');
    const seen = new Set();
    for (const result of mutation.mutants) {
      keys(result, ['id', 'status', 'test_executed', 'violation'], 'mutant result');
      const expected = config.mutants.find(item => item.id === result.id);
      if (!expected || seen.has(result.id)) throw new Error('verification gate returned an unknown or duplicate mutant');
      seen.add(result.id); receipt.mutants.push({ ...expected, ...result });
      if (result.status !== 'killed' || result.test_executed !== true || result.violation !== expected.violation) throw new Error(`verification gate mutant ${result.id} was not killed by its expected violation`);
    }
    restored(); receipt.status = 'passed';
  } catch (error) { receipt.error = error.message; }
  finally { rmSync(work, { recursive: true, force: true }); }
  atomicJson(join(runDir, 'verification-receipt.json'), receipt);
  return receipt;
}

export function verifyVerificationGate(runDir, manifest, requirePassed = false) {
  if (!manifest.verification) return;
  if (digest(readFileSync(join(runDir, 'verification-gate.json'))) !== manifest.verification.config_hash) throw new Error('verification gate configuration bytes changed');
  if (!manifest.verification.receipt_hash) {
    if (requirePassed) throw new Error('verification gate has no validated receipt');
    return;
  }
  const bytes = readFileSync(join(runDir, 'verification-receipt.json'));
  if (digest(bytes) !== manifest.verification.receipt_hash) throw new Error('verification gate receipt bytes changed');
  const receipt = JSON.parse(bytes);
  if (receipt.target_hash !== manifest.target_hash || receipt.context_hash !== manifest.context_hash || receipt.config_hash !== manifest.verification.config_hash) throw new Error('verification gate receipt is bound to another target or context');
  const config = verificationConfig(readState(join(runDir, 'verification-gate.json')), manifest.context_contract);
  if (receipt.inputs.length > config.files.length || (requirePassed && receipt.inputs.length !== config.files.length)
    || receipt.inputs.some((input, index) => input.file !== config.files[index] || digest(inputBytes(manifest, input.file)) !== input.sha256)) throw new Error('verification gate receipt input hashes do not match the frozen files');
  if (requirePassed && receipt.status !== 'passed') throw new Error('verification gate did not pass');
}
