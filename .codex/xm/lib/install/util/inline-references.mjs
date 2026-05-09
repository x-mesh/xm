// @ts-check
/**
 * Inline-reference helper for renderers (PRD §5.2, ADR-002).
 *
 * SKILL.md bodies frequently link to per-plugin reference docs:
 *   See `references/usage.md` for full options.
 *   Detailed lens spec lives in `references/lenses/security.md`.
 *
 * Each renderer has a different size budget:
 *   - Cursor `.mdc`        : ≤ 500 lines, refs become *separate* xm-<plug>-ref-<name>.mdc files.
 *   - Codex AGENTS.md      : index ≤ 16 KiB; SKILL bodies + refs go to ~/.codex/prompts/.
 *   - Kiro steering        : no hard limit, refs use Kiro-native `#[[file:<name>.md]]` include.
 *   - Antigravity .agent/  : same as Codex, no per-file frontmatter.
 *
 * This util provides three primitives:
 *   1) extractRefLinks(body)         — find `references/<path>` mentions
 *   2) replaceRefLinks(body, mapper) — rewrite each link via a renderer-supplied function
 *   3) inlineRefs(body, refs)         — concatenate refs into body with `[See: <name>]` headings
 */

import { flattenRefPath } from './flatten-namespace.mjs';

/**
 * Match `references/...md` tokens in markdown body.
 * Captures: full match, the path *after* `references/` and before `.md`.
 * Allows backticks, plain text, or markdown link syntax.
 */
const REF_LINK_RE = /references\/([A-Za-z0-9_./-]+?)\.md/g;

/**
 * @typedef {Object} RefLink
 * @property {string} match       The matched substring including `references/` prefix and `.md`.
 * @property {string} relativePath e.g. "lenses/security.md"
 * @property {string} flatName     flattenRefPath result, e.g. "lenses-security"
 * @property {number} index        Start offset in body.
 */

/**
 * Find every `references/...md` mention in body.
 * @param {string} body
 * @returns {RefLink[]}
 */
export function extractRefLinks(body) {
  if (typeof body !== 'string') return [];
  /** @type {RefLink[]} */
  const out = [];
  REF_LINK_RE.lastIndex = 0;
  let m;
  while ((m = REF_LINK_RE.exec(body)) !== null) {
    const relativePath = `${m[1]}.md`;
    let flatName;
    try {
      flatName = flattenRefPath(relativePath);
    } catch {
      continue; // skip malformed paths silently; renderer will warn separately
    }
    out.push({ match: m[0], relativePath, flatName, index: m.index });
  }
  return out;
}

/**
 * Replace every `references/...md` mention via a mapper function.
 * @param {string} body
 * @param {(link: RefLink) => string} mapper
 * @returns {string}
 */
export function replaceRefLinks(body, mapper) {
  if (typeof body !== 'string') return body;
  REF_LINK_RE.lastIndex = 0;
  return body.replace(REF_LINK_RE, (full, p1) => {
    let flatName;
    try {
      flatName = flattenRefPath(`${p1}.md`);
    } catch {
      return full;
    }
    return mapper({ match: full, relativePath: `${p1}.md`, flatName, index: 0 });
  });
}

/**
 * Inline all reference bodies into a single string, separated by `[See: <name>]` headings.
 * Used when target tool has no separate-file mechanism (rare; Cursor/Kiro prefer split files).
 *
 * Caller is responsible for size limits — this util makes no truncation decisions.
 *
 * @param {string} body
 * @param {import('../types.mjs').ReferenceFile[]} references
 * @returns {string}
 */
export function inlineRefs(body, references) {
  if (typeof body !== 'string') body = '';
  if (!Array.isArray(references) || references.length === 0) return body;
  const parts = [body.trimEnd(), ''];
  for (const ref of references) {
    parts.push('---');
    parts.push(`<!-- [See: ${ref.name}] -->`);
    parts.push('');
    parts.push(ref.body.trimEnd());
    parts.push('');
  }
  return parts.join('\n');
}
