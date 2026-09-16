// Mutation testing on changed lines.
//
// The change set is always a git diff: `xm mutate --diff <base>` mutates the
// lines changed since the merge base, and `xm build mutate --task <id>` runs the
// same path inside a task's linked worktree and attributes survivors to the
// task. Mutants are generated and run by external tools (see mutate-adapters.mjs).
import { closeSync, constants as FS, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, posix, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendAttentionRows } from './attention-collect.mjs';
import { buildEscapeRow } from './escape-ledger.mjs';
import { resolveMainRepoRoot, validateIdSegment } from './worktree-shared.mjs';
import { getExplicitProject } from './core.mjs';
import { ADAPTERS, MUTANT_STATUSES } from './mutate-adapters.mjs';

// Whole-run ceiling. Each tool sizes its per-mutant timeout from the baseline;
// this only stops a run that has stalled from holding the shell indefinitely.
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
// Enough tool output to explain a failure without storing whole test logs.
const OUTPUT_TAIL_CHARS = 4000;

const USAGE = [
  'Usage: xm mutate --diff <base> [--lang <names>] [--timeout-ms N] [--json]',
  '       xm build mutate [--list] [--json]',
  '       xm build mutate --project <name> --task <id> [--base <ref>] [--lang <names>] [--timeout-ms N] [--json]',
].join('\n');

function fail(message) {
  const error = new Error(message);
  error.exitCode = 2;
  throw error;
}

function emptyCounts() {
  return Object.fromEntries(MUTANT_STATUSES.map(status => [status, 0]));
}

function gitOutput(cwd, args, action) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail(`mutate could not ${action}: ${(result.stderr || result.error?.message || '').trim()}`);
  return result.stdout;
}

function patchPath(value) {
  let path = String(value || '').trim();
  if (path.startsWith('"')) {
    try { path = JSON.parse(path); } catch { return null; }
  }
  path = path.split('\t')[0].replace(/\\/g, '/');
  return path === '/dev/null' ? null : path.replace(/^[ab]\//, '').replace(/^\.\//, '');
}

export function parseDiffChanges(diff) {
  const changes = new Map();
  let file = null, newLine = null, inHeader = false;
  for (const row of String(diff || '').split('\n')) {
    if (row.startsWith('diff --git ')) { file = null; newLine = null; inHeader = true; continue; }
    // Only a header `+++` names the file; an added line can also start with `++`.
    if (inHeader && row.startsWith('+++ ')) { file = patchPath(row.slice(4)); continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) { newLine = Number(hunk[1]); inHeader = false; continue; }
    if (inHeader || file == null || newLine == null || row.startsWith('\\')) continue;
    if (row.startsWith('+')) {
      if (!changes.has(file)) changes.set(file, []);
      changes.get(file).push(newLine);
      newLine += 1;
    } else if (!row.startsWith('-')) {
      newLine += 1;
    }
  }
  return changes;
}

function resolveChangeSet(cwd, base) {
  if (typeof base !== 'string' || !base.trim() || base.startsWith('-')) fail('mutate requires a base that names a git ref');
  const top = realpathSync(gitOutput(cwd, ['rev-parse', '--show-toplevel'], 'find the repository root').trim());
  const mergeBase = gitOutput(top, ['merge-base', base, 'HEAD'], `find the merge base of ${base} and HEAD`).trim();
  const head = gitOutput(top, ['rev-parse', 'HEAD'], 'resolve HEAD').trim();
  // Diff against the working tree so uncommitted edits are mutated too. The
  // tools read files on disk, and cargo-mutants rejects a diff that disagrees with them.
  // The prefixes are pinned because patchPath strips only `a/` and `b/`; with
  // diff.mnemonicPrefix set, git writes `w/` and every path would miss its root.
  const diff = gitOutput(top, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '--unified=0', '--diff-filter=d', mergeBase], 'read the diff');
  return { top, mergeBase, head, changed: parseDiffChanges(diff) };
}

