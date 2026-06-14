// block-marketplace-copy hook — findSourcePath regex coverage.
//
// The hook runs main() at import time (reads stdin), so it can't be imported;
// exercise it as a subprocess with a stdin payload, exactly how Claude Code's
// PreToolUse hook invokes it. Covers the regex generalization from
// /^xm\/skills\/([^/]+)\// to /^xm\/skills\/([^/]+)\/(.+)$/ that makes the
// source hint accurate for sub-assets (flow.md, flow/*.mjs, strategies/*.md).
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const HOOK = join(REPO, '.claude', 'hooks', 'block-marketplace-copy.mjs');

function runHook(toolName, filePath) {
  const payload = JSON.stringify({ tool_name: toolName, tool_input: { file_path: filePath }, cwd: REPO });
  const r = spawnSync('node', [HOOK], {
    input: payload,
    env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
    encoding: 'utf8',
  });
  return { status: r.status, stderr: r.stderr || '' };
}

describe('block-marketplace-copy — blocks marketplace copies with accurate source hints', () => {
  test('blocks the flow engine copy and points at the flow/ source', () => {
    const r = runHook('Edit', 'xm/skills/agent/flow/flow-template.mjs');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('x-agent/skills/agent/flow/flow-template.mjs');
  });

  test('blocks the flow.md copy and points at the flow.md source', () => {
    const r = runHook('Write', 'xm/skills/agent/flow.md');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('x-agent/skills/agent/flow.md');
  });

  test('blocks a top-level SKILL.md copy (regression for the original behavior)', () => {
    const r = runHook('Edit', 'xm/skills/agent/SKILL.md');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('x-agent/skills/agent/SKILL.md');
  });

  test('blocks a nested strategy copy with the correct nested source hint', () => {
    const r = runHook('Edit', 'xm/skills/op/strategies/review.md');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('x-op/skills/op/strategies/review.md');
  });
});

describe('block-marketplace-copy — allows non-marketplace edits', () => {
  test('allows editing the source flow engine', () => {
    const r = runHook('Edit', 'x-agent/skills/agent/flow/flow-template.mjs');
    expect(r.status).toBe(0);
  });

  test('allows editing an unrelated repo file', () => {
    const r = runHook('Edit', 'README.md');
    expect(r.status).toBe(0);
  });

  test('ignores non-write tools even on a marketplace copy', () => {
    const r = runHook('Read', 'xm/skills/agent/flow/flow-template.mjs');
    expect(r.status).toBe(0);
  });
});
