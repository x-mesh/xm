#!/usr/bin/env node

/**
 * cli-prompts — zero-dependency clack-style terminal prompt kit for xm CLIs.
 *
 * Implements the terminal design system in DESIGN.md: glyph vocabulary
 * (◇ ◆ │ └ ● ○ ❯ ✓ ✗ ⚠ with ASCII fallback), ANSI-16 color roles, and
 * dual-mode interaction:
 *
 *   raw mode   — real TTY: arrow-key select (↑↓/jk, digit jump, Enter,
 *                Esc/q = back, Ctrl-C = wizard abort via WizardEOF)
 *   line mode  — piped stdin / XM_CONFIG_WIZARD_STDIN=1: numbered options,
 *                one answer per line. This is the test contract — numbering
 *                and input semantics must stay stable.
 *
 * The line-queue readline wrapper (createRL/ask/WizardEOF) lives here so a
 * single module owns wizard IO. shared-config.mjs imports from this file.
 */

import { createInterface } from 'node:readline';
import { t } from './cli-messages.mjs';

// ── Environment capabilities ────────────────────────────────────────────

const env = process.env;

export function colorEnabled() {
  return !env.NO_COLOR && !!process.stdout.isTTY;
}

function utf8Locale() {
  const l = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  return /utf-?8/i.test(l) || process.platform === 'darwin';
}

/** Raw-mode arrow navigation is possible only on a real interactive TTY. */
export function isRawCapable() {
  return !!process.stdin.isTTY && !!process.stdout.isTTY
    && !env.XM_CONFIG_WIZARD_STDIN
    && typeof process.stdin.setRawMode === 'function';
}

// ── Color roles (DESIGN.md — ANSI 16 only, NO_COLOR aware) ─────────────

function mk(code) {
  return (s) => colorEnabled() ? `\x1b[${code}m${s}\x1b[0m` : String(s);
}

export const P = {
  bold: mk('1'),
  dim: mk('2'),
  cyan: mk('36'),
  green: mk('32'),
  yellow: mk('33'),
  red: mk('31'),
};

// ── Glyphs (clack vocabulary, ASCII fallback) ───────────────────────────

const UTF8 = utf8Locale();

export const G = UTF8 ? {
  section: '◇', active: '◆', rail: '│', end: '└',
  on: '●', off: '○', chkOn: '◼', chkOff: '◻',
  cursor: '❯', ok: '✓', err: '✗', warn: '⚠',
} : {
  section: '*', active: '*', rail: '|', end: '+',
  on: '(o)', off: '( )', chkOn: '[x]', chkOff: '[ ]',
  cursor: '>', ok: '+', err: 'x', warn: '!',
};

// ── Line-queue readline (line mode IO; also drives text inputs in raw mode) ──

export class WizardEOF extends Error {}

/**
 * readline이 파이프 입력을 한 청크로 받으면 모든 line 이벤트를 동기 방출하는
 * 반면 rl.question은 콜백 1개만 등록해 라인이 유실된다. 라인 큐 + 대기자 큐로
 * 모든 라인을 보존한다. (t4에서 발견된 조기-EOF 버그의 수정 형태)
 */
export function createRL() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl._xmLines = [];
  rl._xmWaiters = [];
  rl._xmClosed = false;
  rl.on('line', (line) => {
    const w = rl._xmWaiters.shift();
    if (w) w.resolve(line);
    else rl._xmLines.push(line);
  });
  rl.on('close', () => {
    rl._xmClosed = true;
    let w;
    while ((w = rl._xmWaiters.shift())) w.reject(new WizardEOF());
  });
  rl.on('SIGINT', () => rl.close());
  rl.resume();
  return rl;
}

/** Write prompt, hand back the next buffered line; reject WizardEOF when drained+closed. */
export function ask(rl, question) {
  if (question) process.stdout.write(question);
  if (rl._xmLines.length) return Promise.resolve(rl._xmLines.shift());
  if (rl._xmClosed) return Promise.reject(new WizardEOF());
  return new Promise((resolve, reject) => rl._xmWaiters.push({ resolve, reject }));
}

// ── Layout primitives ───────────────────────────────────────────────────

/** Section header: `◇ title` + optional dim subtitle on the same line. */
export function section(title, subtitle) {
  const sub = subtitle ? `  ${P.dim(subtitle)}` : '';
  console.log(`\n${P.cyan(G.section)} ${P.bold(title)}${sub}`);
}

/** Rail-indented body line under a section. */
export function railLine(text = '') {
  console.log(`${P.dim(G.rail)}  ${text}`);
}

/** Section close: `└ text`. */
export function outro(text) {
  console.log(`${P.dim(G.end)}  ${text}\n`);
}

