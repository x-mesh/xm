import { describe, expect, test } from 'bun:test';
import { cleanDisplayText, createEnvelope, discordBatchChunks, discordChunks, isSensitivePrompt, parseEnvelope, PROTOCOL_VERSION } from '../lib/x-remote/protocol.mjs';

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
  test('filters injected progress text and batches visible output', () => {
    const noisy = createEnvelope({ type: 'session.progress', hostId: 'h', sessionId: 's', provider: 'claude', seq: 1, payload: { original: 'injected context is absent; Pin Gate instructions' } });
    expect(discordChunks(noisy)).toEqual([]);
    const a = createEnvelope({ type: 'session.output', hostId: 'h', sessionId: 's', provider: 'claude', seq: 2, payload: { original: 'first line' } });
    const b = createEnvelope({ type: 'session.output', hostId: 'h', sessionId: 's', provider: 'claude', seq: 3, payload: { original: 'second line' } });
    expect(discordBatchChunks([a, b])[0]).toContain('first line');
    expect(discordBatchChunks([a, b])[0]).toContain('second line');
  });

  // panel review 2026-07-17 (agy HIGH + kiro MEDIUM): the INTERNAL_OUTPUT filter used
  // to match a BARE `stdout:`/`stderr:` anywhere in the text and drop the entire
  // message — including ordinary prose that just mentions the word before a colon.
  test('cleanDisplayText only filters a quoted JSON-key form, not ordinary prose mentioning the same word', () => {
    expect(cleanDisplayText('stdout: build succeeded, 0 errors', 'session.output')).toBe('stdout: build succeeded, 0 errors');
    expect(cleanDisplayText('I checked stderr: nothing printed', 'session.progress')).toBe('I checked stderr: nothing printed');
    expect(cleanDisplayText('raw dump: {"stdout": "leaked internal text"}', 'session.progress')).toBe('');
  });
});
