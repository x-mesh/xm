// @ts-check
//
// cli-prompts clampAnsi — unit tests for the terminal-width clamp that fixes the
// raw-mode menu "글씨 밀림" (line-wrap desync) on narrow terminals.
//
// The bug: rawSelect repaints by moving the cursor up a fixed line count that
// assumes 1 logical line = 1 physical row. A line wider than the terminal wraps
// and breaks that assumption. clampAnsi guarantees each painted line's DISPLAY
// width never exceeds the given column budget, so no line wraps.

import { describe, test, expect } from 'bun:test';
import { clampAnsi, dwidth, P } from '../x-build/lib/cli-prompts.mjs';

// Strip ANSI SGR escapes to measure visible content only.
function visible(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('clampAnsi', () => {
  test('leaves a short ASCII string untouched (no reset appended)', () => {
    const s = 'hello';
    expect(clampAnsi(s, 20)).toBe('hello');
  });

  test('truncates ASCII to the column budget', () => {
    const out = clampAnsi('abcdefghij', 4);
    expect(visible(out)).toBe('abcd');
    expect(dwidth(visible(out))).toBeLessThanOrEqual(4);
  });

  test('counts CJK as 2 columns and never exceeds the budget', () => {
    // 5 Hangul syllables = 10 display cols; budget 5 fits only 2 (=4 cols).
    const out = clampAnsi('가나다라마', 5);
    expect(dwidth(visible(out))).toBeLessThanOrEqual(5);
    expect(visible(out)).toBe('가나');
  });

  test('does not count ANSI escapes toward width and preserves them', () => {
    // Force color on so P.* emits real escapes regardless of TTY state.
    const prevNoColor = process.env.NO_COLOR;
    const prevTTY = process.stdout.isTTY;
    delete process.env.NO_COLOR;
    // @ts-ignore — test shim
    process.stdout.isTTY = true;
    try {
      const colored = P.cyan('abcde'); // 5 visible cols wrapped in escapes
      const out = clampAnsi(colored, 5);
      expect(visible(out)).toBe('abcde'); // all 5 visible chars survive
      expect(out).toContain('\x1b['); // escapes preserved
    } finally {
      if (prevNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = prevNoColor;
      // @ts-ignore — restore
      process.stdout.isTTY = prevTTY;
    }
  });

  test('appends a reset when it cuts inside styled text', () => {
    const styled = '\x1b[36mabcdefabcdef'; // opened color, never closed
    const out = clampAnsi(styled, 3);
    expect(visible(out)).toBe('abc');
    expect(out.endsWith('\x1b[0m')).toBe(true);
  });

  test('returns empty string for a non-positive budget', () => {
    expect(clampAnsi('anything', 0)).toBe('');
    expect(clampAnsi('anything', -5)).toBe('');
  });

  test('skips a CSI escape ending in a non-letter final byte (ECMA-48 0x40-0x7E)', () => {
    // ESC[1@ (insert-char) ends in '@' — must be treated as a zero-width escape,
    // not swallow the following visible text. Regression for the panel finding.
    const s = '\x1b[1@abcdef';
    const out = clampAnsi(s, 3);
    // Escape (zero width) preserved verbatim, exactly 3 visible cols, then a
    // reset because the input was cut ('def' dropped).
    expect(out).toBe('\x1b[1@abc\x1b[0m');
  });

  test('a malformed escape with no final byte terminates without looping or dropping', () => {
    const s = '\x1b[999';                    // no terminator before end-of-string
    const out = clampAnsi(s, 10);
    expect(out).toBe('\x1b[999');            // consumed to end, no hang, no duplication
  });

  test('a rendered menu line stays within a narrow terminal (regression)', () => {
    // Simulate the widest realistic option: long Korean label + long hint.
    const line = `  ${P.cyan('❯')} ${P.cyan('모델 프로파일을 선택하세요 (economy)')}  ${P.dim('토큰 비용을 크게 줄입니다')}`;
    for (const cols of [10, 20, 40, 80]) {
      const out = clampAnsi(line, cols);
      expect(dwidth(visible(out))).toBeLessThanOrEqual(cols);
    }
  });
});
