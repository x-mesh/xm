import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../xm/lib/x-relay-cli.mjs', import.meta.url));
const ID = '11111111-1111-4111-8111-111111111111';
function withFixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'relay-agy-api-'));
  try {
    const data = join(root, 'agy');
    for (const dir of ['cache', 'conversations', 'presence']) mkdirSync(join(data, dir), { recursive: true });
    writeFileSync(join(data, 'cache', 'last_conversations.json'), JSON.stringify({ [root]: ID }));
    writeFileSync(join(data, 'conversations', `${ID}.db`), '');
    writeFileSync(join(data, 'presence', `${ID}.lock`), '');
    const bins = join(root, 'bin');
    mkdirSync(bins);
    const capture = join(root, 'send.json');
    const scripts = {
      lsof: `process.stdout.write(${JSON.stringify(`p${process.pid}\ncagy\nf3\nn${join(realpathSync(data), 'presence', `${ID}.lock`)}\n`)});`,
      ps: `process.stdout.write('${process.pid} agy agy\\n');`,
      agentapi: `import {writeFileSync} from 'node:fs';
const args=process.argv.slice(2);
if(process.env.FAKE_API_ERROR){console.log(JSON.stringify({error:process.env.FAKE_API_ERROR}));process.exit(0);}
if(args[0]==='get-conversation-metadata') console.log(JSON.stringify({response:{conversationMetadata:{metadata:process.env.FAKE_METADATA_MISSING?null:{conversationId:process.env.FAKE_WRONG_ID||args[1]}}}}));
else if(args[0]==='send-message'){writeFileSync(${JSON.stringify(capture)},JSON.stringify(args));console.log(JSON.stringify({response:{sendMessage:{recipientId:args[1],content:args[2]}}}));}
else process.exit(2);`,
    };
    for (const [name, source] of Object.entries(scripts)) { writeFileSync(join(bins, name), '#!/usr/bin/env node\n' + source); chmodSync(join(bins, name), 0o755); }
    const run = (args, env = {}) => {
      const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, CODEX_THREAD_ID: '', ANTIGRAVITY_CONVERSATION_ID: '', XM_RELAY_AGY_DATA_DIR: data, XM_RELAY_AGY_AGENTAPI_BIN: join(bins, 'agentapi'), ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:12345', PATH: bins + ':' + process.env.PATH, ...env } });
      return { status: result.status, output: JSON.parse(result.status === 0 ? result.stdout : result.stderr) };
    };
    fn({ run, capture });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('AGY submits exact literal text through agentapi, without starting or resuming AGY', () => withFixture(({ run, capture }) => {
  const message = 'literal $HOME `whoami`\n--hyphen-leading';
  const result = run(['send', '--provider', 'agy', '--session', ID, '--message=' + message]);
  expect(result.status).toBe(0);
  expect(result.output).toMatchObject({ provider: 'agy', state: 'submitted', session_id: ID });
  const submitted = JSON.parse(readFileSync(capture, 'utf8'));
  expect(submitted.slice(0, 2)).toEqual(['send-message', ID]);
  expect(submitted[2]).toEndWith(message);
  expect(JSON.parse(submitted[2].split('\n')[1])).toMatchObject({ sender: null, request_id: result.output.request_id });
}));

test('AGY rejects exit-zero API errors, missing metadata, and wrong recipients without submitting', () => withFixture(({ run, capture }) => {
  for (const env of [{ FAKE_API_ERROR: 'receiver refused' }, { FAKE_METADATA_MISSING: '1' }, { FAKE_WRONG_ID: '22222222-2222-4222-8222-222222222222' }]) {
    const result = run(['send', '--provider', 'agy', '--session', ID, '--message', 'hello'], env);
    expect(result.status).toBe(1);
    expect(result.output.ok).toBe(false);
    expect(existsSync(capture)).toBe(false);
  }
}));

test('AGY refuses absent or non-local backend context without falling back to print/resume', () => withFixture(({ run, capture }) => {
  for (const address of ['', 'example.com:1234', '127.0.0.1:65536']) {
    const result = run(['send', '--provider', 'agy', '--session', ID, '--message', 'hello'], { ANTIGRAVITY_LS_ADDRESS: address });
    expect(result.status).toBe(1);
    expect(existsSync(capture)).toBe(false);
  }
}));
