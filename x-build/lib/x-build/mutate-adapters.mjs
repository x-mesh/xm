// External mutation-tool adapters for `xm mutate`.
//
// xm does not generate or run mutants itself. Each tool below parses its
// language properly, runs mutants away from the working tree, and separates a
// mutant that no longer builds from one the tests caught. An adapter only
// decides where the tool runs, how the change set reaches it, and how its
// report maps onto the shared status vocabulary.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

export const MUTANT_STATUSES = Object.freeze(['killed', 'survived', 'timeout', 'unviable', 'no_coverage', 'skipped', 'error']);

// A `--version` call that hangs must not stall detection for every language.
const VERSION_PROBE_TIMEOUT_MS = 30_000;
// Documented at https://mutants.rs/exit-codes.html.
const CARGO_EXIT = { missed: 2, timeout: 3, baselineFailed: 4 };

function probe(tool, argv, pattern, cwd) {
  const result = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', timeout: VERSION_PROBE_TIMEOUT_MS });
  if (result.error?.code === 'ENOENT') return { unavailable: `${tool} is not installed` };
  const version = pattern.exec(`${result.stdout || ''}\n${result.stderr || ''}`)?.[1];
  if (result.status !== 0 || !version) return { unavailable: `${tool} did not report a version (\`${argv.join(' ')}\` exited ${result.status ?? result.error?.code})` };
  return { version };
}

function readReport(path, tool) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (error) { throw new Error(`${tool} did not write its report (${error.code || error.message})`); }
  try { return JSON.parse(text); } catch { throw new Error(`${tool} wrote a report that is not valid JSON`); }
}

function invalid(tool, detail) {
  return new Error(`${tool} report has an unexpected shape (${detail}); this adapter was written against a different ${tool} version`);
}

function mapStatus(table, value) {
  return Object.hasOwn(table, value) ? table[value] : 'error';
}

function mutantRow(tool, { file, line, endLine = line, column = null, mutator, description, status }) {
  if (typeof file !== 'string' || !file) throw invalid(tool, 'a mutant has no file');
  if (!Number.isInteger(line) || line < 1) throw invalid(tool, `a mutant in ${file} has no line`);
  return {
    file,
    line,
    end_line: Number.isInteger(endLine) && endLine >= line ? endLine : line,
    column: Number.isInteger(column) ? column : null,
    mutator: String(mutator || ''),
    description: String(description || mutator || ''),
    status,
  };
}

function upward(start, stop, name) {
  let dir = start;
  for (;;) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
    if (dir === stop || dirname(dir) === dir) return null;
    dir = dirname(dir);
  }
}

