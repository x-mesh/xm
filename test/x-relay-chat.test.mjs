import { afterEach, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatCandidates, runChat, createProjectNameResolver, startSessionSpinner } from '../xm/lib/x-relay-chat.mjs';
import { parseArgs } from '../xm/lib/x-relay-cli.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const inventory = id => ({ sessions: [{ session_id: id, name: id === ID ? 'Alpha' : 'Beta', cwd: '/repo' }] });
function context(overrides = {}) {
  return { listProvider: async provider => provider === 'claude' ? inventory(ID) : { sessions: [] }, registryProject: () => ({}), report: () => {}, ...overrides };
}
async function withTTY(fn) {
  const descriptors = [process.stdin, process.stdout].map(stream => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
  for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
  try { return await fn(); }
  finally { [process.stdin, process.stdout].forEach((stream, index) => descriptors[index] ? Object.defineProperty(stream, 'isTTY', descriptors[index]) : delete stream.isTTY); }
}
function ui(choices, messages = []) {
  const specs = [];
  return { specs, startSpinner: () => () => {}, createRL: () => ({ close() {} }), menuSelect: async (_, spec) => { specs.push(spec); return choices.shift() || 'q'; }, ask: async () => messages.shift() || '/quit' };
}

test('initial lookup starts and clears the spinner before showing the picker', async () => withTTY(async () => {
  const events = [];
  const picker = ui(['q']);
  picker.startSpinner = () => { events.push('start'); return () => events.push('stop'); };
  picker.menuSelect = async () => { events.push('menu'); return 'q'; };
  await runChat({ '--provider': 'claude' }, context({ listProvider: async () => { events.push('lookup'); return inventory(ID); } }), picker);
  expect(events).toEqual(['start', 'lookup', 'stop', 'menu']);
}));

test('spinner clears its timer and terminal line and stays silent outside a TTY', async () => {
  const writes = [];
  const stop = startSessionSpinner({ isTTY: true, columns: 80, write: value => writes.push(value) });
  await new Promise(resolve => setTimeout(resolve, 95));
  stop();
  const count = writes.length;
  stop();
  await new Promise(resolve => setTimeout(resolve, 95));
  expect(writes.length).toBe(count);
  expect(writes[0]).toContain('세션 조회 중');
  expect(writes[1]).not.toBe(writes[0]);
  expect(writes.at(-1)).toBe('\r\x1b[2K');
  startSessionSpinner({ isTTY: false, write: () => { throw new Error('unexpected output'); } })();
});

test('failed initial inventory stops the spinner and closes terminal input', async () => withTTY(async () => {
  const events = [];
  const picker = ui(['q']);
  picker.startSpinner = () => () => events.push('stop');
  picker.createRL = () => ({ close: () => events.push('close') });
  await expect(runChat({ '--provider': 'claude' }, context({ listProvider: async () => ({ sessions: null }) }), picker)).rejects.toThrow();
  expect(events).toEqual(['stop', 'close']);
}));

test('directory is the primary label and a configured project name is included', async () => withTTY(async () => {
  const picker = ui(['q']);
  await runChat({}, context({ projectNameFor: () => 'X Mesh Toolkit', listProvider: async provider => provider === 'claude' ? { sessions: [{ ...inventory(ID).sessions[0], cwd: '/work/x-kit' }] } : { sessions: [] } }), picker);
  expect(picker.specs[0].options[0].label).toBe('claude  x-kit (X Mesh Toolkit)');
  expect(picker.specs[0].options[0].hint).toContain('Alpha');
}));

test('project lookup uses the canonical checkout, caches each cwd, and ignores archived or ambiguous entries', () => {
  let calls = 0;
  const lookup = createProjectNameResolver([{ path: '/repo', name: 'Configured' }, { path: '/repo', name: 'Old', archived: true }], () => { calls++; return '/repo'; });
  expect(lookup('/worktree')).toBe('Configured');
  expect(lookup('/worktree')).toBe('Configured');
  expect(calls).toBe(1);
  expect(createProjectNameResolver([{ path: '/repo', name: 'One' }, { path: '/repo', name: 'Two' }], () => '/repo')('/worktree')).toBeNull();
} );

test('chat selects recipients rather than accepting a native session to attach', () => {
  expect(parseArgs([]).command).toBe('chat');
  expect(parseArgs(['chat', '--project', 'target', '--provider', 'claude']).options['--provider']).toBe('claude');
  expect(() => parseArgs(['chat', '--thread', ID])).toThrow('interactively');
  const cli = fileURLToPath(new URL('../xm/lib/x-relay-cli.mjs', import.meta.url));
  const result = spawnSync('node', [cli, 'chat'], { encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stderr).error).toContain('interactive terminal');
});

test('lists exact Claude session UUIDs, keeps unavailable AGY visible, and isolates provider failures', async () => {
  const snapshot = await chatCandidates(context({ listProvider: async provider => {
    if (provider === 'codex') throw new Error('daemon unavailable');
    if (provider === 'agy') return { sessions: [{ session_id: OTHER, cwd: '/repo', live_status: 'running', capabilities: { send: false }, unavailable_reason: 'backend missing' }] };
    return inventory(ID);
  } }));
  expect(snapshot.candidates.map(row => [row.provider, row.id, row.sendable])).toEqual([['claude', ID, true], ['agy', OTHER, false]]);
  expect(snapshot.notes[0]).toContain('daemon unavailable');
});

test('omits saved sessions from recipient selection', async () => {
  const result = await chatCandidates(context({ listProvider: async provider => ({ sessions: provider === 'claude' ? [] : [{ thread_id: ID, session_id: ID, live_status: 'unverified' }] }) }));
  expect(result.candidates).toEqual([]);
});

test('a synchronous provider failure retains the other providers', async () => {
  const snapshot = await chatCandidates(context({ listProvider: provider => {
    if (provider === 'codex') return { sessions: [{ thread_id: ID, live_status: 'running' }] };
    throw new Error('CLI unavailable');
  } }));
  expect(snapshot.candidates.map(row => row.provider)).toEqual(['codex']);
  expect(snapshot.notes).toHaveLength(2);
});

test('sends literal command requests to the selected identity after inventory order changes', async () => withTTY(async () => {
  let calls = 0;
  const sent = [];
  const picker = ui(['2', 'q'], ['/xm:relay literal $HOME `whoami`']);
  await runChat({ '--provider': 'claude' }, context({
    listProvider: async () => ({ sessions: (++calls === 1 ? [ID, OTHER] : [OTHER, ID]).map(id => inventory(id).sessions[0]) }),
    send: async options => { sent.push(options); return { state: 'submitted' }; },
  }), picker);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ '--session': OTHER, '--kind': 'command', '--message': '/xm:relay literal $HOME `whoami`' });
  expect(picker.specs[0].header[0]).toContain('↑↓');
}));

