#!/usr/bin/env node
// @ts-check

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SEVERITIES = new Set(['Critical', 'High', 'Medium', 'Low']);
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/;
const REPORT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const TARGET_HASH_RE = /^sha256:[0-9a-f]{64}$/;
// Grounding outcomes are per-finding, not per-report: an ungrounded snippet drops that one
// finding, it does not invalidate a report whose other findings are grounded.
const GROUNDING_CODES = new Set(['finding_code_mismatch', 'finding_code_wrong_file']);
// Codes whose damage is confined to ONE finding, so the report keeps the rest. A missing line
// used to invalidate the whole report: across 7 real reports that discarded 33 findings to
// reject 20 malformed ones, losing 13 well-formed findings with them. The finding is dropped
// like an ungrounded one instead; a report left with none lands where a zero-finding report
// already lands.
const DROPPABLE_FINDING_CODES = new Set([...GROUNDING_CODES, 'finding_line']);
const ELISION_RE = /^(?:\/\/|#|--|\/\*|\*)?\s*(?:\.\.\.|\u2026|\u22ef)\s*(?:\*\/)?$/;
const COMMENT_ONLY_RE = /^(?:\/\/|\/\*|\*|#|--|<!--)/;
const INLINE_ELISION_RE = /\.\.\.|\u2026|\u22ef/;
// A cited block can end exactly at a hunk boundary, so its closing token belongs to no hunk in
// the frozen target and the whole faithful citation is rejected. A line that is only a block
// terminator carries no identifying content — like a blank, comment-only or elision line — so
// excusing it cannot let fabricated code pass: every other quoted line must still be real.
const CLOSING_ONLY_RE = /^(?:[)\]}>,;]+|done|fi|esac|end|endif|endwhile|endfor)$/i;
// A report-scoped defect invalidates one dispatched report and nothing else, so a run
// carrying only these can keep the reports that did validate and let resume repair that
// one child. Anything absent from this set — frozen-target or chunk tampering, manifest
// defects, staleness, whole-run coverage — stays run-scoped and keeps failing closed, so
// a future code added elsewhere is treated as blocking by default.
const REPORT_SCOPED_CODES = new Set([
  'malformed_report', 'report_schema', 'report_invalid', 'report_failed', 'report_incomplete',
  'empty_report', 'lens_mismatch', 'duplicate_report', 'missing_report', 'findings_invalid',
  'finding_invalid', 'finding_field', 'finding_line', 'finding_severity', 'finding_outside_target',
  'checked_missing', 'checked_files_missing', 'checked_file_outside_target',
  'zero_findings_unsubstantiated', 'report_target_coverage_incomplete',
]);

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

