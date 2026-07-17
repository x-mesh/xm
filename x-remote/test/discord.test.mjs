import { expect, test } from 'bun:test';
import { DiscordBridge, parseDiscordCommand } from '../lib/x-remote/discord.mjs';

test('parses Discord control commands without changing text', () => {
  expect(parseDiscordCommand('!xr sessions')).toEqual({ kind: 'sessions' });
  expect(parseDiscordCommand('!xr steer s1 이 요구사항을 그대로 유지해')).toEqual({ kind: 'steer', target: 's1', text: '이 요구사항을 그대로 유지해' });
  expect(parseDiscordCommand('!xr steer s1 line1\n  line2')).toEqual({ kind: 'steer', target: 's1', text: 'line1\n  line2' });
  expect(parseDiscordCommand('!xr steer s1 keep trailing  ')).toEqual({ kind: 'steer', target: 's1', text: 'keep trailing  ' });
  expect(parseDiscordCommand('!xr interrupt s1')).toEqual({ kind: 'interrupt', target: 's1' });
  expect(parseDiscordCommand('hello')).toBeNull();
});

test('ignores Discord commands from users outside the allowlist', async () => {
  const commands = [];
  const bridge = new DiscordBridge({ token: 't', channelId: 'c', allowedUserIds: ['allowed'], onCommand: (v) => commands.push(v), fetchImpl: async () => {}, WebSocketImpl: class {} });
  bridge.onMessage({ t: 'MESSAGE_CREATE', d: { channel_id: 'c', author: { id: 'denied', bot: false }, content: '!xr interrupt s1' } });
  bridge.onMessage({ t: 'MESSAGE_CREATE', d: { channel_id: 'c', author: { id: 'allowed', bot: false }, content: '!xr interrupt s1' } });
  await Promise.resolve();
  expect(commands).toEqual([{ kind: 'interrupt', target: 's1' }]);
});

// panel review 2026-07-17 (agy MEDIUM): each Discord POST is an independent HTTP
// request with no ordering guarantee — a slower earlier send() used to be able to
// land AFTER a faster later one. send() now serializes through an internal queue.
test('send() preserves message order even when an earlier request resolves later', async () => {
  const posted = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    // The FIRST call is the slow one — without serialization it would complete last.
    if (posted.length === 0) await new Promise((r) => setTimeout(r, 20));
    posted.push(body.content);
    return { ok: true, status: 204, text: async () => '' };
  };
  const bridge = new DiscordBridge({ token: 't', channelId: 'c', onCommand: () => {}, fetchImpl, WebSocketImpl: class {} });
  await Promise.all([bridge.send('first'), bridge.send('second'), bridge.send('third')]);
  expect(posted).toEqual(['first', 'second', 'third']);
});

test('send() keeps queuing later messages after an earlier one fails', async () => {
  const posted = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.content === 'fails') return { ok: false, status: 500, text: async () => 'boom' };
    posted.push(body.content);
    return { ok: true, status: 204, text: async () => '' };
  };
  const bridge = new DiscordBridge({ token: 't', channelId: 'c', onCommand: () => {}, fetchImpl, WebSocketImpl: class {} });
  const results = await Promise.allSettled([bridge.send('fails'), bridge.send('after')]);
  expect(results[0].status).toBe('rejected');
  expect(results[1].status).toBe('fulfilled');
  expect(posted).toEqual(['after']);
});