function manifestRoot(top, file, manifests) {
  let dir = posix.dirname(file);
  for (;;) {
    if (manifests.some(name => existsSync(join(top, dir, name)))) return dir;
    if (dir === '.') return null;
    dir = posix.dirname(dir);
  }
}

function groupChanges({ top, changed }, adapters, languages) {
  const groups = new Map(), widened = new Map();
  for (const [file, lines] of [...changed].sort(([a], [b]) => a.localeCompare(b))) {
    const adapter = adapters.find(candidate => candidate.claims(file));
    if (!adapter || (languages && !languages.has(adapter.language))) continue;
    // An adapter may widen the manifest root: cargo-mutants must run from the
    // workspace root, not from the member crate that owns the changed file.
    // Widening can spawn a process, so each crate directory is resolved once.
    const nearest = manifestRoot(top, file, adapter.manifests);
    const cacheKey = `${adapter.language}\0${nearest}`;
    if (nearest != null && adapter.root && !widened.has(cacheKey)) widened.set(cacheKey, adapter.root(top, nearest));
    const root = nearest != null && adapter.root ? widened.get(cacheKey) : nearest;
    const key = `${adapter.language}\0${root ?? '\0unrooted'}`;
    if (!groups.has(key)) groups.set(key, { adapter, root, files: [], changed: new Map() });
    const group = groups.get(key);
    group.files.push(file);
    group.changed.set(root == null || root === '.' ? file : posix.relative(root, file), lines);
  }
  return [...groups.values()];
}

function runTool(argv, { cwd, timeoutMs, signal }) {
  return new Promise(resolveRun => {
    let child = null, output = '', timedOut = false, aborted = false, settled = false;
    // Tools spawn build and test processes of their own; the whole group goes.
    const killGroup = () => { if (child?.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const onAbort = () => { aborted = true; killGroup(); };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, Math.max(1, timeoutMs));
    const finish = fields => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      killGroup();
      resolveRun({ exitCode: null, timedOut, aborted, output, ...fields });
    };
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ spawnError: error.message });
      return;
    }
    const keep = chunk => { output = (output + chunk).slice(-OUTPUT_TAIL_CHARS); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    if (signal?.aborted) onAbort(); else signal?.addEventListener?.('abort', onAbort, { once: true });
    child.once('error', error => finish({ spawnError: error.message }));
    child.once('close', code => finish({ exitCode: code }));
  });
}

