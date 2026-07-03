// @ts-check
//
// cli-prompts rawSelect — integration test for the narrow-terminal repaint fix.
//
// rawSelect drives a real TTY (arrow-key menu, in-place repaint). We can't spawn
// a TTY here, so we swap process.stdin/stdout for mocks: a fake raw-capable stdin
// (EventEmitter) and a width-limited stdout that CAPTURES every write. Then we
// drive menuSelect down its raw path, press Enter, and assert:
//   1. no PAINTED line's visible width exceeds the terminal columns (no wrap →
//      the fixed cursor-up stays in sync — the 글씨 밀림 fix), and
//   2. the menu resolves to the focused option's key.
//
// No host pollution: only process.std* globals are swapped, restored in finally.

import { describe, test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { menuSelect, dwidth } from '../x-build/lib/cli-prompts.mjs';

// Strip ALL ANSI escapes (SGR + cursor moves + erase) so only visible glyphs remain.
function visibleGlyphs(s) {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z@-~]/g, '');
}

function makeStdout(columns) {
  const chunks = [];
  return {
    isTTY: true,
    columns,
    rows: 40,
    write(s) { chunks.push(String(s)); return true; },
    _chunks: chunks,
  };
}

function makeStdin() {
  const ee = new EventEmitter();
  // @ts-ignore — TTY-ish shim
  ee.isTTY = true;
  // @ts-ignore
  ee.setRawMode = () => ee;
  // @ts-ignore
  ee.resume = () => ee;
  // @ts-ignore
  ee.pause = () => ee;
  // @ts-ignore
  ee.setEncoding = () => ee;
  return ee;
}

async function runRawSelect({ columns, spec }) {
  const realIn = process.stdin, realOut = process.stdout;
  const realWizardEnv = process.env.XM_CONFIG_WIZARD_STDIN;
  const realNoColor = process.env.NO_COLOR;
  const stdin = makeStdin();
  const stdout = makeStdout(columns);
  delete process.env.XM_CONFIG_WIZARD_STDIN; // force isRawCapable() true
  delete process.env.NO_COLOR;               // exercise the colored (escape-heavy) path
  // @ts-ignore
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  // @ts-ignore
  Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });
  try {
    const fakeRl = { close() {} };
    const p = menuSelect(fakeRl, spec);
    // Let paint(true) run and onData register, then press Enter.
    await new Promise((r) => setImmediate(r));
    stdin.emit('data', Buffer.from('\r'));
    const key = await p;
    return { key, chunks: stdout._chunks };
  } finally {
    // @ts-ignore
    Object.defineProperty(process, 'stdin', { value: realIn, configurable: true });
    // @ts-ignore
    Object.defineProperty(process, 'stdout', { value: realOut, configurable: true });
    if (realWizardEnv !== undefined) process.env.XM_CONFIG_WIZARD_STDIN = realWizardEnv;
    if (realNoColor !== undefined) process.env.NO_COLOR = realNoColor;
  }
}

describe('rawSelect narrow-terminal repaint', () => {
  const spec = {
    title: '모델 프로파일을 선택하세요 (economy / default / max)',
    header: ['현재 값: economy (global tier에서 상속됨)'],
    options: [
      { key: '1', label: 'economy', hint: '토큰 비용을 크게 줄입니다 (haiku 위주)' },
      { key: '2', label: 'default', hint: '균형 잡힌 기본 프로파일' },
      { key: '3', label: 'max', hint: '최고 품질 (opus 위주, 비용 높음)' },
      { key: '0', label: '뒤로', hint: '' },
    ],
  };

  for (const columns of [16, 24, 40, 80]) {
    test(`no painted line exceeds ${columns} columns`, async () => {
      const { chunks } = await runRawSelect({ columns, spec });
      // Reconstruct the output stream, split into lines, measure visible width.
      const lines = chunks.join('').split('\n');
      for (const line of lines) {
        expect(dwidth(visibleGlyphs(line))).toBeLessThanOrEqual(columns);
      }
    });
  }

  test('resolves to the focused option key on Enter (default focus = first non-back)', async () => {
    const { key } = await runRawSelect({ columns: 24, spec });
    expect(key).toBe('1'); // first option that is not the back key
  });

  test('repaint + collapse use a consistent cursor-up count (title in the block)', async () => {
    const { chunks } = await runRawSelect({ columns: 24, spec });
    const stream = chunks.join('');
    // blockLines = title(1) + header(1) + blank-rail(1) + options(4) = 7.
    // Every cursor-up in the raw path must move exactly blockLines rows, or the
    // repaint/collapse would drift. Assert all \x1b[<n>A use the same n.
    const ups = [...stream.matchAll(/\x1b\[(\d+)A/g)].map((m) => Number(m[1]));
    expect(ups.length).toBeGreaterThan(0);
    for (const n of ups) expect(n).toBe(7);
  });
});