export function lineRanges(lines) {
  const ranges = [];
  for (const line of [...lines].sort((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (last && line <= last[1] + 1) last[1] = Math.max(last[1], line);
    else ranges.push([line, line]);
  }
  return ranges;
}

// StrykerJS reads the path part of a `mutate` entry as a glob, so a file under a
// `[id]` route directory matches nothing and is never mutated. Backslash escaping
// matches nothing either; the character-class form does (measured against Stryker 10).
// `!` stays out of the set: it is already literal unless it opens a class or an
// extglob, and `[!]` is an unterminated negated class that matches no path at all.
function escapeGlob(path) {
  return path.replace(/[[\]{}()*?+@]/g, character => `[${character}]`);
}

// A widened root helps only while the tool still covers the crate that owns the
// changed file. Cargo allows a member to point at a workspace in a sibling
// directory (`workspace = "../../ws"`), and such a root turns every change-set key
// into a `../` pathspec that `git diff --relative` drops without an error, which
// reads as a clean run with zero mutants.
export function widenedRoot(top, rootRel, workspaceDir) {
  // Every other root here is a posix git path, but `relative` is platform native:
  // a Windows separator would turn each change-set key into a `../` pathspec.
  const workspace = relative(top, workspaceDir).split(/[\\/]/).join('/');
  if (isAbsolute(workspace) || workspace.startsWith('..')) return rootRel;
  const widened = workspace === '' ? '.' : workspace;
  return widened === '.' || widened === rootRel || rootRel.startsWith(`${widened}/`) ? widened : rootRel;
}

const CARGO_STATUS = { CaughtMutant: 'killed', MissedMutant: 'survived', Timeout: 'timeout', Unviable: 'unviable' };

const rust = {
  language: 'rust',
  tool: 'cargo-mutants',
  install: 'cargo install --locked cargo-mutants',
  manifests: ['Cargo.toml'],
  claims: path => path.endsWith('.rs'),
  // cargo-mutants works from the workspace root and names files relative to it.
  // A member crate mutated from its own directory matches no diff path and still
  // exits 0 (measured: 0 mutants for a changed member crate, 8 from the workspace root).
  root(top, rootRel) {
    const result = spawnSync('cargo', ['locate-project', '--workspace', '--message-format', 'plain'], { cwd: join(top, rootRel), encoding: 'utf8', timeout: VERSION_PROBE_TIMEOUT_MS });
    if (result.status !== 0 || !result.stdout?.trim()) return rootRel;
    return widenedRoot(top, rootRel, dirname(result.stdout.trim()));
  },
  detect: ({ root }) => probe('cargo-mutants', ['cargo', 'mutants', '--version'], /cargo-mutants\s+(\S+)/, root),
  plan({ diff, outDir }) {
    // The core takes the diff with --relative from the root above, so --in-diff
    // paths and the reported file paths share one base.
    const diffPath = join(outDir, 'change.diff');
    return { argv: ['cargo', 'mutants', '--in-diff', diffPath, '--output', outDir], files: { [diffPath]: diff } };
  },
  parse({ outDir }, run) {
    if (run.exitCode === CARGO_EXIT.baselineFailed) return { mutants: [], baseline_failed: true };
    if (![0, CARGO_EXIT.missed, CARGO_EXIT.timeout].includes(run.exitCode)) throw new Error(`cargo-mutants exited ${run.exitCode}`);
    const path = join(outDir, 'mutants.out', 'outcomes.json');
    // cargo-mutants writes no output directory when the diff holds no mutable Rust code.
    if (run.exitCode === 0 && !existsSync(path)) return { mutants: [] };
    const report = readReport(path, 'cargo-mutants');
    if (!Array.isArray(report?.outcomes)) throw invalid('cargo-mutants', 'outcomes is not an array');
    const mutants = [];
    for (const outcome of report.outcomes) {
      const mutant = outcome?.scenario?.Mutant;
      if (!mutant) continue;
      mutants.push(mutantRow('cargo-mutants', {
        file: mutant.file,
        line: mutant.span?.start?.line,
        endLine: mutant.span?.end?.line,
        column: mutant.span?.start?.column,
        mutator: mutant.genre,
        // The name repeats "file:line:col: "; the report already carries the location.
        description: String(mutant.name ?? '').replace(/^.*?:\d+:\d+:\s*/, ''),
        status: mapStatus(CARGO_STATUS, outcome.summary),
      }));
    }
    return { mutants };
  },
};

const JS_SOURCE = /\.[cm]?[jt]sx?$/i;
const JS_NOT_SOURCE = /\.d\.[cm]?ts$|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:__tests__|__mocks__)\//i;
const STRYKER_STATUS = { Killed: 'killed', Survived: 'survived', Timeout: 'timeout', CompileError: 'unviable', NoCoverage: 'no_coverage', RuntimeError: 'error', Ignored: 'skipped', Pending: 'skipped' };

function packageTestCommand(root, repoTop) {
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); } catch { return null; }
  if (typeof pkg?.scripts?.test !== 'string' || !pkg.scripts.test.trim()) return null;
  const lockfile = name => upward(root, repoTop, name);
  if (lockfile('bun.lock') || lockfile('bun.lockb')) return 'bun run test';
  if (lockfile('pnpm-lock.yaml')) return 'pnpm test';
  if (lockfile('yarn.lock')) return 'yarn test';
  return 'npm test';
}