test('does not submit after the selected recipient exits', async () => withTTY(async () => {
  let calls = 0;
  let sent = 0;
  await runChat({ '--provider': 'claude' }, context({ listProvider: async () => ++calls === 1 ? inventory(ID) : { sessions: [] }, send: async () => { sent++; } }), ui(['1', 'q'], ['hello']));
  expect(sent).toBe(0);
}));

test('unavailable recipients never receive a prompt or send and refresh stays in the same terminal', async () => withTTY(async () => {
  let sends = 0;
  let prompts = 0;
  const picker = ui(['1', 'r', 'q']);
  picker.ask = async () => { prompts++; return 'hello'; };
  await runChat({ '--provider': 'agy' }, context({ listProvider: async () => ({ sessions: [{ session_id: ID, live_status: 'running', capabilities: { send: false } }] }), send: async () => { sends++; } }), picker);
  expect(sends).toBe(0);
  expect(prompts).toBe(0);
  expect(picker.specs).toHaveLength(3);
}));

test('message-file mode selects once, reports submission, and exits', async () => withTTY(async () => {
  const sent = [];
  await runChat({ '--provider': 'claude', '--message-file': '/message.txt' }, context({ send: async value => { sent.push(value); return { state: 'submitted' }; } }), ui(['1']));
  expect(sent).toHaveLength(1);
  expect(sent[0]['--message-file']).toBe('/message.txt');
}));

