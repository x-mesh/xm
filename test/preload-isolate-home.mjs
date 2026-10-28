// Tests run the xm dispatcher and x-build CLI in temp workspaces. With the developer's HOME,
// every such run registered that workspace in the real ~/.xm/projects.json (about 3,700 dead
// entries had built up). Spawned processes inherit this HOME; Bun's in-process os.homedir()
// ignores it, so in-process imports keep the real home.
import { afterAll } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const realGitConfig = join(homedir(), '.gitconfig');
// Child git keeps the developer's identity and defaults instead of failing to commit.
if (!process.env.GIT_CONFIG_GLOBAL && existsSync(realGitConfig)) process.env.GIT_CONFIG_GLOBAL = realGitConfig;

const isolatedHome = mkdtempSync(join(tmpdir(), 'xm-test-home-'));
process.env.HOME = isolatedHome;
// Bun does not emit process 'exit' to a preload; a global afterAll runs once after every file.
afterAll(() => rmSync(isolatedHome, { recursive: true, force: true }));