// display width: CJK 글자는 2칸 (DESIGN.md 정렬 규칙)
export function dwidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    w += (cp >= 0x1100 && (cp <= 0x115F || (cp >= 0x2E80 && cp <= 0xA4CF)
      || (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0xF900 && cp <= 0xFAFF)
      || (cp >= 0xFE30 && cp <= 0xFE4F) || (cp >= 0xFF00 && cp <= 0xFF60)
      || (cp >= 0xFFE0 && cp <= 0xFFE6))) ? 2 : 1;
  }
  return w;
}

export function padDisplay(s, width) {
  const gap = width - dwidth(s);
  return s + ' '.repeat(Math.max(0, gap));
}

/**
 * Truncate `s` to at most `maxCols` display columns — CJK-aware (2 cols) and
 * skipping ANSI escapes (zero display width, preserved verbatim). Appends a
 * reset when it cuts inside styled text so color never bleeds past the cut.
 *
 * rawSelect repaints in place by moving the cursor up a fixed number of lines
 * (bodyLines), which assumes one logical line = one physical terminal row. On a
 * terminal narrower than a rendered line, that line wraps to 2+ rows, the
 * cursor-up count under-shoots, and the menu "walks" down the screen on every
 * keypress (the reported 글씨 밀림). Clamping each painted line to the terminal
 * width guarantees one row per line and keeps the repaint math correct.
 */
export function clampAnsi(s, maxCols) {
  const str = String(s);
  if (maxCols <= 0) return '';
  let out = '';
  let w = 0;
  let cut = false;
  for (let i = 0; i < str.length;) {
    if (str[i] === '\x1b' && str[i + 1] === '[') {
      // CSI escape — keep it whole, count zero width. Per ECMA-48 the final byte
      // is 0x40–0x7E (not just letters), so match that whole range: a sequence
      // like ESC[1@ must terminate at '@', or the following text is swallowed.
      // (In practice only SGR 'm' reaches here, but stay correct if reused.)
      let j = i + 2;
      while (j < str.length && !/[\x40-\x7e]/.test(str[j])) j++;
      out += str.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const ch = String.fromCodePoint(str.codePointAt(i));
    const cw = dwidth(ch);
    if (w + cw > maxCols) { cut = true; break; }
    out += ch;
    w += cw;
    i += ch.length;
  }
  if (cut) out += '\x1b[0m';
  return out;
}

// ── menuSelect — the single-choice prompt (dual mode) ───────────────────

function renderOption(opt, { active = false, labelWidth = 0 } = {}) {
  const radio = active ? P.cyan(G.on) : P.dim(G.off);
  const cursor = active ? P.cyan(G.cursor) : ' ';
  const label = active ? P.cyan(padDisplay(opt.label, labelWidth)) : padDisplay(opt.label, labelWidth);
  const hint = opt.hint ? `  ${P.dim(opt.hint)}` : '';
  return `${cursor} ${radio} ${label}${hint}`;
}

function renderLineOption(opt, labelWidth) {
  const hint = opt.hint ? `  ${P.dim(opt.hint)}` : '';
  return `${P.dim(G.rail)}  ${P.bold(`${opt.key})`)} ${padDisplay(opt.label, labelWidth)}${hint}`;
}

/**
 * menuSelect(rl, spec) → Promise<string>  (선택된 option.key)
 *
 * spec: {
 *   title: string            — `◆ title` 프롬프트 라인
 *   header?: string[]        — 제목 아래 rail 라인들 (상태 표시 등)
 *   options: [{ key, label, hint? }]
 *   prompt?: string          — line 모드 입력 프롬프트 (기본 '선택: ')
 *   backKey?: string         — Esc/q가 반환할 key (기본 '0')
 * }
 *
 * line 모드: 번호 목록 출력 후 한 줄을 읽어 trim해 그대로 반환한다
 * (유효성 검사는 호출자 몫 — 기존 위저드 루프·테스트 계약 보존).
 * raw 모드: 화살표 내비게이션, Enter 확정. 반환값은 option.key.
 */
export async function menuSelect(rl, spec) {
  const { title, header = [], options, prompt = t('prompt.select'), backKey = '0', initialKey } = spec;
  const labelWidth = Math.max(...options.map(o => dwidth(o.label)));

  if (!isRawCapable()) {
    console.log(`\n${P.cyan(G.active)} ${P.bold(title)}`);
    for (const h of header) railLine(h);
    if (header.length) railLine();
    for (const o of options) console.log(renderLineOption(o, labelWidth));
    const answer = await ask(rl, `${P.dim(G.rail)}  ${prompt}`);
    return answer.trim();
  }

  return rawSelect(rl, { title, header, options, labelWidth, backKey, initialKey });
}

