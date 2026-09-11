/**
 * PURE git-history escape parsing, classification, and aggregation.
 *
 * Why this exists: the panel-based collectors only produce data once a release
 * panel has run. Git history is available in every repository from day one, so
 * it is the cheapest escape source. The signal is not commit density — it is
 * whether a defect-bearing commit also shipped a test. The test a fix adds IS
 * the test that was missing, which makes this a free labelled dataset.
 *
 * This module is PURE — no filesystem, no config loading, no imports — so the
 * x-build CLI and the dashboard (which lives in a different plugin directory
 * and must not import x-build's core) can share the same logic. Callers run
 * git themselves and pass the captured text in, exactly like review-precision.
 *
 * Fidelity levels (see docs/attention-queue-audit-backlog.md):
 *   L0 commit density          — free, weak
 *   L1 + test pairing          — free, implemented here
 *   L2 + blame-derived age     — noisy on refactors, `introduced_commit` slot reserved
 *   L3 + replay test on parent — needs a build, not implemented
 * An L1 row states a habit, not a verified gap. Do not read it as quality.
 */

export const GIT_RECORD_SEP = '\u0000';
export const GIT_FIELD_SEP = '\u001f';
export const GIT_LOG_FORMAT = '%x00%H%x1f%aI%x1f%s';

/** Base git arguments. Callers append --since / -n and run this themselves. */
export const GIT_LOG_ARGS = [
  '-c', 'core.quotePath=false',
  'log', '--no-merges', '--name-only', '--pretty=format:' + GIT_LOG_FORMAT,
];

export const DEFAULT_GIT_ESCAPE_CONFIG = {
  // Segment names that make a path a test path.
  test_dirs: ['test', 'tests', 'tests_v2', '__tests__', 'spec', 'specs', 'testing', 'e2e'],
  test_prefixes: ['test_'],
  test_suffixes: [
    '.test.js', '.test.mjs', '.test.cjs', '.test.ts', '.test.tsx',
    '.spec.js', '.spec.mjs', '.spec.ts', '.spec.tsx',
    '_test.go', '_test.py', '_test.rs', '_test.exs',
    'Tests.swift', 'Test.java', 'Tests.cs', 'Spec.rb',
  ],
  // Never counted as a defect site.
  exclude_dirs: ['node_modules', 'vendor', 'dist', 'build', 'coverage', 'fixtures', '.git'],
  exclude_roots: [],
  // Generated manifests churn on every bundle sync and would otherwise top the
  // repeat-offender list without ever being a defect site.
  ignore_suffixes: ['.md', '.txt', '.lock', '.snap', '.checksums.json'],
  ignore_files: ['CHANGELOG.md', 'package-lock.json', 'bun.lock', 'yarn.lock', 'Package.resolved'],
  area_depth: 2,
  max_files_per_commit: 200,
};

const WINDOW_UNITS = { d: 'days', h: 'hours', m: 'minutes' };

/**
 * Translate the CLI window (`30d`) into a form git's approxidate accepts
 * (`30.days.ago`).
 *
 * This exists because `git log --since=30d` is NOT a parse error — git accepts
 * the argument and returns ZERO commits. A silent empty result would report a
 * repository as having no defects at all, which is the single worst failure
 * direction for this tool. Callers must also treat an empty window as
 * suspicious rather than clean; see `window_commits` in the collector.
 */
export function gitWindowArg(value) {
  const match = /^(\d{1,4})([dhm])$/.exec(String(value || '').trim());
  if (!match || Number(match[1]) <= 0) return null;
  return match[1] + '.' + WINDOW_UNITS[match[2]] + '.ago';
}

const TYPE_ALIASES = { fix: 'fix', bugfix: 'fix', hotfix: 'fix', perf: 'perf', revert: 'revert' };
const LOW_CONFIDENCE_MARKERS = ['hotfix', 'bugfix', 'regression', 'fix ', 'fixes ', 'fixed '];

/** Merge caller config over defaults without letting a partial config drop defaults. */
export function gitEscapeConfig(config) {
  return { ...DEFAULT_GIT_ESCAPE_CONFIG, ...(config || {}) };
}

/**
 * Conventional-commit first, keyword fallback second.
 * Returns `confidence:'low'` for the fallback so callers can separate it out —
 * a repository without a commit convention must not silently look clean.
 * Patterns are bounded and non-nested: no catastrophic backtracking.
 */
export function classifyCommitType(subject) {
  const text = typeof subject === 'string' ? subject.trim() : '';
  if (!text) return { type: null, confidence: 'none' };
  if (/^revert\s+"/i.test(text)) return { type: 'revert', confidence: 'high' };
  const conventional = /^([a-zA-Z]{2,12})(?:\([^)]{0,64}\))?!?:\s/.exec(text);
  if (conventional) {
    const token = conventional[1].toLowerCase();
    const type = TYPE_ALIASES[token] || null;
    return { type, confidence: type ? 'high' : 'none' };
  }
  const lowered = text.toLowerCase();
  for (const marker of LOW_CONFIDENCE_MARKERS) {
    if (lowered.startsWith(marker) || lowered.includes(' ' + marker)) return { type: 'fix', confidence: 'low' };
  }
  return { type: null, confidence: 'none' };
}

/** Repo-relative path or null. Git-quoted paths (special characters) are dropped. */
export function normalizeGitPath(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('"')) return null;
  const path = trimmed.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
  if (!path || path.startsWith('/')) return null;
  const segments = path.split('/');
  return segments.some(segment => !segment || segment === '.' || segment === '..') ? null : path;
}

