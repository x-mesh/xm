#!/usr/bin/env node
// @ts-check

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function parsePathToken(value, start) {
  let index = start;
  while (value[index] === ' ') index += 1;
  if (value[index] !== '"') {
    const end = value.indexOf(' ', index);
    return { value: value.slice(index, end < 0 ? value.length : end), end: end < 0 ? value.length : end };
  }
  index += 1;
  const bytes = [];
  const encoder = new TextEncoder();
  const escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
  while (index < value.length && value[index] !== '"') {
    if (value[index] !== '\\') { bytes.push(...encoder.encode(value[index++])); continue; }
    index += 1;
    const octal = value.slice(index).match(/^[0-7]{1,3}/);
    if (octal) { bytes.push(Number.parseInt(octal[0], 8)); index += octal[0].length; }
    else { const escaped = value[index++]; bytes.push(escapes[escaped] ?? escaped.charCodeAt(0)); }
  }
  return { value: new TextDecoder().decode(Uint8Array.from(bytes)), end: index + 1 };
}

function sectionPath(header) {
  const body = header.slice('diff --git '.length);
  const first = parsePathToken(body, 0);
  const second = parsePathToken(body, first.end);
  return second.value.startsWith('b/') ? second.value.slice(2) : null;
}

export function splitFrozenSections(patch) {
  const sections = [];
  let current = null;
  for (const line of String(patch).split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current) sections.push({ file: current.file, body: current.lines.join('\n') + '\n' });
      current = { file: sectionPath(line), lines: [line] };
    } else if (current) current.lines.push(line);
  }
  if (current) sections.push({ file: current.file, body: current.lines.join('\n') + '\n' });
  return sections.filter((entry) => entry.file);
}

export function buildRetryTarget(patch, { attempt = 0, evidence = '', files = [] } = {}) {
  if (!Number.isInteger(attempt) || attempt < 0) return { ok: false, reason: 'invalid_attempt' };
  if (attempt >= 1) return { ok: false, reason: 'retry_limit', retry_count: attempt };
  const sections = splitFrozenSections(patch);
  if (!sections.length) return { ok: false, reason: 'unsectioned_target' };
  const targetFiles = sections.map((entry) => entry.file);
  const candidates = files.length ? files : targetFiles.filter((file) => String(evidence).includes(file));
  const requested = [...new Set(candidates.map((file) => String(file).replace(/^\.\//, '').replace(/\\/g, '/')).filter((file) => targetFiles.includes(file)))];
  if (!requested.length) return { ok: false, reason: 'unsafe_scope', target_files: targetFiles };
  if (requested.length >= targetFiles.length) return { ok: false, reason: 'full_target_retry_forbidden', target_files: targetFiles };
  const selected = sections.filter((entry) => requested.includes(entry.file));
  if (selected.length !== requested.length) return { ok: false, reason: 'missing_frozen_section', target_files: requested };
  return { ok: true, retry_count: 1, target_files: requested, omitted_files: targetFiles.filter((file) => !requested.includes(file)), patch: selected.map((entry) => entry.body).join('') };
}

export function main(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || argv[i + 1] === undefined) return 2;
    args[argv[i].slice(2)] = argv[i + 1];
  }
  if (!args.target || !args.evidence || !args.out) return 2;
  try {
    const result = buildRetryTarget(readFileSync(resolve(args.target), 'utf8'), { attempt: Number(args.attempt || 0), evidence: readFileSync(resolve(args.evidence), 'utf8') });
    if (!result.ok) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return 1; }
    writeFileSync(resolve(args.out), result.patch);
    process.stdout.write(JSON.stringify({ ok: true, retry_count: result.retry_count, target_files: result.target_files, omitted_files: result.omitted_files, out: resolve(args.out) }, null, 2) + '\n');
    return 0;
  } catch (error) { process.stderr.write('retry target failed: ' + error.message + '\n'); return 2; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main();
