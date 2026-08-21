import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateReviewReports } from '../x-review/skills/review/scripts/validate-reports.mjs';
import { planReview } from '../x-review/skills/review/scripts/plan-review.mjs';
import { canonicalReviewContext, hashReviewContext, normalizeReviewContext } from '../x-review/skills/review/scripts/context-contract.mjs';
import { buildRetryTarget, splitFrozenSections } from '../x-review/skills/review/scripts/retry-target.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'x-review', 'skills', 'review', 'scripts', 'validate-reports.mjs');
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
  test('uses two composite reviewers for an ordinary patch', () => {
    const plan = planReview('diff --git a/src/a.js b/src/a.js\n+++ b/src/a.js\n+return value;');
    expect(plan.profiles.map((entry) => entry.profile)).toEqual(['correctness', 'risk']);
    expect(plan.estimated_llm_waves).toBe(1);
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
    const manifest = { ...MANIFEST, target_files: ['src/auth.ts'] };
    const security = zeroReport('security-1', 'security', {
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
    const logic = zeroReport('logic-1', 'logic', { checked_files: ['src/auth.ts'] });
    const targetBody = 'diff --git a/src/auth.ts b/src/auth.ts\n+++ b/src/auth.ts\n+const tenant = req.params.id;\n+return db.find(tenant);';
    const result = validateReviewReports(manifest, raws(security, logic), { targetBody });
    expect(result.ok).toBe(true);
    expect(result.target_coverage).toEqual({ expected: 1, checked: 1, complete: true, missing_files: [] });
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
    const manifest = { ...MANIFEST, target_files: ['src/value.ts'] };
    const security = zeroReport('security-1', 'security', {
      checked_files: ['src/value.ts'],
      findings: [{ severity: 'Low', file: 'src/value.ts', line: 1, description: 'Negative sentinel', code: '-1', why: 'Concrete value', fix: 'Use a named sentinel' }],
      no_findings_reason: undefined,
    });
    const logic = zeroReport('logic-1', 'logic', { checked_files: ['src/value.ts'] });
    const result = validateReviewReports(manifest, raws(security, logic), { targetBody: '+-1' });
    expect(result.ok).toBe(true);
  });

  test('preserves leading diff-like characters in a raw single-file target', () => {
    const manifest = { ...MANIFEST, target_files: ['src/value.ts'] };
    const security = zeroReport('security-1', 'security', {
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
    const logic = zeroReport('logic-1', 'logic', { checked_files: ['src/value.ts'] });
    const result = validateReviewReports(manifest, raws(security, logic), { targetBody: '-1\n+value' });
    expect(result.ok).toBe(true);
  });

  test('rejects a snippet that exists only in a different frozen target file', () => {
    const manifest = { ...MANIFEST, target_files: ['src/auth.ts', 'src/other.ts'] };
    const security = zeroReport('security-1', 'security', {
      checked_files: ['src/auth.ts'],
      findings: [{ severity: 'High', file: 'src/auth.ts', line: 1, description: 'Claim on auth', code: 'dangerous(value)', why: 'Reachable impact', fix: 'Remove it' }],
      no_findings_reason: undefined,
    });
    const logic = zeroReport('logic-1', 'logic', { checked_files: ['src/auth.ts', 'src/other.ts'] });
    const targetBody = [
      'diff --git a/src/auth.ts b/src/auth.ts',
      '+++ b/src/auth.ts',
      '+safe(value)',
      'diff --git a/src/other.ts b/src/other.ts',
      '+++ b/src/other.ts',
      '+dangerous(value)',
    ].join('\n');
    const result = validateReviewReports(manifest, raws(security, logic), { targetBody });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'finding_code_mismatch', report_id: 'security-1' }));
  });

  test('grounds quoted Git target sections using the decoded filename', () => {
    const manifest = { ...MANIFEST, target_files: ['src/한글.ts'] };
    const security = zeroReport('security-1', 'security', {
      checked_files: manifest.target_files,
      findings: [{
        severity: 'Low', file: 'src/한글.ts', line: 1, description: 'Concrete value',
        code: 'const value = true;', why: 'The target contains this value', fix: 'Keep it explicit',
      }],
      no_findings_reason: undefined,
    });
    const result = validateReviewReports(manifest, raws(
      security,
      zeroReport('logic-1', 'logic', { checked_files: manifest.target_files }),
    ), { targetBody: 'diff --git "a/src/\\355\\225\\234\\352\\270\\200.ts" "b/src/\\355\\225\\234\\352\\270\\200.ts"\n+const value = true;' });
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

  test('marks only targets beyond the documented planner limit for chunking', () => {
    const atLimit = Array.from({ length: 2000 }, () => '+line').join('\n');
    const overLimit = `${atLimit}\n+line`;
    expect(planReview(atLimit).requires_chunking).toBe(false);
    expect(planReview(overLimit).requires_chunking).toBe(true);
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
});