const javascript = {
  language: 'javascript',
  tool: 'StrykerJS',
  install: 'npm install --save-dev @stryker-mutator/core',
  manifests: ['package.json'],
  claims: path => JS_SOURCE.test(path) && !JS_NOT_SOURCE.test(path),
  detect({ root, repoTop }) {
    // No npx fallback: it would download a package in the middle of a run.
    const bin = upward(root, repoTop, join('node_modules', '.bin', 'stryker'));
    if (!bin) return { unavailable: 'StrykerJS is not installed for this package (node_modules/.bin/stryker)' };
    return { ...probe('StrykerJS', [bin, '--version'], /(\d+\.\d+\.\d+)/, root), bin };
  },
  plan({ root, repoTop, changed, outDir }, { bin }) {
    const command = packageTestCommand(root, repoTop);
    if (!command) return { unavailable: 'package.json has no test script for the Stryker command runner' };
    const mutate = [...changed].flatMap(([file, lines]) => lineRanges(lines).map(([start, end]) => `${escapeGlob(file)}:${start}-${end}`));
    const configPath = join(outDir, 'stryker.config.json');
    // The config lives outside the project so xm never writes into the
    // repository. The command runner is the one runner that needs no plugin;
    // it re-runs the whole suite per mutant, which is slower but framework-agnostic.
    const config = {
      testRunner: 'command',
      commandRunner: { command },
      mutate,
      reporters: ['json'],
      jsonReporter: { fileName: join(outDir, 'mutation.json') },
      tempDirName: join(outDir, 'sandbox'),
      logLevel: 'warn',
    };
    return { argv: [bin, 'run', configPath], files: { [configPath]: JSON.stringify(config, null, 2) } };
  },
  parse({ outDir }, run) {
    const path = join(outDir, 'mutation.json');
    if (run.exitCode !== 0 && !existsSync(path)) throw new Error(`StrykerJS exited ${run.exitCode} without a report`);
    const report = readReport(path, 'StrykerJS');
    if (!report?.files || typeof report.files !== 'object') throw invalid('StrykerJS', 'files is missing');
    const mutants = [];
    for (const [file, entry] of Object.entries(report.files)) {
      if (!Array.isArray(entry?.mutants)) throw invalid('StrykerJS', `${file} has no mutants array`);
      for (const mutant of entry.mutants) {
        mutants.push(mutantRow('StrykerJS', {
          file,
          line: mutant?.location?.start?.line,
          endLine: mutant?.location?.end?.line,
          column: mutant?.location?.start?.column,
          mutator: mutant?.mutatorName,
          description: mutant?.replacement == null ? mutant?.mutatorName : `${mutant.mutatorName}: ${mutant.replacement}`,
          status: mapStatus(STRYKER_STATUS, mutant?.status),
        }));
      }
    }
    return { mutants };
  },
};

// The statuses carry a space, measured against gomutants 0.6.1; `NOT VIABLE`
// came from a string `+=` mutated to `-=`, which does not compile.
const GOMUTANTS_STATUS = { KILLED: 'killed', LIVED: 'survived', 'NOT COVERED': 'no_coverage', 'TIMED OUT': 'timeout', 'NOT VIABLE': 'unviable' };

