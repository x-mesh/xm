// @ts-check
/**
 * scan.mjs — SKILL.md → SkillIR[] (PRD §5 stage 1).
 *
 * Reads xm/skills/<plug>/SKILL.md (and optional references/ tree),
 * parses minimal YAML frontmatter, extracts CLI invocations, validates
 * cliCalls[].file existence (critic B2), and emits typed SkillIR records.
 *
 * Purposefully minimal: no external YAML parser. Frontmatter we ship
 * follows a tight subset (string scalars + a single list for allowed-tools).
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve as resolvePath, join, relative as relPath } from 'node:path';
import { createHash } from 'node:crypto';
import { validateName } from './security.mjs';
import { MAX_REF_DEPTH } from './types.mjs';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const CLI_TOKEN_RE = /\$\{?CLAUDE_PLUGIN_ROOT\}?\/lib\/([A-Za-z0-9_./-]+\.mjs)/g;

/**
 * Parse the YAML-like frontmatter we actually use:
 *   name: foo
 *   description: "..."
 *   allowed-tools:
 *     - AskUserQuestion
 *     - Bash
 *
 * @param {string} block  Frontmatter body (between the `---` fences).
 * @returns {{ name?: string, description?: string, allowedTools?: string[], raw: Record<string,string> }}
 */
function parseFrontmatter(block) {
  /** @type {Record<string,string>} */
  const raw = {};
  /** @type {string[]} */
  const allowedTools = [];
  let currentList = null;
  for (const line of block.split(/\r?\n/)) {
    if (line.length === 0) continue;
    if (currentList) {
      const itemMatch = line.match(/^\s+-\s*(.+)$/);
      if (itemMatch) {
        if (currentList === 'allowedTools') allowedTools.push(itemMatch[1].trim());
        continue;
      }
      currentList = null;
    }
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2];
    if (key === 'allowed-tools' && (value === '' || value.trim() === '')) {
      currentList = 'allowedTools';
      continue;
    }
    if (value.trim() === '|' || value.trim() === '>') {
      process.stderr.write(`WARN scan: multiline YAML not supported (${key}: ${value.trim()}) — only the first line is captured.\n`);
    }
    raw[key] = stripQuotes(value);
  }
  return {
    name: raw['name'],
    description: raw['description'],
    allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
    raw,
  };
}

/**
 * @param {string} v
 * @returns {string}
 */
function stripQuotes(v) {
  const trimmed = v.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Walk a `references/` tree up to MAX_REF_DEPTH.
 * @param {string} pluginDir
 * @returns {import('./types.mjs').ReferenceFile[]}
 */
function readReferences(pluginDir) {
  const refsDir = join(pluginDir, 'references');
  if (!existsSync(refsDir)) return [];
  /** @type {import('./types.mjs').ReferenceFile[]} */
  const out = [];
  /** @param {string} dir @param {number} depth */
  function walk(dir, depth) {
    if (depth > MAX_REF_DEPTH) {
      throw new Error(`references depth exceeds ${MAX_REF_DEPTH}: ${relPath(pluginDir, dir)}`);
    }
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      const st = statSync(abs);
      if (st.isDirectory()) {
        walk(abs, depth + 1);
      } else if (st.isFile() && entry.toLowerCase().endsWith('.md')) {
        const relativePath = relPath(pluginDir, abs).replace(/\\/g, '/');
        const body = readFileSync(abs, 'utf8');
        const name = relativePath.replace(/^references\//, '').replace(/\.md$/i, '');
        out.push({
          name,
          relativePath,
          body,
          bytes: Buffer.byteLength(body, 'utf8'),
          depth,
        });
      }
    }
  }
  walk(refsDir, 0);
  return out;
}

/**
 * Resolve an `xm/lib/<file>.mjs` reference relative to a plugin root.
 * Plugin SKILL.md typically lives at <repo>/xm/skills/<plug>/SKILL.md, and
 * the bundled CLI lives at <repo>/xm/lib/. We pass the explicit libDir so
 * tests can point elsewhere.
 *
 * @param {string} libDir   Absolute path to xm/lib/.
 * @param {string} relativeFile  e.g. "x-build-cli.mjs"
 * @returns {'present'|'missing'}
 */
function probeLibFile(libDir, relativeFile) {
  const abs = resolvePath(libDir, relativeFile);
  return existsSync(abs) ? 'present' : 'missing';
}

/**
 * Extract every `${CLAUDE_PLUGIN_ROOT}/lib/<file>.mjs` mention.
 * Deduplicates by sourcePath. Each call is validated against libDir.
 *
 * @param {string} body
 * @param {string} pluginName
 * @param {string} libDir
 * @returns {import('./types.mjs').CliCall[]}
 */
function extractCliCalls(body, pluginName, libDir) {
  /** @type {Map<string, import('./types.mjs').CliCall>} */
  const seen = new Map();
  CLI_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = CLI_TOKEN_RE.exec(body)) !== null) {
    const relativeFile = m[1];
    if (seen.has(relativeFile)) continue;
    seen.set(relativeFile, {
      command: m[0],
      plugin: pluginName,
      args: [],
      file: probeLibFile(libDir, relativeFile),
      sourcePath: `xm/lib/${relativeFile}`,
    });
  }
  return Array.from(seen.values());
}

