import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hashReviewContext } from '../x-review/skills/review/scripts/context-contract.mjs';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'x-review/lib/x-review-cli.mjs');
const MUTATE_CLI = join(ROOT, 'x-build/lib/x-build-cli.mjs');
const PANEL = join(import.meta.dirname, 'fixtures/fake-review-panel.mjs');
const dirs = [];
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const context = { schema_version: 1, goal: 'Protect the exported value', invariants: [{ id: 'I1', text: 'a remains 1' }], constraints: [], non_goals: [], acceptance_checks: [{ id: 'C1', description: 'Check I1 and reject its mutation' }] };

function workspace(mode = 'kill') {
  const dir = mkdtempSync(join(tmpdir(), 'review-verification-')); dirs.push(dir);
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/a.js'), 'export const a = 1;\nexport const b = 2;\n');
  writeFileSync(join(dir, 'target.patch'), 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1,2 @@\n export const a = 1;\n+export const b = 2;\n');
  writeFileSync(join(dir, 'context.json'), JSON.stringify(context));
  writeFileSync(join(dir, 'gate.mjs'), `
import {readFileSync,writeFileSync} from 'node:fs';
const phase=process.argv[2], mode=process.argv[3];
const path='src/a.js', original=readFileSync(path,'utf8');
if(phase==='baseline') {
  console.log(JSON.stringify({schema_version:1,status:original.includes('a = 1')?'passed':'failed',tests_run:mode==='zero'?0:1}));
} else {
  if(mode==='timeout') { setTimeout(()=>{},10000); }
  else if(mode==='malformed') console.log('not JSON');
  else {
    writeFileSync(path,original.replace('a = 1','a = 9'));
    const detected=!readFileSync(path,'utf8').includes('a = 1');
    const item={id:'break-I1',status:mode==='survive'?'survived':mode==='build'?'build_failed':detected?'killed':'survived',test_executed:mode!=='not-run',violation:mode==='wrong'?'I2':'I1'};
    if(mode!=='no-restore') writeFileSync(path,original);
    console.log(JSON.stringify({schema_version:1,mutants:mode==='missing'?[]:mode==='duplicate'?[item,item]:[item]}));
  }
}
`);
  const config = { schema_version: 1, files: ['src/a.js', 'gate.mjs'], baseline: { argv: ['node', 'gate.mjs', 'baseline', mode], timeout_ms: 2000 }, mutation: { argv: ['node', 'gate.mjs', 'mutation', mode], timeout_ms: mode === 'timeout' ? 100 : 2000 }, mutants: [{ id: 'break-I1', invariant_id: 'I1', violation: 'I1' }] };
  writeFileSync(join(dir, 'gate.json'), JSON.stringify(config));
  writeFileSync(join(dir, 'panel.mjs'), `import {spawnSync} from 'node:child_process';const child=spawnSync(process.execPath,[${JSON.stringify(PANEL)},...process.argv.slice(2)],{encoding:'utf8',env:process.env});if(child.status!==0){process.stderr.write(child.stderr);process.exit(child.status);}const result=JSON.parse(child.stdout);result.context_hash=${JSON.stringify(hashReviewContext(context))};console.log(JSON.stringify(result));`);
  for (const args of [['init'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.test'], ['add', '.'], ['commit', '-m', 'fixture']]) {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  return dir;
}

function cli(dir, args) {
  return spawnSync('node', [CLI, ...args, '--json', '--no-trace'], { cwd: dir, encoding: 'utf8', env: {
    ...process.env, XM_REVIEW_ROOT: join(dir, '.xm'), XM_REVIEW_PANEL_COMMAND: JSON.stringify(['node', join(dir, 'panel.mjs')]), XM_FAKE_PANEL_LOG: join(dir, 'panel.log'), XM_FAKE_PANEL_MODE: 'clean',
  } });
}
const prepare = dir => cli(dir, ['prepare', 'target.patch', '--context-file', 'context.json', '--gate-file', 'gate.json', '--lenses', 'correctness', '--run-id', 'gated-run']);
const runDir = dir => join(dir, '.xm/review/runs/gated-run');

afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

describe('project review verification gate', () => {
  test('concurrent authoring requests grant one reservation only', async () => {
    const dir = workspace();
    writeFileSync(join(dir, 'scope.json'), JSON.stringify({ files: ['gate.json'] }));
    const args = ['author-gate', '--operation-id', 'review-task', '--context-file', 'context.json', '--scope-file', 'scope.json', '--reason', 'Protect I1', '--json'];
    const request = () => new Promise(resolve => {
      const child = spawn('node', [CLI, ...args], { cwd: dir, env: { ...process.env, XM_REVIEW_ROOT: join(dir, '.xm') } });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('close', status => resolve({ status, stdout, stderr }));
    });
    const results = await Promise.all([request(), request()]);
    expect(results.filter(result => result.status === 0)).toHaveLength(1);
    const reservation = JSON.parse(results.find(result => result.status === 0).stdout).authoring;
    expect(read(join(dir, '.xm/review/budget.json')).operations['operation:review-task'].gate_authoring.id).toBe(reservation.id);
    expect(read(join(dir, '.xm/review/budget.json')).operations['operation:review-task'].used).toEqual({ full: 0, fix: 0, delta: 0 });
  });

  test('SIGKILL after budget persistence does not refund authoring or permit another task alias', async () => {
    const dir = workspace();
    writeFileSync(join(dir, 'scope.json'), JSON.stringify({ files: ['gate.json'] }));
    const script = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const rename=fs.renameSync;fs.renameSync=(from,to)=>{rename(from,to);if(to.endsWith('/review/budget.json')){fs.writeSync(1,'PERSISTED\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}};syncBuiltinESMExports();
const {reserveGateAuthoring}=await import(${JSON.stringify(join(ROOT, 'x-review/lib/review-lifecycle.mjs'))});
await reserveGateAuthoring({cwd:${JSON.stringify(dir)},operationId:'review-task',contextFile:'context.json',scopeFile:'scope.json',reason:'Protect I1'});`;
    await new Promise((resolve, reject) => {
      const child = spawn('node', ['--input-type=module', '-e', script], { cwd: dir, env: { ...process.env, XM_REVIEW_ROOT: join(dir, '.xm') } });
      let output = '', error = '', killed = false;
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`fixture did not persist reservation: ${error}`)); }, 4000);
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('PERSISTED') && !killed) { killed = true; child.kill('SIGKILL'); } });
      child.stderr.on('data', chunk => { error += chunk; });
      child.on('close', (status, signal) => { clearTimeout(timer); if (killed && signal === 'SIGKILL') resolve(); else reject(new Error(`unexpected fixture exit ${status}: ${error}`)); });
    });
    const before = read(join(dir, '.xm/review/budget.json'));
    const result = cli(dir, ['author-gate', '--operation-id', 'review-task', '--task-id', 'fresh-alias', '--context-file', 'context.json', '--scope-file', 'scope.json', '--reason', 'Retry']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('already reserved');
    expect(read(join(dir, '.xm/review/budget.json'))).toEqual(before);
    expect(existsSync(join(dir, '.xm/review/lifecycle.lock'))).toBe(false);
  });

  test('authoring rejects modified, added and deleted files outside its approved scope', () => {
    for (const variant of ['modified', 'added', 'deleted']) {
      const dir = workspace();
      writeFileSync(join(dir, 'src/a.js'), 'export const a = 1;\nexport const b = 3;\n');
      writeFileSync(join(dir, 'scope.json'), JSON.stringify({ files: ['gate.json'] }));
      expect(cli(dir, ['author-gate', '--operation-id', 'review-task', '--context-file', 'context.json', '--scope-file', 'scope.json', '--reason', 'Protect I1']).status).toBe(0);
      if (variant === 'modified') writeFileSync(join(dir, 'src/a.js'), 'export const a = 1;\nexport const b = 4;\n');
      if (variant === 'added') writeFileSync(join(dir, 'src/outside.mjs'), 'export const outside = true;\n');
      if (variant === 'deleted') rmSync(join(dir, 'panel.mjs'));
      const result = cli(dir, ['prepare', 'target.patch', '--operation-id', 'review-task', '--context-file', 'context.json', '--gate-file', 'gate.json', '--run-id', 'authored-review']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('outside approved gate authoring scope');
      expect(read(join(dir, '.xm/review/budget.json')).operations['operation:review-task'].used.full).toBe(0);
      expect(existsSync(join(dir, 'panel.log'))).toBe(false);
    }
  });

  test('approved authoring edits preserve pre-existing out-of-scope changes', () => {
    const dir = workspace();
    writeFileSync(join(dir, 'src/a.js'), 'export const a = 1;\nexport const b = 3;\n');
    writeFileSync(join(dir, 'scope.json'), JSON.stringify({ files: ['gate.json', 'test/new.test.mjs'] }));
    expect(cli(dir, ['author-gate', '--operation-id', 'review-task', '--context-file', 'context.json', '--scope-file', 'scope.json', '--reason', 'Protect I1']).status).toBe(0);
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'test/new.test.mjs'), 'import assert from "node:assert/strict"; assert.equal(1, 1);\n');
    writeFileSync(join(dir, 'gate.json'), `${readFileSync(join(dir, 'gate.json'), 'utf8')}\n`);
    expect(cli(dir, ['prepare', 'target.patch', '--operation-id', 'review-task', '--context-file', 'context.json', '--gate-file', 'gate.json', '--run-id', 'authored-review']).status).toBe(0);
    expect(readFileSync(join(dir, 'src/a.js'), 'utf8')).toContain('b = 3');
  });

  test('a changed authoring scope baseline cannot authorize the first review', () => {
    const dir = workspace();
    writeFileSync(join(dir, 'scope.json'), JSON.stringify({ files: ['gate.json'] }));
    const reserved = cli(dir, ['author-gate', '--operation-id', 'review-task', '--context-file', 'context.json', '--scope-file', 'scope.json', '--reason', 'Protect I1']);
    expect(reserved.status).toBe(0);
    const baseline = join(JSON.parse(reserved.stdout).run_dir, 'workspace.json');
    writeFileSync(baseline, `${readFileSync(baseline, 'utf8')}\n`);
    const result = cli(dir, ['prepare', 'target.patch', '--operation-id', 'review-task', '--context-file', 'context.json', '--gate-file', 'gate.json', '--run-id', 'authored-review']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('scope baseline bytes changed');
    expect(read(join(dir, '.xm/review/budget.json')).operations['operation:review-task'].used.full).toBe(0);
  });

  test('normal delta changes after completed authoring are not compared to the authoring edit scope', () => {
    const dir = workspace();
    writeFileSync(join(dir, 'scope.json'), JSON.stringify({ files: ['gate.json'] }));
    expect(cli(dir, ['author-gate', '--operation-id', 'review-task', '--context-file', 'context.json', '--scope-file', 'scope.json', '--reason', 'Protect I1']).status).toBe(0);
    expect(cli(dir, ['run', 'target.patch', '--operation-id', 'review-task', '--context-file', 'context.json', '--gate-file', 'gate.json', '--lenses', 'correctness', '--run-id', 'authored-review']).status).toBe(0);
    writeFileSync(join(dir, 'src/a.js'), 'export const a = 1;\nexport const b = 3;\n');
    const result = cli(dir, ['prepare', '--operation-id', 'review-task', '--lenses', 'correctness', '--run-id', 'authored-delta']);
    expect(result.status).toBe(0);
    expect(read(join(dir, '.xm/review/runs/authored-delta/run.json')).review_mode).toBe('delta');
  });

  test('the existing mutate CLI keeps generic survivors advisory and cannot count unviable as a killed gate mutant', () => {
    for (const outcome of ['kill', 'build']) {
      const dir = workspace();
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
      writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
      mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true });
      const bin = join(dir, 'node_modules/.bin/stryker');
      writeFileSync(bin, `#!/usr/bin/env node
const fs=require('node:fs');
if(process.argv.includes('--version')) { console.log('1.0.0'); process.exit(0); }
const config=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
const mutants=['Killed','Survived','CompileError'].map((status,id)=>({id:String(id),mutatorName:'FixtureOperator',replacement:String(id),status,location:{start:{line:2,column:1},end:{line:2,column:2}}}));
fs.writeFileSync(config.jsonReporter.fileName,JSON.stringify({files:{'src/a.js':{mutants}}}));
process.exit(1);
`);
      chmodSync(bin, 0o755);
      writeFileSync(join(dir, 'src/a.js'), 'export const a = 1;\nexport const b = 3;\n');
      writeFileSync(join(dir, 'scope.json'), JSON.stringify({ files: ['gate.json', 'gate.mjs', 'measurement.json'] }));
      expect(cli(dir, ['author-gate', '--operation-id', 'review-task', '--context-file', 'context.json', '--scope-file', 'scope.json', '--reason', 'Protect I1']).status).toBe(0);
      const env = { ...process.env }; delete env.X_BUILD_ROOT; delete env.XM_ROOT;
      const measured = spawnSync('node', [MUTATE_CLI, 'mutate-diff', '--diff', 'HEAD', '--lang', 'javascript', '--json'], { cwd: dir, encoding: 'utf8', env });
      expect(measured.status).toBe(1);
      expect(JSON.parse(measured.stdout).measurement.status).toBe('incomplete');
      const report = JSON.parse(measured.stdout);
      expect(report.counts).toMatchObject({ killed: 1, survived: 1, unviable: 1 });
      expect(report.mutants.map(item => item.status)).toEqual(['killed', 'survived', 'unviable']);
      expect(report.languages[0].tool).toBe('StrykerJS');
      writeFileSync(join(dir, 'measurement.json'), JSON.stringify(report));
      const adapter = readFileSync(join(dir, 'gate.mjs'), 'utf8');
      writeFileSync(join(dir, 'gate.mjs'), `import fs from 'node:fs';const report=JSON.parse(fs.readFileSync('measurement.json','utf8'));if(report.counts.survived!==1||report.counts.unviable!==1)throw Error('invalid observational report');\n${adapter}`);
      const config = read(join(dir, 'gate.json'));
      config.files.push('measurement.json'); config.mutation.argv[3] = outcome;
      writeFileSync(join(dir, 'gate.json'), JSON.stringify(config));
      const result = cli(dir, ['prepare', 'target.patch', '--operation-id', 'review-task', '--context-file', 'context.json', '--gate-file', 'gate.json', '--run-id', 'authored-review']);
      expect(result.status).toBe(outcome === 'kill' ? 0 : 1);
      const receipt = read(join(dir, '.xm/review/runs/authored-review/verification-receipt.json'));
      expect(receipt.inputs.some(item => item.file === 'measurement.json')).toBe(true);
      expect(receipt.status).toBe(outcome === 'kill' ? 'passed' : 'failed');
      if (outcome === 'kill') expect(receipt.mutants).toHaveLength(1);
      else expect(receipt.error).toContain('not killed by its expected violation');
    }
  });

  test('gate authoring reserves one pass in the same operation without spending review units', () => {
    const dir = workspace();
    writeFileSync(join(dir, 'scope.json'), JSON.stringify({ files: ['gate.json', 'test/new.test.mjs'] }));
    const args = ['author-gate', '--operation-id', 'review-task', '--context-file', 'context.json', '--scope-file', 'scope.json', '--reason', 'Protect I1'];
    const reserved = cli(dir, args);
    expect(reserved.status).toBe(0);
    const output = JSON.parse(reserved.stdout);
    expect(output.authoring).toMatchObject({ operation_id: 'review-task', context_hash: hashReviewContext(context), state: 'reserved' });
    expect(output.authoring.files.find(item => item.file === 'test/new.test.mjs')).toMatchObject({ exists: false, sha256: null });
    const path = join(dir, '.xm/review/budget.json');
    const before = readFileSync(path, 'utf8');
    expect(read(path).operations['operation:review-task'].used).toEqual({ full: 0, fix: 0, delta: 0 });
    expect(cli(dir, [...args, '--task-id', 'another-alias']).status).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(cli(dir, ['prepare', 'target.patch', '--operation-id', 'review-task', '--context-file', 'context.json', '--gate-file', 'gate.json', '--run-id', 'authored-review']).status).toBe(0);
  });

  test('authored review cannot drop its gate or weaken its reserved context', () => {
    for (const variant of ['missing-gate', 'changed-context']) {
      const dir = workspace();
      writeFileSync(join(dir, 'scope.json'), JSON.stringify({ files: ['gate.json'] }));
      expect(cli(dir, ['author-gate', '--operation-id', 'review-task', '--context-file', 'context.json', '--scope-file', 'scope.json', '--reason', 'Protect I1']).status).toBe(0);
      if (variant === 'changed-context') writeFileSync(join(dir, 'context.json'), JSON.stringify({ ...context, invariants: [{ id: 'I1', text: 'Any value is acceptable' }] }));
      const args = ['prepare', 'target.patch', '--operation-id', 'review-task', '--context-file', 'context.json', '--run-id', 'authored-review'];
      if (variant !== 'missing-gate') args.push('--gate-file', 'gate.json');
      const result = cli(dir, args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('reserved context and operation identity');
      expect(existsSync(join(dir, 'panel.log'))).toBe(false);
      expect(read(join(dir, '.xm/review/budget.json')).operations['operation:review-task'].used.full).toBe(0);
    }
  });

  test('gate authoring rejects an active review and unsafe output scope', () => {
    const dir = workspace();
    writeFileSync(join(dir, 'scope.json'), JSON.stringify({ files: ['../outside.js'] }));
    const args = ['author-gate', '--operation-id', 'review-task', '--context-file', 'context.json', '--scope-file', 'scope.json', '--reason', 'Protect I1'];
    expect(cli(dir, args).status).toBe(1);
    expect(existsSync(join(dir, '.xm/review/budget.json'))).toBe(false);
    writeFileSync(join(dir, 'scope.json'), JSON.stringify({ files: ['gate.json'] }));
    expect(prepare(dir).status).toBe(0);
    const result = cli(dir, args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('active review');
  });

  test('a completed delta cannot start a gate authoring follow-up', () => {
    const dir = workspace();
    expect(cli(dir, ['run', 'target.patch', '--operation-id', 'review-task', '--context-file', 'context.json', '--gate-file', 'gate.json', '--lenses', 'correctness', '--run-id', 'gated-run']).status).toBe(0);
    writeFileSync(join(dir, 'src/a.js'), 'export const a = 1;\nexport const b = 3;\n');
    expect(cli(dir, ['run', '--operation-id', 'review-task', '--lenses', 'correctness', '--run-id', 'gated-delta']).status).toBe(0);
    writeFileSync(join(dir, 'scope.json'), JSON.stringify({ files: ['gate.json'] }));
    const result = cli(dir, ['author-gate', '--operation-id', 'review-task', '--context-file', 'context.json', '--scope-file', 'scope.json', '--reason', 'Another pass']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('delta review completed; stop');
    expect(read(join(dir, '.xm/review/budget.json')).operations['operation:review-task'].gate_authoring).toBeUndefined();
  });

  test('runs real baseline and mutation checks in frozen copies before native dispatch', () => {
    const dir = workspace();
    const original = readFileSync(join(dir, 'src/a.js'), 'utf8');
    const result = prepare(dir);
    expect(result.status).toBe(0);
    const manifest = read(join(runDir(dir), 'run.json'));
    const receipt = read(join(runDir(dir), 'verification-receipt.json'));
    expect(receipt).toMatchObject({ status: 'passed', target_hash: manifest.target_hash, context_hash: manifest.context_hash, baseline: { tests_run: 1 }, mutants: [{ id: 'break-I1', invariant_id: 'I1', status: 'killed', test_executed: true, violation: 'I1' }] });
    expect(receipt.inputs.map(item => item.file)).toEqual(['gate.mjs', 'src/a.js']);
    expect(readFileSync(join(runDir(dir), 'prompts/correctness.md'), 'utf8')).toContain('Project verification gate evidence');
    expect(existsSync(join(runDir(dir), 'verification-work'))).toBe(false);
    expect(readFileSync(join(dir, 'src/a.js'), 'utf8')).toBe(original);
    expect(JSON.parse(result.stdout).workers).toHaveLength(1);
  });

  test('panel lifecycle keeps bound gate evidence in the completed result', () => {
    const dir = workspace();
    const result = cli(dir, ['run', 'target.patch', '--context-file', 'context.json', '--gate-file', 'gate.json', '--lenses', 'correctness', '--run-id', 'gated-run']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const saved = read(join(runDir(dir), 'result.json'));
    expect(saved.verification.receipt.status).toBe('passed');
    expect(JSON.parse(result.stdout).verification.receipt.status).toBe('passed');
    expect(saved.verdict).toBe('LGTM');
    expect(existsSync(join(dir, 'panel.log'))).toBe(true);
  });

  test('stops without reviewers or LGTM on survived, wrong, unexecuted, or malformed mutants', () => {
    for (const mode of ['survive', 'build', 'not-run', 'wrong', 'missing', 'duplicate', 'malformed', 'no-restore', 'timeout']) {
      const dir = workspace(mode);
      const result = prepare(dir);
      expect(result.status).toBe(1);
      const output = JSON.parse(result.stdout);
      expect(output.action).toMatchObject({ decision: 'stop', continuation: 'human_decision', coverage_complete: false });
      expect(output.terminal.outcome).toBe('incomplete');
      expect(read(join(runDir(dir), 'verification-receipt.json')).status).toBe('failed');
      expect(existsSync(join(dir, 'panel.log'))).toBe(false);
      expect(existsSync(join(dir, '.xm/review/last-result.json'))).toBe(false);
      expect(readFileSync(join(dir, 'src/a.js'), 'utf8')).toContain('a = 1');
      expect(existsSync(join(runDir(dir), 'verification-work'))).toBe(false);
    }
  });

  test('a failed or empty baseline never starts mutation checks', () => {
    for (const mode of ['zero', 'kill']) {
      const dir = workspace(mode);
      if (mode === 'kill') writeFileSync(join(dir, 'src/a.js'), 'export const a = 9;\nexport const b = 2;\n');
      expect(prepare(dir).status).toBe(1);
      expect(existsSync(join(runDir(dir), 'verification-logs/mutation.stdout'))).toBe(false);
      expect(existsSync(join(dir, 'panel.log'))).toBe(false);
    }
  });

  test('requires bound invariants and rejects traversal and unknown invariant ids before dispatch', () => {
    for (const variant of ['context', 'traversal', 'invariant', 'absolute-script']) {
      const dir = workspace();
      const config = read(join(dir, 'gate.json'));
      if (variant === 'traversal') config.files.push('../outside.js');
      if (variant === 'invariant') config.mutants[0].invariant_id = 'absent';
      if (variant === 'absolute-script') config.mutation.argv[1] = join(dir, 'gate.mjs');
      writeFileSync(join(dir, 'gate.json'), JSON.stringify(config));
      const args = ['prepare', 'target.patch', '--gate-file', 'gate.json', '--run-id', 'gated-run'];
      if (variant !== 'context') args.push('--context-file', 'context.json');
      expect(cli(dir, args).status).toBe(1);
      expect(existsSync(join(dir, '.xm/review/budget.json'))).toBe(false);
      expect(existsSync(join(dir, 'panel.log'))).toBe(false);
    }
  });

  test('missing gate dependencies still produce a terminal incomplete receipt', () => {
    const dir = workspace();
    const config = read(join(dir, 'gate.json')); config.files.push('missing.js');
    writeFileSync(join(dir, 'gate.json'), JSON.stringify(config));
    const result = prepare(dir);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).terminal.outcome).toBe('incomplete');
    expect(read(join(runDir(dir), 'verification-receipt.json')).error).toContain('absent from the frozen workspace');
    expect(existsSync(join(dir, 'panel.log'))).toBe(false);
    expect(read(join(dir, '.xm/review/budget.json')).active).toBe(null);
  });

  test('commit reviews execute committed gate inputs even when live files differ', () => {
    const dir = workspace();
    const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(dir, 'src/a.js'), 'export const a = 1;\nexport const b = 3;\n');
    for (const args of [['add', 'src/a.js'], ['commit', '-m', 'update b']]) expect(spawnSync('git', args, { cwd: dir, encoding: 'utf8' }).status).toBe(0);
    writeFileSync(join(dir, 'src/a.js'), 'export const a = 9;\nexport const b = 3;\n');
    const result = cli(dir, ['prepare', '--base-ref', base, '--context-file', 'context.json', '--gate-file', 'gate.json', '--lenses', 'correctness', '--run-id', 'gated-run']);
    expect(result.status).toBe(0);
    expect(read(join(runDir(dir), 'verification-receipt.json')).baseline.status).toBe('passed');
    expect(readFileSync(join(dir, 'src/a.js'), 'utf8')).toContain('a = 9');
  });

  test('receipt tampering blocks finalization rather than silently rerunning the gate', () => {
    const dir = workspace(); expect(prepare(dir).status).toBe(0);
    const receiptPath = join(runDir(dir), 'verification-receipt.json');
    const receipt = read(receiptPath); receipt.baseline.tests_run = 999;
    writeFileSync(receiptPath, JSON.stringify(receipt));
    const result = cli(dir, ['finalize', 'gated-run']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('receipt bytes changed');
    expect(existsSync(join(dir, '.xm/review/last-result.json'))).toBe(false);
  });

  test('completed runs reject gate artifact tampering on finalize, resume and another prepare', () => {
    for (const artifact of ['verification-receipt.json', 'verification-gate.json']) {
      const dir = workspace();
      expect(cli(dir, ['run', 'target.patch', '--context-file', 'context.json', '--gate-file', 'gate.json', '--lenses', 'correctness', '--run-id', 'gated-run']).status).toBe(0);
      const path = join(runDir(dir), artifact);
      writeFileSync(path, `${readFileSync(path, 'utf8')}\n`);
      for (const args of [['finalize', 'gated-run'], ['resume', 'gated-run'], ['status', 'gated-run'], ['close', 'gated-run', '--reason', 'fixture cancellation'], ['prepare', '--run-id', 'gated-delta']]) {
        const result = cli(dir, args);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(artifact === 'verification-receipt.json' ? 'receipt bytes changed' : 'configuration bytes changed');
      }
    }
  });

  test('a delta inherits its gate and executes it again for the new snapshot', () => {
    const dir = workspace();
    const first = cli(dir, ['run', 'target.patch', '--context-file', 'context.json', '--gate-file', 'gate.json', '--lenses', 'correctness', '--run-id', 'gated-run']);
    expect(first.stderr).toBe('');
    expect(first.status).toBe(0);
    writeFileSync(join(dir, 'src/a.js'), 'export const a = 1;\nexport const b = 3;\n');
    const result = cli(dir, ['prepare', '--lenses', 'correctness', '--run-id', 'gated-delta']);
    expect(result.status).toBe(0);
    const manifest = read(join(dir, '.xm/review/runs/gated-delta/run.json'));
    const receipt = read(join(dir, '.xm/review/runs/gated-delta/verification-receipt.json'));
    expect(manifest.review_mode).toBe('delta');
    expect(manifest.verification.config_hash).toBe(read(join(runDir(dir), 'run.json')).verification.config_hash);
    expect(receipt.target_hash).toBe(manifest.target_hash);
    expect(receipt.inputs.find(item => item.file === 'src/a.js').sha256).not.toBe(read(join(runDir(dir), 'verification-receipt.json')).inputs.find(item => item.file === 'src/a.js').sha256);
  });
});

test('a trusted complete mutate report binds its input bytes to the frozen gate', () => {
  const dir = workspace();
  const hash = bytes => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  const inputs = ['src/a.js', 'gate.mjs'].map(file => ({ file, sha256: hash(readFileSync(join(dir, file))) }));
  const report = { schema_v: 3, run_id: 'measurement-one', measurement: { status: 'complete' }, evidence: { stable: true, inputs, input_sha256: hash(JSON.stringify(inputs)) }, mutants: [{ status: 'survived' }] };
  const bytes = JSON.stringify(report); writeFileSync(join(dir, 'measurement.json'), bytes);
  const config = read(join(dir, 'gate.json')); config.files.push('measurement.json');
  config.measurement = { file: 'measurement.json', sha256: hash(bytes) };
  writeFileSync(join(dir, 'gate.json'), JSON.stringify(config));
  const result = prepare(dir);
  expect(result.status).toBe(0);
  expect(read(join(runDir(dir), 'verification-receipt.json')).measurement).toMatchObject({ status: 'complete', survivors: 1 });
});

test('gate measurement rejects tampering, stale inputs, and incomplete measurements before baseline', () => {
  for (const variant of ['tamper', 'stale', 'incomplete', 'omitted-input']) {
    const dir = workspace(), hash = bytes => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    const inputs = ['src/a.js', 'gate.mjs'].map(file => ({ file, sha256: hash(readFileSync(join(dir, file))) }));
    if (variant === 'omitted-input') inputs.push({ file: 'unbound.test.js', sha256: hash('missing') });
    const report = { schema_v: 3, run_id: 'proof', measurement: { status: variant === 'incomplete' ? 'incomplete' : 'complete' }, evidence: { stable: true, inputs, input_sha256: hash(JSON.stringify(inputs)) }, mutants: [{ status: 'killed' }] };
    const bytes = JSON.stringify(report); writeFileSync(join(dir, 'measurement.json'), bytes);
    const config = read(join(dir, 'gate.json')); config.files.push('measurement.json'); config.measurement = { file: 'measurement.json', sha256: hash(bytes) };
    writeFileSync(join(dir, 'gate.json'), JSON.stringify(config));
    if (variant === 'tamper') writeFileSync(join(dir, 'measurement.json'), bytes + '\n');
    if (variant === 'stale') writeFileSync(join(dir, 'src/a.js'), 'export const a = 2;');
    expect(prepare(dir).status).toBe(1);
    const receipt = read(join(runDir(dir), 'verification-receipt.json'));
    expect(receipt.baseline).toBe(null); expect(receipt.error).toContain('measurement');
    expect(existsSync(join(dir, 'panel.log'))).toBe(false);
  }
});
