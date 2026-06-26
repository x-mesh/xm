/**
 * x-recall/render — format artifact records for the terminal (or JSON).
 */

import { C, readText } from './core.mjs';
import { readableContent } from './scan.mjs';

function row(a) {
  const date = String(a.created_at || '').slice(0, 10).padEnd(10);
  const type = String(a.type || '').padEnd(8);
  const status = String(a.status || '').replace(/\s+/g, ' ').slice(0, 16).padEnd(16);
  const title = String(a.title || '').replace(/\s+/g, ' ').slice(0, 50);
  return `${C.dim}${date}${C.reset}  ${C.cyan}${type}${C.reset}  ${C.yellow}${status}${C.reset}  ${title}  ${C.dim}${a.id}${C.reset}`;
}

export function renderList(arts, { json = false, limit } = {}) {
  if (json) return JSON.stringify(arts, null, 2);
  if (!arts.length) {
    return `No artifacts found under .xm/.\n${C.dim}Run an x-op / x-review / x-build session first, or check the directory.${C.reset}`;
  }
  const shown = limit ? arts.slice(0, limit) : arts;
  const header = `${'DATE'.padEnd(10)}  ${'TYPE'.padEnd(8)}  ${'STATUS'.padEnd(16)}  TITLE  ·  ID`;
  const footer = `${C.dim}${shown.length} of ${arts.length} artifact(s).  read one: ${C.reset}xm recall show <id>`;
  return [`${C.bold}${header}${C.reset}`, ...shown.map(row), '', footer].join('\n');
}

export function renderSearch(arts, query, { json = false } = {}) {
  if (json) return JSON.stringify(arts, null, 2);
  if (!arts.length) return `No artifacts match "${query}".`;
  const header = `${C.bold}${arts.length} match(es) for "${query}"${C.reset}`;
  return [header, '', ...arts.map(row)].join('\n');
}

export function renderShow(art, { json = false } = {}) {
  if (!art) return null;
  if (json) {
    // For JSON-format artifacts, emit the raw file verbatim.
    if (art.format === 'json') {
      const raw = readText(art.path);
      if (raw != null) return raw;
    }
    const { text } = readableContent(art);
    return JSON.stringify({ ...art, content: text }, null, 2);
  }
  const { path, text } = readableContent(art);
  const head = [
    `${C.dim}# ${art.type} · ${art.id}${C.reset}`,
    `${C.dim}# ${art.created_at}${art.status ? ' · ' + art.status : ''}${C.reset}`,
    `${C.dim}# ${path}${C.reset}`,
  ].join('\n');
  return `${head}\n\n${text}`;
}
