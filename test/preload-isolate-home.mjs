// Tests run the xm dispatcher and x-build CLI in temp workspaces. With the developer's HOME,
// every such run registered that workspace in the real ~/.xm/projects.json (about 3,700 dead
// entries had built up). Only children spawned with `env: { ...process.env }` see this HOME:
// Bun gives a child with no `env` option the launch environment, and its in-process
// os.homedir() ignores HOME, so in-process imports keep the real home.
import { afterAll } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const isolatedHome = mkdtempSync(join(tmpdir(), 'xm-test-home-'));

// git finds its global config through HOME ($XDG_CONFIG_HOME/git/config, then ~/.gitconfig).
// One generated file includes whichever real ones exist, in git's own order, so child git keeps
// the developer's identity and defaults instead of failing to commit.
if (!process.env.GIT_CONFIG_GLOBAL) {
  const realConfigs = [
    join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'git', 'config'),
    join(homedir(), '.gitconfig'),
  ].filter((path) => existsSync(path));
  const generated = join(isolatedHome, '.gitconfig');
  writeFileSync(generated, realConfigs.map((path) => `[include]\n\tpath = ${JSON.stringify(path)}\n`).join(''));
  process.env.GIT_CONFIG_GLOBAL = generated;
}

process.env.HOME = isolatedHome;
// Bun does not emit process 'exit' to a preload; a global afterAll runs once after every file.
afterAll(() => rmSync(isolatedHome, { recursive: true, force: true }));