function normalizedPath(value) {
  return typeof value === 'string' ? value.replace(/^\.\//, '').replace(/\\/g, '/') : '';
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
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

function normalizeSnippet(value, stripDiffPrefix = false) {
  return String(value)
    .split('\n')
    .map((line) => (stripDiffPrefix ? line.replace(/^[ +\-]/, '') : line).trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join('\n');
}

function substantiveLines(snippet) {
  return snippet.split('\n').filter((line) => !ELISION_RE.test(line)
    && !COMMENT_ONLY_RE.test(line) && !CLOSING_ONLY_RE.test(line));
}

// A quoted line may elide its own middle (`runScript(...)`), so match the surviving
// fragments in order within one target line rather than demanding equality.
function lineOccurs(haystackLines, line) {
  if (haystackLines.includes(line)) return true;
  if (!INLINE_ELISION_RE.test(line)) return false;
  const trimmed = line.trim();
  const openStart = /^(?:\.\.\.|\u2026|\u22ef)/.test(trimmed);
  const openEnd = /(?:\.\.\.|\u2026|\u22ef)$/.test(trimmed);
  // A quoted line stands for one whole target line, so an elision belongs in its middle. With
  // both ends open the fragments only have to appear somewhere inside some target line, which is
  // bare substring matching: `... projectId ...` grounded against any line mentioning projectId,
  // letting an invented statement borrow a real identifier.
  if (openStart && openEnd) return false;
  const fragments = trimmed.split(/(?:\.\.\.|\u2026|\u22ef)+/).map((part) => part.trim()).filter(Boolean);
  if (fragments.length === 0) return false;
  // At least one surviving fragment has to name something; punctuation alone (`...;`) matches
  // almost any target.
  if (!fragments.some((fragment) => /[A-Za-z_$][A-Za-z0-9_$]{2,}/.test(fragment))) return false;
  const occursInOrder = (candidate) => {
    // The un-elided end must sit at the candidate's own edge, so the citation covers a real line
    // rather than a fragment lifted out of its middle.
    if (!openStart && !candidate.startsWith(fragments[0])) return false;
    if (!openEnd && !candidate.endsWith(fragments[fragments.length - 1])) return false;
    let at = 0;
    for (const fragment of fragments) {
      const found = candidate.indexOf(fragment, at);
      if (found === -1) return false;
      at = found + fragment.length;
    }
    return true;
  };
  // The fragment walk stays inside one target line on purpose. Scanning the joined section
  // instead let a fabricated citation ground: the fragments only had to appear in order
  // somewhere in the whole file, so an invented call name plus a real identifier assembled a
  // claim about code that does not exist (`logger.debug(...apiKey...)`).
  if (haystackLines.some(occursInOrder)) return true;
  return spansOneStatement(haystackLines, fragments, openStart, openEnd);
}

// How many target lines one cited line may stand for. A real multi-line call or argument list
// is a handful of lines; a span this small cannot reach across unrelated regions of a section.
const MULTILINE_ELISION_SPAN = 12;

// A citation may also compress a multi-line statement into one line: `tracing::warn!(...);`
// stands for the four target lines of that call. Ground it only when both un-elided ends anchor
// a short run of CONSECUTIVE target lines — the opening fragment must start a line and the
// closing fragment must end a later one within MULTILINE_ELISION_SPAN. This does not reopen the
// joined-section hole: a fabricated call fails because its opening fragment starts no target
// line at all (`logger.debug(` against a target that only has `tracing::warn!(`), and a citation
// open at either end is refused before it gets here, so a bare identifier can never anchor a run.
function spansOneStatement(haystackLines, fragments, openStart, openEnd) {
  if (openStart || openEnd || fragments.length < 2) return false;
  const first = fragments[0];
  const last = fragments[fragments.length - 1];
  const middles = fragments.slice(1, -1);
  for (let start = 0; start < haystackLines.length; start += 1) {
    if (!haystackLines[start].startsWith(first)) continue;
    // The opening line has to be unfinished, or the run is not one statement but two glued
    // together — `const output = await runScript(scriptPath, host, 30);` closes its own call, so
    // a citation ending in a later line's tail is stitching, exactly what the whole-section
    // scan used to allow. Only a line left open by an unclosed bracket continues.
    let depth = bracketDepth(haystackLines[start]);
    if (depth <= 0) continue;
    const limit = Math.min(haystackLines.length - 1, start + MULTILINE_ELISION_SPAN);
    for (let end = start + 1; end <= limit; end += 1) {
      depth += bracketDepth(haystackLines[end]);
      // Past its own closing bracket the statement is over; anything beyond belongs to the next.
      if (depth < 0) break;
      if (depth === 0 && haystackLines[end].endsWith(last)) {
        // Fragments must advance in the order they were quoted, by line AND within a line.
        // Scanning each middle from the run's start instead let `build(...beta...alpha...)`
        // ground against `build(alpha, beta)`, reversing the citation's own order.
        let line = start;
        let column = -1;
        const covered = middles.every((mid) => {
          for (let probe = line; probe <= end; probe += 1) {
            const from = probe === line ? column + 1 : 0;
            const found = haystackLines[probe].indexOf(mid, from);
            if (found !== -1) {
              line = probe;
              column = found + mid.length - 1;
              return true;
            }
          }
          return false;
        });
        if (covered) return true;
      }
      if (depth === 0) break;
    }
  }
  return false;
}

// Net bracket balance of one line. Quotes are not parsed, so a bracket inside a string literal
// skews it; that only ever makes the balance fail to reach zero, which refuses the citation.
function bracketDepth(line) {
  let depth = 0;
  for (const ch of line) {
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
  }
  return depth;
}

// Deliberately looser than an exact substring: a faithful citation may be re-wrapped,
// re-indented, reordered, or elided with `...`. Contiguity and order are both dropped —
// a reviewer routinely quotes the lines that carry the defect out of file order — but
// every substantive quoted line must still occur in the frozen target, so fabricated
// code cannot pass.
function grounds(haystack, snippet) {
  if (!haystack || !snippet) return false;
  const haystackLines = haystack.split('\n');
  if (haystackLines.join(' ').includes(snippet.split('\n').join(' '))) return true;
  const lines = substantiveLines(snippet);
  if (lines.length === 0) return false;
  return lines.every((line) => lineOccurs(haystackLines, line));
}

function groundFinding(targetSections, snippets, ownFile) {
  if (snippets.some((snippet) => grounds(targetSections.get(ownFile) || '', snippet))) return { state: 'grounded' };
  const elsewhere = [...targetSections.keys()].sort()
    .find((section) => section !== ownFile && snippets.some((snippet) => grounds(targetSections.get(section), snippet)));
  return elsewhere ? { state: 'wrong_file', file: elsewhere } : { state: 'ungrounded' };
}

function normalizedTargetSections(targetBody, targetFiles) {
  const sections = new Map();
  let currentFile = null;
  let currentLines = [];
  const flush = () => {
    if (currentFile) sections.set(currentFile, normalizeSnippet(currentLines.join('\n'), true));
  };
  for (const line of String(targetBody).split('\n')) {
    const match = gitDiffPaths(line);
    if (match) {
      flush();
      currentFile = normalizedPath(match[1]);
      currentLines = [line];
    } else if (currentFile) {
      currentLines.push(line);
    }
  }
  flush();
  if (sections.size === 0 && targetFiles?.size === 1) {
    sections.set([...targetFiles][0], normalizeSnippet(targetBody));
  }
  return sections;
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
  const contextStatus = manifest.context_status ?? 'absent';
  if (!['absent', 'bound'].includes(contextStatus)) issues.push(issue('manifest_context_status', 'context_status must be absent or bound'));
  else if (contextStatus === 'bound' && (typeof manifest.context_hash !== 'string' || !TARGET_HASH_RE.test(manifest.context_hash))) {
    issues.push(issue('manifest_context_hash', 'bound context requires context_hash sha256:<64 lowercase hex>'));
  } else if (contextStatus === 'absent' && manifest.context_hash !== undefined) {
    issues.push(issue('manifest_context_hash_unexpected', 'absent context must not carry context_hash'));
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
      if (entry.target_hash !== undefined && (typeof entry.target_hash !== 'string' || !TARGET_HASH_RE.test(entry.target_hash))) {
        issues.push(issue('manifest_report_target_hash', `expected_reports[${index}].target_hash must be sha256:<64 lowercase hex>`));
      }
      if (entry.target_files !== undefined && !nonEmptyStrings(entry.target_files)) {
        issues.push(issue('manifest_report_target_files', `expected_reports[${index}].target_files must be a non-empty string array`));
      }
      if (entry.target_file !== undefined && (typeof entry.target_file !== 'string' || !/^chunks\/chunk-[0-9]+\.patch$/.test(entry.target_file))) {
        issues.push(issue('manifest_report_target_file', `expected_reports[${index}].target_file must name a chunks/chunk-N.patch file`));
      }
      if (entry.chunk_id !== undefined && (typeof entry.chunk_id !== 'string' || !/^chunk-[0-9]+$/.test(entry.chunk_id))) {
        issues.push(issue('manifest_report_chunk_id', `expected_reports[${index}].chunk_id must be chunk-N`));
      }
      if (entry.wave !== undefined && (!Number.isInteger(entry.wave) || entry.wave < 1)) {
        issues.push(issue('manifest_report_wave', `expected_reports[${index}].wave must be a positive integer`));
      }
    });
    if (new Set(reportIds).size !== reportIds.length) {
      issues.push(issue('manifest_report_duplicate', 'expected report_id values must be unique'));
    }
  }
  if (manifest.target_files !== undefined) {
    if (!nonEmptyStrings(manifest.target_files)) {
      issues.push(issue('manifest_target_files', 'target_files must be a non-empty string array when provided'));
    } else if (new Set(manifest.target_files.map(normalizedPath)).size !== manifest.target_files.length) {
      issues.push(issue('manifest_target_files_duplicate', 'target_files must be unique'));
    }
  }
  const chunked = Array.isArray(manifest.expected_reports)
    && manifest.expected_reports.some((entry) => entry?.chunk_id !== undefined || entry?.target_file !== undefined);
  if (chunked) {
    if (!Array.isArray(manifest.profiles) || manifest.profiles.length === 0) {
      issues.push(issue('manifest_profiles', 'chunked reviews require the planner profiles array'));
    }
    if (!Array.isArray(manifest.chunks) || manifest.chunks.length < 2) {
      issues.push(issue('manifest_chunks', 'chunked reviews require at least two planner chunks'));
    }
    const profiles = Array.isArray(manifest.profiles)
      ? manifest.profiles.map((entry) => entry?.profile).filter((value) => typeof value === 'string' && value.length > 0)
      : [];
    const chunks = Array.isArray(manifest.chunks) ? manifest.chunks : [];
    if (profiles.length !== manifest.profiles?.length || new Set(profiles).size !== profiles.length) {
      issues.push(issue('manifest_profiles_invalid', 'planner profiles must have unique non-empty profile names'));
    }
    const chunkIds = chunks.map((entry) => entry?.id);
    if (chunkIds.some((value) => typeof value !== 'string' || !/^chunk-[0-9]+$/.test(value))
      || new Set(chunkIds).size !== chunkIds.length) {
      issues.push(issue('manifest_chunks_invalid', 'planner chunks must have unique chunk-N ids'));
    }
    chunks.forEach((chunk, index) => {
      if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) return;
      if (typeof chunk.target_hash !== 'string' || !TARGET_HASH_RE.test(chunk.target_hash)) {
        issues.push(issue('manifest_chunk_target_hash', `chunks[${index}].target_hash must be sha256:<64 lowercase hex>`));
      }
      if (typeof chunk.target_file !== 'string' || !/^chunks\/chunk-[0-9]+\.patch$/.test(chunk.target_file)) {
        issues.push(issue('manifest_chunk_target_file', `chunks[${index}].target_file must name a chunks/chunk-N.patch file`));
      }
      if (!nonEmptyStrings(chunk.files)) {
        issues.push(issue('manifest_chunk_files', `chunks[${index}].files must be a non-empty string array`));
      }
    });
    if (profiles.length > 0 && chunks.length > 0 && Array.isArray(manifest.expected_reports)) {
      const expectedPairs = new Map();
      const waveByChunk = new Map();
      for (const entry of manifest.expected_reports) {
        if (!entry || typeof entry !== 'object') continue;
        const key = `${entry.lens}\0${entry.chunk_id}`;
        if (expectedPairs.has(key)) {
          issues.push(issue('manifest_profile_chunk_duplicate', `duplicate expected report for ${entry.lens} × ${entry.chunk_id}`));
        }
        expectedPairs.set(key, entry);
      }
      for (const profile of profiles) {
        for (let index = 0; index < chunks.length; index += 1) {
          const chunk = chunks[index];
          const entry = expectedPairs.get(`${profile}\0${chunk.id}`);
          if (!entry) {
            issues.push(issue('manifest_profile_chunk_missing', `expected report is missing for ${profile} × ${chunk.id}`));
            continue;
          }
          if (Number.isInteger(entry.wave) && entry.wave > 0) {
            const assigned = waveByChunk.get(chunk.id);
            if (assigned !== undefined && assigned !== entry.wave) {
              issues.push(issue('manifest_chunk_wave_split', `profiles for ${chunk.id} must share one wave`));
            }
            waveByChunk.set(chunk.id, entry.wave);
          }
          if (entry.target_hash !== chunk.target_hash || entry.target_file !== chunk.target_file
            || !Number.isInteger(entry.wave) || entry.wave < 1
            || JSON.stringify(entry.target_files) !== JSON.stringify(chunk.files)) {
            issues.push(issue('manifest_profile_chunk_mismatch', `expected report metadata does not match ${profile} × ${chunk.id}`));
          }
        }
      }
      if (manifest.expected_reports.length !== profiles.length * chunks.length) {
        issues.push(issue('manifest_profile_chunk_count', 'expected_reports must contain exactly N profiles × M chunks entries'));
      }
    }
  }
  return issues;
}

