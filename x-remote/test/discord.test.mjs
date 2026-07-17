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
