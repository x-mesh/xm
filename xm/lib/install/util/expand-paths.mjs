// @ts-check
/**
 * Replace Claude-Code-specific path tokens with tool-bundle paths.
 * Implements PRD §5.4 (CLI bundling) and R-SEC-07 (mask absolute paths in LLM context).
 *
 * Source forms (in SKILL.md / commands):
 *   ${CLAUDE_PLUGIN_ROOT}/lib/x-build-cli.mjs
 *   $CLAUDE_PLUGIN_ROOT/lib/...
 *
 * Target form for non-Claude tools (LLM-readable, user-mask-safe):
 *   $HOME/.cursor/xm/lib/x-build-cli.mjs
 *   $HOME/.codex/xm/lib/...
 *   $HOME/.kiro/xm/lib/...
 *   $HOME/.gemini/xm/lib/...      (Antigravity)
 *
 * We intentionally use literal `$HOME` so renderers do not bake the user's
 * home directory absolute path into LLM-visible content (R-SEC-07).
 */

import { TARGET_TOOLS, TARGET_DIR } from '../types.mjs';

const TOKEN_RE = /\$\{?CLAUDE_PLUGIN_ROOT\}?/g;

/**
 * Compute the bundle path that replaces `${CLAUDE_PLUGIN_ROOT}` for a given target/scope.
 *
 *   global → "$HOME/.<tool>/xm"
 *   local  → ".<tool>/xm" (relative to project root, no leading $HOME)
 *
 * The `xm` segment matches the layout install.mjs creates: copy of xm/lib/.
 *
 * @param {import('../types.mjs').TargetTool} target
 * @param {'global'|'local'} scope
 * @returns {string}
 */
export function bundleRoot(target, scope) {
  if (!TARGET_TOOLS.includes(target)) {
    throw new Error(`bundleRoot: unknown target ${JSON.stringify(target)}`);
  }
  if (scope !== 'global' && scope !== 'local') {
    throw new Error(`bundleRoot: scope must be 'global' or 'local', got ${JSON.stringify(scope)}`);
  }
  const dir = TARGET_DIR[target];
  return scope === 'global' ? `$HOME/${dir}/xm` : `${dir}/xm`;
}

/**
 * Expand `${CLAUDE_PLUGIN_ROOT}` (and `$CLAUDE_PLUGIN_ROOT`) tokens in body text.
 * Output uses the masked `$HOME/...` form for LLM safety.
 *
 * @param {string} body
 * @param {{ target: import('../types.mjs').TargetTool, scope: 'global'|'local' }} ctx
 * @returns {string}
 */
export function expandPaths(body, ctx) {
  if (typeof body !== 'string') return body;
  const replacement = bundleRoot(ctx.target, ctx.scope);
  return body.replace(TOKEN_RE, replacement);
}

/**
 * Quick check: does the body contain any Claude-Code-specific token that
 * MUST be expanded before shipping to a non-Claude tool?
 * @param {string} body
 * @returns {boolean}
 */
export function hasClaudeTokens(body) {
  if (typeof body !== 'string') return false;
  TOKEN_RE.lastIndex = 0;
  return TOKEN_RE.test(body);
}