async function runGroup(group, changeSet, { deadline, signal }) {
  const { adapter } = group;
  const result = { language: adapter.language, tool: adapter.tool, tool_version: null, root: group.root, files: group.files, status: 'ran', reason: null, exit_code: null, duration_ms: 0, counts: emptyCounts() };
  const stopped = (status, reason, extra = {}) => ({ result: { ...result, ...extra, status, reason }, mutants: [] });
  if (group.root == null) return stopped('unavailable', `no ${adapter.manifests.join(' or ')} found above ${group.files[0]}`);
  const root = join(changeSet.top, group.root);
  const detected = adapter.detect({ root, repoTop: changeSet.top });
  if (detected.unavailable) return stopped('unavailable', detected.unavailable, { install: adapter.install });
  result.tool_version = detected.version;
  if (Date.now() >= deadline) return stopped('skipped', 'the --timeout-ms budget ran out before this language started');
  const outDir = mkdtempSync(join(tmpdir(), 'xm-mutate-')), started = Date.now();
  try {
    const diff = gitOutput(root, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '--relative', '--diff-filter=d', changeSet.mergeBase, '--', ...group.changed.keys()], 'read the package diff');
    const ctx = { root, repoTop: changeSet.top, mergeBase: changeSet.mergeBase, changed: group.changed, diff, outDir };
    const plan = adapter.plan(ctx, detected);
    if (plan.unavailable) return stopped('unavailable', plan.unavailable);
    for (const [path, content] of Object.entries(plan.files || {})) writeFileSync(path, content);
    const run = await runTool(plan.argv, { cwd: root, timeoutMs: deadline - Date.now(), signal });
    const extra = { exit_code: run.exitCode, duration_ms: Date.now() - started, ...(adapter.note ? { note: adapter.note } : {}) };
    const tail = run.output ? { output_tail: run.output } : {};
    if (run.spawnError) return stopped('error', run.spawnError, { ...extra, ...tail });
    if (run.aborted) return stopped('skipped', 'interrupted', extra);
    if (run.timedOut) return stopped('timeout', 'stopped by the --timeout-ms budget', { ...extra, ...tail });
    let parsed;
    try {
      parsed = adapter.parse(ctx, run);
    } catch (error) {
      return stopped('error', error.message, { ...extra, ...tail });
    }
    if (parsed.baseline_failed) return stopped('baseline_failed', 'tests fail before any mutation; fix the suite first', { ...extra, ...tail });
    const ran = { ...result, ...extra }, mutants = [];
    for (const row of parsed.mutants) {
      // Every tool is re-scoped here: Muter mutates whole files, and no tool's
      // own diff handling may widen the report past the requested change set.
      if (!group.changed.get(row.file)?.some(line => line >= row.line && line <= row.end_line)) continue;
      mutants.push({ language: adapter.language, tool: adapter.tool, ...row, file: group.root === '.' ? row.file : posix.join(group.root, row.file) });
      ran.counts[row.status] += 1;
    }
    return { result: ran, mutants };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

export async function runDiffMutate({ cwd = process.cwd(), base, languages = null, timeoutMs = DEFAULT_TIMEOUT_MS, signal = null, adapters = ADAPTERS } = {}) {
  const changeSet = resolveChangeSet(cwd, base);
  const started = Date.now(), deadline = started + timeoutMs, results = [], mutants = [];
  for (const group of groupChanges(changeSet, adapters, languages)) {
    const outcome = await runGroup(group, changeSet, { deadline, signal });
    results.push(outcome.result);
    mutants.push(...outcome.mutants);
  }
  const counts = emptyCounts();
  for (const row of mutants) counts[row.status] += 1;
  return { schema_v: 2, mode: 'diff', base, merge_base: changeSet.mergeBase, head: changeSet.head, languages: results, mutants, counts, duration_ms: Date.now() - started, ts: new Date().toISOString() };
}

function loadTaskArtifact(root, task, projectName = null) {
  const projects = join(root, '.xm', 'build', 'projects');
  if (!existsSync(projects)) return null;
  const matches = [];
  for (const project of readdirSync(projects)) {
    if (projectName && project !== projectName) continue;
    const dir = join(projects, project, 'worktrees', task);
    for (const file of ['run.json', 'task.json', 'mutate.json']) {
      const path = join(dir, file);
      if (!existsSync(path)) continue;
      try {
        const data = JSON.parse(readFileSync(path, 'utf8'));
        const tasksPath = join(projects, project, 'phases', '02-plan', 'tasks.json');
        if (existsSync(tasksPath)) {
          try {
            const row = JSON.parse(readFileSync(tasksPath, 'utf8')).tasks?.find(candidate => candidate.id === task);
            if (row) data.task = row;
          } catch {}
        }
        matches.push({ dir, data, project, artifact_file: file });
        break;
      } catch {}
    }
  }
  if (matches.length > 1) fail('mutate task id is ambiguous; pass --project <name>');
  return matches[0] || null;
}

function repositoryRoot(path) {
  const result = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: path, encoding: 'utf8' });
  if (result.status !== 0) fail('mutate task worktree is not a git repository');
  return realpathSync(resolve(path, result.stdout.trim(), '..'));
}

