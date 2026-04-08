#!/usr/bin/env node
// .claude/hooks/block-marketplace-copy.mjs
//
// PreToolUse hook: deny Edit/Write/MultiEdit/NotebookEdit on x-kit marketplace copies.
// Source of truth for the protected set: scripts/sync-bundle.sh
// Rationale: CLAUDE.md § Edit Policy + § Lessons (x-humble) L4/L5.

import path from 'node:path';

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Plugins whose SKILL.md is copied into x-kit/skills/<plugin>/SKILL.md by sync-bundle.sh.
// Keep in sync with the for-loop at scripts/sync-bundle.sh:26.
const PLUGINS_WITH_SOURCE_SKILL = new Set([
  'x-agent',
  'x-build',
  'x-eval',
  'x-humble',
  'x-memory',
  'x-op',
  'x-probe',
  'x-review',
  'x-solver',
  'x-trace',
]);

// x-build lib files copied into x-kit/lib/x-build/. Keep in sync with sync-bundle.sh:34.
const X_BUILD_LIB_FILES = new Set([
  'core.mjs',
  'project.mjs',
  'phase.mjs',
  'plan.mjs',
  'tasks.mjs',
  'verify.mjs',
  'export.mjs',
  'misc.mjs',
]);

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

function findSourcePath(rel) {
  // x-kit/skills/<plugin>/... where <plugin> has a standalone source directory.
  // Covers SKILL.md and any future copied assets under the same plugin dir.
  const skillMatch = rel.match(/^x-kit\/skills\/([^/]+)\//);
  if (skillMatch && PLUGINS_WITH_SOURCE_SKILL.has(skillMatch[1])) {
    const plugin = skillMatch[1];
    return `${plugin}/skills/${plugin}/SKILL.md`;
  }

  // x-kit/lib/x-build/<file>.mjs
  const libMatch = rel.match(/^x-kit\/lib\/x-build\/([^/]+\.mjs)$/);
  if (libMatch && X_BUILD_LIB_FILES.has(libMatch[1])) {
    return `x-build/lib/x-build/${libMatch[1]}`;
  }

  if (rel === 'x-kit/lib/x-build-cli.mjs') {
    return 'x-build/lib/x-build-cli.mjs';
  }

  if (rel === 'x-kit/lib/x-solver-cli.mjs') {
    return 'x-solver/lib/x-solver-cli.mjs';
  }

  return null;
}

async function main() {
  let input;
  try {
    const raw = await readStdin();
    input = raw ? JSON.parse(raw) : {};
  } catch {
    // Malformed hook payload — fail open so we don't break the session.
    process.exit(0);
  }

  const toolName = input.tool_name;
  if (!WRITE_TOOLS.has(toolName)) {
    process.exit(0);
  }

  const filePath = input.tool_input?.file_path;
  if (typeof filePath !== 'string' || filePath.length === 0) {
    process.exit(0);
  }

  // Prefer CLAUDE_PROJECT_DIR (the repo root) so the check is stable regardless
  // of which subdirectory the shell was launched from.
  const projectRoot = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(projectRoot, filePath);
  const rel = path.relative(projectRoot, abs);

  // Outside the repo root — not our concern.
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    process.exit(0);
  }

  const source = findSourcePath(rel);
  if (!source) {
    process.exit(0);
  }

  process.stderr.write(
    `✋ Blocked by .claude/hooks/block-marketplace-copy.mjs\n` +
      `\n` +
      `${rel} is a marketplace copy — a build artifact produced by scripts/sync-bundle.sh.\n` +
      `\n` +
      `Edit the source instead:\n` +
      `  ${source}\n` +
      `\n` +
      `After editing the source, run \`./scripts/sync-bundle.sh\` to update the bundle.\n` +
      `See CLAUDE.md § Edit Policy.\n`
  );
  process.exit(2);
}

main();
