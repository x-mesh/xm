import { describe, expect, test } from 'bun:test';
import { createEnvelope, discordChunks, isSensitivePrompt, parseEnvelope, PROTOCOL_VERSION } from '../lib/x-remote/protocol.mjs';

describe('XK-REMOTE-v1 protocol', () => {
  test('round-trips a valid envelope', () => {
    const event = createEnvelope({ type: 'session.start', hostId: 'linux-1', sessionId: 's1', provider: 'codex', seq: 3, payload: { original: '그대로 전송' } });
    expect(parseEnvelope(JSON.stringify(event))).toEqual(event);
    expect(event.v).toBe(PROTOCOL_VERSION);
  });
  test('rejects unknown event types', () => expect(() => createEnvelope({ type: 'wat', hostId: 'h', seq: 0 })).toThrow());
  test('detects credential prompts', () => {
    expect(isSensitivePrompt('Enter API token')).toBe(true);
    expect(isSensitivePrompt('Merge this branch?')).toBe(false);
    expect(isSensitivePrompt('Implement token authentication')).toBe(false);
    expect(isSensitivePrompt({ question: 'Value?', isSecret: true })).toBe(true);
  });
  test('preserves long original text across Discord chunks', () => {
    const original = '가'.repeat(5000);
    const event = createEnvelope({ type: 'decision.required', hostId: 'h', seq: 1, payload: { original } });
    const rebuilt = discordChunks(event).map((v) => v.slice(v.indexOf('\n') + 1)).join('');
    expect(rebuilt).toBe(original);
    expect(discordChunks(event).every((v) => v.length <= 1900)).toBe(true);
  });
});