export function isTestPath(path, config) {
  const cfg = gitEscapeConfig(config);
  const value = normalizeGitPath(path);
  if (!value) return false;
  const segments = value.split('/');
  const base = segments[segments.length - 1];
  if (segments.slice(0, -1).some(segment => (cfg.test_dirs || []).includes(segment))) return true;
  if ((cfg.test_prefixes || []).some(prefix => base.startsWith(prefix))) return true;
  return (cfg.test_suffixes || []).some(suffix => base.endsWith(suffix));
}

export function isIgnoredPath(path, config) {
  const cfg = gitEscapeConfig(config);
  const value = normalizeGitPath(path);
  if (!value) return true;
  const segments = value.split('/');
  const base = segments[segments.length - 1];
  if (segments.slice(0, -1).some(segment => (cfg.exclude_dirs || []).includes(segment))) return true;
  if ((cfg.exclude_roots || []).some(root => {
    const prefix = normalizeGitPath(root);
    return prefix && (value === prefix || value.startsWith(prefix + '/'));
  })) return true;
  if ((cfg.ignore_files || []).includes(base)) return true;
  return (cfg.ignore_suffixes || []).some(suffix => base.endsWith(suffix));
}

/** First `depth` directory segments; a top-level file reports itself. */
export function pathArea(path, depth = DEFAULT_GIT_ESCAPE_CONFIG.area_depth) {
  const value = normalizeGitPath(path);
  if (!value) return null;
  const segments = value.split('/');
  if (segments.length === 1) return segments[0];
  const limit = Math.max(1, Math.min(Number.isInteger(depth) && depth > 0 ? depth : 1, segments.length - 1));
  return segments.slice(0, limit).join('/');
}

/**
 * Parse `git log` output captured with GIT_LOG_ARGS.
 * Records are NUL-separated so a subject containing newlines cannot desync the
 * scan. Malformed records are counted, never thrown — a truncated capture must
 * degrade, not abort.
 */
export function parseGitLog(text) {
  const commits = [];
  let malformed = 0;
  for (const record of String(text || '').split(GIT_RECORD_SEP)) {
    if (!record.trim()) continue;
    const newline = record.indexOf('\n');
    const header = newline === -1 ? record : record.slice(0, newline);
    const fields = header.split(GIT_FIELD_SEP);
    if (fields.length < 3) { malformed += 1; continue; }
    const sha = String(fields[0] || '').trim().toLowerCase();
    const when = Date.parse(String(fields[1] || '').trim());
    if (!/^[0-9a-f]{7,64}$/.test(sha) || !Number.isFinite(when)) { malformed += 1; continue; }
    const files = newline === -1
      ? []
      : record.slice(newline + 1).split('\n').map(line => line.trim()).filter(Boolean);
    commits.push({
      sha,
      ts: new Date(when).toISOString(),
      subject: fields.slice(2).join(GIT_FIELD_SEP).trim(),
      files,
    });
  }
  return { commits, malformed };
}

/**
 * Turn parsed commits into defect descriptors plus a blind-spot summary.
 *
 * `perf` commits are classified but never produce defect rows — a performance
 * change is not a defect, and counting it pollutes the "shipped without a test"
 * rate. `revert` rows are kept and marked high severity: a revert means the
 * gate passed something that had to be taken back, which is the strongest
 * escape evidence available from history alone.
 */
export function summarizeGitHistory(commits, config) {
  const cfg = gitEscapeConfig(config);
  const counts = { fix: 0, perf: 0, revert: 0, unclassified: 0, low_confidence: 0 };
  const fileFixes = new Map();
  const areaFixes = new Map();
  const defects = [];
  let defectCommits = 0;
  let defectCommitsWithTest = 0;

  for (const commit of commits || []) {
    const { type, confidence } = classifyCommitType(commit?.subject);
    if (!type) { counts.unclassified += 1; continue; }
    counts[type] += 1;
    if (confidence === 'low') counts.low_confidence += 1;
    if (type === 'perf') continue;

    const files = (commit?.files || [])
      .slice(0, cfg.max_files_per_commit)
      .map(normalizeGitPath)
      .filter(Boolean);
    const shippedTest = files.some(file => isTestPath(file, cfg));
    const sources = files.filter(file => !isTestPath(file, cfg) && !isIgnoredPath(file, cfg));
    if (!sources.length) continue;

    defectCommits += 1;
    if (shippedTest) defectCommitsWithTest += 1;
    for (const file of sources) {
      const area = pathArea(file, cfg.area_depth);
      defects.push({
        sha: commit.sha,
        ts: commit.ts,
        commit_type: type,
        fix_shipped_test: shippedTest,
        confidence,
        file,
        area,
      });
      fileFixes.set(file, (fileFixes.get(file) || 0) + 1);
      if (area) areaFixes.set(area, (areaFixes.get(area) || 0) + 1);
    }
  }

  const rank = (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]);
  return {
    defects,
    counts,
    defect_commits: defectCommits,
    defect_commits_with_test: defectCommitsWithTest,
    test_pairing_rate: defectCommits ? Math.round((defectCommitsWithTest / defectCommits) * 1000) / 1000 : null,
    repeat_offenders: [...fileFixes.entries()].filter(entry => entry[1] > 1).sort(rank).map(([file, fixes]) => ({ file, fixes })),
    areas: [...areaFixes.entries()].sort(rank).map(([area, fixes]) => ({ area, fixes })),
  };
}
