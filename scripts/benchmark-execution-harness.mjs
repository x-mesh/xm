#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'x-build', 'lib', 'x-build-cli.mjs');
const TRIALS = Number(process.env.X_BUILD_AB_TRIALS || 3);
const MODEL = process.env.X_BUILD_AB_MODEL || 'gpt-5.6-luna';
const EFFORT = process.env.X_BUILD_AB_EFFORT || 'low';
const KEEP = process.env.X_BUILD_AB_KEEP === '1';
const OUTPUT_DIR = join(REPO, '.xm', 'eval', 'benchmarks');

function task(id, title, instruction, expectedFiles) {
  return { id, title, instruction, expected_files: expectedFiles, done_criteria: ['Requested content is present and node --test passes'] };
}

const FIXTURES = [
  {
    id: 'independent-modules',
    files: {
      '.gitignore': 'package-lock.json\n',
      'package.json': JSON.stringify({ name: 'independent-modules', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
      'test/fixture.test.mjs': [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { existsSync } from 'node:fs';",
        "test('completed modules', async () => {",
        "  let count = 0;",
        "  for (const name of ['alpha', 'beta', 'gamma']) {",
        "    if (!existsSync(new URL('../src/' + name + '.mjs', import.meta.url))) continue;",
        "    const module = await import('../src/' + name + '.mjs');",
        "    assert.equal(module[name](), name); count += 1;",
        "  }",
        "  assert.ok(count > 0);",
        "});",
        '',
      ].join('\n'),
    },
    tasks: [
      task('A', 'Implement alpha module', 'Create src/alpha.mjs exporting function alpha that returns exactly "alpha".', ['src/alpha.mjs']),
      task('B', 'Implement beta module', 'Create src/beta.mjs exporting function beta that returns exactly "beta".', ['src/beta.mjs']),
      task('C', 'Implement gamma module', 'Create src/gamma.mjs exporting function gamma that returns exactly "gamma".', ['src/gamma.mjs']),
    ],
  },
  {
    id: 'independent-config',
    files: {
      '.gitignore': 'package-lock.json\n',
      'package.json': JSON.stringify({ name: 'independent-config', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
      'test/fixture.test.mjs': [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { existsSync } from 'node:fs';",
        "import { readFile } from 'node:fs/promises';",
        "const load = async (name) => JSON.parse(await readFile(new URL('../config/' + name + '.json', import.meta.url)));",
        "test('completed config', async () => {",
        "  let count = 0;",
        "  for (const name of ['alpha', 'beta', 'gamma']) {",
        "    if (!existsSync(new URL('../config/' + name + '.json', import.meta.url))) continue;",
        "    assert.deepEqual(await load(name), { name, enabled: true }); count += 1;",
        "  }",
        "  assert.ok(count > 0);",
        "});",
        '',
      ].join('\n'),
    },
    tasks: [
      task('A', 'Add alpha config', 'Create config/alpha.json containing a JSON object with name "alpha" and enabled true.', ['config/alpha.json']),
      task('B', 'Add beta config', 'Create config/beta.json containing a JSON object with name "beta" and enabled true.', ['config/beta.json']),
      task('C', 'Add gamma config', 'Create config/gamma.json containing a JSON object with name "gamma" and enabled true.', ['config/gamma.json']),
    ],
  },
  {
    id: 'shared-registry',
    files: {
      '.gitignore': 'package-lock.json\n',
      'package.json': JSON.stringify({ name: 'shared-registry', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
      'src/registry.mjs': 'export const registry = {\n};\n',
      'test/fixture.test.mjs': [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { registry } from '../src/registry.mjs';",
        "test('completed registry entries', () => {",
        "  assert.ok(Object.keys(registry).length > 0);",
        "  for (const [name, value] of Object.entries(registry)) assert.equal(value, { alpha: 1, beta: 2, gamma: 3 }[name]);",
        "});",
        '',
      ].join('\n'),
    },
    tasks: [
      task('A', 'Register alpha', 'Edit src/registry.mjs so registry includes alpha: 1 while preserving every existing entry.', ['src/registry.mjs']),
      task('B', 'Register beta', 'Edit src/registry.mjs so registry includes beta: 2 while preserving every existing entry.', ['src/registry.mjs']),
      task('C', 'Register gamma', 'Edit src/registry.mjs so registry includes gamma: 3 while preserving every existing entry.', ['src/registry.mjs']),
    ],
  },
];

function run(command, args, options = {}) {
  const started = performance.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeout || 120000,
    maxBuffer: 50 * 1024 * 1024,
  });
  return {
    code: result.status == null ? 1 : result.status,
    signal: result.signal || null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    elapsed_ms: performance.now() - started,
    error: result.error ? result.error.message : null,
  };
}

function must(result, label) {
  if (result.code !== 0) throw new Error(label + ' failed (' + result.code + '):\n' + (result.stderr || result.stdout));
  return result;
}

function parseJson(result, label) {
  must(result, label);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(label + ' emitted non-JSON output:\n' + result.stdout + '\n' + result.stderr); }
}

function git(cwd, args) { return run('git', args, { cwd }); }

function writeTree(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

function initRepo(root, fixture) {
  mkdirSync(root, { recursive: true });
  writeTree(root, fixture.files);
  must(git(root, ['init', '-q', '-b', 'develop']), 'git init');
  must(git(root, ['config', 'user.email', 'benchmark@example.com']), 'git config email');
  must(git(root, ['config', 'user.name', 'x-build benchmark']), 'git config name');
  must(git(root, ['add', '-A']), 'git add fixture');
  must(git(root, ['commit', '-qm', 'test: seed benchmark fixture']), 'git commit fixture');
}

function promptFor(spec) {
  return [
    'Implement only this bounded fixture task: ' + spec.instruction,
    'Do not edit any other file. Do not commit. Do not install dependencies or create lockfiles. Do not run project-management commands.',
    'Run node --test after editing, then report the result briefly.',
  ].join('\n');
}

function runCodex(cwd, prompt, env = process.env) {
  const args = [
    'exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    '-m', MODEL, '-c', 'model_reasoning_effort=' + JSON.stringify(EFFORT), '--json', '-C', cwd, prompt,
  ];
  const started = performance.now();
  return new Promise((done) => {
    const child = spawn('codex', args, { cwd, env: { ...env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => done({ code: 1, stdout, stderr, error: error.message, elapsed_ms: performance.now() - started, usage: {} }));
    child.on('close', (code, signal) => {
      const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
      for (const line of stdout.split('\n')) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'turn.completed' && event.usage) for (const key of Object.keys(usage)) usage[key] += Number(event.usage[key] || 0);
        } catch {}
      }
      done({ code: code == null ? 1 : code, signal: signal || null, stdout, stderr, usage, elapsed_ms: performance.now() - started });
    });
  });
}

function mergeAttempts(first, second) {
  const usage = {};
  for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens']) usage[key] = Number(first.usage[key] || 0) + Number(second.usage[key] || 0);
  return { ...second, elapsed_ms: first.elapsed_ms + second.elapsed_ms, usage, attempts: 2 };
}

async function runAgents(entries) {
  const initial = await Promise.all(entries.map(async (entry) => ({ ...entry, result: await runCodex(entry.cwd, promptFor(entry.task), entry.env) })));
  const results = [];
  let retries = 0;
  for (const row of initial) {
    if (row.result.code === 0) { results.push(row); continue; }
    retries += 1;
    const second = await runCodex(row.cwd, promptFor(row.task) + '\nThe previous attempt failed. Finish the same task.', row.env);
    results.push({ ...row, result: mergeAttempts(row.result, second) });
  }
  return { results, retries };
}

function summarizeAgents(rows) {
  const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  for (const row of rows) for (const key of Object.keys(usage)) usage[key] += Number(row.result.usage[key] || 0);
  return {
    count: rows.length,
    failed: rows.filter((row) => row.result.code !== 0).length,
    usage,
    elapsed_ms_sum: rows.reduce((sum, row) => sum + row.result.elapsed_ms, 0),
    elapsed_ms_max: Math.max(0, ...rows.map((row) => row.result.elapsed_ms)),
  };
}

function testRepo(cwd) {
  const result = run('node', ['--test'], { cwd, timeout: 60000 });
  return { passed: result.code === 0, code: result.code, elapsed_ms: result.elapsed_ms, stdout: result.stdout.slice(-4000), stderr: result.stderr.slice(-4000) };
}

function validateFixture(cwd, fixture) {
  const missing = [...new Set(fixture.tasks.flatMap((item) => item.expected_files))].filter((file) => !existsSync(join(cwd, file)));
  const errors = missing.map((file) => 'missing ' + file);
  if (fixture.id === 'independent-modules') {
    for (const name of ['alpha', 'beta', 'gamma']) {
      const path = join(cwd, 'src', name + '.mjs');
      if (existsSync(path) && !new RegExp('export\\s+(?:function|const)\\s+' + name + '[\\s\\S]*?[\"\']' + name + '[\"\']').test(readFileSync(path, 'utf8'))) errors.push('invalid ' + name + ' module');
    }
  } else if (fixture.id === 'independent-config') {
    for (const name of ['alpha', 'beta', 'gamma']) {
      const path = join(cwd, 'config', name + '.json');
      if (!existsSync(path)) continue;
      try {
        const value = JSON.parse(readFileSync(path, 'utf8'));
        if (value.name !== name || value.enabled !== true) errors.push('invalid ' + name + ' config');
      } catch { errors.push('invalid JSON in ' + name + ' config'); }
    }
  } else {
    const text = readFileSync(join(cwd, 'src', 'registry.mjs'), 'utf8');
    for (const [name, value] of [['alpha', 1], ['beta', 2], ['gamma', 3]]) {
      if (!new RegExp(name + '\\s*:\\s*' + value + '\\b').test(text)) errors.push('missing registry entry ' + name);
    }
  }
  return { passed: errors.length === 0, errors };
}

function verify(cwd, fixture) {
  const tests = testRepo(cwd);
  const semantic = validateFixture(cwd, fixture);
  return { ...tests, semantic, passed: tests.passed && semantic.passed };
}

function changedFiles(cwd) {
  return must(git(cwd, ['status', '--porcelain', '--untracked-files=all']), 'git status').stdout.split('\n').filter(Boolean).map((line) => line.slice(3));
}

function digest(cwd, fixture) {
  const hash = createHash('sha256');
  for (const file of [...new Set(fixture.tasks.flatMap((item) => item.expected_files))].sort()) {
    hash.update(file).update('\0').update(existsSync(join(cwd, file)) ? readFileSync(join(cwd, file)) : Buffer.from('MISSING'));
  }
  return hash.digest('hex');
}

async function nativeTrial(fixture, root, trial) {
  initRepo(root, fixture);
  const started = performance.now();
  const agents = await runAgents(fixture.tasks.map((item) => ({ task: item, cwd: root, env: process.env })));
  const verification = verify(root, fixture);
  return {
    fixture: fixture.id,
    variant: 'native',
    trial,
    wall_ms: performance.now() - started,
    agents: summarizeAgents(agents.results),
    retries: agents.retries,
    verification,
    changed_files: changedFiles(root),
    digest: digest(root, fixture),
  };
}

function harnessEnv(root) {
  return { ...process.env, NO_COLOR: '1', XKIT_SERVER: '0', XM_ROOT: join(root, '.xm'), X_BUILD_ROOT: join(root, '.xm', 'build'), X_PANEL_ROOT: join(root, '.xm') };
}

function xbuild(root, env, args, timeout = 120000) { return run('node', [CLI, ...args], { cwd: root, env, timeout }); }

function envelope(fixture) {
  return {
    schema_version: 1,
    status: 'complete',
    executable: true,
    goal: 'Implement ' + fixture.id + ' fixture',
    requirements: fixture.tasks.map((item, index) => ({ id: 'R' + (index + 1), text: item.instruction, priority: 'must' })),
    assumptions: [],
    decision: { selected: 'Execute supplied deterministic tasks', alternatives: [] },
    tasks: fixture.tasks.map((item, index) => ({
      id: item.id,
      title: item.title,
      depends_on: [],
      requirement_refs: ['R' + (index + 1)],
      expected_files: item.expected_files,
      done_criteria: item.done_criteria,
    })),
    steps: [fixture.tasks.map((item) => item.id)],
    validation: { commands: ['node --test'], requirement_refs: fixture.tasks.map((_, index) => 'R' + (index + 1)) },
    disagreements: [],
    unresolved_questions: [],
    provenance: { source: 'benchmark' },
  };
}

function commitTask(cwd, spec) {
  const unexpected = changedFiles(cwd).filter((file) => !spec.expected_files.includes(file) && file !== 'TASK-CONTEXT.md');
  if (unexpected.length) throw new Error(spec.id + ' changed unexpected files: ' + unexpected.join(', '));
  must(run('git-kit', ['commit', '-m', 'feat(fixture): complete ' + spec.id.toLowerCase(), '--', ...spec.expected_files], {
    cwd,
    env: { ...process.env, GK_AGENT: '1' },
    timeout: 60000,
  }), 'commit ' + spec.id);
}

function cleanupWorktrees(root) {
  const result = git(root, ['worktree', 'list', '--porcelain']);
  if (result.code !== 0) return;
  const paths = result.stdout.split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9));
  for (const path of paths) if (resolve(path) !== resolve(root)) git(root, ['worktree', 'remove', '--force', path]);
  git(root, ['worktree', 'prune']);
}

async function harnessTrial(fixture, root, trial) {
  initRepo(root, fixture);
  const env = harnessEnv(root);
  const project = 'bench';
  const plan = join(root, 'plan-envelope.json');
  writeFileSync(plan, JSON.stringify(envelope(fixture), null, 2));
  must(git(root, ['add', 'plan-envelope.json']), 'git add plan');
  must(git(root, ['commit', '-qm', 'test: add benchmark plan']), 'git commit plan');
  const started = performance.now();
  must(xbuild(root, env, ['init', project]), 'x-build init');
  const imported = parseJson(xbuild(root, env, ['import-plan', plan, '--project', project, '--json']), 'x-build import-plan');
  must(xbuild(root, env, ['plan-check', '--project', project, '--json']), 'x-build plan-check');
  must(xbuild(root, env, ['gate', 'pass', 'Benchmark plan approved', '--project', project]), 'x-build gate pass');
  const taskMap = new Map(fixture.tasks.map((item, index) => ['t' + (index + 1), item]));
  const agentRows = [];
  const finishRows = [];
  let retries = 0;
  let acquireMs = 0;
  let taskCheckMs = 0;
  let finishMs = 0;
  let batches = 0;
  let recoveryRechecks = 0;
  let recoverySyncMs = 0;
  try {
    while (true) {
      const invocation = xbuild(root, env, ['run', '--project', project, '--worktrees', '--max-parallel', '3', '--base', 'develop', '--json'], 180000);
      must(invocation, 'x-build run --worktrees');
      acquireMs += invocation.elapsed_ms;
      const batch = JSON.parse(invocation.stdout);
      if (batch.status === 'all_done' || !batch.tasks || batch.tasks.length === 0) break;
      batches += 1;
      const entries = batch.tasks.map((entry) => ({ task: taskMap.get(entry.task_id), task_id: entry.task_id, cwd: entry.worktree, env: { ...env, ...entry.env } }));
      if (entries.some((entry) => !entry.task || !entry.cwd)) throw new Error('Invalid worktree batch: ' + invocation.stdout);
      const agents = await runAgents(entries);
      retries += agents.retries;
      agentRows.push(...agents.results);
      for (const row of agents.results) {
        if (row.result.code !== 0) throw new Error('agent ' + row.task_id + ' failed: ' + row.result.stderr);
        commitTask(row.cwd, row.task);
        const check = xbuild(row.cwd, row.env, ['task-check', row.task_id, '--project', project, '--json'], 120000);
        taskCheckMs += check.elapsed_ms;
        if (!parseJson(check, 'task-check ' + row.task_id).passed) throw new Error('task-check ' + row.task_id + ' did not pass');
      }
      const ids = entries.map((entry) => entry.task_id);
      const finish = xbuild(root, env, ['worktrees', 'resume', ...ids, '--project', project, '--base', 'develop', '--json'], 180000);
      finishMs += finish.elapsed_ms;
      const output = parseJson(finish, 'worktrees resume');
      finishRows.push(...output.results);
      let blocked = output.results.filter((row) => row.worktree_status !== 'DONE');
      if (blocked.length && blocked.every((row) => row.error === 'task_checks_missing')) {
        const remaining = [];
        for (const item of blocked) {
          recoveryRechecks += 1;
          const entry = entries.find((candidate) => candidate.task_id === item.task_id);
          const sync = run('git-kit', ['sync', '--base', 'develop', '--json'], {
            cwd: entry.cwd,
            env: { ...entry.env, GK_AGENT: '1' },
            timeout: 120000,
          });
          recoverySyncMs += sync.elapsed_ms;
          must(sync, 'recovery sync ' + item.task_id);
          const check = xbuild(entry.cwd, entry.env, ['task-check', item.task_id, '--project', project, '--json'], 120000);
          taskCheckMs += check.elapsed_ms;
          if (!parseJson(check, 'recovery task-check ' + item.task_id).passed) throw new Error('recovery task-check ' + item.task_id + ' did not pass');
          const recovered = xbuild(root, env, ['worktrees', 'resume', item.task_id, '--project', project, '--base', 'develop', '--json'], 180000);
          finishMs += recovered.elapsed_ms;
          const recoveredOutput = parseJson(recovered, 'worktrees recovery resume ' + item.task_id);
          finishRows.push(...recoveredOutput.results);
          remaining.push(...recoveredOutput.results.filter((row) => row.worktree_status !== 'DONE'));
        }
        blocked = remaining;
      }
      if (blocked.length) throw new Error('worktree finish failed after recovery: ' + JSON.stringify(blocked));
    }
    const verification = verify(root, fixture);
    return {
      fixture: fixture.id,
      variant: 'x-build-worktree',
      trial,
      wall_ms: performance.now() - started,
      agents: summarizeAgents(agentRows),
      retries,
      verification,
      changed_files: changedFiles(root),
      digest: digest(root, fixture),
      batches,
      acquire_ms: acquireMs,
      task_check_ms: taskCheckMs,
      finish_ms: finishMs,
      recovery_rechecks: recoveryRechecks,
      recovery_sync_ms: recoverySyncMs,
      import_parallelism: imported.parallelism,
      finish_retries: finishRows.filter((row) => row.retried).length,
    };
  } finally {
    cleanupWorktrees(root);
  }
}

function median(values) {
  const rows = [...values].sort((a, b) => a - b);
  if (!rows.length) return 0;
  const middle = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
}

function aggregate(rows) {
  const output = {};
  for (const fixture of FIXTURES) {
    output[fixture.id] = {};
    for (const variant of ['native', 'x-build-worktree']) {
      const samples = rows.filter((row) => row.fixture === fixture.id && row.variant === variant);
      output[fixture.id][variant] = {
        trials: samples.length,
        pass_rate: samples.filter((row) => row.verification.passed).length / samples.length,
        median_wall_ms: median(samples.map((row) => row.wall_ms)),
        median_input_tokens: median(samples.map((row) => row.agents.usage.input_tokens)),
        median_output_tokens: median(samples.map((row) => row.agents.usage.output_tokens)),
        retries: samples.reduce((sum, row) => sum + row.retries, 0),
        finish_retries: samples.reduce((sum, row) => sum + Number(row.finish_retries || 0), 0),
        recovery_rechecks: samples.reduce((sum, row) => sum + Number(row.recovery_rechecks || 0), 0),
      };
    }
    const native = output[fixture.id].native;
    const harness = output[fixture.id]['x-build-worktree'];
    output[fixture.id].comparison = {
      wall_ratio_native_over_harness: harness.median_wall_ms ? native.median_wall_ms / harness.median_wall_ms : null,
      token_ratio_harness_over_native: native.median_input_tokens ? harness.median_input_tokens / native.median_input_tokens : null,
      pass_rate_delta_harness_minus_native: harness.pass_rate - native.pass_rate,
    };
  }
  return output;
}

async function main() {
  if (!Number.isInteger(TRIALS) || TRIALS < 1) throw new Error('X_BUILD_AB_TRIALS must be a positive integer');
  const workspace = mkdtempSync(join(tmpdir(), 'x-build-ab-'));
  const rows = [];
  try {
    for (let trial = 1; trial <= TRIALS; trial += 1) {
      const order = FIXTURES.map((_, index) => FIXTURES[(index + trial - 1) % FIXTURES.length]);
      for (const fixture of order) {
        const variants = trial % 2 ? ['native', 'x-build-worktree'] : ['x-build-worktree', 'native'];
        for (const variant of variants) {
          const root = join(workspace, fixture.id + '-' + variant + '-t' + trial);
          process.stderr.write('[' + (rows.length + 1) + '/' + (FIXTURES.length * TRIALS * 2) + '] ' + fixture.id + ' ' + variant + ' trial ' + trial + '\n');
          const row = variant === 'native' ? await nativeTrial(fixture, root, trial) : await harnessTrial(fixture, root, trial);
          rows.push(row);
          process.stderr.write('  ' + (row.verification.passed ? 'PASS' : 'FAIL') + ' ' + (row.wall_ms / 1000).toFixed(1) + 's input=' + row.agents.usage.input_tokens + ' retries=' + row.retries + '\n');
        }
      }
    }
    const report = {
      schema: 1,
      created_at: new Date().toISOString(),
      model: MODEL,
      reasoning_effort: EFFORT,
      trials_per_variant: TRIALS,
      fixtures: FIXTURES.map((fixture) => ({ id: fixture.id, tasks: fixture.tasks.length, expected_files: fixture.tasks.map((item) => item.expected_files) })),
      rows,
      aggregate: aggregate(rows),
    };
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const output = join(OUTPUT_DIR, 'x-build-execution-harness-' + stamp + '.json');
    writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ output, aggregate: report.aggregate }, null, 2));
  } finally {
    if (KEEP) process.stderr.write('kept workspace: ' + workspace + '\n');
    else rmSync(workspace, { recursive: true, force: true });
  }
}

await main();
