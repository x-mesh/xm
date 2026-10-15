#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, 'coverage');
const BUN_DIR = join(OUT, 'bun');
const V8_DIR = join(OUT, 'v8-raw');
const C8_DIR = join(OUT, 'c8');
const SOURCE_GLOBS = ['x-*/lib/**/*.mjs', 'xm/lib/**/*.mjs', 'xm/scripts/*.mjs', 'scripts/*.mjs'];
const TOP_UNCOVERED = 30;

function sourceFiles() {
  // Without :(glob), git pathspecs need a directory under `**/`, which silently drops lib/*.mjs.
  const result = spawnSync('git', ['ls-files', '--', ...SOURCE_GLOBS.map(glob => `:(glob)${glob}`)], { cwd: REPO, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr.trim()}`);
  return result.stdout.trim().split('\n').filter(Boolean);
}

function readLcov(path) {
  const files = new Map();
  if (!existsSync(path)) {
    console.error(`ℹ no report at ${relative(REPO, path)} — no source file was loaded by that side`);
    return files;
  }
  let current = null;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.startsWith('SF:')) {
      const file = relative(REPO, resolve(REPO, line.slice(3)));
      current = files.get(file) || new Map();
      files.set(file, current);
    } else if (line.startsWith('DA:') && current) {
      const [lineNo, hits] = line.slice(3).split(',').map(Number);
      current.set(lineNo, (current.get(lineNo) || 0) + hits);
    }
  }
  return files;
}

// Bundle mirrors (x-build/lib/... → xm/lib/...) are byte-identical copies, and a test may load
// either one. Grouping by content, not by path convention, merges only copies whose line
// numbers provably match; a copy that drifted out of sync is reported on its own.
function groupByContent(files) {
  const groups = new Map();
  for (const file of files) {
    const body = readFileSync(join(REPO, file));
    const hash = createHash('sha256').update(body).digest('hex');
    const group = groups.get(hash) || { paths: [], lines: body.toString('utf8').split('\n').length };
    group.paths.push(file);
    groups.set(hash, group);
  }
  return [...groups.values()].map(group => {
    const paths = group.paths.sort((a, b) => Number(a.startsWith('xm/')) - Number(b.startsWith('xm/')) || a.localeCompare(b));
    return { file: paths[0], mirrors: paths.slice(1), lines: group.lines };
  });
}

function summarize(groups, reports) {
  return groups.map(group => {
    const hits = new Map();
    for (const path of [group.file, ...group.mirrors]) {
      for (const report of reports) {
        for (const [lineNo, count] of report.get(path) || []) hits.set(lineNo, (hits.get(lineNo) || 0) + count);
      }
    }
    if (!hits.size) return { file: group.file, mirrors: group.mirrors, loaded: false, found: group.lines, hit: 0 };
    const hit = [...hits.values()].filter(count => count > 0).length;
    return { file: group.file, mirrors: group.mirrors, loaded: true, found: hits.size, hit };
  });
}

function pct(hit, found) {
  return found ? Math.round((100 * hit) / found) : 0;
}

function printReport(rows, testStatus) {
  const loaded = rows.filter(row => row.loaded);
  const found = loaded.reduce((sum, row) => sum + row.found, 0);
  const hit = loaded.reduce((sum, row) => sum + row.hit, 0);
  const unloadedLines = rows.filter(row => !row.loaded).reduce((sum, row) => sum + row.found, 0);
  console.log(`\nLine coverage (loaded files): ${pct(hit, found)}%  ${hit}/${found}`);
  console.log(`Line coverage (all files, not-loaded as 0%): ${pct(hit, found + unloadedLines)}%  ${hit}/${found + unloadedLines}`);

  const plugins = new Map();
  for (const row of loaded) {
    const plugin = row.file.split('/')[0];
    const entry = plugins.get(plugin) || { found: 0, hit: 0 };
    entry.found += row.found;
    entry.hit += row.hit;
    plugins.set(plugin, entry);
  }
  console.log('\nBy plugin (uncovered lines, coverage):');
  for (const [plugin, entry] of [...plugins].sort((a, b) => (b[1].found - b[1].hit) - (a[1].found - a[1].hit))) {
    console.log(`  ${plugin.padEnd(12)} ${String(entry.found - entry.hit).padStart(6)}  ${pct(entry.hit, entry.found)}%`);
  }

  console.log(`\nMost uncovered lines (top ${TOP_UNCOVERED}):`);
  for (const row of [...loaded].sort((a, b) => (b.found - b.hit) - (a.found - a.hit)).slice(0, TOP_UNCOVERED)) {
    console.log(`  ${String(pct(row.hit, row.found)).padStart(3)}%  ${String(row.found - row.hit).padStart(5)}  ${row.file}`);
  }

  const unloaded = rows.filter(row => !row.loaded).sort((a, b) => b.found - a.found);
  console.log(`\nNot loaded by any measured process (${unloaded.length}) — untested, or run only under bun subprocesses, which V8 coverage cannot see:`);
  for (const row of unloaded) console.log(`  ${String(row.found).padStart(5)} lines  ${row.file}`);

  if (testStatus !== 0) console.error(`\n⚠ bun test exited ${testStatus}; coverage reflects the tests that ran.`);
}

function main(testArgs) {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(V8_DIR, { recursive: true });

  const tests = spawnSync('bun', ['test', '--coverage', '--coverage-reporter=lcov', '--coverage-dir', BUN_DIR, ...testArgs], {
    cwd: REPO,
    stdio: 'inherit',
    env: { ...process.env, NODE_V8_COVERAGE: V8_DIR },
  });
  if (tests.error) throw tests.error;

  const c8 = spawnSync(join(REPO, 'node_modules', '.bin', 'c8'), [
    'report', '--temp-directory', V8_DIR, '--reports-dir', C8_DIR, '--reporter=lcovonly',
    '--src', REPO, '--exclude-after-remap=false', ...SOURCE_GLOBS.flatMap(glob => ['--include', glob]),
  ], { cwd: REPO, stdio: 'inherit' });
  if (c8.error) throw new Error(`c8 unavailable (run bun install): ${c8.error.message}`);
  if (c8.status !== 0) throw new Error(`c8 report exited ${c8.status}`);
  rmSync(V8_DIR, { recursive: true, force: true });

  const reports = [readLcov(join(BUN_DIR, 'lcov.info')), readLcov(join(C8_DIR, 'lcov.info'))];
  const rows = summarize(groupByContent(sourceFiles()), reports);
  writeFileSync(join(OUT, 'summary.json'), `${JSON.stringify({ test_status: tests.status, files: rows }, null, 2)}\n`);
  printReport(rows, tests.status);
  console.log(`\nWritten: ${relative(REPO, join(OUT, 'summary.json'))}`);
  process.exitCode = tests.status ?? 1;
}

main(process.argv.slice(2));
