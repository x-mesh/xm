// Render-layer gate (Theme 3 / dash-render-untested): the dashboard's pure
// render helpers ship untested in a 6.7k-line app.js, so object/empty/unknown
// shapes reached the UI as "[object Object]" or raw JSON dumps and were caught
// only by the user after a release. These assert the contract instead.
import { describe, test, expect } from 'bun:test';
import '../public/render-helpers.js'; // IIFE sets globalThis.XMRender

const { renderValue, renderEmpty, fmtAgents } = globalThis.XMRender;

describe('renderValue', () => {
  test('never emits "[object Object]" for any shape', () => {
    const fixtures = [
      { a: 1, b: 'x' },
      [{ name: 'codex' }, { name: 'claude' }],
      { nested: { deep: { x: [1, 2, { y: 3 }] } } },
      null,
      undefined,
      '',
      [],
      {},
      { fn: () => 1 },
      0,
      false,
      // 9-level deep nesting — must hit the depth guard without leaking "[object Object]"
      { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 1 } } } } } } } } } },
      [[[[[[[[[['deep']]]]]]]]]],
    ];
    for (const f of fixtures) {
      expect(renderValue(f)).not.toContain('[object Object]');
    }
  });

  test('object input produces a table, not a raw JSON dump', () => {
    const html = renderValue({ strategy: 'debate', rounds: 2 });
    expect(html).toContain('<table');
    expect(html).toContain('strategy');
    expect(html).toContain('debate');
    expect(html).not.toContain('{'); // no JSON.stringify braces
  });

  test('array input produces a list', () => {
    const html = renderValue(['a', 'b']);
    expect(html).toContain('<ul');
    expect(html).toContain('<li>');
  });

  test('escapes HTML in string values', () => {
    expect(renderValue('<script>x</script>')).not.toContain('<script>');
    expect(renderValue({ k: '<b>' })).toContain('&lt;b&gt;');
  });

  test('null/empty render as an em-dash, not literal null', () => {
    expect(renderValue(null)).toContain('—');
    expect(renderValue(null)).not.toContain('null');
    expect(renderValue({})).toContain('—');
  });
});

describe('renderEmpty', () => {
  test('discloses scanned paths when provided', () => {
    const html = renderEmpty('No PRDs found', 'xm build plan', ['.xm/build/projects']);
    expect(html).toContain('searched:');
    expect(html).toContain('.xm/build/projects');
    expect(html).toContain('0 found');
  });

  test('omits the searched line when no paths given (back-compat)', () => {
    const html = renderEmpty('No PRDs found', 'xm build plan');
    expect(html).not.toContain('searched:');
    expect(html).toContain('No PRDs found');
  });

  test('accepts a single path string', () => {
    expect(renderEmpty('empty', null, '.xm/op')).toContain('.xm/op');
  });
});

describe('fmtAgents', () => {
  test('formats array of agent objects without "[object Object]"', () => {
    const out = fmtAgents([{ name: 'codex' }, { role: 'critic' }]);
    expect(out).toBe('codex, critic');
    expect(out).not.toContain('[object Object]');
  });
  test('handles number, string, null', () => {
    expect(fmtAgents(3)).toBe('3');
    expect(fmtAgents('claude')).toBe('claude');
    expect(fmtAgents(null)).toBe('—');
  });
});
