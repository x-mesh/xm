#!/usr/bin/env node
// @ts-check

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROFILE_ORDER = ['correctness', 'risk', 'migrations', 'type-design', 'docs'];

function unique(values) {
  return [...new Set(values)];
}

function parseGitPathToken(value, start) {
  let index = start;
  while (value[index] === ' ') index += 1;
  if (value[index] !== '"') {
    const end = value.indexOf(' ', index);
    return { value: value.slice(index, end === -1 ? value.length : end), end: end === -1 ? value.length : end };
  }

  index += 1;
  const bytes = [];
  const encoder = new TextEncoder();
  const escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
  while (index < value.length && value[index] !== '"') {
    if (value[index] !== '\\') {
      bytes.push(...encoder.encode(value[index]));
      index += 1;
      continue;
    }
    index += 1;
    const octal = value.slice(index).match(/^[0-7]{1,3}/);
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += octal[0].length;
    } else {
      const escaped = value[index];
      bytes.push(escapes[escaped] ?? escaped.charCodeAt(0));
      index += 1;
    }
  }
  return { value: new TextDecoder().decode(Uint8Array.from(bytes)), end: index + 1 };
}

function gitDiffPaths(line) {
  if (!line.startsWith('diff --git ')) return null;
  const body = line.slice('diff --git '.length);
  const first = parseGitPathToken(body, 0);
  const second = parseGitPathToken(body, first.end);
  if (!first.value.startsWith('a/') || !second.value.startsWith('b/')) return null;
  return [first.value.slice(2), second.value.slice(2)];
}

export function changedFilesFromPatch(patch) {
  const files = [];
  for (const line of String(patch).split('\n')) {
    const diff = gitDiffPaths(line);
    if (diff) {
      files.push(diff[1]);
      continue;
    }
    const added = line.match(/^\+\+\+ b\/(.+)$/);
    if (added) files.push(added[1]);
  }
  return unique(files.filter((file) => file !== '/dev/null'));
}

export function planReview(patch, options = {}) {
  const body = String(patch);
  const explicitFiles = Array.isArray(options.targetFiles)
    ? options.targetFiles.map((file) => String(file).replace(/^\.\//, '').replace(/\\/g, '/')).filter(Boolean)
    : [];
  const files = unique([...changedFilesFromPatch(body), ...explicitFiles]);
  const patchLines = body.split('\n');
  const isPatch = patchLines.some((line) => line.startsWith('diff --git '));
  const added = isPatch
    ? patchLines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).join('\n')
    : patchLines.map((line) => `+${line}`).join('\n');
  const selected = new Map([
    ['correctness', 'default core: logic, errors, tests, and silent failures'],
    ['risk', 'default core: security, performance, and architecture'],
  ]);

  const migrationPath = files.some((file) => {
    const examplePath = /(^|\/)(tests?|__tests__|fixtures?|docs?)(\/|$)|\.(test|spec)\.[^/]+$/i.test(file);
    const schemaPath = /(^|\/)(migrations?|alembic|db|prisma)(\/|$)|(^|\/)schema\.(prisma|sql|rb|py|ts|js|json|ya?ml)$|\.sql$/i.test(file);
    return !examplePath && schemaPath;
  });
  if (migrationPath) selected.set('migrations', 'schema, migration, or SQL file changed');

  const typedFiles = files.some((file) => /\.(ts|tsx|py|go|rs|java|kt)$/i.test(file));
  const exportedDeclaration = /^\+\s*export\s+(?:(?:default\s+)?(?:async\s+)?function\b|(?:default\s+)?class\b|(?:interface|type|enum|const|let|var)\b|default\b|(?:\*|\{))/m.test(added);
  const boundaryChange = exportedDeclaration
    || /^\+(?:export\s+)?(?:interface|type|enum|class|def|func|fn)\b|^\+.*\b(public|readonly|Optional|Result<|Promise<)\b/m.test(added);
  if (typedFiles && boundaryChange) selected.set('type-design', 'typed public boundary changed');

  const publicApiChange = exportedDeclaration
    || /^\+.*(?:\bpublic\s+(?:class|interface|fun|func)\b|\brouter\.|\bapp\.(?:get|post|put|patch|delete)\b|\bopenapi\b|\bgraphql\b)/im.test(added);
  const docsTouched = files.some((file) => /(^|\/)(README[^/]*|docs?\/|.*\.md$)/i.test(file));
  if (publicApiChange && !docsTouched) selected.set('docs', 'public API changed without documentation in the target');

  const requestedMax = Number.isInteger(options.maxProfiles) ? options.maxProfiles : 4;
  const maxProfiles = Math.max(2, Math.min(PROFILE_ORDER.length, requestedMax));
  const profiles = PROFILE_ORDER.filter((profile) => selected.has(profile)).slice(0, maxProfiles).map((profile, index) => ({
    profile,
    report_id: `${profile}-1`,
    reason: selected.get(profile),
    wave: 1,
    order: index + 1,
  }));

  const changedLines = isPatch
    ? patchLines.filter((line) => /^[+-]/.test(line) && !/^(---|\+\+\+)/.test(line)).length
    : patchLines.filter((line) => line.trim().length > 0).length;
  return {
    schema_version: 1,
    mode: 'adaptive-fast',
    files,
    changed_lines: changedLines,
    profiles,
    expected_reports: profiles.map(({ report_id, profile }) => ({ report_id, lens: profile })),
    estimated_llm_waves: 1,
    max_profiles: maxProfiles,
    requires_chunking: changedLines > 2000 || files.length > 100,
  };
}

function usage() {
  return 'Usage: node plan-review.mjs --target <content-file> [--target-file <path> ...] [--max-profiles <2-5>]';
}

export function main(argv = process.argv.slice(2)) {
  const args = { targetFiles: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (!['--target', '--target-file', '--max-profiles'].includes(argv[i]) || !argv[i + 1]) {
      process.stderr.write(`${usage()}\n`);
      return 2;
    }
    const key = argv[i].slice(2);
    const value = argv[++i];
    if (key === 'target-file') args.targetFiles.push(value);
    else args[key] = value;
  }
  const maxProfiles = args['max-profiles'] === undefined ? 4 : Number(args['max-profiles']);
  if (!args.target || !Number.isInteger(maxProfiles) || maxProfiles < 2 || maxProfiles > 5) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  try {
    const patch = readFileSync(resolve(args.target), 'utf8');
    process.stdout.write(`${JSON.stringify(planReview(patch, { maxProfiles, targetFiles: args.targetFiles }), null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`x-review planning failed: ${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
