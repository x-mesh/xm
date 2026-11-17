import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = readFileSync(join(ROOT, 'xm', 'skills', 'land', 'SKILL.md'), 'utf8');
const FRONTMATTER = SKILL.slice(0, SKILL.indexOf('\n---', 4));

describe('land skill contract', () => {
  test('frontmatter names the skill and sets no model or tool list', () => {
    expect(FRONTMATTER).toMatch(/^name: land$/m);
    expect(FRONTMATTER).toMatch(/^description: .+/m);
    expect(FRONTMATTER).not.toMatch(/^model:/m);
    expect(FRONTMATTER).not.toMatch(/allowed-tools/);
  });

  test('stays under 500 lines and uses the tag form', () => {
    expect(SKILL.split('\n').length).toBeLessThan(500);
    for (const tag of ['<Purpose>', '<Use_When>', '<Do_Not_Use_When>']) expect(SKILL).toContain(tag);
    expect(SKILL).toContain('## Verification');
    expect(SKILL).toContain('## Common Rationalizations');
  });

  test('carries the dispatcher invocation block', () => {
    expect(SKILL).toContain('Call `xm pr land` directly');
    expect(SKILL).toContain('x-build-cli.mjs');
  });

  test('documents arguments and defaults', () => {
    expect(SKILL).toContain('/xm:land [<pr>] [--review reviewer|here|none] [--merge here|none] [--check <name>]');
    expect(SKILL).toMatch(/\| `--review` \| `reviewer` \|/);
    expect(SKILL).toMatch(/\| `--merge` \| `here` \|/);
    expect(SKILL).toMatch(/\| `--check` \| `reviewer` \|/);
  });

  test('waits with the dry-run command and a 900 second default', () => {
    expect(SKILL).toContain('xm pr land <pr> --wait --timeout 900 --require-check <name> --dry-run --json');
    expect(SKILL).toContain('`900` seconds is the default');
  });

  test('reads every comment and gates the fix loop on the marker sha', () => {
    expect(SKILL).toContain('gh api repos/<owner>/<repo>/pulls/<pr>/comments --paginate');
    expect(SKILL).toContain('Do not filter comments by commit');
    expect(SKILL).toContain('reviewer-agent:v1');
    expect(SKILL).toMatch(/marker `sha` equals the current head/);
    expect(SKILL).toContain('Report the check `description` and stop');
  });

  test('sorts items by group', () => {
    expect(SKILL).toContain('Fix every one');
    expect(SKILL).toContain('/reviewer accept L<n> <reason>');
    expect(SKILL).toMatch(/참고[^\n]*Leave/);
  });

  test('limits fix pushes and stops at round 3 or on churn', () => {
    expect(SKILL).toContain('**Two fix pushes done**');
    expect(SKILL).toContain('Never push a third fix on your own');
    expect(SKILL).toMatch(/`round` is 3 or more/);
    expect(SKILL).toContain('More than half of the new items');
    expect(SKILL).toContain('AskUserQuestion');
  });

  test('never accepts a blocking item without AskUserQuestion', () => {
    expect(SKILL).toContain('Never accept a blocking item on your own');
    expect(SKILL).toMatch(/Ask with the item, its severity, and your reason/);
  });

  test('lands with the required check and --yes', () => {
    expect(SKILL).toContain('xm pr land <pr> --wait --require-check <name> --yes');
    expect(SKILL).toContain('xm pr land <pr> --wait --require-review --yes');
    expect(SKILL).toMatch(/`--merge none`: stop once the review is clean/);
  });

  test('reports a missing or failed check and never merges around it', () => {
    expect(SKILL).toContain('no reviewer check appeared');
    expect(SKILL).toContain('with the timeout used');
    expect(SKILL).toContain('is never merged around');
    expect(SKILL).toContain('only when the user chose it');
  });

  test('commits and pushes through git-kit and branches on state', () => {
    expect(SKILL).toContain('GK_AGENT=1 git-kit commit -m "<message>" -- <files>');
    expect(SKILL).toContain('GK_AGENT=1 git-kit push');
    expect(SKILL).toContain('JSON `state`');
  });

  // Review item L1 on #104: a fix committed in the wrong checkout lands on a branch the user did not name.
  test('fixes only when the checkout is the PR head branch at the PR head commit', () => {
    expect(SKILL).toContain('**Checkout gate.**');
    expect(SKILL).toContain('`git branch --show-current` equals `headRefName`');
    expect(SKILL).toContain('`isCrossRepository` is `false`');
    expect(SKILL).toContain('`git rev-parse HEAD` equals `headRefOid`');
    expect(SKILL).toContain('Never switch branches or push from another checkout on your own');
  });

  // Review item L2 on #104: --wait stops when any check fails, before the required check settles.
  test('handles a required check that is still pending or missing when another check failed', () => {
    expect(SKILL).toContain('| `pending` or `missing` before the timeout |');
    expect(SKILL).toContain('`--wait` stops as soon as any check fails');
    expect(SKILL).toMatch(/Read `checks\.failed`/);
  });

  test('has at least five rationalization rows', () => {
    const section = SKILL.split('## Common Rationalizations')[1].split('\n## ')[0];
    const rows = section.split('\n').filter((l) => l.startsWith('| "'));
    expect(rows.length).toBeGreaterThanOrEqual(5);
  });
});
