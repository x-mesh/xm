import { expect, test } from 'bun:test';
import { ClaudeProvider, CodexProvider } from '../lib/x-remote/providers.mjs';

test('providers pin full-access execution flags', () => {
  const [, args] = ClaudeProvider.command('hello');
  expect(args).toContain('--dangerously-skip-permissions');
  expect(CodexProvider.startParams('/tmp')).toEqual({ cwd: '/tmp', approvalPolicy: 'never', sandbox: 'danger-full-access' });
});

test('Codex uses turn/steer only while a turn is active', () => {
  const provider = new CodexProvider();
  provider.threadId = 'thread-1';
  const calls = [];
  provider.send = (method, params) => calls.push({ method, params });
  provider.steer('first');
  provider.activeTurnId = 'turn-1';
  provider.steer('follow-up');
  expect(calls[0].method).toBe('turn/start');
  expect(calls[1]).toEqual({ method: 'turn/steer', params: { threadId: 'thread-1', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'follow-up' }] } });
});

test('Claude semantic questions are emitted and secrets stay local', () => {
  const provider = new ClaudeProvider();
  const decisions = [], local = [], progress = [];
  provider.on('decision', (v) => decisions.push(v)); provider.on('localRequired', (v) => local.push(v));
  provider.on('progress', (v) => progress.push(v));
  provider.onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { question: 'Merge now?' } }] } }));
  provider.onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'q2', name: 'AskUserQuestion', input: { question: 'Enter token' } }] } }));
  expect(decisions).toHaveLength(1); expect(local).toHaveLength(1);
  expect(JSON.stringify(progress)).not.toContain('Enter token');
});

test('Codex answers match requestUserInput schema and interrupt includes turnId', () => {
  const provider = new CodexProvider();
  const writes = [];
  provider.child = { stdin: { writable: true, write: (v) => writes.push(JSON.parse(v)) } };
  provider.answer(7, 'yes', [{ id: 'confirm' }]);
  expect(writes[0].result).toEqual({ answers: { confirm: { answers: ['yes'] } } });
  provider.threadId = 'thread-1'; provider.activeTurnId = 'turn-1';
  provider.send = (method, params) => writes.push({ method, params });
  provider.interrupt();
  expect(writes[1]).toEqual({ method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' } });
});
