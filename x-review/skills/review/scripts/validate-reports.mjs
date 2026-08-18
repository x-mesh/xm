#!/usr/bin/env node
// @ts-check

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SEVERITIES = new Set(['Critical', 'High', 'Medium', 'Low']);
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/;
const REPORT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const TARGET_HASH_RE = /^sha256:[0-9a-f]{64}$/;

function issue(code, message, lens = null, file = null, reportId = null) {
  return {
    code,
    message,
    ...(reportId ? { report_id: reportId } : {}),
    ...(lens ? { lens } : {}),
    ...(file ? { file } : {}),
  };
}

function nonEmptyStrings(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === 'string' && item.trim().length > 0);
}

function validateManifest(manifest) {
  const issues = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return [issue('manifest_invalid', 'manifest must be a JSON object')];
  }
  if (manifest.schema_version !== 1) issues.push(issue('manifest_schema', 'schema_version must be 1'));
  if (typeof manifest.task_id !== 'string' || !TASK_ID_RE.test(manifest.task_id)) {
    issues.push(issue('manifest_task_id', 'task_id must be 6-128 safe identifier characters'));
  }
  if (typeof manifest.target_hash !== 'string' || !TARGET_HASH_RE.test(manifest.target_hash)) {
    issues.push(issue('manifest_target_hash', 'target_hash must be sha256:<64 lowercase hex>'));
  }
  if (!Array.isArray(manifest.expected_reports) || manifest.expected_reports.length === 0) {
    issues.push(issue('manifest_reports', 'expected_reports must be a non-empty array'));
  } else {
    const reportIds = [];
    manifest.expected_reports.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        issues.push(issue('manifest_report_invalid', `expected_reports[${index}] must be an object`));
        return;
      }
      if (typeof entry.report_id !== 'string' || !REPORT_ID_RE.test(entry.report_id)) {
        issues.push(issue('manifest_report_id', `expected_reports[${index}].report_id must be 3-128 safe identifier characters`));
      } else {
        reportIds.push(entry.report_id);
      }
      if (typeof entry.lens !== 'string' || entry.lens.trim().length === 0) {
        issues.push(issue('manifest_report_lens', `expected_reports[${index}].lens must be a non-empty string`));
      }
    });
    if (new Set(reportIds).size !== reportIds.length) {
      issues.push(issue('manifest_report_duplicate', 'expected report_id values must be unique'));
    }
  }
  return issues;
}

function validateFinding(finding, index, lens, file, reportId) {
  const issues = [];
  const prefix = `findings[${index}]`;
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
    return [issue('finding_invalid', `${prefix} must be an object`, lens, file, reportId)];
  }
  if (!SEVERITIES.has(finding.severity)) {
    issues.push(issue('finding_severity', `${prefix}.severity is invalid`, lens, file, reportId));
  }
  for (const key of ['file', 'description', 'code', 'why', 'fix']) {
    if (typeof finding[key] !== 'string' || finding[key].trim().length === 0) {
      issues.push(issue('finding_field', `${prefix}.${key} must be a non-empty string`, lens, file, reportId));
    }
  }
  const lineOk = Number.isInteger(finding.line) && finding.line > 0;
  if (!lineOk) issues.push(issue('finding_line', `${prefix}.line must be a positive integer`, lens, file, reportId));
  return issues;
}

function validateReport(report, manifest, file) {
  const issues = [];
  const lens = typeof report?.lens === 'string' ? report.lens : null;
  const reportId = typeof report?.report_id === 'string' ? report.report_id : null;
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return [issue('report_invalid', 'report must be a JSON object', null, file)];
  }
  if (report.schema_version !== 1) issues.push(issue('report_schema', 'schema_version must be 1', lens, file, reportId));
  if (report.task_id !== manifest.task_id) {
    issues.push(issue('stale_task', 'task_id does not match this review run', lens, file, reportId));
  }
  if (report.target_hash !== manifest.target_hash) {
    issues.push(issue('stale_target', 'target_hash does not match the dispatched target', lens, file, reportId));
  }
  const expected = manifest.expected_reports.find((entry) => entry.report_id === report.report_id);
  if (!expected) {
    issues.push(issue('unexpected_report', 'report_id was not dispatched for this review run', lens, file, reportId));
  } else if (report.lens !== expected.lens) {
    issues.push(issue('lens_mismatch', 'lens does not match the dispatched report_id', lens, file, reportId));
  }
  if (report.status === 'failed') {
    // Contract-sanctioned failure: there is no content to validate, only a report_id to re-dispatch.
    issues.push(issue('report_failed', 'agent declared the target unreviewable — re-dispatch this report_id', lens, file, reportId));
    return issues;
  }
  if (report.status !== 'complete') {
    issues.push(issue('report_incomplete', 'status must be complete', lens, file, reportId));
  }
  if (!nonEmptyStrings(report.checked)) {
    issues.push(issue('checked_missing', 'checked must name at least one concrete path or behavior reviewed', lens, file, reportId));
  }
  if (!Array.isArray(report.findings)) {
    issues.push(issue('findings_invalid', 'findings must be an array', lens, file, reportId));
  } else {
    report.findings.forEach((finding, index) => issues.push(...validateFinding(finding, index, lens, file, reportId)));
    if (report.findings.length === 0) {
      if (typeof report.no_findings_reason !== 'string' || report.no_findings_reason.trim().length < 12) {
        issues.push(issue('zero_findings_unsubstantiated',
          'a zero-finding report requires a specific no_findings_reason (at least 12 characters)', lens, file, reportId));
      }
    }
  }
  return issues;
}

