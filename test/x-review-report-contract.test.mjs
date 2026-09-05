import { describe, test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateReviewReports } from '../x-review/skills/review/scripts/validate-reports.mjs';
import { chunkFrozenTarget, estimateTargetTokens, filterGeneratedCopies, planReview } from '../x-review/skills/review/scripts/plan-review.mjs';
import { canonicalReviewContext, hashReviewContext, normalizeReviewContext } from '../x-review/skills/review/scripts/context-contract.mjs';
import { buildRetryTarget, splitFrozenSections } from '../x-review/skills/review/scripts/retry-target.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'x-review', 'skills', 'review', 'scripts', 'validate-reports.mjs');
const PLAN_CLI = join(ROOT, 'x-review', 'skills', 'review', 'scripts', 'plan-review.mjs');
const HASH = `sha256:${'a'.repeat(64)}`;
const MANIFEST = {
  schema_version: 1,
  task_id: 'review-20260812-001',
  target_hash: HASH,
  expected_reports: [
    { report_id: 'security-1', lens: 'security' },
    { report_id: 'logic-1', lens: 'logic' },
  ],
};

function zeroReport(reportId, lens, overrides = {}) {
  return {
    schema_version: 1,
    task_id: MANIFEST.task_id,
    target_hash: HASH,
    report_id: reportId,
    lens,
    status: 'complete',
    checked: [`${lens}: examined changed trust boundaries and error paths`],
    findings: [],
    no_findings_reason: `No ${lens} defect found in the concrete changed paths after tracing inputs and exits.`,
    ...overrides,
  };
}

describe('x-review bounded retry target', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-a', '+aa',
    'diff --git a/src/b.ts b/src/b.ts', '--- a/src/b.ts', '+++ b/src/b.ts', '@@ -1 +1 @@', '-b', '+bb',
  ].join('\n');

  test('copies complete frozen sections for exact evidence paths', () => {
    const result = buildRetryTarget(patch, { evidence: 'suspected defect at src/b.ts:1' });
    expect(result.ok).toBe(true);
    expect(result.retry_count).toBe(1);
    expect(result.target_files).toEqual(['src/b.ts']);
    expect(splitFrozenSections(result.patch).map((entry) => entry.file)).toEqual(['src/b.ts']);
    expect(result.patch).toContain('@@ -1 +1 @@');
  });

  test('fails closed for no scope, full-target scope, and a second retry', () => {
    expect(buildRetryTarget(patch, { evidence: 'generic timeout' }).reason).toBe('unsafe_scope');
    expect(buildRetryTarget(patch, { evidence: 'src/a.ts and src/b.ts' }).reason).toBe('full_target_retry_forbidden');
    expect(buildRetryTarget(patch, { attempt: 1, evidence: 'src/a.ts' }).reason).toBe('retry_limit');
  });

  test('decodes quoted Git paths before selecting retry sections', () => {
    const quoted = String.raw`diff --git "a/src/\355\225\234\352\270\200.ts" "b/src/\355\225\234\352\270\200.ts"
+++ b/src/한글.ts
+const value = true;
diff --git a/src/other.ts b/src/other.ts
+++ b/src/other.ts
+const other = true;`;
    const result = buildRetryTarget(quoted, { evidence: 'inspect src/한글.ts' });
    expect(result.ok).toBe(true);
    expect(result.target_files).toEqual(['src/한글.ts']);
  });
});

const CONTEXT = {
  schema_version: 1,
  goal: 'Preserve compatibility while validating review intent.',
  invariants: [{ id: 'INV1', text: 'Existing callers retain their default behavior.' }],
  constraints: [{ id: 'C1', text: 'Do not transmit repository contents.' }],
  non_goals: [{ id: 'NG1', text: 'Do not store the full conversation transcript.' }],
  acceptance_checks: [{ id: 'AC1', description: 'Compatibility fixture passes.', command: 'bun test test/compat.test.mjs' }],
};

describe('x-review context contract', () => {
  test('normalizes and hashes reordered keys deterministically', () => {
    const reordered = { acceptance_checks: CONTEXT.acceptance_checks, non_goals: CONTEXT.non_goals, constraints: CONTEXT.constraints, invariants: CONTEXT.invariants, goal: CONTEXT.goal, schema_version: 1 };
    expect(canonicalReviewContext(reordered)).toBe(canonicalReviewContext(CONTEXT));
    expect(hashReviewContext(reordered)).toBe(hashReviewContext(CONTEXT));
  });

  test('rejects malformed, unknown, and incomplete supplied contexts', () => {
    expect(() => normalizeReviewContext({ ...CONTEXT, schema_version: 2 })).toThrow('schema_version');
    expect(() => normalizeReviewContext({ ...CONTEXT, transcript: 'secret' })).toThrow('unknown fields');
    expect(() => normalizeReviewContext({ ...CONTEXT, invariants: [] })).toThrow('invariants');
    expect(() => normalizeReviewContext({ ...CONTEXT, acceptance_checks: [] })).toThrow('acceptance_checks');
    expect(() => normalizeReviewContext({
      ...CONTEXT,
      acceptance_checks: [{ id: 'INV1', description: 'Collides with an invariant.' }],
    })).toThrow('unique across all sections');
  });
});

