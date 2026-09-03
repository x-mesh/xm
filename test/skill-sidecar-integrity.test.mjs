/**
 * Skill sidecar integrity — every relative path a SKILL.md tells an agent to
 * open must actually ship.
 *
 * Two independent failures produced the same symptom (`/xm:review` running
 * with none of its 11 lenses on a Codex install), and neither was catchable by
 * any existing check:
 *
 *   1. The installer only ever walked `references/`, so `lenses/`,
 *      `strategies/`, `judges/` and every other sidecar was silently dropped
 *      from the install output while the marketplace copy stayed complete.
 *   2. `x-review/SKILL.md` cited three shared references that were never
 *      fanned out into its own `references/` — dangling in EVERY layout,
 *      marketplace copy included.
 *
 * Both are "the document promises a file that isn't there", so both are pinned
 * here: source completeness, and install-output completeness.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = join(REPO, 'xm', 'skills');
const INSTALL_CLI = join(REPO, 'xm', 'lib', 'install', 'install-cli.mjs');

/**
 * Relative sidecar mentions inside a SKILL.md — `references/x.md`,
 * `lenses/{name}.md`, `strategies/debate.md`, …
 *
 * Placeholder segments (`{name}`, `<lens>`, `$ARG`) are templates the agent
 * fills at runtime; they are checked as "the directory must exist and be
 * non-empty" rather than as a literal filename.
 */
const SIDECAR_MENTION = /(?<![\w./-])([a-z][a-z0-9-]*)\/([A-Za-z0-9_{}<>$-]+)\.(md|json|mjs|yaml)(?![\w-])/g;

function skillDirs() {
  return readdirSync(SKILLS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(SKILLS, e.name, 'SKILL.md')))
    .map((e) => e.name);
}

function sidecarMentions(body) {
  const out = [];
  SIDECAR_MENTION.lastIndex = 0;
  let m;
  while ((m = SIDECAR_MENTION.exec(body)) !== null) {
    out.push({ dir: m[1], file: `${m[2]}.${m[3]}`, path: `${m[1]}/${m[2]}.${m[3]}` });
  }
  return out;
}

const isTemplate = (file) => /[{}<>$]/.test(file);

describe('skill sidecar integrity — source tree', () => {
  test('every sidecar path a SKILL.md names exists in that skill', () => {
    /** @type {string[]} */
    const dangling = [];

    for (const skill of skillDirs()) {
      const skillDir = join(SKILLS, skill);
      const body = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');

      for (const mention of sidecarMentions(body)) {
        const dir = join(skillDir, mention.dir);
        // Only judge directories the skill actually owns — a SKILL.md may
        // mention paths belonging to the repo (`lib/foo.mjs`, `test/x.md`).
        if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;

        if (isTemplate(mention.file)) {
          const entries = readdirSync(dir).filter((f) => !f.startsWith('.'));
          if (entries.length === 0) dangling.push(`${skill}: ${mention.path} (directory is empty)`);
          continue;
        }
        if (!existsSync(join(dir, mention.file))) dangling.push(`${skill}: ${mention.path}`);
      }
    }

    expect(dangling).toEqual([]);
  });

  test('x-review ships the lenses and shared references its SKILL.md requires', () => {
    // The exact set the failing Codex session tried to open. These are the CLI
    // identifiers, and promptFor() resolves lenses/<id>.md — so a file whose name
    // does not match the documented id throws `unknown review lens` at run time.
    const reviewDir = join(SKILLS, 'review');
    for (const lens of ['security', 'logic', 'perf', 'tests']) {
      expect(existsSync(join(reviewDir, 'lenses', `${lens}.md`))).toBe(true);
    }
    for (const ref of ['ask-user-question-rule', 'finding-severity', 'trace-recording']) {
      expect(existsSync(join(reviewDir, 'references', `${ref}.md`))).toBe(true);
    }
  });

  test('every lens id documented in x-review SKILL.md resolves to a lens file', () => {
    // review-lifecycle.mjs resolves a lens under the plugin's own tree
    // (SKILL_ROOT = <plugin>/skills/review), so the source is what has to
    // satisfy this. Check the bundle copy alongside it, not instead of it —
    // asserting only against the bundle passes a source-only rename.
    const roots = [join(REPO, 'x-review', 'skills', 'review'), join(SKILLS, 'review')];
    const skill = readFileSync(join(roots[0], 'SKILL.md'), 'utf8');
    // The `list` help block groups ids under "... profiles:" / "... lenses:"
    // headings, one `  <id>   <description>` line each.
    const ids = new Set();
    for (const section of skill.split(/^(?=\S.*(?:profiles|lenses).*:\s*$)/m)) {
      if (!/^\S.*(?:profiles|lenses).*:\s*$/m.test(section.split('\n')[0] ?? '')) continue;
      for (const m of section.split(/\n\s*\n/)[0].matchAll(/^ {2}([a-z][a-z-]*) {2,}\S/gm)) {
        ids.add(m[1]);
      }
    }
    // Pin the count to the lens files themselves: a parser that quietly drops
    // ids can no longer pass, and a new lens has to be documented to ship.
    const lensFiles = readdirSync(join(roots[0], 'lenses')).filter((n) => n.endsWith('.md'));
    expect(ids.size).toBe(lensFiles.length);
    for (const root of roots) {
      const missing = [...ids].filter((id) => !existsSync(join(root, 'lenses', `${id}.md`)));
      expect(missing).toEqual([]);
    }
  });
});

describe('skill sidecar integrity — install output', () => {
  test('a codex install ships every source sidecar, not just references/', () => {
    const root = mkdtempSync(join(tmpdir(), 'xm-sidecar-'));
    try {
      const r = spawnSync('node', [
        INSTALL_CLI, '--target', 'codex',
        '--skills-dir', SKILLS, '--lib-dir', join(REPO, 'xm', 'lib'),
      ], { cwd: root, encoding: 'utf8', timeout: 120000 });
      expect(r.status).toBe(0);

      // review is the regression's namesake: 11 lenses, 6 references.
      const installed = join(root, '.agents', 'skills', 'xm-review');
      expect(readdirSync(join(installed, 'lenses')).sort())
        .toEqual(readdirSync(join(SKILLS, 'review', 'lenses')).sort());
      expect(readdirSync(join(installed, 'references')).sort())
        .toEqual(readdirSync(join(SKILLS, 'review', 'references')).sort());
      expect(readdirSync(join(installed, 'scripts')).sort())
        .toEqual(readdirSync(join(SKILLS, 'review', 'scripts')).sort());

      // And the property that keeps it fixed as skills grow new sidecars:
      // EVERY source file under EVERY skill reaches the install output.
      /** @type {string[]} */
      const missing = [];
      for (const skill of skillDirs()) {
        const stack = [''];
        while (stack.length) {
          const rel = stack.pop();
          for (const entry of readdirSync(join(SKILLS, skill, rel))) {
            if (entry.startsWith('.')) continue;
            const relPath = rel ? `${rel}/${entry}` : entry;
            if (statSync(join(SKILLS, skill, relPath)).isDirectory()) { stack.push(relPath); continue; }
            const target = join(root, '.agents', 'skills', `xm-${skill}`, ...relPath.split('/'));
            if (!existsSync(target)) missing.push(`${skill}/${relPath}`);
          }
        }
      }
      expect(missing).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
