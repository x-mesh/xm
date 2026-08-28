#!/usr/bin/env node
// @ts-check

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROFILE_ORDER = ['correctness', 'risk', 'migrations', 'type-design', 'docs'];
const DEFAULT_CHUNK_TOKEN_BUDGET = 24_000;
const DEFAULT_CHUNK_FILE_BUDGET = 100;
const TOKEN_ESTIMATE_BYTES_PER_TOKEN = 3;

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

export function estimateTargetTokens(value) {
  return Math.max(1, Math.ceil(Buffer.byteLength(String(value), 'utf8') / TOKEN_ESTIMATE_BYTES_PER_TOKEN));
}

function targetHash(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

function patchSections(body) {
  const lines = String(body).split('\n');
  const starts = [];
  lines.forEach((line, index) => {
    if (line.startsWith('diff --git ')) starts.push(index);
  });
  if (starts.length === 0) return [{ body: String(body), files: [] }];
  return starts.map((start, index) => {
    const section = lines.slice(start, starts[index + 1] ?? lines.length).join('\n');
    return { body: section, files: changedFilesFromPatch(section) };
  });
}

function normalizedRoot(value) {
  const root = String(value).replace(/^\.\//, '').replace(/\\/g, '/').replace(/^\/+/, '');
  return root && !root.endsWith('/') ? `${root}/` : root;
}

function pathInRoot(file, root) {
  const normalized = String(file).replace(/^\.\//, '').replace(/\\/g, '/');
  return normalizedRoot(root) === '' || normalized.startsWith(normalizedRoot(root));
}

function reviewSignature(section) {
  const lines = String(section.body).split('\n');
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'));
  if (firstHunk < 0) return null;
  const content = lines.slice(firstHunk).filter((line) => !line.startsWith('@@'));
  while (content.at(-1)?.trim() === '') content.pop();
  return content.join('\n');
}

/**
 * Remove configured generated-root sections only when the same textual change
 * exists outside every configured root. The source twin remains reviewable.
 */
export function filterGeneratedCopies(body, generatedCopyRoots = []) {
  const target = String(body);
  const roots = unique(generatedCopyRoots.map(normalizedRoot).filter(Boolean));
  if (roots.length === 0 || !target.split('\n').some((line) => line.startsWith('diff --git '))) {
    return { body: target, excluded: [] };
  }
  const sections = patchSections(target);
  const signatures = new Map();
  for (const section of sections) {
    const signature = reviewSignature(section);
    if (!signature) continue;
    const entries = signatures.get(signature) || [];
    entries.push(section);
    signatures.set(signature, entries);
  }
  const excluded = [];
  const kept = sections.filter((section) => {
    const file = section.files[0];
    if (!file || !roots.some((root) => pathInRoot(file, root))) return true;
    const signature = reviewSignature(section);
    const twin = (signatures.get(signature) || []).find((candidate) => {
      const candidateFile = candidate.files[0];
      return candidateFile
        && basename(candidateFile) === basename(file)
        && !roots.some((root) => pathInRoot(candidateFile, root));
    });
    if (!twin) return true;
    excluded.push({ file, source_file: twin.files[0] });
    return false;
  });
  return { body: kept.map((section) => section.body).join('\n'), excluded };
}

function splitOversizedSection(section, tokenBudget) {
  const lines = section.body.split('\n');
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'));
  if (firstHunk < 0) return [];
  const header = lines.slice(0, firstHunk);
  const hunkStarts = [];
  lines.forEach((line, index) => {
    if (index >= firstHunk && line.startsWith('@@')) hunkStarts.push(index);
  });
  const units = [];
  for (let index = 0; index < hunkStarts.length; index += 1) {
    const start = hunkStarts[index];
    const end = hunkStarts[index + 1] ?? lines.length;
    const hunkHeader = lines[start];
    const hunkLines = lines.slice(start + 1, end);
    let part = [hunkHeader];
    for (const line of hunkLines) {
      const candidate = [...header, ...part, line].join('\n');
      if (part.length > 1 && estimateTargetTokens(candidate) > tokenBudget) {
        units.push({ body: [...header, ...part].join('\n'), files: section.files, split: 'hunk-fragment' });
        part = [hunkHeader, line];
      } else {
        part.push(line);
      }
    }
    if (part.length > 1) units.push({ body: [...header, ...part].join('\n'), files: section.files, split: 'hunk' });
  }
  return units.every((unit) => estimateTargetTokens(unit.body) <= tokenBudget) ? units : [];
}

function splitRawTarget(body, tokenBudget, files) {
  const units = [];
  let lines = [];
  for (const line of String(body).split('\n')) {
    const candidate = [...lines, line].join('\n');
    if (lines.length > 0 && estimateTargetTokens(candidate) > tokenBudget) {
      units.push({ body: lines.join('\n'), files, split: 'line-range' });
      lines = [line];
    } else {
      lines.push(line);
    }
  }
  if (lines.length > 0) units.push({ body: lines.join('\n'), files, split: 'line-range' });
  return units.every((unit) => estimateTargetTokens(unit.body) <= tokenBudget) ? units : [];
}

export function chunkFrozenTarget(body, tokenBudget = DEFAULT_CHUNK_TOKEN_BUDGET, options = {}) {
  if (!Number.isInteger(tokenBudget) || tokenBudget < 1_000) {
    throw new Error('chunk token budget must be an integer of at least 1000');
  }
  const target = String(body);
  const explicitFiles = Array.isArray(options.targetFiles) ? options.targetFiles : [];
  const fileBudget = Number.isInteger(options.fileBudget) ? options.fileBudget : DEFAULT_CHUNK_FILE_BUDGET;
  if (fileBudget < 1) throw new Error('chunk file budget must be a positive integer');
  const targetFiles = unique([...changedFilesFromPatch(target), ...explicitFiles]);
  if (estimateTargetTokens(target) <= tokenBudget && targetFiles.length <= fileBudget) {
    return [{ id: 'chunk-001', body: target, files: targetFiles, split: 'whole-target' }];
  }

  const units = [];
  const sections = patchSections(target);
  if (sections.length === 1 && sections[0].files.length === 0) {
    units.push(...splitRawTarget(target, tokenBudget, explicitFiles));
  }
  for (const section of sections.filter((entry) => entry.files.length > 0)) {
    if (estimateTargetTokens(section.body) <= tokenBudget) {
      units.push({ ...section, split: 'file' });
      continue;
    }
    const split = splitOversizedSection(section, tokenBudget);
    if (split.length === 0) return [];
    units.push(...split);
  }

  const chunks = [];
  let current = [];
  for (const unit of units) {
    const candidate = [...current, unit];
    const candidateBody = candidate.map((entry) => entry.body).join('\n');
    const candidateFiles = unique(candidate.flatMap((entry) => entry.files));
    if (current.length > 0
      && (estimateTargetTokens(candidateBody) > tokenBudget || candidateFiles.length > fileBudget)) {
      chunks.push(current);
      current = [unit];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks.map((entries, index) => ({
    id: `chunk-${String(index + 1).padStart(3, '0')}`,
    body: entries.map((entry) => entry.body).join('\n'),
    files: unique(entries.flatMap((entry) => entry.files)),
    split: entries.some((entry) => entry.split === 'hunk-fragment')
      ? 'hunk-fragment'
      : entries.some((entry) => entry.split === 'hunk') ? 'hunk' : 'file',
  }));
}

export function planReview(patch, options = {}) {
  const filtered = filterGeneratedCopies(patch, options.generatedCopyRoots);
  const body = filtered.body;
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
    ['risk', 'default core: security, performance, architecture, and setup paths'],
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
  const profileDefinitions = PROFILE_ORDER.filter((profile) => selected.has(profile)).slice(0, maxProfiles).map((profile, index) => ({
    profile,
    reason: selected.get(profile),
    wave: 1,
    order: index + 1,
  }));

  const changedLines = isPatch
    ? patchLines.filter((line) => /^[+-]/.test(line) && !/^(---|\+\+\+)/.test(line)).length
    : patchLines.filter((line) => line.trim().length > 0).length;
  const requestedBudget = Number.isInteger(options.chunkTokenBudget) ? options.chunkTokenBudget : DEFAULT_CHUNK_TOKEN_BUDGET;
  const tokenBudget = Math.max(1_000, requestedBudget);
  const requestedFileBudget = Number.isInteger(options.chunkFileBudget) ? options.chunkFileBudget : DEFAULT_CHUNK_FILE_BUDGET;
  const fileBudget = Math.max(1, requestedFileBudget);
  const hasReviewableChange = changedLines > 0 || (isPatch && files.length > 0);
  if (!hasReviewableChange) {
    return {
      schema_version: 1,
      mode: 'no-changes',
      files,
      changed_lines: 0,
      estimated_target_tokens: 0,
      token_estimate: { method: 'utf8-bytes/3', bytes_per_token: TOKEN_ESTIMATE_BYTES_PER_TOKEN },
      chunk_token_budget: tokenBudget,
      chunk_file_budget: fileBudget,
      chunked: false,
      chunks: [],
      profiles: [],
      expected_reports: [],
      estimated_llm_waves: 0,
      max_profiles: maxProfiles,
      requires_chunking: false,
      reviewable: false,
      no_changes: true,
    };
  }
  const estimatedTokens = estimateTargetTokens(body);
  const targetChunks = chunkFrozenTarget(body, tokenBudget, { targetFiles: explicitFiles, fileBudget });
  const chunkingFailed = targetChunks.length === 0;
  const chunks = targetChunks.map(({ body: chunkBody, ...chunk }) => ({
    ...chunk,
    target_hash: targetHash(chunkBody),
    estimated_target_tokens: estimateTargetTokens(chunkBody),
    target_file: `chunks/${chunk.id}.patch`,
  }));
  const chunked = chunks.length > 1;
  const profiles = profileDefinitions.map((profile) => ({
    ...profile,
    ...(!chunked && chunks.length === 1 ? { report_id: `${profile.profile}-1` } : {}),
    report_ids: chunks.map((chunk) => chunked ? `${profile.profile}-${chunk.id}` : `${profile.profile}-1`),
  }));
  const reportsPerChunk = Math.max(1, profileDefinitions.length);
  const maxConcurrentReports = Number.isInteger(options.maxConcurrentReports)
    ? Math.max(reportsPerChunk, options.maxConcurrentReports)
    : maxProfiles;
  const chunksPerWave = Math.max(1, Math.floor(maxConcurrentReports / reportsPerChunk));
  const expectedReports = profileDefinitions.flatMap(({ profile }) => chunks.map((chunk, chunkIndex) => ({
    report_id: chunked ? `${profile}-${chunk.id}` : `${profile}-1`,
    lens: profile,
    ...(chunked ? {
      chunk_id: chunk.id,
      wave: Math.floor(chunkIndex / chunksPerWave) + 1,
      target_hash: chunk.target_hash,
      target_file: chunk.target_file,
      ...(chunk.files.length > 0 ? { target_files: chunk.files } : {}),
    } : {}),
  })));
  return {
    schema_version: 1,
    mode: 'adaptive-fast',
    ...(filtered.excluded.length > 0 ? { excluded_generated_copies: filtered.excluded } : {}),
    files,
    changed_lines: changedLines,
    estimated_target_tokens: estimatedTokens,
    token_estimate: { method: 'utf8-bytes/3', bytes_per_token: TOKEN_ESTIMATE_BYTES_PER_TOKEN },
    chunk_token_budget: tokenBudget,
    chunk_file_budget: fileBudget,
    chunked,
    chunks,
    profiles,
    expected_reports: expectedReports,
    max_concurrent_reports: maxConcurrentReports,
    chunks_per_wave: chunksPerWave,
    estimated_llm_waves: Math.max(1, Math.ceil(chunks.length / chunksPerWave)),
    max_profiles: maxProfiles,
    requires_chunking: chunked,
    reviewable: !chunkingFailed,
    ...(chunkingFailed ? { incomplete_reason: 'target cannot be split within the token budget' } : {}),
  };
}

function usage() {
  return 'Usage: node plan-review.mjs --target <content-file> [--target-file <path> ...] [--max-profiles <2-5>] [--chunk-token-budget <tokens>] [--chunk-file-budget <files>] [--config <path>] [--filtered-target <path>] [--chunks-dir <dir>]';
}

const CLI_OPTIONS = new Set([
  '--target', '--target-file', '--max-profiles', '--chunk-token-budget',
  '--chunk-file-budget', '--config', '--filtered-target', '--chunks-dir',
]);

function cliError(message) {
  process.stderr.write(`plan-review: ${message}\n${usage()}\n`);
  return 2;
}

function unsupportedOptionMessage(option) {
  if (option === '--agent-max-count') return 'unknown option: --agent-max-count; did you mean --max-profiles?';
  if (option === '--run-dir') return 'unknown option: --run-dir; use --filtered-target and --chunks-dir to select output paths';
  if (option === '--json') return 'unknown option: --json; the command already writes JSON to stdout';
  return `unknown option: ${option}`;
}

export function main(argv = process.argv.slice(2)) {
  const args = { targetFiles: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (!CLI_OPTIONS.has(argv[i])) return cliError(unsupportedOptionMessage(argv[i]));
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) return cliError(`option requires a value: ${argv[i]}`);
    const key = argv[i].slice(2);
    const value = argv[++i];
    if (key === 'target-file') args.targetFiles.push(value);
    else args[key] = value;
  }
  if (!args.target) {
    const targetHint = args.targetFiles.length > 0
      ? '; use --target for the frozen content file (--target-file only labels source paths)'
      : '';
    return cliError(`missing required option: --target${targetHint}`);
  }
  const maxProfiles = args['max-profiles'] === undefined ? 4 : Number(args['max-profiles']);
  const chunkTokenBudget = args['chunk-token-budget'] === undefined
    ? DEFAULT_CHUNK_TOKEN_BUDGET
    : Number(args['chunk-token-budget']);
  const chunkFileBudget = args['chunk-file-budget'] === undefined
    ? DEFAULT_CHUNK_FILE_BUDGET
    : Number(args['chunk-file-budget']);
  if (!Number.isInteger(maxProfiles) || maxProfiles < 2 || maxProfiles > 5) {
    return cliError('--max-profiles must be an integer between 2 and 5');
  }
  if (!Number.isInteger(chunkTokenBudget) || chunkTokenBudget < 1_000) {
    return cliError('--chunk-token-budget must be an integer of at least 1000');
  }
  if (!Number.isInteger(chunkFileBudget) || chunkFileBudget < 1) {
    return cliError('--chunk-file-budget must be a positive integer');
  }
  try {
    const patch = readFileSync(resolve(args.target), 'utf8');
    const configPath = resolve(args.config || '.xm-review.json');
    const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
    if (config.generated_copy_roots !== undefined
      && (!Array.isArray(config.generated_copy_roots) || !config.generated_copy_roots.every((root) => typeof root === 'string' && root.trim()))) {
      throw new Error('generated_copy_roots must be an array of non-empty strings');
    }
    const generatedCopyRoots = config.generated_copy_roots || [];
    const filtered = filterGeneratedCopies(patch, generatedCopyRoots);
    const plan = planReview(patch, {
      maxProfiles, targetFiles: args.targetFiles, chunkTokenBudget, chunkFileBudget,
      maxConcurrentReports: maxProfiles, generatedCopyRoots,
    });
    if (args['filtered-target']) writeFileSync(resolve(args['filtered-target']), filtered.body);
    if (args['chunks-dir'] && plan.reviewable) {
      const chunksDir = resolve(args['chunks-dir']);
      mkdirSync(chunksDir, { recursive: true });
      for (const chunk of chunkFrozenTarget(filtered.body, chunkTokenBudget, { targetFiles: args.targetFiles, fileBudget: chunkFileBudget })) {
        writeFileSync(resolve(chunksDir, `${chunk.id}.patch`), chunk.body);
      }
    }
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`x-review planning failed: ${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
