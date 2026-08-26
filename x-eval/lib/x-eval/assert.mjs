/**
 * x-eval/assert — deterministic (code-based) assertions.
 *
 * `--assert "<statement>"` asks another LLM whether a statement holds. That is
 * the right tool for qualitative claims and the wrong tool for anything a
 * command can settle: "the tests pass", "the file exists", "eval( is not used".
 * These runners answer those with an exit code, a stat, or a regex — and they
 * never store command output, only its result.
 *
 * Execution is shell-free on purpose. A `cmd` assertion is tokenized here and
 * handed to spawnSync(argv[0], argv.slice(1), { shell: false }); unquoted shell
 * operators are rejected instead of being passed through, so a judge prompt or
 * a case file cannot smuggle `; rm -rf` into a gate. Need a pipeline? Wrap it in
 * a script and assert the script.
 *
 * Zero-dependency: node builtins only (see root.mjs for why).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

export const ASSERTION_KINDS = ['cmd', 'file', 'grep', 'json'];
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_GREP_TIMEOUT_MS = 2_000;
export const MAX_GREP_FILE_BYTES = 1024 * 1024;
export const MAX_GREP_PATTERN_CHARS = 4_096;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Characters that only mean something to a shell. Parentheses are deliberately
// allowed: `node -e process.exit(0)` is literal argv without a shell.
const SHELL_META = new Set([';', '|', '&', '<', '>', '`', '$', '\n']);
const ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TERM', 'SHELL', 'USER', 'LOGNAME', 'XM_ROOT', 'NODE_ENV', 'CI', 'BUN_INSTALL'];

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');

/**
 * Quote-aware tokenizer with no expansion. Supports 'single', "double" and
 * backslash escapes; throws on unquoted shell metacharacters.
 */
export function tokenize(command) {
  const text = String(command ?? '');
  const argv = [];
  let current = '';
  let inToken = false;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (quote === '"' && ch === '\\' && i + 1 < text.length && ['"', '\\'].includes(text[i + 1])) { current += text[++i]; continue; }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; inToken = true; continue; }
    if (ch === '\\') {
      if (i + 1 >= text.length) throw new Error('dangling backslash at end of command');
      current += text[++i];
      inToken = true;
      continue;
    }
    if (SHELL_META.has(ch)) {
      throw new Error(`unquoted shell operator "${ch === '\n' ? '\\n' : ch}" is not supported — assertions run without a shell; wrap the command in a script`);
    }
    if (ch === ' ' || ch === '\t') {
      if (inToken) { argv.push(current); current = ''; inToken = false; }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (quote) throw new Error(`unterminated ${quote === '"' ? 'double' : 'single'} quote`);
  if (inToken) argv.push(current);
  if (!argv.length) throw new Error('empty command');
  return argv;
}

/** `name=spec` → { name, spec }. Names are short identifiers so result rows stay greppable. */
export function parseSpec(raw, kind) {
  const text = String(raw ?? '');
  const eq = text.indexOf('=');
  if (eq <= 0) throw new Error(`${kind} assertion must look like name=<spec> (got "${text}")`);
  const name = text.slice(0, eq).trim();
  const spec = text.slice(eq + 1).trim();
  if (!NAME_RE.test(name)) throw new Error(`${kind} assertion name "${name}" must match ${NAME_RE}`);
  if (!spec) throw new Error(`${kind} assertion "${name}" has an empty spec`);
  return { name, spec };
}

/** Resolve `target` under `cwd`, refusing anything that escapes it. */
export function containedPath(cwd, target) {
  const base = resolve(cwd);
  const full = resolve(base, String(target));
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error(`path "${target}" escapes the assertion cwd`);
  }
  let existing = full;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const actualBase = realpathSync(base);
  const actual = realpathSync(existing);
  if (actual !== actualBase && !actual.startsWith(actualBase + sep)) {
    throw new Error(`path "${target}" escapes the assertion cwd through a symlink`);
  }
  return full;
}