function validateFinding(finding, index, lens, file, reportId, targetFiles, targetSections, diffTarget) {
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
  if (!lineOk) issues.push({ ...issue('finding_line', `${prefix}.line must be a positive integer`, lens, file, reportId), finding_index: index });
  if (targetFiles && typeof finding.file === 'string' && !targetFiles.has(normalizedPath(finding.file))) {
    issues.push(issue('finding_outside_target', `${prefix}.file is not present in the frozen target`, lens, file, reportId));
  }
  if (targetSections && typeof finding.code === 'string' && typeof finding.file === 'string') {
    const snippets = (diffTarget
      ? [normalizeSnippet(finding.code), normalizeSnippet(finding.code, true)]
      : [normalizeSnippet(finding.code)]).filter(Boolean);
    const grounding = groundFinding(targetSections, snippets, normalizedPath(finding.file));
    if (grounding.state === 'wrong_file') {
      issues.push({
        ...issue('finding_code_wrong_file', `${prefix}.code occurs in ${grounding.file}, not in the section for ${finding.file}`, lens, file, reportId),
        finding_index: index,
        grounded_file: grounding.file,
      });
    } else if (grounding.state === 'ungrounded') {
      issues.push({
        ...issue('finding_code_mismatch', `${prefix}.code does not occur anywhere in the frozen target`, lens, file, reportId),
        finding_index: index,
      });
    }
  }
  return issues;
}