/**
 * Validate that every dispatched report instance returned one fresh, contract-valid report.
 * A valid zero-finding review is complete evidence, not an empty response.
 *
 * @param {unknown} manifest
 * @param {{ file: string, body: string }[]} rawReports
 */
export function validateReviewReports(manifest, rawReports) {
  const manifestIssues = validateManifest(manifest);
  if (manifestIssues.length > 0) {
    return { schema_version: 1, ok: false, coverage: { expected: 0, valid: 0 }, valid_reports: [], missing_reports: [], issues: manifestIssues };
  }

  const expected = manifest.expected_reports;
  const issues = [];
  const reports = [];
  for (const raw of rawReports) {
    if (!raw.body.trim()) {
      issues.push(issue('empty_report', 'report file is empty', null, raw.file));
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw.body);
    } catch {
      issues.push(issue('malformed_report', 'report is not a single JSON object (greetings/prose are invalid)', null, raw.file));
      continue;
    }
    const reportIssues = validateReport(parsed, manifest, raw.file);
    issues.push(...reportIssues);
    reports.push({ file: raw.file, report: parsed, valid: reportIssues.length === 0 });
  }

  const byReportId = new Map();
  for (const item of reports) {
    const reportId = item.report?.report_id;
    if (typeof reportId !== 'string' || !expected.some((entry) => entry.report_id === reportId)) continue;
    const list = byReportId.get(reportId) || [];
    list.push(item);
    byReportId.set(reportId, list);
  }
  for (const [reportId, entries] of byReportId) {
    if (entries.length > 1) {
      const lens = expected.find((entry) => entry.report_id === reportId)?.lens || null;
      issues.push(issue('duplicate_report', 'more than one response was returned for this report_id', lens, null, reportId));
    }
  }

  const validReports = expected.filter((entry) => {
    const entries = byReportId.get(entry.report_id) || [];
    return entries.length === 1 && entries[0].valid;
  }).map((entry) => entry.report_id);
  const missingReports = expected.filter((entry) => !validReports.includes(entry.report_id));
  for (const entry of missingReports) {
    if (!byReportId.has(entry.report_id)) {
      issues.push(issue('missing_report', 'no response returned for dispatched report_id', entry.lens, null, entry.report_id));
    }
  }

  const ok = issues.length === 0 && validReports.length === expected.length;
  return {
    schema_version: 1,
    task_id: manifest.task_id,
    target_hash: manifest.target_hash,
    ok,
    coverage: { expected: expected.length, valid: validReports.length },
    valid_reports: validReports,
    missing_reports: missingReports,
    issues,
  };
}

function usage() {
  return 'Usage: node validate-reports.mjs --manifest <run.json> --reports-dir <dir> [--out <validation.json>]';
}

export function main(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!['--manifest', '--reports-dir', '--out'].includes(key) || !argv[i + 1]) {
      process.stderr.write(`${usage()}\n`);
      return 2;
    }
    args[key.slice(2)] = argv[++i];
  }
  if (!args.manifest || !args['reports-dir']) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }

  let manifest;
  let rawReports;
  try {
    manifest = JSON.parse(readFileSync(resolve(args.manifest), 'utf8'));
    const reportsDir = resolve(args['reports-dir']);
    rawReports = readdirSync(reportsDir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => ({ file: name, body: readFileSync(resolve(reportsDir, name), 'utf8') }));
  } catch (error) {
    process.stderr.write(`x-review report validation setup failed: ${error.message}\n`);
    return 2;
  }

  const result = validateReviewReports(manifest, rawReports);
  const rendered = `${JSON.stringify(result, null, 2)}\n`;
  if (args.out) writeFileSync(resolve(args.out), rendered);
  process.stdout.write(rendered);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