function worktreeRecords(root) {
  const result = spawnSync('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) fail('mutate could not enumerate registered worktrees');
  return String(result.stdout || '').split('\0\0').filter(Boolean).map(block => {
    const record = { path: null, branch: null, detached: false, bare: false, prunable: false };
    for (const token of block.split('\0').filter(Boolean)) {
      const space = token.indexOf(' '), key = space < 0 ? token : token.slice(0, space), value = space < 0 ? '' : token.slice(space + 1);
      if (key === 'worktree') record.path = value;
      else if (key === 'branch') record.branch = value;
      else if (key === 'detached') record.detached = true;
      else if (key === 'bare') record.bare = true;
      else if (key === 'prunable') record.prunable = true;
    }
    return record;
  });
}

function workspaceClaims(stateRoot, workspace) {
  const projects = join(stateRoot, '.xm', 'build', 'projects'), claims = [];
  if (!existsSync(projects)) return claims;
  for (const projectEntry of readdirSync(projects, { withFileTypes: true })) {
    if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink()) continue;
    const worktrees = join(projects, projectEntry.name, 'worktrees');
    if (!existsSync(worktrees)) continue;
    for (const taskEntry of readdirSync(worktrees, { withFileTypes: true })) {
      if (!taskEntry.isDirectory() || taskEntry.isSymbolicLink()) continue;
      const run = join(worktrees, taskEntry.name, 'run.json');
      if (!existsSync(run)) continue;
      try {
        const data = JSON.parse(readFileSync(run, 'utf8'));
        const candidate = typeof data.worktree === 'string' && data.worktree.trim() ? (isAbsolute(data.worktree) ? resolve(data.worktree) : resolve(stateRoot, data.worktree)) : null;
        if (candidate && existsSync(candidate) && realpathSync(candidate) === workspace) claims.push({ project: projectEntry.name, task: taskEntry.name });
      } catch {}
    }
  }
  return claims;
}

function mutationWorkspace(artifact, stateRoot, task) {
  const data = artifact?.data;
  if (artifact?.artifact_file !== 'run.json') fail('mutate task requires an authoritative run.json artifact');
  if (data?.task_id !== task) fail('mutate task artifact identity does not match the selected task');
  if (typeof data?.branch !== 'string' || !data.branch.trim()) fail('mutate task artifact is missing its branch');
  if (typeof data?.worktree !== 'string' || !data.worktree.trim()) fail('mutate task artifact is missing its worktree path');
  const path = isAbsolute(data.worktree) ? resolve(data.worktree) : resolve(stateRoot, data.worktree);
  if (!existsSync(path)) fail('mutate task worktree is missing');
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('mutate task worktree must be a regular directory');
  const workspace = realpathSync(path), stateRepo = repositoryRoot(resolve(stateRoot)), worktreeRepo = repositoryRoot(workspace);
  if (stateRepo !== worktreeRepo) fail('mutate task worktree belongs to a different repository');
  if (workspace === stateRepo) fail('mutate refuses the primary checkout; task requires its linked worktree');
  const matches = worktreeRecords(stateRepo).filter(record => {
    if (!record.path || !existsSync(record.path)) return false;
    try { return realpathSync(record.path) === workspace; } catch { return false; }
  });
  if (matches.length !== 1) fail('mutate task worktree is not uniquely registered');
  const record = matches[0], expectedBranch = `refs/heads/${data.branch}`;
  if (record.detached || record.bare || record.prunable || record.branch !== expectedBranch) fail('mutate task worktree registration does not match its recorded branch');
  const claims = workspaceClaims(stateRoot, workspace);
  if (claims.length !== 1 || claims[0].project !== artifact.project || claims[0].task !== task) fail('mutate task worktree is claimed by another task');
  return workspace;
}

function canonicalStateRoot(cwd) {
  if (process.env.X_BUILD_ROOT) return resolve(process.env.X_BUILD_ROOT, '..', '..');
  if (process.env.XM_ROOT) return resolve(process.env.XM_ROOT, '..');
  return resolveMainRepoRoot(cwd) || resolve(cwd);
}

function reportArtifact(project, task) {
  return `.xm/review/mutate/${project}/${task}.json`;
}

function diffReportArtifact(name) {
  return `.xm/review/mutate-diff/${name}.json`;
}