/**
 * Build a SkillIR from a single plugin directory.
 *
 * @param {Object} args
 * @param {string} args.pluginName     Directory basename, must pass validateName.
 * @param {string} args.skillsDir      e.g. "<repo>/xm/skills"
 * @param {string} args.libDir         e.g. "<repo>/xm/lib"
 * @returns {import('./types.mjs').SkillIR}
 */
export function readSkill({ pluginName, skillsDir, libDir }) {
  validateName(pluginName, 'plugin');
  const pluginDir = join(skillsDir, pluginName);
  const skillFile = join(pluginDir, 'SKILL.md');
  if (!existsSync(skillFile)) {
    throw new Error(`SKILL.md not found at ${skillFile}`);
  }
  const raw = readFileSync(skillFile, 'utf8');

  let frontmatter = { name: undefined, description: undefined, allowedTools: undefined, raw: {} };
  let body = raw;
  const fmMatch = raw.match(FRONTMATTER_RE);
  if (fmMatch) {
    frontmatter = /** @type {any} */ (parseFrontmatter(fmMatch[1]));
    body = raw.slice(fmMatch[0].length);
  }

  const skillName = validateName(frontmatter.name ?? pluginName, 'skill');
  const description = frontmatter.description ?? '';

  const references = readReferences(pluginDir);
  const cliCalls = extractCliCalls(body, pluginName, libDir);

  const lines = body.split(/\r?\n/).length;
  const bytes = Buffer.byteLength(raw, 'utf8');
  const checksum = createHash('sha256').update(raw, 'utf8').digest('hex');

  return {
    pluginName,
    skillName,
    description,
    body,
    references,
    cliCalls,
    hooks: [],
    size: { lines, bytes },
    checksum,
    allowedTools: frontmatter.allowedTools,
    sourcePath: skillFile,
  };
}

/**
 * Scan all plugins in a skills directory.
 *
 * @param {Object} args
 * @param {string} args.skillsDir
 * @param {string} args.libDir
 * @param {string[]} [args.only]  Optional whitelist of plugin names.
 * @returns {import('./types.mjs').SkillIR[]}
 */
export function scanAll({ skillsDir, libDir, only }) {
  if (!existsSync(skillsDir)) {
    throw new Error(`skillsDir not found: ${skillsDir}`);
  }
  const entries = readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => /^[a-z][a-z0-9-]{0,30}$/.test(n))
    .sort();
  const targets = only && only.length > 0 ? entries.filter((n) => only.includes(n)) : entries;

  /** @type {import('./types.mjs').SkillIR[]} */
  const out = [];
  for (const name of targets) {
    const skillFile = join(skillsDir, name, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    out.push(readSkill({ pluginName: name, skillsDir, libDir }));
  }
  return out;
}

/**
 * Quick summary of which CLI calls are missing on disk (critic B2 ghost-ref guard).
 * @param {import('./types.mjs').SkillIR[]} skills
 * @returns {{ plugin: string, sourcePath: string }[]}
 */
export function listMissingCliRefs(skills) {
  const out = [];
  for (const s of skills) {
    for (const c of s.cliCalls) {
      if (c.file === 'missing') {
        out.push({ plugin: s.pluginName, sourcePath: c.sourcePath });
      }
    }
  }
  return out;
}
