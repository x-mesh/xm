import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { tokenize, parseSpec, containedPath, runCmd, runFile, runGrep, runJson, runAssertions } from '../x-eval/lib/x-eval/assert.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'x-eval', 'lib', 'x-eval-cli.mjs');

function makeProject() {
  const tmp = mkdtempSync(join(tmpdir(), 'xe-assert-'));
  mkdirSync(join(tmp, '.xm'), { recursive: true });
  mkdirSync(join(tmp, 'src'), { recursive: true });
  writeFileSync(join(tmp, 'src', 'a.mjs'), 'export const a = 1;\n// no dynamic code here\n');
  writeFileSync(join(tmp, 'meta.json'), JSON.stringify({ name: 'demo', nested: { count: 2, ok: true } }));
  return tmp;
}

function cli(args, cwd, env = {}) {
  const r = spawnSync('node', [CLI, ...args], {
    cwd,
    env: { ...process.env, XM_ROOT: join(cwd, '.xm'), ...env },
    encoding: 'utf8',
    timeout: 20000,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status ?? 1 };
}

describe('x-eval assert: tokenizer', () => {
  test('splits on whitespace and honours quotes and escapes', () => {
    expect(tokenize('node -e "process.exit(0)"')).toEqual(['node', '-e', 'process.exit(0)']);
    expect(tokenize("bun test 'a b.test.mjs'")).toEqual(['bun', 'test', 'a b.test.mjs']);
    expect(tokenize('echo a\\ b "c \\"d\\""')).toEqual(['echo', 'a b', 'c "d"']);
    expect(tokenize('  spaced   out  ')).toEqual(['spaced', 'out']);
  });

  test('rejects unquoted shell operators, but allows them inside quotes', () => {
    for (const bad of ['echo a | cat', 'a; b', 'a && b', 'cat < f', 'echo > f', 'echo $(id)', 'echo $HOME', 'echo `id`']) {
      expect(() => tokenize(bad)).toThrow(/shell operator/);
    }
    expect(tokenize('node -e "a | b; $x"')).toEqual(['node', '-e', 'a | b; $x']);
    // parentheses are plain argv characters without a shell
    expect(tokenize('node -e process.exit(0)')).toEqual(['node', '-e', 'process.exit(0)']);
  });

  test('rejects empty, unterminated, and dangling input', () => {
    expect(() => tokenize('')).toThrow(/empty/);
    expect(() => tokenize('echo "open')).toThrow(/unterminated/);
    expect(() => tokenize('echo \\')).toThrow(/dangling/);
  });

  test('parseSpec requires name=spec with a safe name', () => {
    expect(parseSpec('tests=bun test', 'cmd')).toEqual({ name: 'tests', spec: 'bun test' });
    expect(() => parseSpec('bun test', 'cmd')).toThrow(/name=/);
    expect(() => parseSpec('bad name=x', 'cmd')).toThrow(/must match/);
    expect(() => parseSpec('x=', 'cmd')).toThrow(/empty spec/);
  });
});

describe('x-eval assert: runners', () => {
  test('cmd: exit 0 → PASS, non-zero → HARD_FAIL, stdout never stored', () => {
    const tmp = makeProject();
    try {
      const pass = runCmd({ name: 'ok', command: 'node -e "console.log(\'secret-output\'); process.exit(0)"', cwd: tmp });
      expect(pass.result).toBe('PASS');
      expect(pass.exit_code).toBe(0);
      expect(pass.command_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(pass)).not.toContain('secret-output');
      const fail = runCmd({ name: 'no', command: 'node -e "process.exit(4)"', cwd: tmp });
      expect(fail).toMatchObject({ result: 'HARD_FAIL', exit_code: 4 });
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test('cmd: timeout and missing binary are HARD_FAIL with error codes', () => {
    const tmp = makeProject();
    try {
      const slow = runCmd({ name: 'slow', command: 'node -e "setTimeout(()=>{},10000)"', cwd: tmp, timeoutMs: 200 });
      expect(slow.result).toBe('HARD_FAIL');
      expect(slow.error_code).toBe('ETIMEDOUT');
      const missing = runCmd({ name: 'missing', command: 'definitely-not-a-binary-xyz --flag', cwd: tmp });
      expect(missing).toMatchObject({ result: 'HARD_FAIL', error_code: 'ENOENT' });
      const shell = runCmd({ name: 'pipe', command: 'echo a | cat', cwd: tmp });
      expect(shell).toMatchObject({ result: 'HARD_FAIL', error_code: 'EINVAL' });
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test('cmd: only allowlisted env reaches the child unless --env passes it', () => {
    const tmp = makeProject();
    try {
      process.env.XE_SECRET_PROBE = 'leak';
      const hidden = runCmd({ name: 'env', command: 'node -e "process.exit(process.env.XE_SECRET_PROBE ? 1 : 0)"', cwd: tmp });
      expect(hidden.result).toBe('PASS');
      const passed = runCmd({ name: 'env', command: 'node -e "process.exit(process.env.XE_SECRET_PROBE ? 0 : 1)"', cwd: tmp, envKeys: ['XE_SECRET_PROBE'] });
      expect(passed.result).toBe('PASS');
    } finally {
      delete process.env.XE_SECRET_PROBE;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('file / grep / json runners', () => {
    const tmp = makeProject();
    try {
      expect(runFile({ name: 'f', spec: 'exists=src/a.mjs', cwd: tmp }).result).toBe('PASS');
      expect(runFile({ name: 'f', spec: 'absent=src/a.mjs', cwd: tmp }).result).toBe('HARD_FAIL');
      expect(runFile({ name: 'f', spec: 'absent=src/zzz.mjs', cwd: tmp }).result).toBe('PASS');
      expect(runFile({ name: 'f', spec: 'weird=src/a.mjs', cwd: tmp })).toMatchObject({ result: 'HARD_FAIL', error_code: 'EINVAL' });

      expect(runGrep({ name: 'g', spec: 'export const a:src/a.mjs', cwd: tmp })).toMatchObject({ result: 'PASS', matched: true });
      expect(runGrep({ name: 'g', spec: '!eval\\(:src/a.mjs', cwd: tmp })).toMatchObject({ result: 'PASS', negated: true });
      expect(runGrep({ name: 'g', spec: '!const:src/a.mjs', cwd: tmp }).result).toBe('HARD_FAIL');
      expect(runGrep({ name: 'g', spec: 'x:src/missing.mjs', cwd: tmp })).toMatchObject({ result: 'HARD_FAIL', error_code: 'ENOENT' });
      expect(runGrep({ name: 'g', spec: '[:src/a.mjs', cwd: tmp })).toMatchObject({ result: 'HARD_FAIL', error_code: 'EINVAL' });

      expect(runJson({ name: 'j', spec: 'name=demo:meta.json', cwd: tmp }).result).toBe('PASS');
      expect(runJson({ name: 'j', spec: 'nested.count=2:meta.json', cwd: tmp }).result).toBe('PASS');
      expect(runJson({ name: 'j', spec: 'nested.ok=false:meta.json', cwd: tmp })).toMatchObject({ result: 'HARD_FAIL', actual: 'true' });
      expect(runJson({ name: 'j', spec: 'nested.nope=1:meta.json', cwd: tmp })).toMatchObject({ result: 'HARD_FAIL', actual: null });
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test('paths cannot escape cwd', () => {
    const tmp = makeProject();
    try {
      expect(() => containedPath(tmp, '../outside.txt')).toThrow(/escapes/);
      expect(containedPath(tmp, 'src/a.mjs')).toBe(join(tmp, 'src', 'a.mjs'));
      expect(runFile({ name: 'f', spec: 'exists=../../etc/passwd', cwd: tmp })).toMatchObject({ result: 'HARD_FAIL', error_code: 'EINVAL' });
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test('runAssertions aggregates and reports source=executable', () => {
    const tmp = makeProject();
    try {
      const report = runAssertions([
        { kind: 'cmd', name: 'ok', command: 'node -e "process.exit(0)"' },
        { kind: 'file', name: 'f', spec: 'exists=src/a.mjs' },
        { kind: 'bogus', name: 'b', spec: 'x' },
      ], { cwd: tmp });
      expect(report.passed).toBe(false);
      expect(report.hard_fail).toBe(1);
      expect(report.source).toBe('executable');
      expect(report.results.map(r => r.result)).toEqual(['PASS', 'PASS', 'HARD_FAIL']);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe('x-eval assert: CLI', () => {
  test('exit 0 on all PASS with --json report', () => {
    const tmp = makeProject();
    try {
      const r = cli(['assert', '--cmd', 'ok=node -e process.exit(0)', '--file', 'src=exists=src/a.mjs', '--grep', 'clean=!eval\\(:src/a.mjs', '--json-eq', 'n=name=demo:meta.json', '--json'], tmp);
      expect(r.exitCode).toBe(0);
      const body = JSON.parse(r.stdout);
      expect(body.passed).toBe(true);
      expect(body.results.length).toBe(4);
      expect(body.cwd).toBe(tmp);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test('exit 1 on a HARD_FAIL, table output names the failure', () => {
    const tmp = makeProject();
    try {
      const r = cli(['assert', '--cmd', 'tests=node -e process.exit(2)'], tmp);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain('HARD_FAIL');
      expect(r.stdout).toContain('tests');
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test('exit 2 on usage errors: no assertions, bad spec, cwd outside project, bad timeout', () => {
    const tmp = makeProject();
    try {
      expect(cli(['assert'], tmp).exitCode).toBe(2);
      expect(cli(['assert', '--cmd', 'no-name-here'], tmp).exitCode).toBe(2);
      expect(cli(['assert', '--cmd', 'ok=true', '--cwd', '../..'], tmp).exitCode).toBe(2);
      expect(cli(['assert', '--cmd', 'ok=true', '--timeout-ms', '0'], tmp).exitCode).toBe(2);
      expect(cli(['nope'], tmp).exitCode).toBe(2);
      expect(cli([], tmp).exitCode).toBe(2);
      expect(cli(['help'], tmp).exitCode).toBe(0);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test('--cwd runs assertions inside a subdirectory of the project', () => {
    const tmp = makeProject();
    try {
      const r = cli(['assert', '--file', 'here=exists=a.mjs', '--cwd', 'src', '--json'], tmp);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout).cwd).toBe(join(tmp, 'src'));
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});
