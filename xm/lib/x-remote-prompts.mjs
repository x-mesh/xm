import { stdin, stdout } from 'node:process';

const tty = Boolean(stdin.isTTY && stdout.isTTY && typeof stdin.setRawMode === 'function');
const color = (code, value) => tty ? `\x1b[${code}m${value}\x1b[0m` : value;
const C = { cyan: (v) => color(36, v), dim: (v) => color(2, v), bold: (v) => color(1, v) };
const G = { section: '◇', active: '◆', rail: '│', on: '●', off: '○', cursor: '❯', end: '└' };

export class PromptAbort extends Error {}

export function printSection(title, subtitle = '') {
  console.log(`\n${C.cyan(G.section)} ${C.bold(title)}${subtitle ? `  ${C.dim(subtitle)}` : ''}`);
}

export function printRail(text = '') { console.log(`${C.dim(G.rail)}  ${text}`); }

function lineSelect(rl, { title, header = [], options }) {
  console.log(`\n${C.cyan(G.active)} ${C.bold(title)}`);
  for (const line of header) printRail(line);
  if (header.length) printRail();
  const width = Math.max(...options.map((o) => o.label.length));
  for (const option of options) console.log(`${C.dim(G.rail)}  ${C.bold(`${option.key})`)} ${option.label.padEnd(width)}${option.hint ? `  ${C.dim(option.hint)}` : ''}`);
  return rl.question(`${C.dim(G.rail)}  선택: `).then((value) => value.trim());
}

export function menuSelect(rl, { title, subtitle = '', header = [], options, initialKey = null }) {
  if (!tty) return lineSelect(rl, { title, header, options });
  return new Promise((resolve, reject) => {
    let index = Math.max(0, options.findIndex((o) => o.key === initialKey));
    const savedData = stdin.listeners('data');
    const savedKeypress = stdin.listeners('keypress');
    const wasRaw = Boolean(stdin.isRaw);
    stdin.removeAllListeners('data'); stdin.removeAllListeners('keypress'); stdin.setRawMode(true); stdin.resume();
    const bodyLines = 1 + header.length + (header.length ? 1 : 0) + options.length;
    const paint = (first = false) => {
      if (first) stdout.write('\n'); else stdout.write(`\x1b[${bodyLines}A`);
      stdout.write(`\x1b[2K${C.cyan(G.active)} ${C.bold(title)}${subtitle ? `  ${C.dim(subtitle)}` : ''}\n`);
      for (const line of header) stdout.write(`\x1b[2K${C.dim(G.rail)}  ${line}\n`);
      if (header.length) stdout.write(`\x1b[2K${C.dim(G.rail)}\n`);
      for (const [i, option] of options.entries()) {
        const active = i === index;
        stdout.write(`\x1b[2K  ${active ? C.cyan(G.cursor) : ' '} ${active ? C.cyan(G.on) : C.dim(G.off)} ${active ? C.cyan(option.label) : option.label}${option.hint ? `  ${C.dim(option.hint)}` : ''}\n`);
      }
    };
    const cleanup = () => {
      stdin.removeListener('data', onData); stdin.setRawMode(wasRaw);
      for (const listener of savedData) stdin.on('data', listener);
      for (const listener of savedKeypress) stdin.on('keypress', listener);
    };
    const finish = (key) => {
      cleanup(); stdout.write(`\x1b[${bodyLines}A`);
      for (let i = 0; i < bodyLines; i++) stdout.write('\x1b[2K\x1b[1B');
      stdout.write(`\x1b[${bodyLines}A\x1b[2K${C.cyan(G.section)} ${C.bold(title)}  ${C.cyan(options[index].label)}\n`);
      resolve(key);
    };
    const onData = (buffer) => {
      const value = buffer.toString('utf8');
      if (value === '\x03') { cleanup(); stdout.write('\n'); rl.close(); reject(new PromptAbort()); return; }
      if (value === '\r' || value === '\n') return finish(options[index].key);
      if (value === 'q' || value === '\x1b') { cleanup(); stdout.write('\n'); resolve('0'); return; }
      if (value === '\x1b[A' || value === 'k') index = (index + options.length - 1) % options.length;
      else if (value === '\x1b[B' || value === 'j') index = (index + 1) % options.length;
      else if (/^[1-9]$/.test(value) && Number(value) <= options.length) index = Number(value) - 1;
      else return;
      paint();
    };
    stdin.on('data', onData); paint(true);
  });
}
