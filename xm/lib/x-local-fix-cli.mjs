#!/usr/bin/env node
/**
 * x-local-fix-cli.mjs — prepare a same-host cross-project fix without
 * bypassing toss/inbox audit records. It captures the sender outbox record
 * through toss(), then creates a git-kit-managed worktree in the registered
 * target project. MCP delivery and materialization remain the SKILL's job.
 */

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { toss } from './x-inbox/toss.mjs';
import { resolveTarget } from './x-inbox/target.mjs';

const KNOWN_FLAGS = new Set(['--command', '--output', '--output-file', '--fix', '--why', '--to-files', '--from-commit', '--branch', '--base', '--no-init', '--json']);
const LOCAL_FIX_TAG = 'local-fix';

function getFlag(args, name) {
  const eq = args.find((arg) => arg.startsWith(`${name}=`));
  if (eq !== undefined) return eq.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  return value === undefined || KNOWN_FLAGS.has(value) ? true : value;
}

function hasFlag(args, name) { return args.includes(name); }
function nonEmpty(value) { return typeof value === 'string' && value.trim().length > 0; }

function usage() {
  return 'Usage: xm local-fix <project> "<title>" --command <cmd> --output <text> --fix <direction> '
    + '[--why <text>] [--output-file <path>] [--to-files a,b] [--from-commit <hash>] '
    + '[--branch <name>] [--base <ref>] [--no-init] [--json]\n';
}

function parseWorktreeResult(raw) {
  try {
    const parsed = JSON.parse(raw);
    const result = parsed?.result;
    if (parsed?.state === 'ok' && typeof result?.path === 'string' && result.path) return result;
  } catch {
    // Report a stable CLI-level error below rather than exposing a parser trace.
  }
  return null;
}

function acquireWorktree(targetPath, branch, base, noInit) {
  const args = ['worktree', 'acquire', branch, '--from', base, '--json'];
  if (noInit) args.push('--no-init');
  const result = spawnSync('git-kit', args, { cwd: targetPath, env: { ...process.env, GK_AGENT: '1' }, encoding: 'utf8' });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  const worktree = result.status === 0 ? parseWorktreeResult(result.stdout) : null;
  if (!worktree || !existsSync(worktree.path)) return { ok: false, message: output || result.error?.message || 'git-kit worktree acquire failed' };
  return { ok: true, worktree };
}

async function main(args) {
  const targetName = args[0];
  const title = args[1];
  if (!nonEmpty(targetName) || !nonEmpty(title)) return { ok: false, code: 2, message: usage() };

  const command = getFlag(args, '--command');
  const outputFlag = getFlag(args, '--output');
  const outputFile = getFlag(args, '--output-file');
  const fixDirection = getFlag(args, '--fix');
  if (!nonEmpty(command) || !nonEmpty(fixDirection)) return { ok: false, code: 2, message: 'xm local-fix: --command and --fix are required\n' + usage() };

  let output = typeof outputFlag === 'string' ? outputFlag : null;
  if (output === null && typeof outputFile === 'string') {
    try { output = readFileSync(outputFile, 'utf8'); } catch (err) {
      return { ok: false, code: 1, message: `xm local-fix: failed to read --output-file ${outputFile}: ${err.message}` };
    }
  }
  if (!nonEmpty(output)) return { ok: false, code: 2, message: 'xm local-fix: --output (or --output-file) is required\n' + usage() };

  const toFilesRaw = getFlag(args, '--to-files');
  const toFiles = typeof toFilesRaw === 'string' ? toFilesRaw.split(',').map((value) => value.trim()).filter(Boolean) : [];
  const why = getFlag(args, '--why');
  const fromCommit = getFlag(args, '--from-commit');
  const captured = await toss({
    toProject: targetName, title, why: typeof why === 'string' ? why : undefined,
    repro: { command, output }, anchors: { to_files: toFiles, ...(typeof fromCommit === 'string' ? { from_commit: fromCommit } : {}) }, fixDirection,
  });
  if (!captured.ok) return { ok: false, code: 1, message: captured.message, capture: captured };

  const target = resolveTarget(targetName);
  if (!target.ok) return { ok: false, code: 1, message: target.message, capture: captured };
  const branchFlag = getFlag(args, '--branch');
  const branch = typeof branchFlag === 'string' && branchFlag.trim() ? branchFlag.trim() : `local-fix/${captured.item.id}`;
  const baseFlag = getFlag(args, '--base');
  const base = typeof baseFlag === 'string' && baseFlag.trim() ? baseFlag.trim() : 'HEAD';
  const acquired = acquireWorktree(target.path, branch, base, hasFlag(args, '--no-init'));
  if (!acquired.ok) return { ok: false, code: 1, message: `xm local-fix: worktree preparation failed; sender outbox remains at ${captured.outboxPath}: ${acquired.message}`, capture: captured };
  const withLocalFixTag = (call) => ({ ...call, tags: [...call.tags, LOCAL_FIX_TAG] });

  return {
    ok: true, code: 0,
    local_fix: {
      item_id: captured.item.id, outbox_path: captured.outboxPath, target_path: target.path,
      target_worktree: acquired.worktree.path, branch: acquired.worktree.branch,
      mem_mesh_project_id: captured.memMeshProjectId,
      mcp_calls: { pin_add: withLocalFixTag(captured.payload.pin_add), add: withLocalFixTag(captured.payload.add) },
    },
  };
}

const args = process.argv.slice(2);
const result = await main(args);
if (hasFlag(args, '--json')) process.stdout.write(`${JSON.stringify(result.ok ? { ok: true, ...result.local_fix } : { ok: false, message: result.message, capture: result.capture }, null, 2)}\n`);
else if (result.ok) {
  const item = result.local_fix;
  process.stdout.write(`🌳 local-fix ready: ${item.item_id}\nworktree: ${item.target_worktree}\nbranch: ${item.branch}\n`);
  process.stdout.write('Run the printed MCP calls, materialize the memory inside this worktree, then fix and test there.\n');
} else process.stderr.write(`${result.message}\n`);
process.exit(result.code);