describe('x-review adaptive-fast planner', () => {
  test('planner CLI reports actionable argument errors', () => {
    const cases = [
      {
        args: ['--target', 'target.patch', '--run-dir', 'run'],
        error: 'unknown option: --run-dir; use --filtered-target and --chunks-dir to select output paths',
      },
      {
        args: ['--target', 'target.patch', '--agent-max-count', '3'],
        error: 'unknown option: --agent-max-count; did you mean --max-profiles?',
      },
      {
        args: ['--target', 'target.patch', '--json'],
        error: 'unknown option: --json; the command already writes JSON to stdout',
      },
      {
        args: ['--target-file', 'target.patch'],
        error: 'missing required option: --target; use --target for the frozen content file (--target-file only labels source paths)',
      },
      {
        args: ['--target'],
        error: 'option requires a value: --target',
      },
      {
        args: ['--target', 'target.patch', '--max-profiles', '1'],
        error: '--max-profiles must be an integer between 2 and 5',
      },
    ];

    for (const entry of cases) {
      const run = spawnSync('node', [PLAN_CLI, ...entry.args], { encoding: 'utf8' });
      expect(run.status).toBe(2);
      expect(run.stderr).toContain(`plan-review: ${entry.error}`);
      expect(run.stderr).toContain('Usage: node plan-review.mjs');
    }
  });

  test('returns a no-changes plan without dispatching reviewers for an empty target', () => {
    expect(planReview('')).toEqual(expect.objectContaining({
      mode: 'no-changes',
      changed_lines: 0,
      estimated_target_tokens: 0,
      chunks: [],
      profiles: [],
      expected_reports: [],
      estimated_llm_waves: 0,
      requires_chunking: false,
      reviewable: false,
      no_changes: true,
    }));
  });

  test('reviews binary and rename-only Git changes even when changed_lines is zero', () => {
    const binary = planReview([
      'diff --git a/image.png b/image.png',
      'index 111..222 100644',
      'Binary files a/image.png and b/image.png differ',
    ].join('\n'));
    expect(binary).toEqual(expect.objectContaining({
      mode: 'adaptive-fast', files: ['image.png'], changed_lines: 0, reviewable: true,
    }));
    expect(binary).not.toHaveProperty('no_changes');
    expect(binary.profiles).toHaveLength(2);

    const rename = planReview([
      'diff --git a/old.js b/new.js',
      'similarity index 100%',
      'rename from old.js',
      'rename to new.js',
    ].join('\n'));
    expect(rename).toEqual(expect.objectContaining({
      mode: 'adaptive-fast', files: ['new.js'], changed_lines: 0, reviewable: true,
    }));
    expect(rename).not.toHaveProperty('no_changes');
    expect(rename.profiles).toHaveLength(2);
  });

  test('uses two composite reviewers for an ordinary patch', () => {
    const plan = planReview('diff --git a/src/a.js b/src/a.js\n+++ b/src/a.js\n+return value;');
    expect(plan.profiles.map((entry) => entry.profile)).toEqual(['correctness', 'risk']);
    expect(plan.estimated_llm_waves).toBe(1);
    expect(plan.chunked).toBe(false);
    expect(plan.expected_reports).toEqual([
      { report_id: 'correctness-1', lens: 'correctness' },
      { report_id: 'risk-1', lens: 'risk' },
    ]);
  });

  test('excludes a configured generated copy only when an identical source section is present', () => {
    const patch = [
      'diff --git a/x-eval/lib/a.mjs b/x-eval/lib/a.mjs',
      '--- a/x-eval/lib/a.mjs',
      '+++ b/x-eval/lib/a.mjs',
      '@@ -1 +1 @@',
      '-export const value = 1;',
      '+export const value = 2;',
      'diff --git a/xm/lib/x-eval/a.mjs b/xm/lib/x-eval/a.mjs',
      '--- a/xm/lib/x-eval/a.mjs',
      '+++ b/xm/lib/x-eval/a.mjs',
      '@@ -1 +1 @@',
      '-export const value = 1;',
      '+export const value = 2;',
    ].join('\n');
    const filtered = filterGeneratedCopies(patch, ['xm/lib']);
    expect(filtered.excluded).toEqual([{ file: 'xm/lib/x-eval/a.mjs', source_file: 'x-eval/lib/a.mjs' }]);
    expect(filtered.body).toContain('x-eval/lib/a.mjs');
    expect(filtered.body).not.toContain('xm/lib/x-eval/a.mjs');
    expect(planReview(patch, { generatedCopyRoots: ['xm/lib'] }).files).toEqual(['x-eval/lib/a.mjs']);
  });

  test('keeps a generated-root change when no identical source section is present', () => {
    const patch = [
      'diff --git a/xm/lib/native.mjs b/xm/lib/native.mjs',
      '--- a/xm/lib/native.mjs',
      '+++ b/xm/lib/native.mjs',
      '@@ -1 +1 @@',
      '-export const value = 1;',
      '+export const value = 2;',
    ].join('\n');
    const filtered = filterGeneratedCopies(patch, ['xm/lib']);
    expect(filtered.excluded).toEqual([]);
    expect(planReview(patch, { generatedCopyRoots: ['xm/lib'] }).files).toEqual(['xm/lib/native.mjs']);
  });

  test('reads literal and C-escaped UTF-8 paths from quoted Git headers', () => {
    const literal = planReview('diff --git "a/src/한글.ts" "b/src/한글.ts"\n+const value = true;');
    const escaped = planReview('diff --git "a/src/\\355\\225\\234\\352\\270\\200.ts" "b/src/\\355\\225\\234\\352\\270\\200.ts"\n+const value = true;');
    expect(literal.files).toEqual(['src/한글.ts']);
    expect(escaped.files).toEqual(['src/한글.ts']);
  });

  test('routes exported function and variable declarations to public API specialists', () => {
    for (const declaration of [
      'export async function handler() {}',
      'export const handler = () => {}',
      'export default function handler() {}',
    ]) {
      const plan = planReview(`diff --git a/src/api.ts b/src/api.ts\n+${declaration}`, { maxProfiles: 5 });
      expect(plan.profiles.map((entry) => entry.profile)).toEqual(['correctness', 'risk', 'type-design', 'docs']);
    }
  });

  test('keeps explicit file-mode targets in the coverage manifest', () => {
    const plan = planReview('export interface Value { id: string }', { targetFiles: ['./src/value.ts'] });
    expect(plan.files).toEqual(['src/value.ts']);
    expect(plan.changed_lines).toBe(1);
    expect(plan.profiles.map((entry) => entry.profile)).toEqual(['correctness', 'risk', 'type-design', 'docs']);
  });

  test('adds specialists to the same wave only for matching risk signals', () => {
    const patch = [
      'diff --git a/prisma/schema.prisma b/prisma/schema.prisma',
      '+++ b/prisma/schema.prisma',
      '+ALTER TABLE users ADD COLUMN role TEXT NOT NULL;',
      'diff --git a/src/api.ts b/src/api.ts',
      '+++ b/src/api.ts',
      '+export interface PublicUser { role: string }',
    ].join('\n');
    const plan = planReview(patch, { maxProfiles: 5 });
    expect(plan.profiles.map((entry) => entry.profile)).toEqual(['correctness', 'risk', 'migrations', 'type-design', 'docs']);
    expect(new Set(plan.profiles.map((entry) => entry.wave))).toEqual(new Set([1]));
  });

  test('does not route a migration specialist for DDL text in a test fixture', () => {
    const patch = [
      'diff --git a/test/schema.test.mjs b/test/schema.test.mjs',
      '+++ b/test/schema.test.mjs',
      "+const fixture = 'ALTER TABLE users ADD COLUMN role TEXT NOT NULL;';",
    ].join('\n');
    expect(planReview(patch).profiles.map((entry) => entry.profile)).toEqual(['correctness', 'risk']);
  });

  test('routes a migration specialist for schema and SQL paths', () => {
    const schema = planReview('diff --git a/prisma/schema.prisma b/prisma/schema.prisma\n+++ b/prisma/schema.prisma\n+model User {}');
    const sql = planReview('diff --git a/db/patch.sql b/db/patch.sql\n+++ b/db/patch.sql\n+ALTER TABLE users ADD role text;');
    expect(schema.profiles.map((entry) => entry.profile)).toContain('migrations');
    expect(sql.profiles.map((entry) => entry.profile)).toContain('migrations');
  });

  test('caps specialists deterministically while preserving both core reviewers', () => {
    const patch = [
      'diff --git a/prisma/schema.prisma b/prisma/schema.prisma',
      '+++ b/prisma/schema.prisma',
      '+ALTER TABLE users ADD COLUMN role TEXT NOT NULL;',
      'diff --git a/src/api.ts b/src/api.ts',
      '+++ b/src/api.ts',
      '+export interface PublicUser { role: string }',
    ].join('\n');
    expect(planReview(patch).profiles.map((entry) => entry.profile))
      .toEqual(['correctness', 'risk', 'migrations', 'type-design']);
    expect(planReview(patch, { maxProfiles: 2 }).profiles.map((entry) => entry.profile))
      .toEqual(['correctness', 'risk']);
  });
});

function raws(...reports) {
  return reports.map((report, index) => ({ file: `${index}.json`, body: JSON.stringify(report) }));
}