function baseEnv(extraKeys = []) {
  const env = {};
  for (const key of [...ENV_ALLOWLIST, ...extraKeys]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function finish(row, result, extra = {}) {
  return { ...row, result, ...extra };
}

/** Run one `cmd` assertion. The row records the outcome, never the output. */
export function runCmd({ name, command, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, envKeys = [] }) {
  const row = { name, kind: 'cmd', command_sha256: sha256(command), exit_code: null, signal: null, error_code: null, duration_ms: 0 };
  let argv;
  try { argv = tokenize(command); } catch (error) { return finish(row, 'HARD_FAIL', { error_code: 'EINVAL', error: error.message }); }
  const started = Date.now();
  const proc = spawnSync(argv[0], argv.slice(1), {
    cwd, shell: false, timeout: timeoutMs, env: baseEnv(envKeys),
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
  });
  row.duration_ms = Date.now() - started;
  row.exit_code = proc.status;
  row.signal = proc.signal || null;
  if (proc.error) {
    row.error_code = proc.error.code || 'ESPAWN';
    const message = proc.error.code === 'ENOENT' ? `command not found: ${argv[0]}`
      : proc.error.code === 'ETIMEDOUT' ? `timed out after ${timeoutMs}ms`
        : proc.error.message;
    return finish(row, 'HARD_FAIL', { error: message });
  }
  if (proc.signal) return finish(row, 'HARD_FAIL', { error: `terminated by ${proc.signal}` });
  return finish(row, proc.status === 0 ? 'PASS' : 'HARD_FAIL');
}

/** `exists=<path>` / `absent=<path>` */
export function runFile({ name, spec, cwd }) {
  const row = { name, kind: 'file', spec };
  const match = /^(exists|absent)=(.+)$/.exec(spec);
  if (!match) return finish(row, 'HARD_FAIL', { error_code: 'EINVAL', error: 'file assertion spec must be exists=<path> or absent=<path>' });
  let full;
  try { full = containedPath(cwd, match[2]); } catch (error) { return finish(row, 'HARD_FAIL', { error_code: 'EINVAL', error: error.message }); }
  const present = existsSync(full);
  const ok = match[1] === 'exists' ? present : !present;
  return finish(row, ok ? 'PASS' : 'HARD_FAIL', { exists: present });
}

/** `[!]<regex>:<path>` — `!` means the pattern must NOT match. */
export function runGrep({ name, spec, cwd, timeoutMs = DEFAULT_GREP_TIMEOUT_MS }) {
  const row = { name, kind: 'grep', spec };
  const negate = spec.startsWith('!');
  const body = negate ? spec.slice(1) : spec;
  const colon = body.lastIndexOf(':');
  if (colon <= 0 || colon === body.length - 1) return finish(row, 'HARD_FAIL', { error_code: 'EINVAL', error: 'grep assertion spec must be [!]<regex>:<path>' });
  const pattern = body.slice(0, colon);
  if (pattern.length > MAX_GREP_PATTERN_CHARS) return finish(row, 'HARD_FAIL', { error_code: 'E2BIG', error: `grep regex exceeds ${MAX_GREP_PATTERN_CHARS} characters` });
  try { new RegExp(pattern, 'm'); } catch (error) { return finish(row, 'HARD_FAIL', { error_code: 'EINVAL', error: `invalid regex: ${error.message}` }); }
  let full;
  try { full = containedPath(cwd, body.slice(colon + 1)); } catch (error) { return finish(row, 'HARD_FAIL', { error_code: 'EINVAL', error: error.message }); }
  if (!existsSync(full) || !statSync(full).isFile()) return finish(row, 'HARD_FAIL', { error_code: 'ENOENT', error: `file not found: ${body.slice(colon + 1)}` });
  const size = statSync(full).size;
  if (size > MAX_GREP_FILE_BYTES) return finish(row, 'HARD_FAIL', { error_code: 'E2BIG', error: `grep file exceeds ${MAX_GREP_FILE_BYTES} bytes` });
  const probe = [
    "const { readFileSync } = require('node:fs');",
    "try { process.exit(new RegExp(process.argv[1], 'm').test(readFileSync(process.argv[2], 'utf8')) ? 0 : 1); }",
    "catch { process.exit(2); }",
  ].join('');
  const proc = spawnSync(process.execPath, ['-e', probe, '--', pattern, full], {
    cwd, shell: false, timeout: Math.min(timeoutMs, DEFAULT_GREP_TIMEOUT_MS),
    env: baseEnv(), stdio: ['ignore', 'ignore', 'ignore'],
  });
  if (proc.error?.code === 'ETIMEDOUT') return finish(row, 'HARD_FAIL', { error_code: 'ETIMEDOUT', error: `grep regex timed out after ${Math.min(timeoutMs, DEFAULT_GREP_TIMEOUT_MS)}ms` });
  if (proc.error) return finish(row, 'HARD_FAIL', { error_code: proc.error.code || 'ESPAWN', error: proc.error.message });
  if (proc.status === 2 || proc.signal) return finish(row, 'HARD_FAIL', { error_code: 'EREGEX', error: proc.signal ? `grep matcher terminated by ${proc.signal}` : 'grep matcher failed' });
  const matched = proc.status === 0;
  return finish(row, (negate ? !matched : matched) ? 'PASS' : 'HARD_FAIL', { matched, negated: negate });
}

/** `<dotted.path>=<expected>:<file.json>` — string equality against the JSON value. */
export function runJson({ name, spec, cwd }) {
  const row = { name, kind: 'json', spec };
  const match = /^([^=]+)=(.*):([^:]+)$/.exec(spec);
  if (!match) return finish(row, 'HARD_FAIL', { error_code: 'EINVAL', error: 'json assertion spec must be <dotted.path>=<expected>:<file>' });
  let full;
  try { full = containedPath(cwd, match[3]); } catch (error) { return finish(row, 'HARD_FAIL', { error_code: 'EINVAL', error: error.message }); }
  if (!existsSync(full) || !statSync(full).isFile()) return finish(row, 'HARD_FAIL', { error_code: 'ENOENT', error: `file not found: ${match[3]}` });
  const size = statSync(full).size;
  if (size > MAX_GREP_FILE_BYTES) return finish(row, 'HARD_FAIL', { error_code: 'E2BIG', error: `JSON file exceeds ${MAX_GREP_FILE_BYTES} bytes` });
  let doc;
  try { doc = JSON.parse(readFileSync(full, 'utf8')); } catch (error) { return finish(row, 'HARD_FAIL', { error_code: 'EPARSE', error: `cannot read JSON: ${error.message}` }); }
  let value = doc;
  for (const key of match[1].split('.').filter(Boolean)) {
    if (value === null || typeof value !== 'object' || !(key in value)) { value = undefined; break; }
    value = value[key];
  }
  const actual = value === undefined ? undefined : (typeof value === 'string' ? value : JSON.stringify(value));
  return finish(row, actual === match[2] ? 'PASS' : 'HARD_FAIL', { actual: actual ?? null });
}

/**
 * Run a list of assertions. Each item: { kind, name, spec|command }.
 * Returns { results, passed, hard_fail } — `passed` is false on any HARD_FAIL.
 */
export function runAssertions(items, { cwd = process.cwd(), timeoutMs = DEFAULT_TIMEOUT_MS, envKeys = [] } = {}) {
  const results = [];
  for (const item of items) {
    switch (item.kind) {
      case 'cmd': results.push(runCmd({ name: item.name, command: item.command ?? item.spec, cwd, timeoutMs, envKeys })); break;
      case 'file': results.push(runFile({ name: item.name, spec: item.spec, cwd })); break;
      case 'grep': results.push(runGrep({ name: item.name, spec: item.spec, cwd, timeoutMs })); break;
      case 'json': results.push(runJson({ name: item.name, spec: item.spec, cwd })); break;
      default: results.push({ name: item.name || '?', kind: String(item.kind), result: 'HARD_FAIL', error_code: 'EINVAL', error: `unknown assertion kind "${item.kind}"` });
    }
  }
  const hardFail = results.filter(r => r.result === 'HARD_FAIL').length;
  return { results, passed: hardFail === 0, hard_fail: hardFail, source: 'executable' };
}