function rawSelect(rl, { title, header, options, labelWidth, backKey, initialKey }) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const out = process.stdout;
    let idx = initialKey != null ? options.findIndex(o => o.key === initialKey) : -1;
    if (idx === -1) idx = Math.max(0, options.findIndex(o => o.key !== backKey));
    if (idx === -1) idx = 0;

    // readline의 data 소비를 잠시 걷어내고 raw 키 입력을 직접 처리한다.
    const savedData = stdin.listeners('data');
    const savedKeypress = stdin.listeners('keypress');
    const wasRaw = !!stdin.isRaw;
    stdin.removeAllListeners('data');
    stdin.removeAllListeners('keypress');
    stdin.setRawMode(true);
    stdin.resume();

    const bodyLines = header.length + (header.length ? 1 : 0) + options.length;
    const blockLines = 1 + bodyLines; // title row + body — the full repainted block

    const paint = (first = false) => {
      // Clamp every painted line to the terminal width (1-col margin) so no line
      // wraps — a wrapped line spans 2+ physical rows and desyncs the fixed
      // cursor-up, walking the menu down the screen on narrow terminals. Read
      // columns each paint so a mid-navigation resize self-corrects. The TITLE is
      // repainted with the body (not printed once) so its one-row guarantee also
      // survives a resize — otherwise finish()'s collapse would misalign on it.
      const cols = Math.max(1, (out.columns || 80) - 1);
      if (first) out.write('\n');             // one-time blank separator above the block
      else out.write(`\x1b[${blockLines}A`);  // back up to the title row
      out.write(`\x1b[2K${clampAnsi(`${P.cyan(G.active)} ${P.bold(title)}`, cols)}\n`);
      for (const h of header) out.write(`\x1b[2K${clampAnsi(`${P.dim(G.rail)}  ${h}`, cols)}\n`);
      if (header.length) out.write(`\x1b[2K${P.dim(G.rail)}\n`);
      options.forEach((o, i) => {
        out.write(`\x1b[2K${clampAnsi(`  ${renderOption(o, { active: i === idx, labelWidth })}`, cols)}\n`);
      });
    };

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      for (const f of savedData) stdin.on('data', f);
      for (const f of savedKeypress) stdin.on('keypress', f);
    };

    const finish = (key, label) => {
      cleanup();
      // 목록을 접고 결과 한 줄로 치환 (clack collapse). Clear the whole block
      // (title + body) and write the result on the title row. Clamp it too, and
      // drive off blockLines so a resized/re-wrapped title can't misalign it.
      const cols = Math.max(1, (out.columns || 80) - 1);
      out.write(`\x1b[${blockLines}A`);                          // up to the title row
      for (let i = 0; i < blockLines; i++) out.write('\x1b[2K\x1b[1B'); // clear the block
      out.write(`\x1b[${blockLines}A`);                          // back to the title row
      out.write(`\x1b[2K${clampAnsi(`${P.cyan(G.section)} ${P.bold(title)}  ${P.cyan(label)}`, cols)}\n`);
      resolve(key);
    };

    const onData = (buf) => {
      const s = buf.toString('utf8');
      if (s === '\x03') { // Ctrl-C → 위저드 중단 (FM3: 저장된 항목 유지)
        cleanup();
        out.write('\n');
        rl.close();
        reject(new WizardEOF());
        return;
      }
      if (s === '\r' || s === '\n') { finish(options[idx].key, options[idx].label); return; }
      if (s === '\x1b' || s === 'q') { // Esc / q → 뒤로
        const back = options.find(o => o.key === backKey);
        finish(backKey, back ? back.label : '');
        return;
      }
      if (s === '\x1b[A' || s === 'k') idx = (idx - 1 + options.length) % options.length;
      else if (s === '\x1b[B' || s === 'j') idx = (idx + 1) % options.length;
      else {
        // 숫자 즉시선택 — 단, 다른 키의 접두어면(예: '1' vs '10') 오선택 방지 위해 스킵
        const hit = options.findIndex(o => o.key === s);
        const ambiguous = options.some(o => o.key !== s && o.key.startsWith(s));
        if (hit !== -1 && !ambiguous) { finish(options[hit].key, options[hit].label); return; }
        return;
      }
      paint();
    };

    paint(true);
    stdin.on('data', onData);
  });
}

// ── confirm — y/N (line 기반; 테스트 계약 유지) ──────────────────────────

export async function confirmYN(rl, message, { yes = 'y', prompt = '(y/N): ' } = {}) {
  const answer = (await ask(rl, `${message} ${prompt}`)).trim().toLowerCase();
  return answer === yes;
}
