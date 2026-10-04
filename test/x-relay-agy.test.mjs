import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agySessions } from '../xm/lib/x-relay-agy.mjs';
import { parseArgs } from '../xm/lib/x-relay-cli.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const originalRoot = process.env.XM_RELAY_AGY_DATA_DIR;
const roots = [];
afterEach(() => {
  if (originalRoot === undefined) delete process.env.XM_RELAY_AGY_DATA_DIR;
  else process.env.XM_RELAY_AGY_DATA_DIR = originalRoot;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(cache = {}) {
  const root = mkdtempSync(join(tmpdir(), 'xm-relay-agy-'));
  roots.push(root);
  process.env.XM_RELAY_AGY_DATA_DIR = root;
  mkdirSync(join(root, 'cache'));
  mkdirSync(join(root, 'conversations'));
  writeFileSync(join(root, 'cache', 'last_conversations.json'), JSON.stringify(cache));
  writeFileSync(join(root, 'conversations', `${ID}.db`), '');
  return root;
}

const inventory = (options = {}) => agySessions({ ...options, liveFiles: () => new Map([[ID, [process.pid]]]) });


test('accepts AGY listing and sending through an exact recipient UUID', () => {
  expect(parseArgs(['sessions', '--provider', 'agy']).options['--provider']).toBe('agy');
  expect(parseArgs(['send', '--provider', 'agy', '--session', ID, '--message', 'hello']).command).toBe('send');
  expect(() => parseArgs(['sessions', '--provider', 'unknown'])).toThrow('--provider');
});

test('cache fallback reports partial inventory, ignores missing IDs, and filters by workspace', () => {
  fixture({ '/other': ID, '/repo': ID, '/deleted': OTHER, '/invalid': '--continue' });
  const result = inventory({ matchesProject: cwd => cwd === '/repo' });
  expect(result.partial).toBe(true);
  expect(result.sessions).toHaveLength(1);
  expect(result.sessions[0]).toMatchObject({ session_id: ID, cwd: '/repo', capabilities: { send: false }, live_status: 'running' });
  expect(inventory({ matchesProject: cwd => cwd === '/outside' }).sessions).toEqual([]);
});

test('malformed cache is an unavailable inventory, not an empty successful list', () => {
  const root = fixture();
  writeFileSync(join(root, 'cache', 'last_conversations.json'), '{broken');
  expect(() => inventory()).toThrow('inventory unavailable');
});

test.if(spawnSync('sqlite3', ['--version']).status === 0)('summaries exclude killed, nested, and IDE conversations and select the matching workspace', () => {
  const root = fixture();
  const database = join(root, 'conversation_summaries.db');
  const created = spawnSync('sqlite3', [database], { encoding: 'utf8', input: `
CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT, workspace_uris TEXT, status TEXT, last_modified_time TEXT, killed INTEGER, nesting_depth INTEGER, parent_conversation_id TEXT, app_data_dir TEXT);
INSERT INTO conversation_summaries VALUES ('${ID}', 'saved conversation', '["file:///other","file:///repo%20space"]', 'CASCADE_RUN_STATUS_IDLE', '2026-10-04', 0, 0, '', 'antigravity-cli');
INSERT INTO conversation_summaries VALUES ('${OTHER}', 'nested', '[]', '', '', 0, 1, '${ID}', 'antigravity-cli');
INSERT INTO conversation_summaries VALUES ('${OTHER}', 'killed', '[]', '', '', 1, 0, '', 'antigravity-cli');
INSERT INTO conversation_summaries VALUES ('${OTHER}', 'IDE', '[]', '', '', 0, 0, '', 'antigravity');
` });
  expect(created.status).toBe(0);
  writeFileSync(join(root, 'conversations', `${OTHER}.db`), '');
  const result = inventory({ matchesProject: cwd => cwd === '/repo space' });
  expect(result.partial).toBe(false);
  expect(result.sessions).toHaveLength(1);
  expect(result.sessions[0]).toMatchObject({ session_id: ID, cwd: '/repo space', name: 'saved conversation' });
});


test('stale presence files and saved metadata do not appear without an active owner', () => {
  const root = fixture({ '/repo': ID });
  mkdirSync(join(root, 'presence'));
  writeFileSync(join(root, 'presence', `${ID}.lock`), '');
  expect(agySessions().sessions).toEqual([]);
});
