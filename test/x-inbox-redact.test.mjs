/**
 * x-inbox redact — secret-masking gate for captured command stdout
 * (cross-project-handoff t3 done_criteria).
 *
 * Covers: known secret patterns get masked, a 100k-char adversarial input
 * completes well under the 100ms budget (ReDoS defense), and an honest
 * pass/fail matrix for base64/URL-encoding bypass (documented, not hidden,
 * in redact.mjs's module header too).
 */
import { describe, test, expect } from 'bun:test';
import { redact } from '../xm/lib/x-inbox/redact.mjs';

describe('redact() — known secret patterns', () => {
  test('masks a plain assignment, keeping the key name as context', () => {
    const { text, masked } = redact('DB_PASSWORD=hunter2');
    expect(text).toBe('DB_PASSWORD=[REDACTED]');
    expect(masked).toBe(1);
  });

  test('masks a quoted assignment, keeping the quotes', () => {
    const { text, masked } = redact('password: "hunter2"');
    expect(text).toBe('password: "[REDACTED]"');
    expect(masked).toBe(1);
  });

  test('masks a compound identifier containing a secret term as a substring', () => {
    const { text, masked } = redact('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    expect(text).toBe('AWS_SECRET_ACCESS_KEY=[REDACTED]');
    expect(masked).toBe(1);
  });

  test('masks a bare AWS access key ID with no key-name context', () => {
    const { text, masked } = redact('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE');
    expect(text).toBe('AWS_ACCESS_KEY_ID=[REDACTED]');
    expect(masked).toBe(1);
  });

  test('masks an Authorization Bearer header, keeping the "Bearer " marker', () => {
    const { text, masked } = redact('Authorization: Bearer abcDEF1234567890ZZZ');
    expect(text).toBe('Authorization: Bearer [REDACTED]');
    expect(masked).toBe(1);
  });

  test('masks a bare JWT (header.payload.signature) with no preceding "Bearer" or key name', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ';
    const { text, masked } = redact(`token seen in logs: ${jwt}`);
    expect(text).toBe('token seen in logs: [REDACTED]');
    expect(masked).toBe(1);
  });

  test('masks a provider-prefixed key pasted inline with no key=value context', () => {
    const { text, masked } = redact('leaked key: sk-proj-abcDEF1234567890');
    expect(text).toBe('leaked key: [REDACTED]');
    expect(masked).toBe(1);
  });

  test('masks a multi-line PEM private key block', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyzABCDEFGH',
      'IJKLMNOP==',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const { text, masked } = redact(pem);
    expect(text).toBe('[REDACTED]');
    expect(masked).toBe(1);
  });

  test('does not mask ordinary prose that merely mentions a secret-ish word', () => {
    expect(redact('Implement token authentication')).toEqual({ text: 'Implement token authentication', masked: 0 });
    expect(redact('Merge this branch?')).toEqual({ text: 'Merge this branch?', masked: 0 });
  });

  test('a provider-shaped secret inside a key=value context is masked exactly once, not double-counted', () => {
    // Regression: an earlier draft ran the whole-match provider-key pattern
    // before the key=value assignment scan, so the assignment scan would
    // then re-match the already-redacted `[REDACTED]` placeholder as if it
    // were a fresh value, counting the same secret twice.
    const { text, masked } = redact("api_key='sk-proj-abcDEF1234567890'");
    expect(text).toBe("api_key='[REDACTED]'");
    expect(masked).toBe(1);
  });

  test('handles empty string and non-string input without throwing', () => {
    expect(redact('')).toEqual({ text: '', masked: 0 });
    expect(redact(null)).toEqual({ text: '', masked: 0 });
    expect(redact(undefined)).toEqual({ text: '', masked: 0 });
  });

  test('is pure — repeated calls on the same input produce identical results', () => {
    const input = 'DB_PASSWORD=hunter2 and AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
    const first = redact(input);
    const second = redact(input);
    expect(second).toEqual(first);
    // input itself must be untouched (redact must not mutate its argument)
    expect(input).toBe('DB_PASSWORD=hunter2 and AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE');
  });
});

