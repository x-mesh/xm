import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const rules = [
  { id: 'skip-empty', invariant_id: 'SYNC_EMPTY', test: 'an empty final snapshot deletes the last remote file', edits: [
    ['x-sync/lib/x-sync/sync-push.mjs', 'const files = scanXmFiles(xmDir, state);', 'const files = scanXmFiles(xmDir, state); if (!files.length) return;'],
  ] },
  { id: 'echo-imports', invariant_id: 'SYNC_ORIGIN', test: 'remote updates replace tracked copies and never echo through another machine', edits: [
    ['x-sync/lib/x-sync/sync-push.mjs', 'if (imports.some(', 'if (false && imports.some('],
  ] },
  { id: 'shared-cursor', invariant_id: 'SYNC_CURSOR', test: 'cursor identity isolates projects and server URLs', edits: [
    ['x-sync/lib/x-sync/sync-storage.mjs', "const key = JSON.stringify([config.server_url.replace(/\\/+$/, ''), projectId, config.machine_id]);", "const key = JSON.stringify(['shared']);"],
  ] },
  { id: 'ignore-active-copy', invariant_id: 'SYNC_ACTIVE', test: 'a tombstone restores another active machine in the materialized view', edits: [
    ['x-sync/lib/x-sync-server.mjs', 'const active = stmtLatestActive.get(projectId, path);', 'const active = null;'],
  ] },
  { id: 'skip-identical-repair', invariant_id: 'SYNC_REPAIR', test: 'materialization failure is nonzero and an identical retry repairs the missing file', edits: [
    ['x-sync/lib/x-sync-server.mjs', 'skipped++;\n      continue;', 'skipped++;\n      touchedPaths.delete(path);\n      continue;'],
    ['x-sync/lib/x-sync-server.mjs', 'for (const { path } of stmtListOwnedPaths.all(project_id, machine_id))', 'if (accepted > 0 || deleted > 0) for (const { path } of stmtListOwnedPaths.all(project_id, machine_id))'],
  ] },
  { id: 'include-worktrees', invariant_id: 'SYNC_SCOPE', test: 'push excludes worktrees, nested repositories and temporary gate source copies', edits: [
    ['x-sync/lib/x-sync/sync-storage.mjs', "if (['merge-review', 'worktrees'].includes(parts[0]))", "if (false && ['merge-review', 'worktrees'].includes(parts[0]))"],
  ] },
  { id: 'follow-symlinks', invariant_id: 'SYNC_SYMLINK', test: 'pull rejects symlink escapes without advancing its cursor', edits: [
    ['x-sync/lib/x-sync/sync-storage.mjs', 'if (lstatSync(cursor).isSymbolicLink())', 'if (false && lstatSync(cursor).isSymbolicLink())'],
  ] },
];

function execute(argv, cwd) {
  return new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), { cwd, detached: true, env: { PATH: process.env.PATH, LANG: 'C', HOME: join(cwd, '.home'), TMPDIR: join(cwd, '.tmp') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', failure = null;
    const kill = reason => { failure ||= reason; try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(() => kill('timeout'), 30000);
    const collect = data => { if (output.length + data.length > 1024 * 1024) kill('output limit'); else output += data; };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('error', error => { failure = error.message; });
    child.on('close', status => { clearTimeout(timer); resolve({ status, output, failure }); });
  });
}

const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function run(rulesToRun, mutation = null) {
  const config = JSON.parse(readFileSync('x-sync/review-gate.json', 'utf8'));
  const work = mkdtempSync(join(tmpdir(), 'sync-rule-gate-'));
  try {
    mkdirSync(join(work, '.home')); mkdirSync(join(work, '.tmp'));
    for (const file of config.files) { mkdirSync(dirname(join(work, file)), { recursive: true }); cpSync(file, join(work, file)); }
    for (const [file, before, after] of mutation?.edits || []) {
      const path = join(work, file), source = readFileSync(path, 'utf8');
      if (source.split(before).length !== 2) throw new Error(`mutation anchor is not unique: ${mutation.id}: ${file}`);
      writeFileSync(path, source.replace(before, after));
      const check = await execute(['node', '--check', file], work);
      if (check.status !== 0 || check.failure) throw new Error(`unviable mutation: ${mutation.id}`);
    }
    const pattern = rulesToRun.map(rule => `^${escapePattern(rule.test)}$`).join('|');
    return await execute(['bun', 'test', 'test/sync-lifecycle-integration.test.mjs', '--test-name-pattern', pattern], work);
  } finally { rmSync(work, { recursive: true, force: true }); }
}

try {
  const phase = process.argv[2];
  if (phase === 'baseline') {
    const result = await run(rules);
    if (result.failure || result.status !== 0 || !/\n\s*7 pass\n(?:\s*\d+ filtered out\n)?\s*0 fail\n/.test(result.output)) throw new Error(`baseline failed or omitted tests: ${result.failure || result.output}`);
    console.log(JSON.stringify({ schema_version: 1, status: 'passed', tests_run: rules.length }));
  } else if (phase === 'mutation') {
    const mutants = [];
    for (const rule of rules) {
      const result = await run([rule], rule);
      const marker = `error: INVARIANT:${rule.invariant_id}`;
      const killed = !result.failure && result.status === 1 && result.output.split('\n').some(line => line.trim() === marker)
        && /\n\s*1 fail\n/.test(result.output) && result.output.includes(`(fail) ${rule.test}`);
      if (!killed) process.stderr.write(`${rule.id}: ${result.failure || result.output}\n`);
      mutants.push({ id: rule.id, status: killed ? 'killed' : 'error', test_executed: killed, violation: rule.invariant_id });
      if (!killed) throw new Error(`mutation did not fail for its expected invariant: ${rule.id}`);
    }
    console.log(JSON.stringify({ schema_version: 1, mutants }));
  } else throw new Error('expected baseline or mutation');
} catch (error) { console.error(error.message); process.exitCode = 1; }
