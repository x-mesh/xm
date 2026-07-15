// @ts-check
/**
 * SkillIR — Intermediate Representation between SKILL.md sources and per-tool renderers.
 *
 * Source: xm/skills/<plug>/SKILL.md (+ references/*.md)
 * Sinks: cursor / codex / kiro / antigravity / opencode renderers
 *
 * Frozen interface (PRD v2.1 §5.1, ADR-001).
 * Minor change policy: new optional fields allowed; renames/removals forbidden until v3.
 */

/**
 * @typedef {Object} ReferenceFile
 * @property {string} name           Logical name (e.g. "phases-plan" for build/references/phases/plan.md).
 * @property {string} relativePath   Path relative to plugin root (e.g. "references/phases/plan.md").
 * @property {string} body           File contents (UTF-8).
 * @property {number} bytes
 * @property {number} depth          0 = direct child of references/, 1 = one nested dir, etc. Max 2 (PRD Q6).
 */

/**
 * @typedef {Object} CliCall
 * @property {string} command        Raw command string as it appears in SKILL.md.
 * @property {string} plugin         Resolved plugin name (e.g. "x-build").
 * @property {string[]} args         Argv-style tokens after the script path.
 * @property {'present'|'missing'} file  Whether the referenced .mjs exists in xm/lib/. Renderer warns on 'missing' (critic B2).
 * @property {string} sourcePath     Path the call resolves to (e.g. "xm/lib/x-build-cli.mjs").
 */

/**
 * @typedef {Object} HookSpec
 * @property {string} event          PreToolUse / PostToolUse / Stop / etc.
 * @property {string} command        Validated against allowlist (R-SEC-01).
 * @property {string} [matcher]      Optional tool matcher (Cursor regex / Kiro tool name).
 * @property {string} sourcePath     Path to original .claude/hooks/*.mjs.
 */

/**
 * @typedef {Object} SkillSize
 * @property {number} lines
 * @property {number} bytes
 */

/**
 * @typedef {Object} SkillIR
 * @property {string} pluginName     Validated against /^[a-z][a-z0-9-]{0,30}$/ (R-SEC-04).
 * @property {string} skillName      Same regex as pluginName.
 * @property {string} description    One-sentence trigger (used for Cursor agent-requested, Kiro auto inclusion).
 * @property {string} body           Original SKILL.md body (frontmatter stripped).
 * @property {ReferenceFile[]} references
 * @property {CliCall[]} cliCalls
 * @property {HookSpec[]} hooks
 * @property {SkillSize} size
 * @property {string} checksum       SHA-256 hex of body+frontmatter (R-SEC-02).
 * @property {string[]} [allowedTools]  Optional frontmatter `allowed-tools`.
 * @property {string} sourcePath     Absolute path to source SKILL.md (renderers must NOT leak this).
 */

/**
 * @typedef {'cursor'|'codex'|'kiro'|'antigravity'|'opencode'} TargetTool
 */

/**
 * @typedef {Object} RenderOutput
 * @property {string} relativePath   Path relative to install root (e.g. ".cursor/rules/xm-build.mdc").
 * @property {string} content
 * @property {0o600|0o644} [mode]   File mode: 0o600 for --global, 0o644 for --local (R-SEC-08). Directory modes (0o700/0o755) are managed by merge.mjs/atomicWrite, not by renderers.
 * @property {'overwrite'|'merge-marker'|'hook-merge'|'marketplace-merge'} kind  marker = AGENTS.md style merge; hook-merge manages shared Codex hooks; marketplace-merge manages only the xm plugin entry.
 * @property {string} [marketplaceName] Seed name when creating a new marketplace file.
 */

/**
 * @typedef {Object} RenderContext
 * @property {TargetTool} target
 * @property {'global'|'local'} scope
 * @property {string} installRoot    Absolute base path (~/.cursor/ or <repo>/.cursor/ etc.).
 * @property {string} libPath        Bundled xm/lib/ location (e.g. "$HOME/.cursor/xm/lib").
 * @property {boolean} dryRun
 * @property {boolean} allowUnverified
 * @property {string} [pluginVersion] xm plugin semver when a target packages a native plugin.
 */

/**
 * Renderer contract. All four target renderers MUST implement this.
 * @typedef {(skills: SkillIR[], ctx: RenderContext) => RenderOutput[]} Renderer
 */

// Manifest types live in `manifest.mjs` (`Manifest`, `ManifestEntry`).
// Import them via `import('./manifest.mjs').Manifest` when annotating manifest
// payloads. Earlier drafts duplicated typedefs here, but the in-memory shape
// produced by `buildManifest()` (kind, schemaVersion, prdVersion, installRoot,
// nonce, ...) was the authoritative one — keep a single source of truth in
// manifest.mjs to avoid the docs-vs-runtime drift the docs lens flagged (H11).

export const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
export const SKILL_NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
export const TARGET_TOOLS = /** @type {const} */ (['cursor', 'codex', 'kiro', 'antigravity', 'opencode']);

/**
 * Per-target home/install directory name. Single source of truth — every
 * module that needs to translate a `TargetTool` to its directory must import
 * this map (architect H7 finding: previously duplicated in 4 files).
 *
 * @type {Readonly<Record<import('./types.mjs').TargetTool, string>>}
 */
export const TARGET_DIR = Object.freeze({
  cursor: '.cursor',
  codex: '.codex',
  kiro: '.kiro',
  antigravity: '.gemini',
  opencode: '.opencode',
});

/**
 * Per-target user-global directory. Most tools use the same directory name
 * globally and locally; OpenCode follows the XDG-style `~/.config/opencode`.
 *
 * @type {Readonly<Record<import('./types.mjs').TargetTool, string>>}
 */
export const TARGET_GLOBAL_DIR = Object.freeze({
  ...TARGET_DIR,
  opencode: '.config/opencode',
});

/**
 * @param {import('./types.mjs').TargetTool} target
 * @param {'global'|'local'} scope
 * @returns {string}
 */
export function targetDirFor(target, scope) {
  return scope === 'global' ? TARGET_GLOBAL_DIR[target] : TARGET_DIR[target];
}
export const MARKER_BEGIN = '<!-- xm:BEGIN v2 -->';
export const MARKER_END = '<!-- xm:END -->';
export const LOCK_TTL_MS = 60_000;
export const MAX_REF_DEPTH = 2;
export const MAX_BAK_ROTATION = 3;
export const CODEX_AGENTS_MAX_BYTES = 16 * 1024;        // 16 KiB index cap (PRD §5.2, 32 KiB hard limit / 50% headroom)
export const CURSOR_MDC_MAX_LINES = 500;
/**
 * Best-effort secret-pattern detector. Matches `key = "<secret>"` only when
 * the value looks like a real credential (≥ 20 chars of base64/hex), not a
 * variable reference (`$API_KEY`, `${API_KEY}`) or placeholder
 * (`<your-key>`, `your_secret_here`). False positives on shell examples in
 * docstrings would block legitimate installs (R-SEC-11).
 */
export const SECRET_PATTERNS = [
  /\bapi[_-]?key\b\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{20,}["']?/i,
  /\bsecret\b\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{20,}["']?/i,
  /\btoken\b\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{20,}["']?/i,
  /\bpassword\b\s*[:=]\s*["']?[A-Za-z0-9+/=_!@#$%^&*-]{8,}["']?/i,
];
export const SHELL_METACHARS_RE = /[;|&`$(){}><\n]/;
export const PRD_VERSION = 'v2.1';

export {};
