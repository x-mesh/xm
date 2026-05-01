// @ts-check
/**
 * Flatten namespace separators for tool targets that lack `:` namespacing.
 * Cursor's `.cursor/rules/<name>.mdc` and `.cursor/commands/<name>.md` cannot
 * contain `/` or `:` — file name IS the rule/command identifier (PRD §5.1, B1 N2).
 *
 * Examples:
 *   xm:build       → xm-build
 *   xm:op:debate   → xm-op-debate
 *   phases/plan    → phases-plan
 */

import { validateName } from '../security.mjs';
import { PLUGIN_NAME_RE } from '../types.mjs';

const NS_SEPS = /[/:]+/g;

/**
 * Flatten a namespaced identifier into a single dash-separated lowercase string,
 * then validate against the plugin/skill name pattern.
 * @param {string} input  e.g. "xm:build"
 * @returns {string}      e.g. "xm-build"
 * @throws {Error}        If the result violates PLUGIN_NAME_RE.
 */
export function flatten(input) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('flatten: input must be non-empty string');
  }
  const collapsed = input
    .toLowerCase()
    .replace(NS_SEPS, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!PLUGIN_NAME_RE.test(collapsed)) {
    throw new Error(`flatten: result ${JSON.stringify(collapsed)} does not match ${PLUGIN_NAME_RE}`);
  }
  return validateName(collapsed, 'plugin');
}

/**
 * Compose a tool-namespaced rule/command name: `xm-<plugin>-<skill>`.
 * Used by every renderer to keep xm-owned files identifiable for cleanup.
 * @param {string} plugin
 * @param {string} skill
 * @returns {string}
 */
export function xmName(plugin, skill) {
  const p = flatten(plugin);
  const s = flatten(skill);
  // If skill === plugin (single-skill plugin), avoid duplicating: xm-<plugin>
  if (p === s) return `xm-${p}`;
  return `xm-${p}-${s}`;
}

/**
 * Build a hyphen-flattened reference name from a relative path under references/.
 * Examples:
 *   "references/usage.md"          → "usage"
 *   "references/phases/plan.md"    → "phases-plan"
 *   "references/a/b/c.md"          → "a-b-c"
 * Strips leading "references/" and ".md" suffix.
 * @param {string} relativePath
 * @returns {string}
 */
export function flattenRefPath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('flattenRefPath: input must be non-empty string');
  }
  const stripped = relativePath
    .replace(/^references\//, '')
    .replace(/\.md$/i, '');
  return flatten(stripped);
}
