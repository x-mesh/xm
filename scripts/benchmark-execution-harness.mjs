#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'x-build', 'lib', 'x-build-cli.mjs');
const TRIALS = Number(process.env.X_BUILD_AB_TRIALS || 3);
const MODEL = process.env.X_BUILD_AB_MODEL || 'gpt-5.6-luna';
const EFFORT = process.env.X_BUILD_AB_EFFORT || 'low';
const KEEP = process.env.X_BUILD_AB_KEEP === '1';
// Comma-separated fixture ids; empty runs them all. Lets a new fixture be
// smoke-tested for a couple of minutes instead of a full 24-run sweep.
const ONLY = (process.env.X_BUILD_AB_FIXTURES || '').split(',').map((id) => id.trim()).filter(Boolean);
// Comma-separated variant ids; empty runs every variant.
const ONLY_VARIANTS = (process.env.X_BUILD_AB_VARIANTS || '').split(',').map((id) => id.trim()).filter(Boolean);
const OUTPUT_DIR = join(REPO, '.xm', 'eval', 'benchmarks');

function task(id, title, instruction, expectedFiles, stress = null) {
  return { id, title, instruction, expected_files: expectedFiles, stress, done_criteria: ['Requested content is present and node --test passes'] };
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
  // Reproduces docs/phase-model-routing-experiment.md. Wildcard matching was
  // tried first and failed as a fixture: it is a well-known problem, so the
  // model emits the linear two-pointer solution and the baseline is already
  // safe. A backtracking regex subset with nested quantifiers is the case
  // where the naive implementation is the natural one — (a+)+b against a long
  // non-matching run is the classic exponential blow-up.
  {
    id: 'redos-matcher',
    files: {
      '.gitignore': 'package-lock.json\n',
      'package.json': JSON.stringify({ name: 'redos-matcher', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
      'src/match.mjs': [
        '// Return true when `pattern` matches the WHOLE of `text`.',
        '// Supported syntax:',
        '//   literal characters',
        '//   .   any single character',
        '//   *   zero or more of the preceding unit',
        '//   +   one or more of the preceding unit',
        '//   ( ) grouping, so a quantifier can apply to a group',
        '// Implement the matching engine yourself. Do NOT construct a RegExp',
        '// or delegate to the built-in regular expression engine.',
        'export function match(pattern, text) {',
        "  throw new Error('not implemented');",
        '}',
        '',
      ].join('\n'),
      'test/fixture.test.mjs': [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { match } from '../src/match.mjs';",
        "test('matches literals, dot, and quantifiers', () => {",
        "  assert.equal(match('abc', 'abc'), true);",
        "  assert.equal(match('a.c', 'abc'), true);",
        "  assert.equal(match('ab*c', 'ac'), true);",
        "  assert.equal(match('ab*c', 'abbbc'), true);",
        "  assert.equal(match('ab+c', 'ac'), false);",
        "  assert.equal(match('ab+c', 'abbc'), true);",
        "  assert.equal(match('(ab)+', 'abab'), true);",
        "  assert.equal(match('(ab)+', 'aba'), false);",
        "  assert.equal(match('a*', 'aaa'), true);",
        "});",
        '',
      ].join('\n'),
    },
    tasks: [
      task('A', 'Implement the pattern matcher', 'Implement match(pattern, text) in src/match.mjs for the syntax described in the file comment, without using RegExp.', ['src/match.mjs'],
        'a nested quantifier such as (a+)+b applied to a long run of non-matching input makes backtracking explore exponentially many splits and the call never returns → prescription: bound the search explicitly (cap the number of match steps or memoize position/pattern pairs) and return a boolean or throw at the bound; never search unboundedly'),
    ],
  },
  // The three fixtures above are 3-line tasks with no room for a quality
  // difference. This one asks for behaviour the test does NOT pin down —
  // rejection of malformed input — so a blind rater has something to grade.
  {
    id: 'shared-validator',
    files: {
      '.gitignore': 'package-lock.json\n',
      'package.json': JSON.stringify({ name: 'shared-validator', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
      'src/validate.mjs': [
        '// Each rule takes a record and returns an array of error strings.',
        'export const rules = [];',
        '',
        'export function validate(record) {',
        '  return rules.flatMap((rule) => rule(record));',
        '}',
        '',
      ].join('\n'),
      'test/fixture.test.mjs': [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { validate, rules } from '../src/validate.mjs';",
        "test('accepts a valid record', () => {",
        "  assert.deepEqual(validate({ name: 'ok', age: 30, email: 'a@b.co' }), []);",
        "});",
        "test('registered rules reject at least one violation', () => {",
        "  assert.ok(rules.length > 0);",
        "  const bad = [{ name: '', age: 30, email: 'a@b.co' }, { name: 'ok', age: -1, email: 'a@b.co' }, { name: 'ok', age: 30, email: 'nope' }];",
        "  assert.ok(bad.some((record) => validate(record).length > 0));",
        "});",
        '',
      ].join('\n'),
    },
    tasks: [
      task('A', 'Add the name rule', 'Edit src/validate.mjs and push a rule onto rules that rejects a missing or empty name. Preserve every existing rule.', ['src/validate.mjs']),
      task('B', 'Add the age rule', 'Edit src/validate.mjs and push a rule onto rules that rejects an age that is not a non-negative number. Preserve every existing rule.', ['src/validate.mjs']),
      task('C', 'Add the email rule', 'Edit src/validate.mjs and push a rule onto rules that rejects an email without a local part, an @, and a domain. Preserve every existing rule.', ['src/validate.mjs']),
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

// Verbatim from x-build/lib/x-build/tasks.mjs buildAgentPrompt(). The harness
// variant here never reaches that function — the runner drives codex directly —
// so measuring x-build's prompt requires carrying the text across explicitly.
const LEAN_INSTRUCTIONS = [
  'Follow existing code patterns and conventions.',
  'Make the smallest change that satisfies the actual user goal. Do not add unsolicited abstractions, compatibility layers, configuration, telemetry, or state tracking.',
  'Treat the requested method as a hypothesis: verify it fits the repository and goal; if it does not, report concrete evidence and the simplest adequate alternative before changing code.',
  'Add a fallback only for a concrete evidenced failure condition, and only when activation is observable, behavioral differences are explicit, and both paths can be tested. Otherwise fail clearly; never hide failure behind broad catches, empty results, or arbitrary defaults.',
  'Do not claim quality, safety, or performance improvements that were not measured.',
  'Sequential execution is the default. Use parallel execution only when files, shared state, dependencies, and validation environments are verified independent and the expected time saving exceeds orchestration cost.',
  'Identify what this change can break and run only the smallest existing validation that directly observes that risk. Do not run test, lint, build, and review as a fixed checklist; explain any relevant check you intentionally omit.',
  "Write clean code and use the repository's existing validation commands when they are relevant to the changed behavior.",
];

const PLAN_MODEL = process.env.X_BUILD_AB_PLAN_MODEL || 'gpt-5.6-sol';
const PLAN_EFFORT = process.env.X_BUILD_AB_PLAN_EFFORT || 'high';

function planPromptFor(fixture) {
  return [
    'Write an implementation plan for the task below. Do NOT edit any file.',
    '',
    'Task: ' + fixture.tasks.map((item) => item.instruction).join(' / '),
    '',
    'Inspect the repository first, then output a plan with these sections and nothing else:',
    '- Approach: the algorithm or structure to use, and why it fits.',
    '- Failure modes: for each way the implementation can break on pathological or adversarial input, one line as "<what breaks> → 처방: <how the code must behave at the limit> → 검증: <how to observe it>". Write "none — <reason>" only if there is genuinely nothing to defend.',
    '- Done when: the observable conditions that make the task complete.',
  ].join('\n');
}

function agentMessage(result) {
  let message = '';
  for (const line of String(result.stdout || '').split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') message = event.item.text;
    } catch { /* progress line */ }
  }
  return message.trim();
}

function promptFor(spec, { lean = false, stress = false, plan = '' } = {}) {
  return [
    'Implement only this bounded fixture task: ' + spec.instruction,
    'Do not edit any other file. Do not commit. Do not install dependencies or create lockfiles. Do not run project-management commands.',
    ...(lean ? LEAN_INSTRUCTIONS : []),
    // Same shape import-plan injects into done_criteria from failure_modes.
    ...(stress && spec.stress ? ['스트레스: ' + spec.stress] : []),
    ...(plan ? ['', 'Follow this plan:', plan, ''] : []),
    'Run node --test after editing, then report the result briefly.',
  ].join('\n');
}

function runCodex(cwd, prompt, env = process.env, model = MODEL, effort = EFFORT) {
  const args = [
    'exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    '-m', model, '-c', 'model_reasoning_effort=' + JSON.stringify(effort), '--json', '-C', cwd, prompt,
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

// One agent at a time on a single checkout. This is the control that separates
// "serialization helped" from "the harness helped": the parallel native variant
// lets three agents rewrite the same file simultaneously, which is where the
// harness's structure-preservation win came from.
async function runAgentsSerial(entries) {
  const results = [];
  let retries = 0;
  for (const entry of entries) {
    let result = await runCodex(entry.cwd, promptFor(entry.task), entry.env);
    if (result.code !== 0) {
      retries += 1;
      const second = await runCodex(entry.cwd, promptFor(entry.task) + '\nThe previous attempt failed. Finish the same task.', entry.env);
      result = mergeAttempts(result, second);
    }
    results.push({ ...entry, result });
  }
  return { results, retries };
}

async function runAgents(entries, options = {}) {
  const execModel = options.execModel || MODEL;
  const initial = await Promise.all(entries.map(async (entry) => ({ ...entry, result: await runCodex(entry.cwd, promptFor(entry.task, options), entry.env, execModel) })));
  const results = [];
  let retries = 0;
  for (const row of initial) {
    if (row.result.code === 0) { results.push(row); continue; }
    retries += 1;
    const second = await runCodex(row.cwd, promptFor(row.task, options) + '\nThe previous attempt failed. Finish the same task.', row.env, execModel);
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
  } else if (fixture.id === 'redos-matcher') {
    const path = join(cwd, 'src', 'match.mjs');
    if (existsSync(path) && /not implemented/.test(readFileSync(path, 'utf8'))) errors.push('matcher is still a stub');
  } else if (fixture.id === 'shared-validator') {
    // Run the produced module and check each required violation is caught.
    // The fixture test only demands ONE of them, so this is where a lost task
    // shows up. Anything beyond these three cases is left for the blind rater.
    const probe = [
      'import { validate } from ' + JSON.stringify(pathToFileURL(join(cwd, 'src', 'validate.mjs')).href) + ';',
      "const cases = [['name', { name: '', age: 30, email: 'a@b.co' }], ['age', { name: 'ok', age: -1, email: 'a@b.co' }], ['email', { name: 'ok', age: 30, email: 'nope' }]];",
      'const missed = cases.filter(([, record]) => validate(record).length === 0).map(([key]) => key);',
      "const falsePositive = validate({ name: 'ok', age: 30, email: 'a@b.co' }).length > 0;",
      'process.stdout.write(JSON.stringify({ missed, falsePositive }));',
    ].join('\n');
    const result = run('node', ['--input-type=module', '-e', probe], { cwd, timeout: 30000 });
    if (result.code !== 0) errors.push('validator probe failed: ' + (result.stderr || '').slice(-300));
    else {
      try {
        const report = JSON.parse(result.stdout);
        for (const key of report.missed) errors.push('rule not enforced: ' + key);
        if (report.falsePositive) errors.push('valid record rejected');
      } catch { errors.push('validator probe emitted non-JSON'); }
    }
  } else {
    const text = readFileSync(join(cwd, 'src', 'registry.mjs'), 'utf8');
    for (const [name, value] of [['alpha', 1], ['beta', 2], ['gamma', 3]]) {
      if (!new RegExp(name + '\\s*:\\s*' + value + '\\b').test(text)) errors.push('missing registry entry ' + name);
    }
  }
  return { passed: errors.length === 0, errors };
}

// The scoring axis from docs/phase-model-routing-experiment.md: does the
// implementation still return on a pathological input? A naive backtracking
// matcher passes every visible test and hangs here.
const STRESS_BUDGET_MS = 5000;

function stressProbe(cwd, fixture) {
  if (fixture.id !== 'redos-matcher') return null;
  const source = [
    'import { match } from ' + JSON.stringify(pathToFileURL(join(cwd, 'src', 'match.mjs')).href) + ';',
    'const started = Date.now();',
    'let result = null, threw = null;',
    "try { result = match('(a+)+b', 'a'.repeat(28)); } catch (error) { threw = String(error && error.message || error); }",
    'process.stdout.write(JSON.stringify({ elapsed_ms: Date.now() - started, result, threw }));',
  ].join('\n');
  const outcome = run('node', ['--input-type=module', '-e', source], { cwd, timeout: STRESS_BUDGET_MS });
  // A timeout kills the child, so no stdout arrives: that is the hang.
  if (outcome.signal || (outcome.code !== 0 && !outcome.stdout.trim())) {
    return { returned: false, hung: true, elapsed_ms: outcome.elapsed_ms, detail: outcome.signal || (outcome.stderr || '').slice(-200) };
  }
  try {
    const report = JSON.parse(outcome.stdout);
    return { returned: true, hung: false, elapsed_ms: report.elapsed_ms, result: report.result, threw: report.threw };
  } catch {
    return { returned: false, hung: false, elapsed_ms: outcome.elapsed_ms, detail: 'probe emitted non-JSON' };
  }
}

function qualityProbe(cwd, fixture) {
  if (fixture.id !== 'redos-matcher') return null;
  const source = [
    'import { match } from ' + JSON.stringify(pathToFileURL(join(cwd, 'src', 'match.mjs')).href) + ';',
    'const errors = [];',
    'const check = (name, expected, fn) => {',
    '  try { const actual = fn(); if (actual !== expected) errors.push(name + `: expected ${expected}, got ${actual}`); }',
    '  catch (error) { errors.push(name + `: threw ${String(error && error.message || error)}`); }',
    '};',
    "check('nullable-star', true, () => match('a*', ''));",
    "check('nullable-nested-group', true, () => match('((a*)*)*', ''));",
    "check('unicode-dot', true, () => match('.', '😀'));",
    "check('unicode-literal', true, () => match('😀', '😀'));",
    'const rejectsMalformed = pattern => {',
    '  try { return match(pattern, `a`) === false; }',
    '  catch (error) { return error instanceof SyntaxError; }',
    '};',
    "for (const pattern of ['*a', 'a**', '(', 'a)']) check('malformed-' + pattern, true, () => rejectsMalformed(pattern));",
    "const deep = '('.repeat(2000) + 'a' + ')'.repeat(2000);",
    "check('deep-nesting', true, () => match(deep, 'a'));",
    'process.stdout.write(JSON.stringify({ errors }));',
  ].join('\n');
  const outcome = run('node', ['--input-type=module', '-e', source], { cwd, timeout: STRESS_BUDGET_MS });
  if (outcome.signal || (outcome.code !== 0 && !outcome.stdout.trim())) {
    return { passed: false, errors: ['quality probe did not return: ' + (outcome.signal || (outcome.stderr || '').slice(-200))] };
  }
  try {
    const report = JSON.parse(outcome.stdout);
    return { passed: report.errors.length === 0, errors: report.errors };
  } catch {
    return { passed: false, errors: ['quality probe emitted non-JSON'] };
  }
}

function verify(cwd, fixture) {
  const tests = testRepo(cwd);
  const semantic = validateFixture(cwd, fixture);
  const stress = stressProbe(cwd, fixture);
  const quality = qualityProbe(cwd, fixture);
  const stressPassed = !stress || (stress.returned && !stress.hung && stress.result === false && !stress.threw);
  return {
    ...tests, semantic, stress, quality,
    passed: tests.passed && semantic.passed && stressPassed && (!quality || quality.passed),
  };
}

function changedFiles(cwd) {
  return must(git(cwd, ['status', '--porcelain', '--untracked-files=all']), 'git status').stdout.split('\n').filter(Boolean).map((line) => line.slice(3));
}

// The blind quality rater compares these bodies, never the directories: a
// harness workspace carries .xm/build/** metadata that would reveal the variant.
function artifacts(cwd, fixture) {
  const out = {};
  for (const file of [...new Set(fixture.tasks.flatMap((item) => item.expected_files))].sort()) {
    const path = join(cwd, file);
    out[file] = existsSync(path) ? readFileSync(path, 'utf8') : null;
  }
  return out;
}

function digest(cwd, fixture) {
  const hash = createHash('sha256');
  for (const file of [...new Set(fixture.tasks.flatMap((item) => item.expected_files))].sort()) {
    hash.update(file).update('\0').update(existsSync(join(cwd, file)) ? readFileSync(join(cwd, file)) : Buffer.from('MISSING'));
  }
  return hash.digest('hex');
}

async function nativeTrial(fixture, root, trial, options = {}) {
  initRepo(root, fixture);
  const started = performance.now();
  const agents = await runAgents(fixture.tasks.map((item) => ({ task: item, cwd: root, env: process.env })), options);
  const verification = verify(root, fixture);
  return {
    fixture: fixture.id,
    variant: options.stress ? 'native-stress' : options.lean ? 'native-lean-prompt' : 'native',
    trial,
    wall_ms: performance.now() - started,
    agents: summarizeAgents(agents.results),
    retries: agents.retries,
    verification,
    changed_files: changedFiles(root),
    digest: digest(root, fixture),
    artifacts: artifacts(root, fixture),
  };
}

async function nativeSerialTrial(fixture, root, trial) {
  initRepo(root, fixture);
  const started = performance.now();
  const agents = await runAgentsSerial(fixture.tasks.map((item) => ({ task: item, cwd: root, env: process.env })));
  const verification = verify(root, fixture);
  return {
    fixture: fixture.id,
    variant: 'native-serial',
    trial,
    wall_ms: performance.now() - started,
    agents: summarizeAgents(agents.results),
    retries: agents.retries,
    verification,
    changed_files: changedFiles(root),
    digest: digest(root, fixture),
    artifacts: artifacts(root, fixture),
  };
}

// A planning turn on one model, execution turns on another — the routing the
// phase-model-routing experiment measured, which the fixture-driven variants
// never exercised because their plan was baked into the fixture.
const short = (model) => model.replace(/^gpt-5\.6-/, '');

async function plannedTrial(fixture, root, trial, planModel, execModel) {
  initRepo(root, fixture);
  const started = performance.now();
  const planning = await runCodex(root, planPromptFor(fixture), process.env, planModel, PLAN_EFFORT);
  const plan = agentMessage(planning);
  const agents = await runAgents(fixture.tasks.map((item) => ({ task: item, cwd: root, env: process.env })), { plan, execModel });
  const verification = verify(root, fixture);
  const execution = summarizeAgents(agents.results);
  const total = { ...execution, usage: { ...execution.usage } };
  for (const key of Object.keys(total.usage)) total.usage[key] += Number(planning.usage[key] || 0);
  return {
    fixture: fixture.id,
    variant: 'plan-' + short(planModel) + '-exec-' + short(execModel),
    trial,
    wall_ms: performance.now() - started,
    // Keep the combined usage for existing report readers, but preserve phase
    // attribution so mixed-model cost and latency can be computed correctly.
    agents: total,
    retries: agents.retries,
    plan_model: planModel,
    exec_model: execModel,
    planning_usage: {
      model: planModel,
      reasoning_effort: PLAN_EFFORT,
      wall_ms: planning.elapsed_ms,
      ...planning.usage,
    },
    execution_usage: {
      model: execModel,
      reasoning_effort: EFFORT,
      wall_ms_sum: execution.elapsed_ms_sum,
      wall_ms_max: execution.elapsed_ms_max,
      ...execution.usage,
    },
    plan_chars: plan.length,
    plan_text: plan,
    verification,
    changed_files: changedFiles(root),
    digest: digest(root, fixture),
    artifacts: artifacts(root, fixture),
  };
}

function addUsage(left, right) {
  const output = {};
  for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens']) {
    output[key] = Number(left?.[key] || 0) + Number(right?.[key] || 0);
  }
  return output;
}

function fastPathEligible(fixture) {
  return ['independent-modules', 'independent-config', 'redos-matcher'].includes(fixture.id);
}

async function adaptiveTrial(fixture, root, trial) {
  if (!fastPathEligible(fixture)) {
    const planned = await plannedTrial(fixture, root, trial, PLAN_MODEL, PLAN_MODEL);
    return { ...planned, variant: 'adaptive-stress-plan-sol', route: 'planned', escalated: false };
  }
  const fast = await nativeTrial(fixture, root, trial, { stress: true });
  const variant = 'adaptive-stress-plan-sol';
  if (fast.verification.passed) return { ...fast, variant, route: 'fast', escalated: false, fast_path: fast };

  // The fast path has already mutated and committed this fixture workspace. A
  // clean fallback workspace avoids treating that state as planning context.
  const fallback = await plannedTrial(fixture, root + '-fallback', trial, PLAN_MODEL, PLAN_MODEL);
  const executionUsage = addUsage(fast.agents.usage, fallback.execution_usage);
  return {
    ...fallback,
    variant,
    wall_ms: fast.wall_ms + fallback.wall_ms,
    agents: {
      ...fallback.agents,
      count: fast.agents.count + fallback.agents.count,
      failed: fast.agents.failed + fallback.agents.failed,
      usage: addUsage(fast.agents.usage, fallback.agents.usage),
      elapsed_ms_sum: fast.agents.elapsed_ms_sum + fallback.agents.elapsed_ms_sum,
      elapsed_ms_max: Math.max(fast.agents.elapsed_ms_max, fallback.agents.elapsed_ms_max),
    },
    retries: fast.retries + fallback.retries,
    route: 'escalated',
    execution_usage: {
      ...fallback.execution_usage,
      wall_ms_sum: fast.agents.elapsed_ms_sum + fallback.execution_usage.wall_ms_sum,
      wall_ms_max: fast.agents.elapsed_ms_max + fallback.execution_usage.wall_ms_max,
      ...executionUsage,
    },
    escalated: true,
    fast_path: fast,
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
      artifacts: artifacts(root, fixture),
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
  // Only fixtures that actually ran — X_BUILD_AB_FIXTURES may select a subset.
  for (const fixture of FIXTURES.filter((item) => rows.some((row) => row.fixture === item.id))) {
    output[fixture.id] = {};
    const variants = [...new Set(rows.filter((row) => row.fixture === fixture.id).map((row) => row.variant))];
    for (const variant of variants) {
      const samples = rows.filter((row) => row.fixture === fixture.id && row.variant === variant);
      output[fixture.id][variant] = {
        trials: samples.length,
        pass_rate: samples.filter((row) => row.verification.passed).length / samples.length,
        median_wall_ms: median(samples.map((row) => row.wall_ms)),
        median_input_tokens: median(samples.map((row) => row.agents.usage.input_tokens)),
        median_output_tokens: median(samples.map((row) => row.agents.usage.output_tokens)),
        median_planning_wall_ms: median(samples.map((row) => Number(row.planning_usage?.wall_ms || 0))),
        median_execution_wall_ms: median(samples.map((row) => Number(row.execution_usage?.wall_ms_max || row.agents.elapsed_ms_max || 0))),
        median_planning_input_tokens: median(samples.map((row) => Number(row.planning_usage?.input_tokens || 0))),
        median_planning_cached_input_tokens: median(samples.map((row) => Number(row.planning_usage?.cached_input_tokens || 0))),
        median_planning_output_tokens: median(samples.map((row) => Number(row.planning_usage?.output_tokens || 0))),
        median_execution_input_tokens: median(samples.map((row) => Number(row.execution_usage?.input_tokens || row.agents.usage.input_tokens || 0))),
        median_execution_cached_input_tokens: median(samples.map((row) => Number(row.execution_usage?.cached_input_tokens || row.agents.usage.cached_input_tokens || 0))),
        median_execution_output_tokens: median(samples.map((row) => Number(row.execution_usage?.output_tokens || row.agents.usage.output_tokens || 0))),
        retries: samples.reduce((sum, row) => sum + row.retries, 0),
        finish_retries: samples.reduce((sum, row) => sum + Number(row.finish_retries || 0), 0),
        recovery_rechecks: samples.reduce((sum, row) => sum + Number(row.recovery_rechecks || 0), 0),
        stress_returned: samples.filter((row) => row.verification.stress?.returned).length,
        stress_hung: samples.filter((row) => row.verification.stress?.hung).length,
        quality_gate_applicable: samples.filter((row) => row.verification.quality !== null).length,
        quality_gate_passed: samples.filter((row) => row.verification.quality?.passed === true).length,
        fast_routes: samples.filter((row) => row.route === 'fast').length,
        planned_routes: samples.filter((row) => row.route === 'planned').length,
        escalations: samples.filter((row) => row.escalated).length,
      };
    }
    const empty = { median_wall_ms: 0, median_input_tokens: 0, pass_rate: 0 };
    const native = output[fixture.id].native || empty;
    const serial = output[fixture.id]['native-serial'] || empty;
    const harness = output[fixture.id]['x-build-worktree'] || empty;
    const ratio = (a, b) => (b ? a / b : null);
    output[fixture.id].comparison = {
      wall_ratio_native_over_harness: ratio(native.median_wall_ms, harness.median_wall_ms),
      token_ratio_harness_over_native: ratio(harness.median_input_tokens, native.median_input_tokens),
      pass_rate_delta_harness_minus_native: harness.pass_rate - native.pass_rate,
      // native-serial is the control: it serializes without the harness, so a
      // harness win over it is the harness's own, not serialization's.
      wall_ratio_serial_over_harness: ratio(serial.median_wall_ms, harness.median_wall_ms),
      wall_ratio_native_over_serial: ratio(native.median_wall_ms, serial.median_wall_ms),
      pass_rate_delta_harness_minus_serial: harness.pass_rate - serial.pass_rate,
    };
  }
  return output;
}

async function main() {
  if (!Number.isInteger(TRIALS) || TRIALS < 1) throw new Error('X_BUILD_AB_TRIALS must be a positive integer');
  const selected = ONLY.length ? FIXTURES.filter((item) => ONLY.includes(item.id)) : FIXTURES;
  if (!selected.length) throw new Error('X_BUILD_AB_FIXTURES matched no fixture');
  const workspace = mkdtempSync(join(tmpdir(), 'x-build-ab-'));
  const rows = [];
  try {
    for (let trial = 1; trial <= TRIALS; trial += 1) {
      const order = selected.map((_, index) => selected[(index + trial - 1) % selected.length]);
      for (const fixture of order) {
        const rotation = (ONLY_VARIANTS.length ? ONLY_VARIANTS : ['native', 'native-serial', 'x-build-worktree']);
        const variants = rotation.map((_, index) => rotation[(index + trial - 1) % rotation.length]);
        for (const variant of variants) {
          const root = join(workspace, fixture.id + '-' + variant + '-t' + trial);
          process.stderr.write('[' + (rows.length + 1) + '/' + (selected.length * TRIALS * (ONLY_VARIANTS.length || 3)) + '] ' + fixture.id + ' ' + variant + ' trial ' + trial + '\n');
          const planned = variant.match(/^plan-([a-z0-9.]+)-exec-([a-z0-9.]+)$/);
          const row = planned ? await plannedTrial(fixture, root, trial, 'gpt-5.6-' + planned[1], 'gpt-5.6-' + planned[2]) : variant === 'adaptive-stress-plan-sol' ? await adaptiveTrial(fixture, root, trial) : variant === 'native' ? await nativeTrial(fixture, root, trial, {}) : variant === 'native-lean-prompt' ? await nativeTrial(fixture, root, trial, { lean: true }) : variant === 'native-stress' ? await nativeTrial(fixture, root, trial, { stress: true }) : variant === 'native-serial' ? await nativeSerialTrial(fixture, root, trial) : await harnessTrial(fixture, root, trial);
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
      fixtures: selected.map((fixture) => ({ id: fixture.id, tasks: fixture.tasks.length, expected_files: fixture.tasks.map((item) => item.expected_files) })),
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

export { addUsage, aggregate, fastPathEligible, median, qualityProbe, summarizeAgents };