function ensureReportDirectory(dir) {
  try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o022) !== 0) fail('mutate report directory is unsafe');
}

function writeAll(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    let written;
    try {
      written = writeSync(fd, buffer, offset, buffer.length - offset, null);
    } catch (error) {
      if (error?.code === 'EINTR') continue;
      throw error;
    }
    if (written <= 0) {
      const error = new Error('mutate report write made no progress');
      error.code = 'EIO';
      throw error;
    }
    offset += written;
  }
}

function sameFileIdentity(path, identity) {
  try {
    const stat = lstatSync(path, { bigint: true });
    return !stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino;
  } catch {
    return false;
  }
}

function syncDirectory(path) {
  const fd = openSync(path, FS.O_RDONLY);
  try { fsyncSync(fd); } catch (error) { if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)) throw error; } finally { closeSync(fd); }
}

function persistReport(state, segments, name, report) {
  const dirs = [join(state, '.xm'), join(state, '.xm', 'review')];
  for (const segment of segments) dirs.push(join(dirs.at(-1), segment));
  for (const dir of dirs) ensureReportDirectory(dir);
  const directory = dirs.at(-1), reportPath = join(directory, `${name}.json`);
  if (existsSync(reportPath)) {
    const stat = lstatSync(reportPath);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('mutate report path is unsafe');
  }
  const payload = Buffer.from(`${JSON.stringify(report)}\n`), noFollow = Number.isInteger(FS.O_NOFOLLOW) ? FS.O_NOFOLLOW : 0, flags = FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | noFollow;
  let fd = null, tmp = null, identity = null, published = false;
  try {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      tmp = join(directory, `.${name}.${randomBytes(16).toString('hex')}.tmp`);
      try { fd = openSync(tmp, flags, 0o600); break; } catch (error) { if (error?.code !== 'EEXIST') throw error; }
    }
    if (fd == null) fail('mutate could not allocate a unique report temporary file');
    const stat = fstatSync(fd, { bigint: true });
    identity = { dev: stat.dev, ino: stat.ino };
    if (!stat.isFile()) fail('mutate report temporary path is unsafe');
    writeAll(fd, payload);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    ensureReportDirectory(directory);
    if (!sameFileIdentity(tmp, identity)) fail('mutate report temporary path changed before publication');
    renameSync(tmp, reportPath);
    syncDirectory(directory);
    published = true;
    return reportPath;
  } finally {
    if (fd != null) try { closeSync(fd); } catch {}
    if (!published && tmp && identity && sameFileIdentity(tmp, identity)) try { unlinkSync(tmp); } catch {}
  }
}

