import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// Claude Code resolves /<plugin>:<name> to commands/<name>.md when a skill has
// the same name, and a Skill call for that name returns the command again. A
// wrapper that says "invoke the skill" therefore never loads SKILL.md.
function shadowingWrappers() {
  const roots = readdirSync(REPO).filter((d) => d === 'xm' || d.startsWith('x-'));
  const found = [];
  for (const root of roots) {
    const commands = join(REPO, root, 'commands');
    if (!existsSync(commands)) continue;
    for (const file of readdirSync(commands)) {
      if (!file.endsWith('.md')) continue;
      const name = file.slice(0, -3);
      if (!existsSync(join(REPO, root, 'skills', name, 'SKILL.md'))) continue;
      found.push({ root, name, text: readFileSync(join(commands, file), 'utf8') });
    }
  }
  return found;
}

describe('command wrappers beside a same-name skill', () => {
  const wrappers = shadowingWrappers();

  test('the bundle and the plugin sources are both covered', () => {
    expect(wrappers.filter((w) => w.root === 'xm').length).toBeGreaterThanOrEqual(24);
    expect(wrappers.filter((w) => w.root !== 'xm').length).toBeGreaterThanOrEqual(17);
  });

  test('point at SKILL.md by plugin-root path instead of invoking the skill', () => {
    for (const { root, name, text } of wrappers) {
      const where = `${root}/commands/${name}.md`;
      expect(text, where).toContain(`\${CLAUDE_PLUGIN_ROOT}/skills/${name}/SKILL.md`);
      expect(text, where).not.toMatch(/Invoke the `[\w-]+` skill/);
    }
  });

  test('pre-approve reading the skill directory, which is outside the working directory', () => {
    for (const { root, name, text } of wrappers) {
      const frontmatter = text.split('\n---\n')[0];
      expect(frontmatter, `${root}/commands/${name}.md`).toContain(`Read(/\${CLAUDE_PLUGIN_ROOT}/skills/${name}/**)`);
    }
  });
});
