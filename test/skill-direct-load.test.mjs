import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ROOTS = readdirSync(REPO).filter((d) => d === 'xm' || d.startsWith('x-'));
const READ_OWN_DIR = 'Read(/${CLAUDE_SKILL_DIR}/**)';

function skills() {
  const found = [];
  for (const root of PLUGIN_ROOTS) {
    const skillsDir = join(REPO, root, 'skills');
    if (!existsSync(skillsDir)) continue;
    for (const name of readdirSync(skillsDir)) {
      const dir = join(skillsDir, name);
      const file = join(dir, 'SKILL.md');
      if (!existsSync(file)) continue;
      const text = readFileSync(file, 'utf8');
      const end = text.indexOf('\n---', 4);
      found.push({ where: `${root}/skills/${name}/SKILL.md`, root, name, dir, frontmatter: text.slice(0, end), body: text.slice(end) });
    }
  }
  return found;
}

function shipsOtherMarkdown(dir) {
  return readdirSync(dir, { recursive: true }).some((rel) => rel.endsWith('.md') && rel !== 'SKILL.md');
}

// Claude Code loads skills/<name>/SKILL.md itself for /<plugin>:<name>: the
// body arrives with the arguments, and it is attached again after compaction.
describe('plugin skills load directly', () => {
  const all = skills();

  test('the bundle and the plugin sources are both covered', () => {
    expect(all.filter((s) => s.root === 'xm').length).toBeGreaterThanOrEqual(31);
    expect(all.filter((s) => s.root !== 'xm').length).toBeGreaterThanOrEqual(18);
  });

  // A command named like a skill wins /<plugin>:<name>, and a Skill call for
  // that name returns the command again, so SKILL.md never loads.
  test('no command shares a name with a skill in the same plugin', () => {
    for (const root of PLUGIN_ROOTS) {
      const commands = join(REPO, root, 'commands');
      if (!existsSync(commands)) continue;
      for (const file of readdirSync(commands)) {
        if (!file.endsWith('.md')) continue;
        const shadowed = join(REPO, root, 'skills', file.slice(0, -3), 'SKILL.md');
        expect(existsSync(shadowed), `${root}/commands/${file} shadows a skill`).toBe(false);
      }
    }
  });

  // The plugin directory is outside the working directory, so the default
  // permission mode denies a read of references/ unless the skill approves it.
  test('a skill that ships other Markdown files pre-approves reading its own directory', () => {
    for (const { where, dir, frontmatter } of all) {
      if (!shipsOtherMarkdown(dir)) continue;
      const approved = frontmatter.includes(READ_OWN_DIR) || /^\s+- Read$/m.test(frontmatter);
      expect(approved, `${where} needs allowed-tools: ${READ_OWN_DIR}`).toBe(true);
    }
  });

  // ship, wt and batch start xm:write through the Skill tool, and a skill that
  // lists allowed-tools needs approval there. So write keeps its README rules
  // in SKILL.md instead of a sibling file that would need the read rule.
  test('xm:write lists no allowed-tools and ships no sibling Markdown', () => {
    const write = all.find((s) => s.root === 'xm' && s.name === 'write');
    expect(write.frontmatter).not.toContain('allowed-tools');
    expect(shipsOtherMarkdown(write.dir)).toBe(false);
    expect(write.body).toContain('\n## README mode\n');
  });

  // A direct load replaces $0, $1, ... with positional arguments ("$0.42"
  // became "<first argument>.42") and pastes the user's text over $ARGUMENTS.
  test('no skill body holds a positional placeholder or a shell-quoted $ARGUMENTS', () => {
    for (const { where, body } of all) {
      expect(body, `${where}: write a dollar amount or a shell parameter without "$<digit>"`).not.toMatch(/(?<!\\)\$\d/);
      expect(body, `${where}: name the argument in the snippet and tell the model how to quote it`).not.toContain('"$ARGUMENTS"');
    }
  });
});
