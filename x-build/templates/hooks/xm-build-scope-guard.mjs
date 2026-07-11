#!/usr/bin/env node
// xm-build-scope-guard.mjs — PreToolUse hook (installed by `x-build hooks install`).
//
// During an ACTIVE x-build review-fix, block Edit/Write/MultiEdit/NotebookEdit to
// files OUTSIDE triage.fix_scope.allowed_files. Fail-open otherwise. This makes the
// review-fix scope discipline machine-enforced instead of a prompt convention.

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

  const filePath = input.tool_input?.file_path;
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
  process.stderr.write(
    `✋ Blocked by xm-build-scope-guard — a review-fix is in progress.\n\n` +
    `${rel} is OUTSIDE the review-fix scope. Edits are limited to:\n` +
    `${allowedList}\n\n` +
    `Fix only the fix_now findings in their files. If this edit is genuinely required,\n` +
    `add the file to triage.fix_scope.allowed_files, or set XM_BUILD_HOOKS_OFF=1 to bypass.\n`
  );
  process.exit(2);
}

main();