function validateReport(report, manifest, file, targetSections = null, diffTarget = false) {
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
  if ((manifest.context_status ?? 'absent') === 'bound' && report.context_hash !== manifest.context_hash) {
    issues.push(issue('stale_context', 'context_hash does not match the dispatched review context', lens, file, reportId));
  }
  const expected = manifest.expected_reports.find((entry) => entry.report_id === report.report_id);
  if (!expected) {
    issues.push(issue('unexpected_report', 'report_id was not dispatched for this review run', lens, file, reportId));
  } else if (report.lens !== expected.lens) {
    issues.push(issue('lens_mismatch', 'lens does not match the dispatched report_id', lens, file, reportId));
  }
  const expectedTargetHash = expected?.target_hash ?? manifest.target_hash;
  if (report.target_hash !== expectedTargetHash) {
    issues.push(issue('stale_target', 'target_hash does not match the dispatched target or chunk', lens, file, reportId));
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
  const targetFiles = Array.isArray(expected?.target_files)
    ? new Set(expected.target_files.map(normalizedPath))
    : Array.isArray(manifest.target_files)
      ? new Set(manifest.target_files.map(normalizedPath))
    : null;
  if (targetFiles) {
    if (!nonEmptyStrings(report.checked_files)) {
      issues.push(issue('checked_files_missing', 'checked_files must name at least one frozen target file', lens, file, reportId));
    } else {
      const checkedFiles = new Set(report.checked_files.map(normalizedPath));
      for (const checked of report.checked_files) {
        if (!targetFiles.has(normalizedPath(checked))) {
          issues.push(issue('checked_file_outside_target', `checked_files contains a path outside the frozen target: ${checked}`, lens, file, reportId));
        }
      }
      const missingFiles = [...targetFiles].filter((target) => !checkedFiles.has(target));
      if (missingFiles.length > 0) {
        issues.push(issue('report_target_coverage_incomplete', `checked_files omits frozen target files: ${missingFiles.join(', ')}`, lens, file, reportId));
      }
    }
  }
  if (!Array.isArray(report.findings)) {
    issues.push(issue('findings_invalid', 'findings must be an array', lens, file, reportId));
  } else {
    report.findings.forEach((finding, index) => issues.push(...validateFinding(finding, index, lens, file, reportId, targetFiles, targetSections, diffTarget)));
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
export function validateReviewReports(manifest, rawReports, options = {}) {
  const manifestIssues = validateManifest(manifest);
  if (manifestIssues.length > 0) {
    return { schema_version: 1, ok: false, run_blocking: [...new Set(manifestIssues.map((entry) => entry.code))], coverage: { expected: 0, valid: 0 }, valid_reports: [], missing_reports: [], issues: manifestIssues };
  }

  const expected = manifest.expected_reports;
  const targetFiles = Array.isArray(manifest.target_files)
    ? new Set(manifest.target_files.map(normalizedPath))
    : null;
  const issues = [];
  const chunkBodies = options.chunkBodies && typeof options.chunkBodies === 'object' ? options.chunkBodies : {};
  for (const entry of expected) {
    if (!entry.target_file) continue;
    const chunkBody = chunkBodies[entry.target_file];
    if (typeof chunkBody !== 'string') {
      issues.push(issue('frozen_chunk_missing', `frozen chunk is unavailable: ${entry.target_file}`, entry.lens, null, entry.report_id));
    } else if (sha256(chunkBody) !== entry.target_hash) {
      issues.push(issue('frozen_chunk_hash_mismatch', `frozen chunk hash does not match the manifest: ${entry.target_file}`, entry.lens, null, entry.report_id));
    }
  }
  const hasFrozenTarget = typeof options.targetBody === 'string' && options.targetBody.length > 0;
  if (targetFiles && !hasFrozenTarget) {
    issues.push(issue('frozen_target_missing', 'target_files requires the frozen target body for deterministic grounding'));
  }
  if (hasFrozenTarget && sha256(options.targetBody) !== manifest.target_hash) {
    issues.push(issue('frozen_target_hash_mismatch', 'frozen target hash does not match the manifest target_hash'));
  }
  const targetSections = hasFrozenTarget ? normalizedTargetSections(options.targetBody, targetFiles) : null;
  if (targetFiles && targetFiles.size > 1 && targetSections?.size === 0) {
    issues.push(issue('frozen_target_unsectioned', 'multi-file frozen targets require diff --git sections for file-specific grounding'));
  }
  if (targetFiles && targetSections && targetSections.size > 0) {
    const missingSections = [...targetFiles].filter((file) => !targetSections.has(file));
    const unexpectedSections = [...targetSections.keys()].filter((file) => !targetFiles.has(file));
    if (missingSections.length > 0) {
      issues.push(issue('frozen_target_sections_missing', `target_files are absent from the frozen target: ${missingSections.join(', ')}`));
    }
    if (unexpectedSections.length > 0) {
      issues.push(issue('frozen_target_sections_unexpected', `frozen target files are absent from target_files: ${unexpectedSections.join(', ')}`));
    }
  }
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
    const expectedReport = expected.find((entry) => entry.report_id === parsed?.report_id);
    const reportTargetFiles = Array.isArray(expectedReport?.target_files)
      ? new Set(expectedReport.target_files.map(normalizedPath))
      : targetFiles;
    const reportTargetBody = expectedReport?.target_file ? chunkBodies[expectedReport.target_file] : options.targetBody;
    const reportTargetSections = typeof reportTargetBody === 'string'
      ? normalizedTargetSections(reportTargetBody, reportTargetFiles)
      : targetSections;
    const reportIsDiff = typeof reportTargetBody === 'string'
      && reportTargetBody.split('\n').some((line) => line.startsWith('diff --git '));
    const reportIssues = validateReport(parsed, manifest, raw.file, reportTargetSections, reportIsDiff);
    const grounding = reportIssues.filter((entry) => DROPPABLE_FINDING_CODES.has(entry.code));
    issues.push(...reportIssues);
    // A report that loses every finding this way lands where a zero-finding report already
    // lands, which is a valid outcome — so there is no separate "nothing survived" rejection.
    reports.push({ file: raw.file, report: parsed, valid: reportIssues.length === grounding.length, grounding });
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

  let targetCoverage;
  if (Array.isArray(manifest.target_files) && manifest.target_files.length > 0) {
    const expectedFiles = new Set(manifest.target_files.map(normalizedPath));
    const checkedFiles = new Set();
    for (const item of reports.filter((entry) => entry.valid)) {
      for (const file of item.report.checked_files || []) checkedFiles.add(normalizedPath(file));
    }
    const missingFiles = [...expectedFiles].filter((file) => !checkedFiles.has(file));
    targetCoverage = { expected: expectedFiles.size, checked: expectedFiles.size - missingFiles.length, complete: missingFiles.length === 0, missing_files: missingFiles };
    if (missingFiles.length > 0) issues.push(issue('target_coverage_incomplete', `frozen target files were not checked: ${missingFiles.join(', ')}`));
  }
  const findingGrounding = { findings: 0, grounded: 0, wrong_file: 0, ungrounded: 0, reports: [] };
  for (const item of reports) {
    const total = Array.isArray(item.report?.findings) ? item.report.findings.length : 0;
    const ungrounded = item.grounding.filter((entry) => entry.code === 'finding_code_mismatch').map((entry) => entry.finding_index);
    const wrongFile = item.grounding.filter((entry) => entry.code === 'finding_code_wrong_file').map((entry) => entry.finding_index);
    const malformed = item.grounding.filter((entry) => entry.code === 'finding_line' && Number.isInteger(entry.finding_index)).map((entry) => entry.finding_index);
    findingGrounding.findings += total;
    // Findings removed before synthesis are not part of what grounded: counting them here
    // reported more surviving findings than the run actually carries forward.
    findingGrounding.grounded += total - ungrounded.length - malformed.length;
    findingGrounding.wrong_file += wrongFile.length;
    findingGrounding.ungrounded += ungrounded.length;
    const reportId = typeof item.report?.report_id === 'string' ? item.report.report_id : null;
    if (reportId && (ungrounded.length > 0 || wrongFile.length > 0 || malformed.length > 0)) {
      findingGrounding.reports.push({
        report_id: reportId, file: item.file, findings: total,
        ungrounded_findings: ungrounded, wrong_file_findings: wrongFile,
        ...(malformed.length > 0 ? { malformed_findings: malformed } : {}),
      });
    }
  }

  // Grounding issues are reported, not blocking: they are resolved by dropping the finding.
  const ok = issues.every((entry) => GROUNDING_CODES.has(entry.code)) && validReports.length === expected.length;
  const runBlocking = [...new Set(issues
    .filter((entry) => !GROUNDING_CODES.has(entry.code) && !REPORT_SCOPED_CODES.has(entry.code))
    .map((entry) => entry.code))];
  return {
    schema_version: 1,
    task_id: manifest.task_id,
    target_hash: manifest.target_hash,
    context_status: manifest.context_status ?? 'absent',
    ...((manifest.context_status ?? 'absent') === 'bound' ? { context_hash: manifest.context_hash } : {}),
    ok,
    run_blocking: runBlocking,
    coverage: { expected: expected.length, valid: validReports.length },
    ...(targetCoverage ? { target_coverage: targetCoverage } : {}),
    finding_grounding: findingGrounding,
    valid_reports: validReports,
    missing_reports: missingReports,
    issues,
  };
}

function usage() {
  return 'Usage: node validate-reports.mjs --manifest <run.json> --reports-dir <dir> [--target <frozen-target>] [--chunks-dir <dir>] [--out <validation.json>]';
}

export function main(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!['--manifest', '--reports-dir', '--target', '--chunks-dir', '--out'].includes(key) || !argv[i + 1]) {
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

  let targetBody = '';
  if (args.target) {
    try {
      targetBody = readFileSync(resolve(args.target), 'utf8');
    } catch (error) {
      process.stderr.write(`x-review frozen target read failed: ${error.message}\n`);
      return 2;
    }
  }
  const chunkBodies = {};
  if (args['chunks-dir']) {
    try {
      const chunksDir = resolve(args['chunks-dir']);
      for (const entry of manifest.expected_reports || []) {
        if (!entry.target_file || chunkBodies[entry.target_file] !== undefined) continue;
        if (!/^chunks\/chunk-[0-9]+\.patch$/.test(entry.target_file)) continue;
        const name = entry.target_file.slice('chunks/'.length);
        chunkBodies[entry.target_file] = readFileSync(resolve(chunksDir, name), 'utf8');
      }
    } catch (error) {
      process.stderr.write(`x-review frozen chunk read failed: ${error.message}\n`);
      return 2;
    }
  }
  const result = validateReviewReports(manifest, rawReports, { targetBody, chunkBodies });
  const rendered = `${JSON.stringify(result, null, 2)}\n`;
  if (args.out) writeFileSync(resolve(args.out), rendered);
  process.stdout.write(rendered);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