const go = {
  language: 'go',
  tool: 'gomutants',
  install: 'go install github.com/szhekpisov/gomutants@latest',
  manifests: ['go.mod'],
  claims: path => path.endsWith('.go') && !path.endsWith('_test.go'),
  detect: ({ root }) => probe('gomutants', ['gomutants', '-version'], /gomutants\s+v?(\S+)/, root),
  plan: ({ mergeBase, outDir }) => ({
    // gomutants reads the changed lines from the ref itself, uncommitted edits
    // included. Its incremental cache would otherwise land in the module root.
    argv: ['gomutants', '-changed-since', mergeBase, '-o', join(outDir, 'gomutants.json'), '-cache', 'off', '-q'],
  }),
  parse({ outDir }, run) {
    // A red baseline exits 1 and writes no report (measured), so it arrives as
    // `error` with the tool's output rather than as a mutation result.
    if (run.exitCode !== 0) throw new Error(`gomutants exited ${run.exitCode}`);
    const report = readReport(join(outDir, 'gomutants.json'), 'gomutants');
    if (!Array.isArray(report?.files)) throw invalid('gomutants', 'files is not an array');
    const mutants = [];
    for (const file of report.files) {
      if (!Array.isArray(file?.mutations)) throw invalid('gomutants', `${file?.file_name} has no mutations array`);
      for (const mutation of file.mutations) {
        const original = String(mutation?.original ?? '');
        mutants.push(mutantRow('gomutants', {
          file: file.file_name,
          line: mutation?.line,
          endLine: Number.isInteger(mutation?.line) ? mutation.line + original.split('\n').length - 1 : undefined,
          column: mutation?.column,
          mutator: mutation?.type,
          description: `${original.replace(/\s+/g, ' ')} -> ${String(mutation?.replacement ?? '').replace(/\s+/g, ' ')}`,
          status: mapStatus(GOMUTANTS_STATUS, mutation?.status),
        }));
      }
    }
    return { mutants };
  },
};

// Muter's own TestSuiteOutcome names runtimeError "mutant killed (runtime error)".
const MUTER_STATUS = { failed: 'killed', runtimeError: 'killed', passed: 'survived', buildError: 'unviable', noCoverage: 'no_coverage', timeout: 'timeout' };

const swift = {
  language: 'swift',
  tool: 'Muter',
  install: 'brew install muter-mutation-testing/formulae/muter',
  manifests: ['muter.conf.yml', 'Package.swift'],
  claims: path => path.endsWith('.swift') && !/(?:^|\/)Tests\//.test(path) && !/(?:^|\/)Package\.swift$/.test(path),
  detect: ({ root }) => probe('Muter', ['muter', '--version'], /(\d+(?:\.\d+)*)/, root),
  note: 'Muter builds a copy next to the project (<root>_mutated) and writes muter_logs/ inside the project.',
  plan({ root, changed, outDir }) {
    if (!existsSync(join(root, 'muter.conf.yml'))) return { unavailable: 'muter.conf.yml is missing; run `muter init` in the project root' };
    // Muter has no line filter. It mutates whole files; the core keeps only
    // mutants on changed lines.
    const files = [...changed.keys()].flatMap(file => ['--files-to-mutate', file]);
    return { argv: ['muter', 'run', ...files, '--format', 'json', '--output', join(outDir, 'muter.json'), '--skip-update-check'] };
  },
  parse({ root, outDir }, run) {
    // A red baseline exits 255 and writes no report (measured); Muter stops
    // before it mutates rather than reporting every mutant as killed.
    if (run.exitCode !== 0) throw new Error(`Muter exited ${run.exitCode}`);
    const report = readReport(join(outDir, 'muter.json'), 'Muter');
    if (!Array.isArray(report?.fileReports)) throw invalid('Muter', 'fileReports is not an array');
    const copyPrefix = `${root}_mutated/`, mutants = [];
    for (const fileReport of report.fileReports) {
      for (const applied of fileReport?.appliedOperators || []) {
        const point = applied?.mutationPoint;
        if (typeof point?.filePath !== 'string' || !point.filePath.startsWith(copyPrefix)) throw invalid('Muter', `a mutation path is outside ${copyPrefix}`);
        mutants.push(mutantRow('Muter', {
          file: point.filePath.slice(copyPrefix.length),
          line: point.position?.line,
          column: point.position?.column,
          mutator: point.mutationOperatorId,
          description: point.mutationOperatorId,
          status: mapStatus(MUTER_STATUS, applied.testSuiteOutcome),
        }));
      }
    }
    return { mutants };
  },
};

export const ADAPTERS = Object.freeze([rust, javascript, go, swift]);