describe('x-review lens report coverage contract', () => {
  test('keeps legacy context absence compatible and explicit', () => {
    const result = validateReviewReports(MANIFEST, raws(zeroReport('security-1', 'security'), zeroReport('logic-1', 'logic')));
    expect(result.ok).toBe(true);
    expect(result.context_status).toBe('absent');
    expect(result.context_hash).toBeUndefined();
  });

  test('requires every report to echo a bound context hash', () => {
    const contextHash = hashReviewContext(CONTEXT);
    const manifest = { ...MANIFEST, context_status: 'bound', context_hash: contextHash };
    const valid = validateReviewReports(manifest, raws(
      zeroReport('security-1', 'security', { context_hash: contextHash }),
      zeroReport('logic-1', 'logic', { context_hash: contextHash }),
    ));
    expect(valid.ok).toBe(true);
    expect(valid.context_hash).toBe(contextHash);

    const stale = validateReviewReports(manifest, raws(
      zeroReport('security-1', 'security'),
      zeroReport('logic-1', 'logic', { context_hash: `sha256:${'b'.repeat(64)}` }),
    ));
    expect(stale.ok).toBe(false);
    expect(stale.issues.filter((entry) => entry.code === 'stale_context')).toHaveLength(2);
  });
  test('accepts explicit, evidenced zero-finding reports for every lens', () => {
    const result = validateReviewReports(MANIFEST, raws(zeroReport('security-1', 'security'), zeroReport('logic-1', 'logic')));
    expect(result.ok).toBe(true);
    expect(result.coverage).toEqual({ expected: 2, valid: 2 });
  });

  test('accepts a complete actionable finding', () => {
    const security = zeroReport('security-1', 'security', {
      findings: [{
        severity: 'High',
        file: 'src/auth.ts',
        line: 42,
        description: 'A user-controlled tenant id reaches a cross-tenant lookup.',
        code: 'const tenant = req.params.id;\nreturn db.find(tenant);',
        why: 'Authenticated users can read data outside their assigned tenant.',
        fix: 'Bind the lookup to the tenant id from the authenticated session.',
      }],
      no_findings_reason: undefined,
    });
    const result = validateReviewReports(MANIFEST, raws(security, zeroReport('logic-1', 'logic')));
    expect(result.ok).toBe(true);
    expect(result.coverage).toEqual({ expected: 2, valid: 2 });
  });

  test('grounds findings and source coverage in the frozen target without another reviewer call', () => {
    const targetBody = 'diff --git a/src/auth.ts b/src/auth.ts\n+++ b/src/auth.ts\n+const tenant = req.params.id;\n+return db.find(tenant);';
    const manifest = { ...MANIFEST, target_hash: `sha256:${createHash('sha256').update(targetBody).digest('hex')}`, target_files: ['src/auth.ts'] };
    const security = zeroReport('security-1', 'security', {
      target_hash: manifest.target_hash,
      checked_files: ['src/auth.ts'],
      findings: [{
        severity: 'High',
        file: 'src/auth.ts',
        line: 2,
        description: 'A user-controlled id reaches the lookup.',
        code: 'const tenant = req.params.id;\nreturn db.find(tenant);',
        why: 'Cross-tenant access is reachable.',
        fix: 'Bind the lookup to the authenticated tenant.',
      }],
      no_findings_reason: undefined,
    });
    const logic = zeroReport('logic-1', 'logic', { target_hash: manifest.target_hash, checked_files: ['src/auth.ts'] });
    const result = validateReviewReports(manifest, raws(security, logic), { targetBody });
    expect(result.ok).toBe(true);
    expect(result.target_coverage).toEqual({ expected: 1, checked: 1, complete: true, missing_files: [] });
  });

  test('accepts diff-prefixed finding code while preserving raw-file prefixes', () => {
    const targetBody = 'diff --git a/src/auth.ts b/src/auth.ts\n+++ b/src/auth.ts\n+const tenant = req.params.id;\n+return db.find(tenant);';
    const targetHash = `sha256:${createHash('sha256').update(targetBody).digest('hex')}`;
    const manifest = { ...MANIFEST, target_hash: targetHash, target_files: ['src/auth.ts'] };
    const finding = {
      severity: 'High', file: 'src/auth.ts', line: 2, description: 'Reachable lookup',
      code: '+const tenant = req.params.id;\n+return db.find(tenant);',
      why: 'Cross-tenant access is reachable.', fix: 'Bind the authenticated tenant.',
    };
    const result = validateReviewReports(manifest, raws(
      zeroReport('security-1', 'security', { target_hash: targetHash, checked_files: ['src/auth.ts'], findings: [finding], no_findings_reason: undefined }),
      zeroReport('logic-1', 'logic', { target_hash: targetHash, checked_files: ['src/auth.ts'] }),
    ), { targetBody });
    expect(result.ok).toBe(true);
  });

  test('preserves a source-leading diff character when grounding a diff finding', () => {
    const targetBody = 'diff --git a/src/value.ts b/src/value.ts\n+++ b/src/value.ts\n++value';
    const targetHash = `sha256:${createHash('sha256').update(targetBody).digest('hex')}`;
    const manifest = { ...MANIFEST, target_hash: targetHash, target_files: ['src/value.ts'] };
    const finding = {
      severity: 'Low', file: 'src/value.ts', line: 1, description: 'Literal prefix', code: '+value',
      why: 'The source value starts with plus.', fix: 'Keep the literal value.',
    };
    const result = validateReviewReports(manifest, raws(
      zeroReport('security-1', 'security', { target_hash: targetHash, checked_files: ['src/value.ts'], findings: [finding], no_findings_reason: undefined }),
      zeroReport('logic-1', 'logic', { target_hash: targetHash, checked_files: ['src/value.ts'] }),
    ), { targetBody });
    expect(result.ok).toBe(true);
  });

  test('fails closed when target files are declared without the frozen target body', () => {
    const manifest = { ...MANIFEST, target_files: ['src/auth.ts'] };
    const security = zeroReport('security-1', 'security', { checked_files: ['src/auth.ts'] });
    const logic = zeroReport('logic-1', 'logic', { checked_files: ['src/auth.ts'] });
    const result = validateReviewReports(manifest, raws(security, logic));
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'frozen_target_missing' }));
  });

  test('preserves a legitimate leading minus in finding code during grounding', () => {
    const targetBody = '+-1';
    const manifest = { ...MANIFEST, target_hash: `sha256:${createHash('sha256').update(targetBody).digest('hex')}`, target_files: ['src/value.ts'] };
    const security = zeroReport('security-1', 'security', {
      target_hash: manifest.target_hash,
      checked_files: ['src/value.ts'],
      findings: [{ severity: 'Low', file: 'src/value.ts', line: 1, description: 'Negative sentinel', code: '-1', why: 'Concrete value', fix: 'Use a named sentinel' }],
      no_findings_reason: undefined,
    });
    const logic = zeroReport('logic-1', 'logic', { target_hash: manifest.target_hash, checked_files: ['src/value.ts'] });
    const result = validateReviewReports(manifest, raws(security, logic), { targetBody });
    expect(result.ok).toBe(true);
  });

  test('preserves leading diff-like characters in a raw single-file target', () => {
    const targetBody = '-1\n+value';
    const manifest = { ...MANIFEST, target_hash: `sha256:${createHash('sha256').update(targetBody).digest('hex')}`, target_files: ['src/value.ts'] };
    const security = zeroReport('security-1', 'security', {
      target_hash: manifest.target_hash,
      checked_files: ['src/value.ts'],
      findings: [{
        severity: 'Low',
        file: 'src/value.ts',
        line: 1,
        description: 'Raw values use diff-like prefixes',
        code: '-1\n+value',
        why: 'The literal characters belong to the source file',
        fix: 'Keep the literal values',
      }],
      no_findings_reason: undefined,
    });
    const logic = zeroReport('logic-1', 'logic', { target_hash: manifest.target_hash, checked_files: ['src/value.ts'] });
    const result = validateReviewReports(manifest, raws(security, logic), { targetBody });
    expect(result.ok).toBe(true);
  });

  test('separates a misattributed snippet from a fabricated one without failing the report', () => {
    const targetBody = [
      'diff --git a/src/auth.ts b/src/auth.ts',
      '+++ b/src/auth.ts',
      '+safe(value)',
      'diff --git a/src/other.ts b/src/other.ts',
      '+++ b/src/other.ts',
      '+dangerous(value)',
    ].join('\n');
    const manifest = {
      ...MANIFEST,
      target_hash: `sha256:${createHash('sha256').update(targetBody).digest('hex')}`,
      target_files: ['src/auth.ts', 'src/other.ts'],
    };
    const security = zeroReport('security-1', 'security', {
      target_hash: manifest.target_hash,
      checked_files: ['src/auth.ts', 'src/other.ts'],
      findings: [{ severity: 'High', file: 'src/auth.ts', line: 1, description: 'Claim on auth', code: 'dangerous(value)', why: 'Reachable impact', fix: 'Remove it' }],
      no_findings_reason: undefined,
    });
    const logic = zeroReport('logic-1', 'logic', { target_hash: manifest.target_hash, checked_files: ['src/auth.ts', 'src/other.ts'] });
    const result = validateReviewReports(manifest, raws(security, logic), { targetBody });
    expect(result.ok).toBe(true);
    expect(result.valid_reports).toContain('security-1');
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'finding_code_wrong_file', report_id: 'security-1', finding_index: 0, grounded_file: 'src/other.ts',
    }));
    expect(result.finding_grounding).toMatchObject({ findings: 1, grounded: 1, wrong_file: 1, ungrounded: 0 });
  });

  test('keeps the grounded findings of a report that also carries a fabricated one', () => {
    const targetBody = [
      'diff --git a/src/auth.ts b/src/auth.ts',
      '+++ b/src/auth.ts',
      '+const tenant = req.params.id;',
      '+return db.find(tenant);',
    ].join('\n');
    const manifest = {
      ...MANIFEST,
      target_hash: `sha256:${createHash('sha256').update(targetBody).digest('hex')}`,
      target_files: ['src/auth.ts'],
    };
    const security = zeroReport('security-1', 'security', {
      target_hash: manifest.target_hash,
      checked_files: ['src/auth.ts'],
      findings: [
        { severity: 'High', file: 'src/auth.ts', line: 1, description: 'Real claim', code: 'const tenant = req.params.id;', why: 'Reachable', fix: 'Bind the tenant' },
        { severity: 'Low', file: 'src/auth.ts', line: 2, description: 'Invented claim', code: 'eval(userInput)', why: 'Impact', fix: 'Remove it' },
      ],
      no_findings_reason: undefined,
    });
    const logic = zeroReport('logic-1', 'logic', { target_hash: manifest.target_hash, checked_files: ['src/auth.ts'] });
    const result = validateReviewReports(manifest, raws(security, logic), { targetBody });
    expect(result.ok).toBe(true);
    expect(result.finding_grounding).toMatchObject({ findings: 2, grounded: 1, ungrounded: 1 });
    expect(result.finding_grounding.reports).toEqual([
      expect.objectContaining({ report_id: 'security-1', findings: 2, ungrounded_findings: [1], wrong_file_findings: [] }),
    ]);
  });

  test('grounds citations that are elided or re-wrapped but faithful', () => {
    const targetBody = [
      'diff --git a/src/auth.ts b/src/auth.ts',
      '+++ b/src/auth.ts',
      '+const tenant = req.params.id;',
      '+const scope = resolveScope(tenant);',
      '+audit(scope);',
      '+return db.find(tenant);',
    ].join('\n');
    const manifest = {
      ...MANIFEST,
      target_hash: `sha256:${createHash('sha256').update(targetBody).digest('hex')}`,
      target_files: ['src/auth.ts'],
    };
    const base = { severity: 'High', file: 'src/auth.ts', line: 1, why: 'Cross-tenant access is reachable.', fix: 'Bind the lookup to the authenticated tenant.' };
    const security = zeroReport('security-1', 'security', {
      target_hash: manifest.target_hash,
      checked_files: ['src/auth.ts'],
      findings: [
        { ...base, description: 'Elided quotation', code: 'const tenant = req.params.id;\n// ...\nreturn db.find(tenant);' },
        { ...base, line: 2, description: 'Re-wrapped quotation', code: 'const scope =\n  resolveScope(tenant);' },
      ],
      no_findings_reason: undefined,
    });
    const logic = zeroReport('logic-1', 'logic', { target_hash: manifest.target_hash, checked_files: ['src/auth.ts'] });
    const result = validateReviewReports(manifest, raws(security, logic), { targetBody });
    expect(result.ok).toBe(true);
    expect(result.finding_grounding).toMatchObject({ findings: 2, grounded: 2, ungrounded: 0 });
  });

  test('grounds a faithful citation whose lines are quoted out of target order', () => {
    const targetBody = [
      'diff --git a/src/restart.ts b/src/restart.ts',
      '+++ b/src/restart.ts',
      '+rebuildSucceeded = failures.isEmpty;',
      '+if (rebuildSucceeded) {',
      '+  reattachReservedAnchors(reserved);',
      '+} else {',
      '+  restoreAnchorsAfterFailedRestart(reserved);',
      '+}',
    ].join('\n');
    const manifest = {
      ...MANIFEST,
      target_hash: `sha256:${createHash('sha256').update(targetBody).digest('hex')}`,
      target_files: ['src/restart.ts'],
    };
    const security = zeroReport('security-1', 'security', {
      target_hash: manifest.target_hash,
      checked_files: ['src/restart.ts'],
      findings: [{
        severity: 'High',
        file: 'src/restart.ts',
        line: 1,
        description: 'Failure branch quoted before the flag it depends on',
        code: '} else {\n  restoreAnchorsAfterFailedRestart(reserved);\n}\nrebuildSucceeded = failures.isEmpty;',
        why: 'The failure path runs with anchors already reattached.',
        fix: 'Set the flag before branching.',
      }],
      no_findings_reason: undefined,
    });
    const logic = zeroReport('logic-1', 'logic', { target_hash: manifest.target_hash, checked_files: ['src/restart.ts'] });
    const result = validateReviewReports(manifest, raws(security, logic), { targetBody });
    expect(result.ok).toBe(true);
    expect(result.finding_grounding).toMatchObject({ findings: 1, grounded: 1, ungrounded: 0 });
  });

  test('grounds a quoted line that elides its own middle with an inline ellipsis', () => {
    const targetBody = [
      'diff --git a/src/host.ts b/src/host.ts',
      '+++ b/src/host.ts',
      '+const output = await PeerHostReadinessChecker.runScript(scriptPath, host, 30);',
      '+rpcPrint(&sock, "peer.takeover", json!({ "project_id": projectId, "revision": revision }));',
    ].join('\n');
    const manifest = {
      ...MANIFEST,
      target_hash: `sha256:${createHash('sha256').update(targetBody).digest('hex')}`,
      target_files: ['src/host.ts'],
    };
    const base = { severity: 'Medium', file: 'src/host.ts', line: 1, why: 'The readiness result is trusted unchecked.', fix: 'Check the exit status.' };
    const security = zeroReport('security-1', 'security', {
      target_hash: manifest.target_hash,
      checked_files: ['src/host.ts'],
      findings: [
        { ...base, description: 'Call arguments elided', code: 'const output = await PeerHostReadinessChecker.runScript(...);' },
        { ...base, line: 2, description: 'Payload elided', code: 'rpcPrint(&sock, "peer.takeover", json!({ ... }));' },
      ],
      no_findings_reason: undefined,
    });
    const logic = zeroReport('logic-1', 'logic', { target_hash: manifest.target_hash, checked_files: ['src/host.ts'] });
    const result = validateReviewReports(manifest, raws(security, logic), { targetBody });
    expect(result.ok).toBe(true);
    expect(result.finding_grounding).toMatchObject({ findings: 2, grounded: 2, ungrounded: 0 });
  });

  // An abbreviation whose elided middle spanned line breaks deliberately does NOT ground. The
  // fallback that allowed it scanned the joined section, which degenerated into substring
  // matching and let fabricated citations through, so the trade was made the other way: a
  // dropped finding costs less than a fabricated one reaching the review-fix gate.
  test('does not ground an abbreviation whose elided middle crossed line breaks', () => {
    const targetBody = [
      'diff --git a/src/host.ts b/src/host.ts',
      '+++ b/src/host.ts',
      '+const output = await PeerHostReadinessChecker.runScript(',
      '+  scriptPath,',
      '+  host,',
      '+  30,',
      '+);',
    ].join('\n');
    const manifest = {
      ...MANIFEST,
      target_hash: `sha256:${createHash('sha256').update(targetBody).digest('hex')}`,
      target_files: ['src/host.ts'],
    };
    const security = zeroReport('security-1', 'security', {
      target_hash: manifest.target_hash,
      checked_files: ['src/host.ts'],
      findings: [{ severity: 'Medium', file: 'src/host.ts', line: 1, description: 'Readiness result trusted unchecked', code: 'const output = await PeerHostReadinessChecker.runScript(...);', why: 'Impact', fix: 'Check the exit status' }],
      no_findings_reason: undefined,
    });
    const logic = zeroReport('logic-1', 'logic', { target_hash: manifest.target_hash, checked_files: ['src/host.ts'] });
    const result = validateReviewReports(manifest, raws(security, logic), { targetBody });
    expect(result.finding_grounding).toMatchObject({ findings: 1, grounded: 0, ungrounded: 1 });
    // Quoting the call across its real lines still grounds, so the citation is not unquotable.
    const faithful = zeroReport('security-1', 'security', {
      target_hash: manifest.target_hash,
      checked_files: ['src/host.ts'],
      findings: [{ severity: 'Medium', file: 'src/host.ts', line: 1, description: 'Readiness result trusted unchecked', code: 'const output = await PeerHostReadinessChecker.runScript(\n  scriptPath,\n  host,\n  30,\n);', why: 'Impact', fix: 'Check the exit status' }],
      no_findings_reason: undefined,
    });
    expect(validateReviewReports(manifest, raws(faithful, logic), { targetBody }).finding_grounding)
      .toMatchObject({ findings: 1, grounded: 1, ungrounded: 0 });
  });

  test('grounds a cited block whose closing token falls outside every hunk', () => {
    const targetBody = [
      'diff --git a/scripts/run.sh b/scripts/run.sh',
      '+++ b/scripts/run.sh',
      '@@ -10,3 +10,4 @@',
      '+for f in $list; do',
      '+  check "$f"',
      '+  echo ok',
      // The loop's `done` is below this boundary and belongs to no hunk in the frozen target.
      '@@ -205,6 +265,7 @@',
      '+unrelated_tail',
    ].join('\n');
    const manifest = {
      ...MANIFEST,
      target_hash: `sha256:${createHash('sha256').update(targetBody).digest('hex')}`,
      target_files: ['scripts/run.sh'],
    };
    const security = zeroReport('security-1', 'security', {
      target_hash: manifest.target_hash,
      checked_files: ['scripts/run.sh'],
      findings: [{ severity: 'Medium', file: 'scripts/run.sh', line: 10, description: 'Unquoted expansion in the loop', code: 'for f in $list; do\n  check "$f"\n  echo ok\ndone', why: 'Impact', fix: 'Quote the expansion' }],
      no_findings_reason: undefined,
    });
    const logic = zeroReport('logic-1', 'logic', { target_hash: manifest.target_hash, checked_files: ['scripts/run.sh'] });
    const result = validateReviewReports(manifest, raws(security, logic), { targetBody });
    expect(result.ok).toBe(true);
    expect(result.finding_grounding).toMatchObject({ findings: 1, grounded: 1, ungrounded: 0 });
  });

  test('an elision must sit in the middle of a real line, not open at both ends', () => {
    const targetBody = [
      'diff --git a/src/host.ts b/src/host.ts',
      '+++ b/src/host.ts',
      '+const output = await PeerHostReadinessChecker.runScript(scriptPath, host, 30);',
      '+rpcPrint(&sock, "peer.takeover", json!({ "project_id": projectId, "revision": revision }));',
    ].join('\n');
    const manifest = {
      ...MANIFEST,
      target_hash: `sha256:${createHash('sha256').update(targetBody).digest('hex')}`,
      target_files: ['src/host.ts'],
    };
    const base = { severity: 'High', file: 'src/host.ts', line: 1, why: 'Impact', fix: 'Change it' };
    const check = (code, expected) => {
      const security = zeroReport('security-1', 'security', {
        target_hash: manifest.target_hash,
        checked_files: ['src/host.ts'],
        findings: [{ ...base, description: 'cited', code }],
        no_findings_reason: undefined,
      });
      const logic = zeroReport('logic-1', 'logic', { target_hash: manifest.target_hash, checked_files: ['src/host.ts'] });
      const result = validateReviewReports(manifest, raws(security, logic), { targetBody });
      expect(result.finding_grounding).toMatchObject({ findings: 1, grounded: expected, ungrounded: 1 - expected });
    };

    // Both ends open degenerates to substring matching: an invented statement borrows a real
    // identifier, and stitching two separate statements passes for one.
    check('... projectId ...', 0);
    check('const output = await ... "revision": revision }));', 0);
    check('const output = await ... json!({ "project_id": projectId ...', 0);
    // An elided middle inside one real line still grounds, at either edge.
    check('const output = await PeerHostReadinessChecker.runScript(...);', 1);
    check('rpcPrint(&sock, "peer.takeover", json!({ ... }));', 1);
  });

  test('rejects a citation that identifies nothing, and a real closing token cannot rescue it', () => {
    const targetBody = [
      'diff --git a/scripts/run.sh b/scripts/run.sh',
      '+++ b/scripts/run.sh',
      '@@ -10,3 +10,4 @@',
      '+for f in $list; do',
      '+  check "$f"',
      '+  echo ok',
    ].join('\n');
    const manifest = {
      ...MANIFEST,
      target_hash: `sha256:${createHash('sha256').update(targetBody).digest('hex')}`,
      target_files: ['scripts/run.sh'],
    };
    const base = { severity: 'High', file: 'scripts/run.sh', line: 10, why: 'Impact', fix: 'Remove it' };
    for (const [description, code] of [
      ['punctuation only', '...;'],
      ['punctuation across lines', '(...)...;'],
      ['closing token alone', 'done'],
      ['fabricated body with a real closing token', 'rm -rf /\ndone'],
    ]) {
      const security = zeroReport('security-1', 'security', {
        target_hash: manifest.target_hash,
        checked_files: ['scripts/run.sh'],
        findings: [{ ...base, description, code }],
        no_findings_reason: undefined,
      });
      const logic = zeroReport('logic-1', 'logic', { target_hash: manifest.target_hash, checked_files: ['scripts/run.sh'] });
      const result = validateReviewReports(manifest, raws(security, logic), { targetBody });
      expect(result.finding_grounding).toMatchObject({ findings: 1, grounded: 0, ungrounded: 1 });
      expect(result.issues).toContainEqual(expect.objectContaining({ code: 'finding_code_mismatch', finding_index: 0 }));
    }
  });

  test('an inline ellipsis does not let a fabricated call ground against a real line', () => {
    const targetBody = 'diff --git a/src/host.ts b/src/host.ts\n+++ b/src/host.ts\n+const output = await PeerHostReadinessChecker.runScript(scriptPath, host, 30);';
    const manifest = {
      ...MANIFEST,
      target_hash: `sha256:${createHash('sha256').update(targetBody).digest('hex')}`,
      target_files: ['src/host.ts'],
    };
    const security = zeroReport('security-1', 'security', {
      target_hash: manifest.target_hash,
      checked_files: ['src/host.ts'],
      findings: [{ severity: 'High', file: 'src/host.ts', line: 1, description: 'Invented sink behind an ellipsis', code: 'const output = await execSync(...);', why: 'Impact', fix: 'Remove it' }],
      no_findings_reason: undefined,
    });
    const logic = zeroReport('logic-1', 'logic', { target_hash: manifest.target_hash, checked_files: ['src/host.ts'] });
    const result = validateReviewReports(manifest, raws(security, logic), { targetBody });
    expect(result.finding_grounding).toMatchObject({ findings: 1, grounded: 0, ungrounded: 1 });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'finding_code_mismatch', finding_index: 0 }));
  });

  test('classifies a report-scoped defect as non-blocking and target tampering as blocking', () => {
    const targetBody = 'diff --git a/src/auth.ts b/src/auth.ts\n+++ b/src/auth.ts\n+const tenant = req.params.id;';
    const manifest = {
      ...MANIFEST,
      target_hash: `sha256:${createHash('sha256').update(targetBody).digest('hex')}`,
      target_files: ['src/auth.ts'],
    };
    const offTarget = zeroReport('security-1', 'security', {
      target_hash: manifest.target_hash,
      checked_files: ['src/auth.ts'],
      findings: [{ severity: 'High', file: 'src/elsewhere.ts', line: 1, description: 'Outside the frozen target', code: 'const tenant = req.params.id;', why: 'Impact', fix: 'Bind the tenant' }],
      no_findings_reason: undefined,
    });
    const logic = zeroReport('logic-1', 'logic', { target_hash: manifest.target_hash, checked_files: ['src/auth.ts'] });

    const reportScoped = validateReviewReports(manifest, raws(offTarget, logic), { targetBody });
    expect(reportScoped.ok).toBe(false);
    expect(reportScoped.issues.map((entry) => entry.code)).toContain('finding_outside_target');
    expect(reportScoped.valid_reports).toEqual(['logic-1']);
    expect(reportScoped.run_blocking).toEqual([]);

    const tampered = validateReviewReports(manifest, raws(offTarget, logic), { targetBody: `${targetBody}\n+tampered` });
    expect(tampered.run_blocking).toContain('frozen_target_hash_mismatch');
  });

  test('treats an unlisted validation code as run-scoped so new checks fail closed', () => {
    const result = validateReviewReports({ schema_version: 1 }, []);
    expect(result.ok).toBe(false);
    expect(result.run_blocking.length).toBeGreaterThan(0);
    expect(result.run_blocking).toContain('manifest_reports');
  });

  test('does not let an elision marker ground a snippet whose code lines are invented', () => {
    const targetBody = 'diff --git a/src/auth.ts b/src/auth.ts\n+++ b/src/auth.ts\n+const tenant = req.params.id;';
    const manifest = {
      ...MANIFEST,
      target_hash: `sha256:${createHash('sha256').update(targetBody).digest('hex')}`,
      target_files: ['src/auth.ts'],
    };
    const security = zeroReport('security-1', 'security', {
      target_hash: manifest.target_hash,
      checked_files: ['src/auth.ts'],
      findings: [{ severity: 'High', file: 'src/auth.ts', line: 1, description: 'Invented with elision', code: '// ...\nexecSync(payload);\n// ...', why: 'Impact', fix: 'Remove it' }],
      no_findings_reason: undefined,
    });
    const logic = zeroReport('logic-1', 'logic', { target_hash: manifest.target_hash, checked_files: ['src/auth.ts'] });
    const result = validateReviewReports(manifest, raws(security, logic), { targetBody });
    expect(result.finding_grounding).toMatchObject({ findings: 1, grounded: 0, ungrounded: 1 });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'finding_code_mismatch', finding_index: 0 }));
  });

  test('grounds quoted Git target sections using the decoded filename', () => {
    const targetBody = 'diff --git "a/src/\\355\\225\\234\\352\\270\\200.ts" "b/src/\\355\\225\\234\\352\\270\\200.ts"\n+const value = true;';
    const manifest = { ...MANIFEST, target_hash: 'sha256:' + createHash('sha256').update(targetBody).digest('hex'), target_files: ['src/한글.ts'] };
    const security = zeroReport('security-1', 'security', {
      target_hash: manifest.target_hash,
      checked_files: manifest.target_files,
      findings: [{
        severity: 'Low', file: 'src/한글.ts', line: 1, description: 'Concrete value',
        code: 'const value = true;', why: 'The target contains this value', fix: 'Keep it explicit',
      }],
      no_findings_reason: undefined,
    });
    const result = validateReviewReports(manifest, raws(
      security,
      zeroReport('logic-1', 'logic', { target_hash: manifest.target_hash, checked_files: manifest.target_files }),
    ), { targetBody });
    expect(result.ok).toBe(true);
  });

  test('requires every profile report to cover every frozen target file', () => {
    const manifest = { ...MANIFEST, target_files: ['src/a.ts', 'src/b.ts'] };
    const result = validateReviewReports(manifest, raws(
      zeroReport('security-1', 'security', { checked_files: ['src/a.ts'] }),
      zeroReport('logic-1', 'logic', { checked_files: ['src/b.ts'] }),
    ), { targetBody: [
      'diff --git a/src/a.ts b/src/a.ts', '+const a = true;',
      'diff --git a/src/b.ts b/src/b.ts', '+const b = true;',
    ].join('\n') });
    expect(result.ok).toBe(false);
    expect(result.target_coverage).toEqual({ expected: 2, checked: 0, complete: false, missing_files: ['src/a.ts', 'src/b.ts'] });
    expect(result.issues.filter((entry) => entry.code === 'report_target_coverage_incomplete')).toHaveLength(2);
  });

  test('requires every profile by chunk report and validates each chunk hash', () => {
    const chunkA = `sha256:${'b'.repeat(64)}`;
    const chunkB = `sha256:${'c'.repeat(64)}`;
    const manifest = {
      ...MANIFEST,
      target_files: ['src/a.ts', 'src/b.ts'],
      profiles: [{ profile: 'security' }],
      chunks: [
        { id: 'chunk-001', target_hash: chunkA, target_file: 'chunks/chunk-001.patch', files: ['src/a.ts'] },
        { id: 'chunk-002', target_hash: chunkB, target_file: 'chunks/chunk-002.patch', files: ['src/b.ts'] },
      ],
      expected_reports: [
        { report_id: 'security-chunk-001', lens: 'security', chunk_id: 'chunk-001', wave: 1, target_hash: chunkA, target_file: 'chunks/chunk-001.patch', target_files: ['src/a.ts'] },
        { report_id: 'security-chunk-002', lens: 'security', chunk_id: 'chunk-002', wave: 2, target_hash: chunkB, target_file: 'chunks/chunk-002.patch', target_files: ['src/b.ts'] },
      ],
    };
    const targetBody = [
      'diff --git a/src/a.ts b/src/a.ts', '+const a = true;',
      'diff --git a/src/b.ts b/src/b.ts', '+const b = true;',
    ].join('\n');
    manifest.target_hash = 'sha256:' + createHash('sha256').update(targetBody).digest('hex');
    const chunkBodies = {
      'chunks/chunk-001.patch': 'a',
      'chunks/chunk-002.patch': 'b',
    };
    manifest.expected_reports[0].target_hash = `sha256:${createHash('sha256').update('a').digest('hex')}`;
    manifest.expected_reports[1].target_hash = `sha256:${createHash('sha256').update('b').digest('hex')}`;
    manifest.chunks[0].target_hash = manifest.expected_reports[0].target_hash;
    manifest.chunks[1].target_hash = manifest.expected_reports[1].target_hash;
    const complete = validateReviewReports(manifest, raws(
      zeroReport('security-chunk-001', 'security', { target_hash: manifest.expected_reports[0].target_hash, checked_files: ['src/a.ts'] }),
      zeroReport('security-chunk-002', 'security', { target_hash: manifest.expected_reports[1].target_hash, checked_files: ['src/b.ts'] }),
    ), { targetBody, chunkBodies });
    expect(complete.ok).toBe(true);
    expect(complete.coverage).toEqual({ expected: 2, valid: 2 });

    const stale = validateReviewReports(manifest, raws(
      zeroReport('security-chunk-001', 'security', { target_hash: manifest.expected_reports[0].target_hash, checked_files: ['src/a.ts'] }),
      zeroReport('security-chunk-002', 'security', { target_hash: manifest.expected_reports[0].target_hash, checked_files: ['src/b.ts'] }),
    ), { targetBody, chunkBodies });
    expect(stale.ok).toBe(false);
    expect(stale.issues).toContainEqual(expect.objectContaining({ code: 'stale_target', report_id: 'security-chunk-002' }));
  });

  test('rejects a chunk manifest that omits one profile by chunk report', () => {
    const hash = `sha256:${createHash('sha256').update('a').digest('hex')}`;
    const manifest = {
      ...MANIFEST,
      target_files: ['src/a.ts', 'src/b.ts'],
      profiles: [{ profile: 'security' }, { profile: 'logic' }],
      chunks: [
        { id: 'chunk-001', target_hash: hash, target_file: 'chunks/chunk-001.patch', files: ['src/a.ts'] },
        { id: 'chunk-002', target_hash: hash, target_file: 'chunks/chunk-002.patch', files: ['src/b.ts'] },
      ],
      expected_reports: [
        { report_id: 'security-chunk-001', lens: 'security', chunk_id: 'chunk-001', wave: 1, target_hash: hash, target_file: 'chunks/chunk-001.patch', target_files: ['src/a.ts'] },
        { report_id: 'security-chunk-002', lens: 'security', chunk_id: 'chunk-002', wave: 2, target_hash: hash, target_file: 'chunks/chunk-002.patch', target_files: ['src/b.ts'] },
        { report_id: 'logic-chunk-001', lens: 'logic', chunk_id: 'chunk-001', wave: 1, target_hash: hash, target_file: 'chunks/chunk-001.patch', target_files: ['src/a.ts'] },
      ],
    };
    const result = validateReviewReports(manifest, [], { targetBody: [
      'diff --git a/src/a.ts b/src/a.ts', '+a', 'diff --git a/src/b.ts b/src/b.ts', '+b',
    ].join('\n'), chunkBodies: { 'chunks/chunk-001.patch': 'a', 'chunks/chunk-002.patch': 'a' } });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'manifest_profile_chunk_missing' }));
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'manifest_profile_chunk_count' }));
  });

  test('does not reject a 2001-line target that fits the token budget', () => {
    const target = Array.from({ length: 2001 }, () => '+x').join('\n');
    const plan = planReview(target);
    expect(plan.changed_lines).toBe(2001);
    expect(plan.requires_chunking).toBe(false);
    expect(plan.reviewable).toBe(true);
  });

  test('uses file dispersion as a chunk condition without rejecting 101 small files', () => {
    const target = Array.from({ length: 101 }, (_, index) => [
      `diff --git a/src/${index}.js b/src/${index}.js`, `+++ b/src/${index}.js`, '+export default true;',
    ].join('\n')).join('\n');
    // Pin the budget: the assertion is about dispersion-driven chunking, not the default.
    const plan = planReview(target, { chunkFileBudget: 100 });
    expect(plan.files).toHaveLength(101);
    expect(plan.requires_chunking).toBe(true);
    expect(plan.reviewable).toBe(true);
    expect(plan.chunks.map((chunk) => chunk.files.length)).toEqual([100, 1]);
    expect(plan.expected_reports).toHaveLength(plan.profiles.length * 2);
    const withDefaults = planReview(target);
    expect(withDefaults.reviewable).toBe(true);
    expect(withDefaults.chunks.every((chunk) => chunk.files.length <= withDefaults.chunk_file_budget)).toBe(true);
  });

  test('honors a three-file budget for bounded panel dispatch', () => {
    const target = Array.from({ length: 7 }, (_, index) => [
      `diff --git a/src/${index}.js b/src/${index}.js`, `+++ b/src/${index}.js`, '+export default true;',
    ].join('\n')).join('\n');
    const plan = planReview(target, { chunkFileBudget: 3 });
    expect(plan.chunk_file_budget).toBe(3);
    expect(plan.chunks.map((chunk) => chunk.files.length)).toEqual([3, 3, 1]);
    expect(plan.chunks.every((chunk) => chunk.files.length <= 3)).toBe(true);
  });

  test('keeps directly related source, test, and Xcode manifest evidence in bounded chunk context', () => {
    const section = (file, lines) => [
      `diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -1 +1 @@', ...lines,
    ].join('\n');
    const target = [
      section('GhosttyTabs.xcodeproj/project.pbxproj', [
        '+path = InputInjectionLogTests.swift;',
        '+path = PeerPaneSessionTests.swift;',
        '+path = TerminalControllerTests.swift;',
      ]),
      section('Sources/GhosttyPaneSurfaceProvider.swift', ['+struct GhosttyPaneSurfaceProvider {}']),
      section('Sources/TeamOrchestrator.swift', ['+func classifyProjectNameConflict() {}']),
      section('Sources/TerminalController.swift', ['+final class TerminalController {}']),
      section('termMeshTests/InputInjectionLogTests.swift', ['+final class InputInjectionLogTests {}']),
      section('termMeshTests/PeerPaneSessionTests.swift', ['+classifyProjectNameConflict()']),
      section('termMeshTests/TerminalControllerTests.swift', ['+TerminalController()']),
    ].join('\n');

    const first = planReview(target, { chunkFileBudget: 3 });
    const second = planReview(target, { chunkFileBudget: 3 });
    const bodies = chunkFrozenTarget(target, 24_000, { fileBudget: 3 });
    const relationVisible = (left, right) => bodies.some((chunk) => (
      (chunk.files.includes(left) && chunk.files.includes(right))
      || chunk.body.includes(`${left} <-> ${right}`)
      || chunk.body.includes(`${right} <-> ${left}`)
    ));

    expect(relationVisible('termMeshTests/InputInjectionLogTests.swift', 'GhosttyTabs.xcodeproj/project.pbxproj')).toBe(true);
    expect(relationVisible('termMeshTests/PeerPaneSessionTests.swift', 'Sources/TeamOrchestrator.swift')).toBe(true);
    expect(relationVisible('termMeshTests/TerminalControllerTests.swift', 'Sources/TerminalController.swift')).toBe(true);
    expect(first.chunks.flatMap((chunk) => chunk.files)).toHaveLength(new Set(first.chunks.flatMap((chunk) => chunk.files)).size);
    expect(first.chunks.every((chunk) => chunk.files.length <= 3)).toBe(true);
    expect(first.chunks.every((chunk) => chunk.estimated_target_tokens <= first.chunk_token_budget)).toBe(true);
    expect(second.chunks).toEqual(first.chunks);
  });

  test('keeps co-located dotted test names with their source file', () => {
    const section = (file) => [
      `diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -1 +1 @@', '+export default true;',
    ].join('\n');
    const plan = planReview([
      section('src/Widget.ts'), section('src/unrelated.ts'), section('src/Widget.test.ts'), section('src/other.ts'),
    ].join('\n'), { chunkFileBudget: 2 });
    const testChunk = plan.chunks.find((chunk) => chunk.files.includes('src/Widget.test.ts'));

    expect(testChunk.files).toContain('src/Widget.ts');
    expect(plan.chunks.every((chunk) => chunk.files.length <= 2)).toBe(true);
  });

  test('preserves short callable relationships without duplicating source sections', () => {
    const section = (file, line) => [
      `diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -1 +1 @@', line,
    ].join('\n');
    const plan = planReview([
      section('Sources/Runner.swift', '+func run() {}'),
      section('Tests/WorkflowTests.swift', '+run()'),
      section('Tests/RetryTests.swift', '+run()'),
    ].join('\n'), { chunkFileBudget: 2 });
    const bodies = chunkFrozenTarget([
      section('Sources/Runner.swift', '+func run() {}'),
      section('Tests/WorkflowTests.swift', '+run()'),
      section('Tests/RetryTests.swift', '+run()'),
    ].join('\n'), 24_000, { fileBudget: 2 });

    expect(plan.chunks.every((chunk) => chunk.files.length <= 2)).toBe(true);
    expect(plan.chunks.flatMap((chunk) => chunk.files).filter((file) => file === 'Sources/Runner.swift')).toHaveLength(1);
    expect(bodies.filter((chunk) => chunk.body.includes('diff --git a/Sources/Runner.swift'))).toHaveLength(1);
    expect(bodies.every((chunk) => chunk.body.includes('X-REVIEW COMPANION CONTEXT'))).toBe(true);
    expect(bodies.every((chunk) => chunk.body.includes('Sources/Runner.swift <-> Tests/WorkflowTests.swift'))).toBe(true);
  });

  test('fails closed when companion context plus one unit exceeds the token budget', () => {
    const section = (file, line) => [
      `diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -1 +1 @@', line,
    ].join('\n');
    const target = [
      section('Sources/Runner.swift', `+func run() { ${'x'.repeat(2750)} }`),
      ...Array.from({ length: 35 }, (_, index) => section(`Tests/Workflow${index}Tests.swift`, '+run()')),
    ].join('\n');
    expect(chunkFrozenTarget(target, 1_000, { fileBudget: 2 })).toEqual([]);
    expect(planReview(target, { chunkTokenBudget: 1_000, chunkFileBudget: 2 }).reviewable).toBe(false);
  });

  test('chunks a large target by file within the token budget and expands profile coverage', () => {
    const section = (file, value) => [
      `diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -1 +1 @@', '-old', `+${value.repeat(2200)}`,
    ].join('\n');
    const target = [section('src/a.ts', 'a'), section('src/b.ts', 'b')].join('\n');
    const plan = planReview(target, { chunkTokenBudget: 1_000 });
    expect(plan.chunked).toBe(true);
    expect(plan.reviewable).toBe(true);
    expect(plan.chunks).toHaveLength(2);
    expect(plan.estimated_llm_waves).toBe(1);
    expect(plan.chunks.every((chunk) => chunk.estimated_target_tokens <= 1_000)).toBe(true);
    expect(plan.expected_reports).toHaveLength(plan.profiles.length * plan.chunks.length);
    expect(plan.expected_reports.map((entry) => entry.report_id)).toEqual([
      'correctness-chunk-001', 'correctness-chunk-002', 'risk-chunk-001', 'risk-chunk-002',
    ]);
    expect(plan.expected_reports.map((entry) => entry.wave)).toEqual([1, 1, 1, 1]);
  });

  test('packs complete chunks into bounded waves without exceeding report concurrency', () => {
    const section = (name, value) => [
      `diff --git a/src/${name}.ts b/src/${name}.ts`,
      `--- a/src/${name}.ts`,
      `+++ b/src/${name}.ts`,
      '@@ -1 +1 @@',
      `+${'x'.repeat(value)}`,
    ].join('\n');
    const target = [section('a', 1800), section('b', 1800), section('c', 1800)].join('\n');
    const plan = planReview(target, { chunkTokenBudget: 1_000, maxProfiles: 4, maxConcurrentReports: 4 });
    expect(plan.profiles).toHaveLength(2);
    expect(plan.chunks).toHaveLength(3);
    expect(plan.chunks_per_wave).toBe(2);
    expect(plan.estimated_llm_waves).toBe(2);
    const reportsByWave = Object.groupBy(plan.expected_reports, (entry) => entry.wave);
    expect(Object.values(reportsByWave).map((reports) => reports.length)).toEqual([4, 2]);
    for (const chunk of plan.chunks) {
      const waves = new Set(plan.expected_reports.filter((entry) => entry.chunk_id === chunk.id).map((entry) => entry.wave));
      expect(waves.size).toBe(1);
    }
  });

  test('splits an oversized single-file hunk and fails closed for an unsplittable line', () => {
    const header = ['diff --git a/src/big.ts b/src/big.ts', '--- a/src/big.ts', '+++ b/src/big.ts', '@@ -1,900 +1,900 @@'];
    const target = [...header, ...Array.from({ length: 900 }, (_, index) => `+const value${index} = ${index};`)].join('\n');
    const chunks = chunkFrozenTarget(target, 1_000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => estimateTargetTokens(chunk.body) <= 1_000)).toBe(true);
    expect(chunks.every((chunk) => chunk.files.includes('src/big.ts'))).toBe(true);

    const unsplittable = [...header, `+${'x'.repeat(4_000)}`].join('\n');
    const plan = planReview(unsplittable, { chunkTokenBudget: 1_000 });
    expect(plan.reviewable).toBe(false);
    expect(plan.incomplete_reason).toContain('cannot be split');
  });

  test('splits a raw file target by line range and preserves its explicit path', () => {
    const target = Array.from({ length: 900 }, (_, index) => `const value${index} = ${index};`).join('\n');
    const plan = planReview(target, { targetFiles: ['src/big.ts'], chunkTokenBudget: 1_000 });
    expect(plan.chunked).toBe(true);
    expect(plan.reviewable).toBe(true);
    expect(plan.chunks.every((chunk) => chunk.files.join() === 'src/big.ts')).toBe(true);
    expect(plan.expected_reports.every((entry) => entry.target_files.join() === 'src/big.ts')).toBe(true);
  });

  test('rejects unreviewed files and snippets fabricated outside the frozen target', () => {
    const manifest = { ...MANIFEST, target_files: ['src/auth.ts', 'src/session.ts'] };
    const security = zeroReport('security-1', 'security', {
      checked_files: ['src/auth.ts'],
      findings: [{ severity: 'High', file: 'src/auth.ts', line: 2, description: 'Claim', code: 'not in target', why: 'Impact', fix: 'Fix it' }],
      no_findings_reason: undefined,
    });
    const logic = zeroReport('logic-1', 'logic', { checked_files: ['src/auth.ts'] });
    const result = validateReviewReports(manifest, raws(security, logic), { targetBody: '+const safe = true;' });
    expect(result.ok).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain('finding_code_mismatch');
    expect(result.issues.map((entry) => entry.code)).toContain('target_coverage_incomplete');
  });

  test('requires frozen target bytes whenever target files enable grounding', () => {
    const manifest = { ...MANIFEST, target_files: ['src/auth.ts'] };
    const result = validateReviewReports(manifest, raws(
      zeroReport('security-1', 'security', { checked_files: ['src/auth.ts'] }),
      zeroReport('logic-1', 'logic', { checked_files: ['src/auth.ts'] }),
    ));
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'frozen_target_missing' }));
  });

  test('rejects a manifest whose top-level target hash does not bind the supplied frozen target', () => {
    const target = 'diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n+const a = 1;';
    const manifest = {
      ...MANIFEST,
      target_hash: `sha256:${'f'.repeat(64)}`,
      target_files: ['src/a.ts'],
    };
    const reports = raws(
      zeroReport('security-1', 'security', { target_hash: manifest.target_hash, checked_files: ['src/a.ts'] }),
      zeroReport('logic-1', 'logic', { target_hash: manifest.target_hash, checked_files: ['src/a.ts'] }),
    );
    const result = validateReviewReports(manifest, reports, { targetBody: target });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'frozen_target_hash_mismatch' }));
  });

  test('rejects unsectioned multi-file frozen targets', () => {
    const manifest = { ...MANIFEST, target_files: ['src/auth.ts', 'src/session.ts'] };
    const result = validateReviewReports(manifest, raws(
      zeroReport('security-1', 'security', { checked_files: manifest.target_files }),
      zeroReport('logic-1', 'logic', { checked_files: manifest.target_files }),
    ), { targetBody: 'const auth = true;\nconst session = true;' });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'frozen_target_unsectioned' }));
  });

  test('requires the frozen target and manifest to contain the same file set', () => {
    const manifest = { ...MANIFEST, target_files: ['src/a.ts', 'src/b.ts'] };
    const reports = raws(
      zeroReport('security-1', 'security', { checked_files: manifest.target_files }),
      zeroReport('logic-1', 'logic', { checked_files: manifest.target_files }),
    );
    const missing = validateReviewReports(manifest, reports, {
      targetBody: 'diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n+const a = true;',
    });
    expect(missing.ok).toBe(false);
    expect(missing.issues).toContainEqual(expect.objectContaining({ code: 'frozen_target_sections_missing' }));

    const extra = validateReviewReports(
      { ...MANIFEST, target_files: ['src/a.ts'] },
      raws(
        zeroReport('security-1', 'security', { checked_files: ['src/a.ts'] }),
        zeroReport('logic-1', 'logic', { checked_files: ['src/a.ts'] }),
      ),
      { targetBody: [
        'diff --git a/src/a.ts b/src/a.ts', '+++ b/src/a.ts', '+const a = true;',
        'diff --git a/src/b.ts b/src/b.ts', '+++ b/src/b.ts', '+const b = true;',
      ].join('\n') },
    );
    expect(extra.ok).toBe(false);
    expect(extra.issues).toContainEqual(expect.objectContaining({ code: 'frozen_target_sections_unexpected' }));
  });

  test('rejects an empty response and generic prior-context prose', () => {
    const result = validateReviewReports(MANIFEST, [
      { file: 'security.json', body: '' },
      { file: 'logic.json', body: 'STATUS: DONE — waiting for the next task.' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain('empty_report');
    expect(result.issues.map((entry) => entry.code)).toContain('malformed_report');
    expect(result.missing_reports).toEqual(MANIFEST.expected_reports);
  });

  test('rejects a structurally valid report from an earlier task or target', () => {
    const stale = zeroReport('security-1', 'security', { task_id: 'review-previous-001', target_hash: `sha256:${'b'.repeat(64)}` });
    const result = validateReviewReports(MANIFEST, raws(stale, zeroReport('logic-1', 'logic')));
    expect(result.ok).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain('stale_task');
    expect(result.issues.map((entry) => entry.code)).toContain('stale_target');
    expect(result.missing_reports).toContainEqual({ report_id: 'security-1', lens: 'security' });
  });

  test('rejects partial fan-out coverage', () => {
    const result = validateReviewReports(MANIFEST, raws(zeroReport('security-1', 'security')));
    expect(result.ok).toBe(false);
    expect(result.coverage).toEqual({ expected: 2, valid: 1 });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'missing_report', report_id: 'logic-1', lens: 'logic' }));
  });

  test('rejects bare zero findings without checked evidence and reason', () => {
    const invalid = zeroReport('security-1', 'security', { checked: [], no_findings_reason: 'none' });
    const result = validateReviewReports(MANIFEST, raws(invalid, zeroReport('logic-1', 'logic')));
    expect(result.ok).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain('checked_missing');
    expect(result.issues.map((entry) => entry.code)).toContain('zero_findings_unsubstantiated');
  });

  test('CLI writes a validation receipt and exits nonzero on incomplete coverage', () => {
    const root = mkdtempSync(join(tmpdir(), 'x-review-contract-'));
    try {
      const reports = join(root, 'reports');
      mkdirSync(reports);
      writeFileSync(join(root, 'run.json'), JSON.stringify(MANIFEST));
      writeFileSync(join(reports, 'security-1.json'), JSON.stringify(zeroReport('security-1', 'security')));
      const out = join(root, 'validation.json');
      const run = spawnSync('node', [CLI, '--manifest', join(root, 'run.json'), '--reports-dir', reports, '--out', out], { encoding: 'utf8' });
      expect(run.status).toBe(1);
      const receipt = JSON.parse(run.stdout);
      expect(receipt.ok).toBe(false);
      expect(receipt.missing_reports).toEqual([{ report_id: 'logic-1', lens: 'logic' }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('validator rejects an unsafe chunk path without reading outside the chunk directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'x-review-unsafe-chunk-'));
    try {
      const reports = join(root, 'reports');
      const chunks = join(root, 'chunks');
      mkdirSync(reports);
      mkdirSync(chunks);
      const manifest = {
        ...MANIFEST,
        expected_reports: [{
          report_id: 'security-chunk-001', lens: 'security', chunk_id: 'chunk-001', wave: 1,
          target_hash: HASH, target_file: 'chunks/../../outside.patch', target_files: ['src/a.ts'],
        }],
      };
      writeFileSync(join(root, 'run.json'), JSON.stringify(manifest));
      writeFileSync(join(root, 'outside.patch'), 'sensitive');
      const run = spawnSync('node', [
        CLI, '--manifest', join(root, 'run.json'), '--reports-dir', reports, '--chunks-dir', chunks,
      ], { encoding: 'utf8' });
      expect(run.status).toBe(1);
      expect(JSON.parse(run.stdout).issues).toContainEqual(expect.objectContaining({ code: 'manifest_report_target_file' }));
      expect(run.stderr).not.toContain('frozen chunk read failed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('planner and validator CLIs complete a token-chunked profile by chunk run', () => {
    const root = mkdtempSync(join(tmpdir(), 'x-review-chunked-cli-'));
    try {
      const section = (file, value) => [
        `diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -1 +1 @@', '-old', `+${value.repeat(2_200)}`,
      ].join('\n');
      const targetBody = [section('src/a.ts', 'a'), section('src/b.ts', 'b')].join('\n');
      const target = join(root, 'target.patch');
      const chunksDir = join(root, 'chunks');
      writeFileSync(target, targetBody);
      const planned = spawnSync('node', [
        PLAN_CLI, '--target', target, '--chunk-token-budget', '1000', '--chunks-dir', chunksDir,
      ], { encoding: 'utf8' });
      expect(planned.status).toBe(0);
      const plan = JSON.parse(planned.stdout);
      expect(plan).toMatchObject({ chunked: true, reviewable: true, estimated_llm_waves: 1 });
      expect(plan.expected_reports).toHaveLength(plan.profiles.length * plan.chunks.length);

      const manifest = {
        schema_version: 1,
        task_id: 'review-chunked-cli-001',
        target_hash: `sha256:${createHash('sha256').update(targetBody).digest('hex')}`,
        target_files: plan.files,
        profiles: plan.profiles,
        chunks: plan.chunks,
        expected_reports: plan.expected_reports,
      };
      const reportsDir = join(root, 'reports');
      mkdirSync(reportsDir);
      writeFileSync(join(root, 'run.json'), JSON.stringify(manifest));
      for (const expected of plan.expected_reports) {
        writeFileSync(join(reportsDir, `${expected.report_id}.json`), JSON.stringify({
          schema_version: 1,
          task_id: manifest.task_id,
          target_hash: expected.target_hash,
          report_id: expected.report_id,
          lens: expected.lens,
          status: 'complete',
          checked: [`${expected.lens}: inspected ${expected.chunk_id}`],
          checked_files: expected.target_files,
          findings: [],
          no_findings_reason: `No ${expected.lens} defect found in ${expected.chunk_id} after checking every supplied file.`,
        }));
      }

      const validated = spawnSync('node', [
        CLI, '--manifest', join(root, 'run.json'), '--reports-dir', reportsDir,
        '--target', target, '--chunks-dir', chunksDir,
      ], { encoding: 'utf8' });
      expect(validated.status).toBe(0);
      const receipt = JSON.parse(validated.stdout);
      expect(receipt.ok).toBe(true);
      expect(receipt.coverage).toEqual({ expected: plan.expected_reports.length, valid: plan.expected_reports.length });
      expect(receipt.target_coverage).toEqual({ expected: 2, checked: 2, complete: true, missing_files: [] });
      for (const chunk of plan.chunks) {
        const chunkBody = readFileSync(join(root, chunk.target_file), 'utf8');
        expect(`sha256:${createHash('sha256').update(chunkBody).digest('hex')}`).toBe(chunk.target_hash);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('supports redundant agents for one lens and requires every instance', () => {
    const manifest = {
      ...MANIFEST,
      expected_reports: [
        { report_id: 'security-1', lens: 'security' },
        { report_id: 'security-2', lens: 'security' },
        { report_id: 'security-3', lens: 'security' },
      ],
    };
    const complete = validateReviewReports(manifest, raws(
      zeroReport('security-1', 'security'),
      zeroReport('security-2', 'security'),
      zeroReport('security-3', 'security'),
    ));
    expect(complete.ok).toBe(true);
    expect(complete.coverage).toEqual({ expected: 3, valid: 3 });

    const partial = validateReviewReports(manifest, raws(
      zeroReport('security-1', 'security'),
      zeroReport('security-3', 'security'),
    ));
    expect(partial.ok).toBe(false);
    expect(partial.missing_reports).toContainEqual({ report_id: 'security-2', lens: 'security' });
  });

  test('rejects duplicate responses for one report instance', () => {
    const result = validateReviewReports(MANIFEST, raws(
      zeroReport('security-1', 'security'),
      zeroReport('security-1', 'security'),
      zeroReport('logic-1', 'logic'),
    ));
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'duplicate_report',
      report_id: 'security-1',
    }));
  });

  test('reports a contract-sanctioned failed report as a single report_failed issue', () => {
    const failed = zeroReport('security-1', 'security', {
      status: 'failed',
      checked: undefined,
      findings: undefined,
      no_findings_reason: undefined,
    });
    const result = validateReviewReports(MANIFEST, raws(failed, zeroReport('logic-1', 'logic')));
    expect(result.ok).toBe(false);
    expect(result.issues.filter((entry) => entry.report_id === 'security-1'))
      .toEqual([expect.objectContaining({ code: 'report_failed' })]);
    expect(result.missing_reports).toContainEqual({ report_id: 'security-1', lens: 'security' });
  });

  test('keeps report_incomplete for a non-failed, non-complete status', () => {
    const partial = zeroReport('security-1', 'security', { status: 'partial' });
    const result = validateReviewReports(MANIFEST, raws(partial, zeroReport('logic-1', 'logic')));
    expect(result.ok).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain('report_incomplete');
    expect(result.issues.map((entry) => entry.code)).not.toContain('report_failed');
  });

  test('rejects a report whose lens does not match its dispatched instance', () => {
    const result = validateReviewReports(MANIFEST, raws(
      zeroReport('security-1', 'logic'),
      zeroReport('logic-1', 'logic'),
    ));
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'lens_mismatch',
      report_id: 'security-1',
    }));
  });

  test('the planner and the lifecycle agree on the default file budget', () => {
    const planner = readFileSync(join(ROOT, 'x-review', 'skills', 'review', 'scripts', 'plan-review.mjs'), 'utf8');
    const lifecycle = readFileSync(join(ROOT, 'x-review', 'lib', 'review-lifecycle.mjs'), 'utf8');
    const plannerBudget = planner.match(/const DEFAULT_CHUNK_FILE_BUDGET = (\d+);/)?.[1];
    const lifecycleBudget = lifecycle.match(/const DEFAULT_FILE_BUDGET = (\d+);/)?.[1];
    expect(plannerBudget).toBeDefined();
    expect(lifecycleBudget).toBeDefined();
    // A drift here silently splits one target two different ways depending on the entry point.
    expect(plannerBudget).toBe(lifecycleBudget);
  });
});
