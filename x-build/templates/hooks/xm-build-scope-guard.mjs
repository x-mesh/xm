#!/usr/bin/env node
// xm-build-scope-guard.mjs — PreToolUse hook (installed by `x-build hooks install`).
//
// During an ACTIVE x-build review-fix, block Edit/Write/MultiEdit/NotebookEdit to
// files OUTSIDE triage.fix_scope.allowed_files. Fail-open otherwise. This makes the
// review-fix scope discipline machine-enforced instead of a prompt convention.
//
// THREAT MODEL (be honest about the boundary): this is a guardrail against DRIFT — an
// agent that wanders out of scope while fixing something — not a sandbox against a
// determined one. A PreToolUse matcher cannot observe Bash, so file writes (and even
// `rm .xm/review/triage.json`) issued through a shell are outside its reach, and
// XM_BUILD_HOOKS_OFF=1 is a documented, deliberate bypass anyway. It raises the cost of
// silently leaving scope; it does not make leaving scope impossible.

import { hooksOff, reviewFixState, isProtectedPath, isAllowed, repoRelative } from './hook-state.mjs';

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

async function main() {
  if (hooksOff()) process.exit(0);

  let input;
  try {
    const raw = await readStdin();
    input = raw ? JSON.parse(raw) : {};
  } catch { process.exit(0); } // malformed payload → fail-open (never break the session)

  if (!WRITE_TOOLS.has(input.tool_name)) process.exit(0);

  // NotebookEdit carries `notebook_path`, not `file_path` — reading only file_path let
  // every notebook write skip the scope check entirely while still being matched (F3).
  const filePath = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (typeof filePath !== 'string' || !filePath) process.exit(0);

  const projectRoot = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();

  const state = reviewFixState(projectRoot);
  if (!state.active) process.exit(0); // no review-fix in progress → nothing to scope

  const rel = repoRelative(filePath, projectRoot);
  if (rel === null) process.exit(0);                          // outside repo → not ours
  if (isProtectedPath(rel)) process.exit(0);                  // .xm state / later-queue → never block
  if (isAllowed(filePath, projectRoot, state.allowedFiles)) process.exit(0);

  const allowedList = state.allowedFiles.length
    ? state.allowedFiles.map(f => `  - ${f}`).join('\n')
    : '  (none — the triage lists no allowed_files)';
  // Do NOT advise editing triage.json here: it is one of the guard's own decision
  // sources and is deliberately no longer auto-allowed (F4), so widening the scope from
  // inside a guarded session must be a deliberate, visible bypass — not a quiet self-edit.
  process.stderr.write(
    `✋ Blocked by xm-build-scope-guard — a review-fix is in progress.\n\n` +
    `${rel} is OUTSIDE the review-fix scope. Edits are limited to:\n` +
    `${allowedList}\n\n` +
    `Fix only the fix_now findings in their files. If this edit is genuinely required,\n` +
    `re-run with XM_BUILD_HOOKS_OFF=1 (an explicit, visible bypass).\n`
  );
  process.exit(2);
}

main();
