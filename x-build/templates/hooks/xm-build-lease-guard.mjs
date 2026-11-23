#!/usr/bin/env node
// xm-build-lease-guard.mjs — Agent-only PreToolUse hook (installed by `x-build hooks install`).
//
// `xm build route start` writes the lease that the rest of a route run is checked against.
// When it fails, an agent can still dispatch executor agents and finish the work with no
// lease, no receipt, and no recorded outcome. This hook blocks a new Agent dispatch in the
// session whose start failed, until a start succeeds or the failed start is abandoned.
//
// THREAT MODEL (be honest about the boundary): this is a guardrail against DRIFT — an agent
// that reads the error and carries on — not a sandbox. It sees only the Agent tool, so an
// agent started through Bash or a workflow passes, and so does a run that never calls
// `route start`. `xm build route abandon` and XM_BUILD_HOOKS_OFF=1 are deliberate, visible
// releases. The message names abandon as the user's decision and prints no ready-to-run
// line for it: the run this hook was written for passed `test=true` to get past the CLI.

import { hooksOff, failedRouteStart } from './hook-state.mjs';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
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

  if (input.tool_name !== 'Agent') process.exit(0);

  const failed = failedRouteStart([process.env.CLAUDE_PROJECT_DIR, input.cwd], input.session_id);
  if (!failed) process.exit(0);

  process.stderr.write(
    `✋ Agent dispatch blocked by xm-build-lease-guard — \`xm build route start\` failed for ${failed.decision_id} in this session, and no start succeeded after it.\n\n` +
    `  ${failed.error}\n\n` +
    `Fix that cause and run \`xm build route start\` again, or stop and report the error to the user.\n` +
    `Giving up this run is the user's decision, not yours. After the user says so,\n` +
    `\`xm build route abandon\` for this decision releases the guard.\n` +
    `Explicit, visible bypass: XM_BUILD_HOOKS_OFF=1.\n`
  );
  process.exit(2);
}

// `xm setup` installs this for every project on the machine, so an unexpected error must
// not surface on each Agent dispatch: it fails open.
main().catch(() => process.exit(0));