describe('redact() — ReDoS stress (100k-char adversarial input, <100ms budget)', () => {
  const BUDGET_MS = 100;

  test('100k flat non-matching characters completes within budget', () => {
    const input = 'a'.repeat(100000);
    const t0 = performance.now();
    const { masked } = redact(input);
    const elapsed = performance.now() - t0;
    expect(masked).toBe(0);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  test('100k chars of dense "-----BEGIN ... PRIVATE KEY-----" markers with no matching END completes within budget', () => {
    // Adversarial against PEM_RE specifically: forces a body scan attempt at
    // every marker occurrence with no closing END anywhere in the string.
    const marker = '-----BEGIN RSA PRIVATE KEY-----';
    const input = marker.repeat(Math.ceil(100000 / marker.length)).slice(0, 100000);
    const t0 = performance.now();
    const { masked } = redact(input);
    const elapsed = performance.now() - t0;
    expect(masked).toBe(0);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  test('100k chars of dense near-miss "token..." runs with no separator completes within budget', () => {
    // Adversarial against ASSIGNMENT_RE specifically: the term matches
    // repeatedly, but no ":"/"=" ever follows, forcing the trailing bounded
    // quantifier to backtrack at every occurrence.
    const unit = `token${'x'.repeat(40)} `;
    const input = unit.repeat(Math.ceil(100000 / unit.length)).slice(0, 100000);
    const t0 = performance.now();
    const { masked } = redact(input);
    const elapsed = performance.now() - t0;
    expect(masked).toBe(0);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  test('100k chars mixing all three adversarial shapes completes within budget', () => {
    const marker = '-----BEGIN RSA PRIVATE KEY-----';
    const pemPart = marker.repeat(400).slice(0, 33334);
    const unit = `token${'x'.repeat(40)} `;
    const assignPart = unit.repeat(800).slice(0, 33333);
    const flatPart = 'a'.repeat(100000 - pemPart.length - assignPart.length);
    const input = pemPart + assignPart + flatPart;
    expect(input.length).toBe(100000);
    const t0 = performance.now();
    redact(input);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  test('100k chars of a non-Latin (Korean) secret-term flood completes within budget', () => {
    const input = '토큰'.repeat(50000).slice(0, 100000);
    const t0 = performance.now();
    redact(input);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });
});

describe('redact() — encoding bypass investigation (documented, not silently missed)', () => {
  // See the KNOWN LIMITATION block in xm/lib/x-inbox/redact.mjs's module
  // header for the full explanation. Summary verified by these cases:
  // redact() never decodes base64/percent-encoding before scanning, so it
  // only catches an encoded secret when the encoding happens to still look
  // like one of the known raw shapes (JWT/AWS-key/provider-prefix), or when
  // the *key name* pointing at the value is still plaintext.

  test('BYPASS: a base64-encoded key=value pair with no surrounding context is NOT masked', () => {
    const encoded = Buffer.from('PASSWORD=hunter2plainsecretvalue').toString('base64');
    const { text, masked } = redact(encoded);
    expect(masked).toBe(0);
    expect(text).toBe(encoded); // passes through completely unmasked
  });

  test('BYPASS: a base64-encoded "Authorization: Bearer ..." header is NOT masked', () => {
    const encoded = Buffer.from('Authorization: Bearer sometoken').toString('base64');
    const { text, masked } = redact(encoded);
    expect(masked).toBe(0);
    expect(text).toBe(encoded);
  });

  test('BYPASS: a percent-encoded key name with a plain (non-shaped) value is NOT masked', () => {
    // "tok%65n" is "token" with the middle "e" percent-encoded — the literal
    // bytes no longer contain the substring "token", so the key-name match
    // (a plain substring check) never fires.
    const { text, masked } = redact('tok%65n=hunter2plainsecretvalue');
    expect(masked).toBe(0);
    expect(text).toBe('tok%65n=hunter2plainsecretvalue');
  });

  test('CAUGHT (not a bypass): an encoded value under a plaintext recognized key name is masked opaquely', () => {
    // The key name ("password") is what triggers the match; the value is
    // swallowed as an opaque non-whitespace token whether or not it happens
    // to be percent-encoded. redact() does not need to decode it to mask it.
    const { text, masked } = redact('password=hunter%32%21');
    expect(masked).toBe(1);
    expect(text).toBe('password=[REDACTED]');
  });

  test('CAUGHT (not a bypass, but not because of decoding): a provider-shaped value happens to survive even under an encoded key name', () => {
    // This is NOT the encoding defense working — PROVIDER_KEY_RE matches the
    // sk-... value independently of the (unmasked, percent-encoded) key name
    // beside it. Included to make the boundary of the limitation precise:
    // encoding only defeats masking when it also hides the *matched* signal
    // (key name or known prefix shape), not when an unrelated signal survives.
    const { text, masked } = redact('tok%65n=sk-proj-abc123XYZsecretvalue');
    expect(masked).toBe(1);
    expect(text).toBe('tok%65n=[REDACTED]');
  });
});

describe('redact() — value-remainder leaks (cross-vendor review regressions)', () => {
  // These pin the defect class the earlier tests missed: they asserted the
  // `masked` COUNT and the presence of "[REDACTED]", never that the secret was
  // actually gone from the output. Both cases below returned masked:1 while
  // leaking — the caller was told the text was clean.

  test('a quoted value containing spaces is masked to its CLOSING quote', () => {
    const { text, masked } = redact('password="correct horse battery staple"');
    expect(masked).toBe(1);
    // The whole point: no word of the secret survives anywhere in the output.
    for (const word of ['correct', 'horse', 'battery', 'staple']) {
      expect(text).not.toContain(word);
    }
    expect(text).toBe('password="[REDACTED]"');
  });

  test("a single-quoted value containing spaces is masked to its closing quote", () => {
    const { text } = redact("secret='multi word value here'");
    for (const word of ['multi', 'word', 'value', 'here']) {
      expect(text).not.toContain(word);
    }
    expect(text).toBe("secret='[REDACTED]'");
  });

  test('a value far longer than the old 500-char cap leaves no tail behind', () => {
    const secret = 'x'.repeat(3000);
    const { text, masked } = redact(`api_key=${secret}`);
    expect(masked).toBe(1);
    expect(text).not.toContain('xxxxx');
    expect(text).toBe('api_key=[REDACTED]');
  });

  test('Bearer tokens still mask after the assignment-pattern change', () => {
    // Regression guard for a cross-vendor claim that ASSIGNMENT_RE running
    // first would consume the "Bearer " marker. Execution refuted it; this
    // keeps it refuted.
    const { text } = redact('Authorization: Bearer sk-live-abcdefghijklmnop');
    expect(text).toBe('Authorization: Bearer [REDACTED]');
    expect(text).not.toContain('abcdefghijklmnop');
  });

  test('stress: the widened value capture stays inside the 100ms budget', () => {
    const input = `password="${'a b '.repeat(25000)}"`.slice(0, 100000);
    const start = performance.now();
    redact(input);
    expect(performance.now() - start).toBeLessThan(100);
  });
});