export function listMutationTasks(stateRoot, { adapters = ADAPTERS } = {}) {
  const state = resolve(stateRoot), projects = join(state, '.xm', 'build', 'projects'), rows = [];
  if (!existsSync(projects)) return rows;
  for (const entry of readdirSync(projects, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const project = entry.name, tasksPath = join(projects, project, 'phases', '02-plan', 'tasks.json');
    let tasks = [];
    if (existsSync(tasksPath)) try { tasks = JSON.parse(readFileSync(tasksPath, 'utf8')).tasks || []; } catch {}
    const ids = new Set(tasks.map(task => task.id).filter(Boolean)), worktrees = join(projects, project, 'worktrees');
    if (existsSync(worktrees)) for (const dirent of readdirSync(worktrees, { withFileTypes: true })) if (dirent.isDirectory() && dirent.name !== '__integration__') ids.add(dirent.name);
    for (const id of [...ids].sort()) {
      const artifact = loadTaskArtifact(state, id, project), task = tasks.find(candidate => candidate.id === id) || artifact?.data?.task || {};
      let reason = null, files = [];
      if (!artifact) reason = 'missing worktree artifact';
      else {
        try {
          const workspace = mutationWorkspace(artifact, state, id), base = artifact.data.base;
          if (typeof base !== 'string' || !base.trim()) reason = 'run.json has no base; pass --base <ref>';
          else {
            files = [...resolveChangeSet(workspace, base).changed.keys()].filter(file => adapters.some(adapter => adapter.claims(file)));
            if (!files.length) reason = 'no changed files in a supported language';
          }
        } catch (error) {
          reason = error.message;
        }
      }
      rows.push({ project, id, name: task.name || id, status: task.status || null, files, runnable: reason === null, reason });
    }
  }
  return rows.sort((a, b) => Number(b.runnable) - Number(a.runnable) || String(a.project).localeCompare(String(b.project)) || String(a.id).localeCompare(String(b.id)));
}

export async function runTaskMutate(stateRoot, task, { project = null, base = null, languages = null, timeoutMs = DEFAULT_TIMEOUT_MS, signal = null, adapters = ADAPTERS } = {}) {
  const taskError = validateIdSegment(task, '--task');
  if (taskError) fail(taskError);
  if (project != null) {
    const projectError = validateIdSegment(project, '--project');
    if (projectError) fail(projectError);
  }
  const state = resolve(stateRoot), artifact = loadTaskArtifact(state, task, project);
  if (!artifact) fail('mutate task artifact not found');
  const workspace = mutationWorkspace(artifact, state, task), ref = base ?? artifact.data.base;
  if (typeof ref !== 'string' || !ref.trim()) fail('mutate task run.json has no base; pass --base <ref>');
  const report = { ...(await runDiffMutate({ cwd: workspace, base: ref, languages, timeoutMs, signal, adapters })), mode: 'task', project: artifact.project, task_id: task };
  persistReport(state, ['mutate', artifact.project], task, report);
  const artifactPath = reportArtifact(artifact.project, task);
  const surviving = report.mutants
    .filter(row => row.status === 'survived')
    .map(row => buildEscapeRow({ mutant: true, ts: report.ts, task_id: task, file: row.file, artifact: artifactPath, source: 'mutate', operator: row.mutator, line: row.line }));
  if (surviving.length) appendAttentionRows(state, surviving);
  return report;
}

function printReport(report, artifactPath) {
  const label = report.mode === 'task' ? `${report.project}/${report.task_id}` : `diff ${report.base} (merge-base ${report.merge_base.slice(0, 12)})`;
  if (!report.languages.length) {
    console.log(`Mutate ${label}: no changed files in a supported language (${ADAPTERS.map(adapter => adapter.language).join(', ')}).`);
    console.log(`Report: ${artifactPath}`);
    return;
  }
  const counts = report.counts;
  console.log(`Mutate ${label}: ${counts.survived} survived, ${counts.killed} killed, ${counts.timeout} timeout, ${counts.unviable} unviable, ${counts.no_coverage} no coverage (${report.mutants.length} mutants)`);
  for (const row of report.languages) {
    const where = row.root && row.root !== '.' ? ` in ${row.root}` : '';
    if (row.status === 'ran') console.log(`  ${row.language}${where}: ${row.tool} ${row.tool_version} — ${row.counts.survived} survived, ${row.counts.killed} killed`);
    else console.log(`  ${row.language}${where}: ${row.status} — ${row.reason}${row.install ? `. Install: ${row.install}` : ''}`);
    if (row.note) console.log(`    note: ${row.note}`);
  }
  const survivors = report.mutants.filter(row => row.status === 'survived');
  if (survivors.length) {
    console.log('Survived (candidates for a missing test, not proof of one):');
    for (const row of survivors) console.log(`  ${row.file}:${row.line}  ${row.description}`);
  }
  console.log(`Report: ${artifactPath}`);
}

function printTaskList(tasks) {
  const runnable = tasks.filter(row => row.runnable);
  if (runnable.length) {
    console.log('Mutation testing candidates (existing tests are checked; no tests are generated):');
    for (const row of runnable) console.log(`  ✓ ${row.project}/${row.id} — ${row.name}${row.status ? ` [${row.status}]` : ''} — ${row.files.join(', ')}`);
    console.log('Choose one with /xm:mutate or run: xm build mutate --project <project> --task <id>');
    return;
  }
  if (!tasks.length) console.log('No x-build tasks found.');
  else {
    const reasons = new Map();
    for (const row of tasks) reasons.set(row.reason, (reasons.get(row.reason) || 0) + 1);
    console.log('No tasks are ready for mutation testing.');
    console.log(`Why: ${[...reasons].map(([reason, count]) => `${count} ${reason}`).join('; ')}`);
  }
  console.log('Without a task, run: xm mutate --diff <base>');
}

export async function cmdMutate(args) {
  let task = null, project = getExplicitProject(), base = null, diff = null, languageArg = null, timeoutMs = DEFAULT_TIMEOUT_MS, json = false, list = args.length === 0;
  const usage = message => {
    console.error(message);
    console.error(USAGE);
    process.exitCode = 2;
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i], value = args[i + 1];
    if (arg === '--list') list = true;
    else if (arg === '--json') json = true;
    else if (arg === '--diff' && value) { diff = value; i += 1; }
    else if (arg === '--task' && value) { task = value; i += 1; }
    else if ((arg === '--project' || arg === '-p') && value) { project = value; i += 1; }
    else if (arg.startsWith('--project=')) project = arg.slice('--project='.length);
    else if (arg === '--base' && value) { base = value; i += 1; }
    else if (arg === '--lang' && value) { languageArg = value; i += 1; }
    else if (arg === '--timeout-ms' && value) { timeoutMs = Number(value); i += 1; }
    else if (arg === '--max-mutants') return usage('mutate: --max-mutants was removed; the external tool chooses the mutants for the changed lines');
    else return usage(`mutate: unknown or incomplete argument '${arg}'`);
  }
  if ([list, diff != null, task != null].filter(Boolean).length !== 1) return usage('mutate: choose exactly one of --list, --diff <base>, or --task <id>');
  if (base != null && task == null) return usage('mutate: --base applies to --task; use --diff <base> without a task');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) return usage('mutate: --timeout-ms must be a positive integer');
  let languages = null;
  if (languageArg != null) {
    const known = ADAPTERS.map(adapter => adapter.language), names = languageArg.split(',').map(name => name.trim()).filter(Boolean);
    if (!names.length || names.some(name => !known.includes(name))) return usage(`mutate: --lang accepts ${known.join(', ')}`);
    languages = new Set(names);
  }
  const workspace = resolve(process.cwd()), state = canonicalStateRoot(workspace);
  if (list) {
    const tasks = listMutationTasks(state);
    if (json) console.log(JSON.stringify({ schema_v: 2, tasks, runnable_count: tasks.filter(row => row.runnable).length }));
    else printTaskList(tasks);
    return;
  }
  const controller = new AbortController();
  let interrupted = null;
  const stop = signalName => () => { interrupted = signalName; controller.abort(); };
  const onInt = stop('SIGINT'), onTerm = stop('SIGTERM');
  process.once('SIGINT', onInt);
  process.once('SIGTERM', onTerm);
  try {
    let report, artifactPath;
    if (diff != null) {
      report = await runDiffMutate({ cwd: workspace, base: diff, languages, timeoutMs, signal: controller.signal });
      const name = `${report.head.slice(0, 12)}-${report.merge_base.slice(0, 12)}`;
      persistReport(state, ['mutate-diff'], name, report);
      artifactPath = diffReportArtifact(name);
    } else {
      report = await runTaskMutate(state, task, { project, base, languages, timeoutMs, signal: controller.signal });
      artifactPath = reportArtifact(report.project, task);
    }
    if (json) console.log(JSON.stringify(report));
    else printReport(report, artifactPath);
    // Survivors are observational; only a language that could not run fails the command.
    process.exitCode = interrupted ? 130 : report.languages.every(row => row.status === 'ran') ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = interrupted ? 130 : (error.exitCode || 2);
  } finally {
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
  }
}