test('message-file submission errors propagate rather than exiting successfully', async () => withTTY(async () => {
  await expect(runChat({ '--provider': 'claude', '--message-file': '/message.txt' },
    context({ send: async () => { throw new Error('submission refused'); } }), ui(['1']))).rejects.toThrow('submission refused');
}));

test('chat implementation contains no process spawning or native session commands', () => {
  const source = readFileSync(fileURLToPath(new URL('../xm/lib/x-relay-chat.mjs', import.meta.url)), 'utf8');
  expect(source).not.toMatch(/spawnSync|child_process|tmux|attach-session|--conversation|claudeBin|codexBin/);
});

test.if(['darwin', 'linux'].includes(process.platform) && spawnSync('python3', ['--version']).status === 0)('arrow keys choose a recipient in a real terminal, then send text without opening a provider CLI', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-picker-'));
  roots.push(root);
  const wrapper = join(root, 'picker.mjs');
  const capture = join(root, 'sent.json');
  const module = new URL('../xm/lib/x-relay-chat.mjs', import.meta.url).href;
  writeFileSync(wrapper, `import { runChat } from ${JSON.stringify(module)};\nimport { writeFileSync } from 'node:fs';\nawait runChat({'--provider':'claude'}, {listProvider: async () => ({sessions:[{session_id:'${ID}',name:'Alpha',cwd:'/repo'},{session_id:'${OTHER}',name:'Beta',cwd:'/repo'}]}), report: x => console.log(typeof x==='string'?x:JSON.stringify(x)),send: async x=>{writeFileSync(${JSON.stringify(capture)},JSON.stringify(x));return {state:'submitted'};}});\n`);
  const bridge = `import os,pty,sys,select,signal
pid,fd=pty.fork()
if pid==0: os.execv(sys.argv[1],sys.argv[1:])
def stop(*args):
 try: os.kill(pid,signal.SIGTERM)
 except ProcessLookupError: pass
signal.signal(signal.SIGTERM,stop)
try:
 while True:
  ready,_,_=select.select([fd,0],[],[])
  for source in ready:
   data=os.read(source,65536)
   if not data: raise EOFError()
   os.write(1 if source==fd else fd,data)
except (EOFError,OSError): pass
finally:
 stop()
 _,status=os.waitpid(pid,0)
 os.close(fd)
 sys.exit(os.waitstatus_to_exitcode(status))
`;
  const child = spawn('python3', ['-c', bridge, process.execPath, wrapper], { env: { ...process.env, XM_CONFIG_WIZARD_STDIN: '', NO_COLOR: '1' } });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const wait = async check => { const deadline = Date.now() + 3000; while (!check()) { if (Date.now() > deadline) throw new Error(output); await new Promise(resolve => setTimeout(resolve, 20)); } };
  try {
    await wait(() => output.includes('Beta'));
    child.stdin.write('\x1b[B');
    await wait(() => output.split('\n').some(row => /[❯>]/.test(row) && row.includes('Beta')));
    child.stdin.write('\r');
    await wait(() => output.includes('보낼 메시지'));
    child.stdin.write('literal relay message\r');
    await wait(() => existsSync(capture));
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toMatchObject({ '--session': OTHER, '--message': 'literal relay message' });
    await wait(() => output.lastIndexOf('메시지를 보낼 세션 선택') > output.indexOf('\"state\":\"submitted\"'));
    const closed = new Promise(resolve => child.on('close', resolve));
    child.stdin.write('q');
    await closed;
  } finally { child.kill(); }
});
