import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateReviewReports } from '../x-review/skills/review/scripts/validate-reports.mjs';

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

function raws(...reports) {
  return reports.map((report, index) => ({ file: `${index}.json`, body: JSON.stringify(report) }));
}

describe('x-review lens report coverage contract', () => {
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
