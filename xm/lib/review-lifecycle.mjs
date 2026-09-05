import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { planReview, filterGeneratedCopies, chunkFrozenTarget, changedFilesFromPatch } from '../skills/review/scripts/plan-review.mjs';
import { validateReviewReports } from '../skills/review/scripts/validate-reports.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(HERE, '..', 'skills', 'review');
// Measured on a 10-file / 21k-token target: a budget of 3 filled only 22% of the token
// budget, split it into 4 chunks (8 reports), and separated one implementation from its
// test file. A budget of 8 keeps every implementation with its tests, fills 43%, and
// halves the report count. The token budget stays the real size guard.
const DEFAULT_FILE_BUDGET = 8;
const DEFAULT_TOKEN_BUDGET = 24_000;
const DEFAULT_PROFILES = 4;
// Concurrency is independent of lens selection: max_profiles picks WHICH lenses run,
// this caps HOW MANY reports run at once. Tying them serialized chunked reviews into
// floor(max_profiles / lenses) chunks per wave.
const DEFAULT_CONCURRENT_REPORTS = 8;
const RANK = { Critical: 0, High: 1, Medium: 2, Low: 3 };

function hash(value, prefixed = true) {
  const digest = createHash('sha256').update(value).digest('hex');
  return prefixed ? `sha256:${digest}` : digest;
}
function iso() { return new Date().toISOString(); }
function json(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function readJson(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }
function normalizedPath(value) { return String(value || '').replace(/^\.\//, '').replace(/\\/g, '/'); }

function event(runDir, type, detail = {}, trace = true) {
  const record = { at: iso(), type, ...detail };
  appendFileSync(join(runDir, 'events.jsonl'), `${JSON.stringify(record)}\n`);
  if (trace) try { appendFileSync(join(runDir, 'trace.jsonl'), `${JSON.stringify(record)}\n`); } catch { /* optional trace is best-effort */ }
}

function commandParts(env) {
  if (!env.XM_REVIEW_PANEL_COMMAND) return ['xm', 'panel'];
  try {
    const command = JSON.parse(env.XM_REVIEW_PANEL_COMMAND);
    if (!Array.isArray(command) || command.length === 0 || !command.every((part) => typeof part === 'string' && part)) throw new Error();
    return command;
  } catch { throw new Error('XM_REVIEW_PANEL_COMMAND must be a non-empty JSON string array'); }
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return result.status === 0 ? (result.stdout || '').trim() : null;
}

function freezeTarget(target, cwd) {
  if (!target) {
    let body = git(cwd, ['--no-pager', 'diff', '--binary', 'HEAD']);
    if (body === null) throw new Error('unable to freeze git diff');
    const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd, encoding: 'utf8' });
    if (untracked.status !== 0) throw new Error('unable to enumerate untracked review files');
    for (const file of (untracked.stdout || '').split('\0').filter(Boolean).sort()) {
      const extra = spawnSync('git', ['--no-pager', 'diff', '--no-index', '--binary', '--', '/dev/null', file], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      if (![0, 1].includes(extra.status) || !(extra.stdout || '').trim()) throw new Error('unable to freeze untracked file: ' + file);
      body += '\n' + extra.stdout.trim();
    }
    if (!body) throw new Error('review target is empty');
    return { body, kind: 'git-diff', ref: 'HEAD' };
  }
  const path = resolve(cwd, target);
  if (!existsSync(path)) throw new Error(`review target does not exist: ${target}`);
  const body = readFileSync(path, 'utf8');
  if (!body.trim()) throw new Error(`review target is empty: ${target}`);
  const files = changedFilesFromPatch(body);
  return { body, kind: files.length ? 'git-diff-file' : 'file', ref: target };
}

function promptFor(lens) {
  const path = join(SKILL_ROOT, 'lenses', `${lens}.md`);
  if (!existsSync(path)) throw new Error(`unknown review lens: ${lens}`);
  return [
    'You are one leaf reviewer in an existing x-review lifecycle. Do not invoke review commands or spawn workflows.',
    'The supplied frozen target is the complete scope. Do not open repository files outside it.',
    readFileSync(path, 'utf8'),
  ].join('\n\n');
}

function lineMap(body) {
  const lines = new Map();
  let file = null;
  let line = 0;
  for (const row of String(body).split('\n')) {
    const fileHeader = row.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (fileHeader) { file = normalizedPath(fileHeader[2]); continue; }
    const hunk = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (!file || row.startsWith('+++') || row.startsWith('---') || row.startsWith('\ No newline')) continue;
    if (row.startsWith('+') || row.startsWith(' ')) { lines.set(`${file}\0${line}`, row.slice(1)); line += 1; }
    else if (!row.startsWith('-')) { lines.set(`${file}\0${line}`, row); line += 1; }
  }
  return lines;
}

function severity(value) {
  const lower = String(value || '').toLowerCase();
  return lower ? `${lower[0].toUpperCase()}${lower.slice(1)}` : '';
}

function sourceIdentity(finding) {
  const values = new Set();
  for (const model of finding?.models || []) if (model) values.add(String(model));
  for (const claim of finding?.claims || []) if (claim?.model) values.add(String(claim.model));
  for (const model of String(finding?.owner || '').split('+')) if (model) values.add(model);
  return [...values].sort();
}

function contractFinding(finding, bucket, expected, lines) {
  const level = severity(finding?.severity);
  const file = normalizedPath(finding?.file);
  const line = Number.isInteger(finding?.line) ? finding.line : null;
  const opponents = Array.isArray(finding?.opponents) ? finding.opponents : [];
  const challenged = opponents.some((entry) => ['concede', 'refute'].includes(entry?.stance));
  const disposition = bucket === 'confirmed' && ['Critical', 'High'].includes(level) && !challenged ? 'unreviewed' : bucket;
  const sources = sourceIdentity(finding);
  const consensusCount = Number.isInteger(finding?.consensus) ? finding.consensus : Math.max(1, sources.length);
  const description = String(finding?.claim || finding?.description || '').trim();
  const evidence = String(finding?.evidence || finding?.claims?.find((claim) => claim?.evidence)?.evidence || '').trim();
  const citedCode = String(finding?.code || finding?.claims?.find((claim) => claim?.code)?.code || '').trim();
  const citedFix = String(finding?.fix || finding?.claims?.find((claim) => claim?.fix)?.fix || '').trim();
  return {
    severity: level, file, line, description, claim: description,
    code: citedCode || lines.get(`${file}\0${line}`) || '',
    why: evidence, evidence,
    fix: citedFix || 'Correct the cited behavior and add a regression check.',
    disposition, source_disposition: bucket,
    ...(disposition !== bucket ? { unresolved_reason: 'High/Critical confirmation had no explicit challenge verdict.' } : {}),
    lens: expected.lens, lenses: [expected.lens], sources,
    source_count: Math.max(sources.length, consensusCount),
    confidence: disposition === 'contested' ? 'contested' : disposition === 'unreviewed' ? 'unresolved' : consensusCount > 1 ? 'corroborated' : 'challenged',
    consensus: consensusCount > 1, consensus_count: consensusCount,
    owner: finding?.owner || null, opponents,
  };
}

function panelReport(stdout, expected, chunkBody, manifest) {
  let verdict;
  try { verdict = JSON.parse(stdout); } catch { throw new Error(`${expected.report_id}: panel output is not valid JSON`); }
  if (!verdict || verdict.coverage_failed === true) throw new Error(`${expected.report_id}: panel result failed coverage`);
  const failed = Object.entries(verdict.by_model || {}).filter(([, value]) => ['failed', 'suspect_empty'].includes(value?.r1)).map(([model]) => model);
  if (failed.length) throw new Error(`${expected.report_id}: panel coverage missing for ${failed.join(', ')}`);
  const buckets = ['confirmed', 'unreviewed', 'contested'];
  if (!buckets.every((bucket) => Array.isArray(verdict[bucket]))) throw new Error(`${expected.report_id}: panel output has no canonical finding buckets`);
  const successfulModels = Object.entries(verdict.by_model || {}).filter(([, value]) => !['failed', 'suspect_empty'].includes(value?.r1)).map(([model]) => model);
  const evidence = verdict.review_evidence || {};
  if (successfulModels.length === 0) throw new Error(`${expected.report_id}: panel returned no successful reviewer evidence`);
  for (const model of successfulModels) {
    const item = evidence[model];
    if (!item || !Array.isArray(item.checked) || item.checked.length === 0 || !Array.isArray(item.checked_files)) {
      throw new Error(`${expected.report_id}: missing review evidence for ${model}`);
    }
    const missing = expected.target_files.filter((file) => !item.checked_files.includes(file));
    if (missing.length) throw new Error(`${expected.report_id}: ${model} omitted checked files: ${missing.join(', ')}`);
    if ((verdict.by_model[model]?.raised || 0) === 0 && (!item.no_findings_reason || item.no_findings_reason.length < 12)) {
      throw new Error(`${expected.report_id}: ${model} supplied no clean-review reason`);
    }
  }
  const lines = lineMap(chunkBody);
  const findings = buckets.flatMap((bucket) => verdict[bucket].map((finding) => contractFinding(finding, bucket, expected, lines)));
  const checked = [...new Set(successfulModels.flatMap((model) => evidence[model].checked))];
  const cleanReasons = successfulModels.map((model) => evidence[model].no_findings_reason).filter(Boolean);
  return {
    schema_version: 1, task_id: manifest.task_id, report_id: expected.report_id, lens: expected.lens,
    target_hash: expected.target_hash, status: 'complete',
    checked, checked_files: expected.target_files,
    findings,
    ...(findings.length === 0 ? { no_findings_reason: cleanReasons.join(' | ') } : {}),
  };
}

function stableFindingId(finding) {
  const identity = { file: finding.file || null, lens: finding.lens || null, summary: finding.description.trim().replace(/\s+/g, ' ') };
  return `rf_${hash(JSON.stringify(identity), false).slice(0, 16)}`;
}

function findingTokens(value) {
  const aliases = new Map([['credentials', 'credential'], ['password', 'credential'], ['passwords', 'credential'], ['secrets', 'secret'], ['leaked', 'exposure'], ['leak', 'exposure'], ['printed', 'exposure']]);
  return [...new Set((String(value || '').toLowerCase().match(/[a-z0-9_]+/g) || []).map((token) => aliases.get(token) || token).filter((token) => !['a', 'an', 'and', 'the', 'is', 'to', 'of', 'in', 'on', 'with'].includes(token)))];
}

function equivalentFinding(left, right) {
  if (left.file !== right.file) return false;
  if (Number.isInteger(left.line) && Number.isInteger(right.line) && Math.abs(left.line - right.line) > 2) return false;
  const a = findingTokens(left.description), b = findingTokens(right.description);
  const rightTokens = new Set(b);
  const common = a.filter((token) => rightTokens.has(token)).length;
  return common / Math.max(a.length, b.length, 1) >= 0.8;
}

function synthesize(reports) {
  const findings = [];
  for (const candidate of reports.flatMap((report) => report.findings || [])) {
    const existing = findings.find((finding) => equivalentFinding(finding, candidate));
    if (!existing) { findings.push({ ...candidate }); continue; }
    existing.lenses = [...new Set([...(existing.lenses || []), ...(candidate.lenses || [])])].sort();
    existing.sources = [...new Set([...(existing.sources || []), ...(candidate.sources || [])])].sort();
    existing.source_count = existing.sources.length;
    existing.consensus_count = Math.max(existing.consensus_count || 1, candidate.consensus_count || 1, existing.sources.length);
    existing.consensus = existing.consensus_count > 1;
    existing.confidence = existing.consensus ? 'corroborated' : existing.confidence;
    if ((RANK[candidate.severity] ?? 9) < (RANK[existing.severity] ?? 9)) existing.severity = candidate.severity;
    const dispositions = new Set([existing.disposition, candidate.disposition]);
    existing.disposition = dispositions.has('unreviewed') || dispositions.has('contested') ? 'unreviewed' : 'confirmed';
    existing.source_dispositions = [...new Set([...(existing.source_dispositions || [existing.source_disposition]), candidate.source_disposition].filter(Boolean))].sort();
    existing.confidence = existing.disposition === 'unreviewed' ? 'unresolved' : existing.confidence;
  }
  findings.sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9) || a.file.localeCompare(b.file) || a.line - b.line || a.description.localeCompare(b.description));
  findings.forEach((finding, index) => { finding.id = `F${index + 1}`; finding.finding_id = stableFindingId(finding); });
  const active = findings.filter((finding) => finding.disposition !== 'contested');
  const count = (level) => active.filter((finding) => finding.severity === level).length;
  const unresolved = active.filter((finding) => finding.disposition === 'unreviewed');
  let verdict = count('Critical') > 0 || count('High') > 2 ? 'Block' : count('High') > 0 || count('Medium') > 3 ? 'Request Changes' : 'LGTM';
  if (unresolved.some((finding) => finding.severity === 'Critical')) verdict = 'Block';
  else if (verdict === 'LGTM' && unresolved.some((finding) => finding.severity === 'High')) verdict = 'Request Changes';
  return {
    verdict, findings,
    confirmed: findings.filter((finding) => finding.disposition === 'confirmed'),
    unreviewed: findings.filter((finding) => finding.disposition === 'unreviewed'),
    contested: findings.filter((finding) => finding.disposition === 'contested'),
    counts: Object.fromEntries(['Critical', 'High', 'Medium', 'Low'].map((level) => [level.toLowerCase(), count(level)])),
  };
}

function snapshots(cwd, files) {
  return files.map((file) => {
    const path = resolve(cwd, file);
    return existsSync(path) ? { file, exists: true, sha256: hash(readFileSync(path), false) } : { file, exists: false, sha256: null };
  });
}

function verifyChild(runDir, manifest, expected) {
  const child = readJson(join(runDir, 'children', `${expected.report_id}.json`));
  if (child?.status !== 'completed') return;
  const reportPath = join(runDir, 'reports', `${expected.report_id}.json`);
  const report = readJson(reportPath);
  if (!existsSync(reportPath) || child.task_id !== manifest.task_id || child.report_id !== expected.report_id
    || child.target_hash !== expected.target_hash || child.prompt_hash !== expected.prompt_hash
    || child.report_hash !== hash(readFileSync(reportPath)) || report?.task_id !== manifest.task_id
    || report?.report_id !== expected.report_id || report?.target_hash !== expected.target_hash) {
    throw new Error(`${expected.report_id}: completed child binding mismatch`);
  }
}

function verifyBytes(runDir, manifest) {
  const target = join(runDir, manifest.target.file);
  if (!existsSync(target) || hash(readFileSync(target)) !== manifest.target.hash || manifest.target.hash !== manifest.target_hash) throw new Error('frozen target bytes do not match run manifest');
  for (const chunk of manifest.chunks) if (!existsSync(join(runDir, chunk.target_file)) || hash(readFileSync(join(runDir, chunk.target_file))) !== chunk.target_hash) throw new Error(`${chunk.id}: frozen chunk bytes do not match run manifest`);
  for (const prompt of manifest.prompts) if (!existsSync(join(runDir, prompt.file)) || hash(readFileSync(join(runDir, prompt.file))) !== prompt.prompt_hash) throw new Error(`${prompt.lens}: prompt bytes do not match run manifest`);
  for (const expected of manifest.expected_reports) {
    const binding = manifest.bindings?.[expected.report_id];
    if (!binding || binding.task_id !== manifest.task_id || binding.target_hash !== expected.target_hash || binding.prompt_hash !== expected.prompt_hash) throw new Error(`${expected.report_id}: dispatch binding mismatch`);
    verifyChild(runDir, manifest, expected);
  }
}

function markdown(result) {
  const rows = result.findings.length ? result.findings.map((f) => `- ${f.id} [${f.severity}] ${f.file}:${f.line} — ${f.description} (${f.disposition})`).join('\n') : '- No findings.';
  return `# x-review: ${result.target.ref} — ${result.verdict}\n- Date: ${result.timestamp}\n- Lenses: ${result.lenses.join(', ')}\n- Agents: ${result.agents}\n- Findings: ${result.findings.length} (Critical: ${result.counts.critical}, High: ${result.counts.high}, Medium: ${result.counts.medium}, Low: ${result.counts.low})\n\n---\n${rows}\n`;
}

// A finding whose code does not occur anywhere in the frozen target is dropped rather than
// carried into synthesis. validation.json still reports it, so a fabricating model stays visible.
function groundedReports(rawReports, validation) {
  const valid = new Set(validation.valid_reports || []);
  // Every per-finding defect is dropped the same way: a citation absent from the target, a
  // citation that belongs to a different file than the finding claims, and a finding whose line
  // is unusable. Keeping the report and losing the finding is what stops one bad entry from
  // discarding its well-formed siblings. A wrong-file finding used to survive to synthesis and
  // name a file its own evidence contradicts, which then steered the review-fix scope.
  const dropped = new Map((validation.finding_grounding?.reports || [])
    .map((entry) => [entry.report_id, new Set([
      ...(entry.ungrounded_findings || []),
      ...(entry.wrong_file_findings || []),
      ...(entry.malformed_findings || []),
    ])]));
  // A report the validator rejected contributes nothing. On the complete path every report is
  // valid so this is a no-op; on the partial path it is the whole point — dropping only
  // ungrounded findings left the rejected report's other findings as the salvaged output.
  return rawReports.map((entry) => JSON.parse(entry.body)).filter((report) => valid.has(report.report_id)).map((report) => {
    const drop = dropped.get(report.report_id);
    if (!drop || drop.size === 0 || !Array.isArray(report.findings)) return report;
    return { ...report, findings: report.findings.filter((_, index) => !drop.has(index)) };
  });
}

// Persist the validator verdict on each child so resume can tell "the model replied" from
// "the reply is usable". Without it a rejected report is skipped and re-rejected forever.
function recordChildValidity(runDir, manifest, validation) {
  const valid = new Set(validation.valid_reports);
  for (const expected of manifest.expected_reports) {
    const childPath = join(runDir, 'children', `${expected.report_id}.json`);
    const child = readJson(childPath);
    if (child?.status !== 'completed') continue;
    const record = { ...child, valid: valid.has(expected.report_id) };
    if (record.valid) delete record.invalid_codes;
    else record.invalid_codes = [...new Set(validation.issues.filter((entry) => entry.report_id === expected.report_id).map((entry) => entry.code))];
    json(childPath, record);
  }
}

function persistResult(runDir, manifest, validation, synthesis, persistOptions = {}) {
  const reviewDir = dirname(dirname(runDir));
  const timestamp = iso();
  const summary = Object.fromEntries(manifest.profiles.map(({ profile }) => {
    const items = synthesis.findings.filter((f) => f.lenses.includes(profile) && f.disposition !== 'contested');
    return [profile, { total: items.length, critical: items.filter((f) => f.severity === 'Critical').length, high: items.filter((f) => f.severity === 'High').length, medium: items.filter((f) => f.severity === 'Medium').length, low: items.filter((f) => f.severity === 'Low').length }];
  }));
  const result = {
    schema: 'xm.review.result.v2', timestamp, completed_at: timestamp, run_id: manifest.id, task_id: manifest.task_id,
    target: { type: manifest.target.kind === 'file' ? 'file' : 'diff', ref: manifest.target.ref }, target_hash: manifest.target_hash,
    context_status: 'absent', lenses: manifest.profiles.map((entry) => entry.profile), agents: validation.coverage.valid,
    coverage: { expected: validation.coverage.expected, completed: validation.coverage.valid, valid: validation.coverage.valid, ok: validation.ok, complete: validation.ok },
    target_coverage: validation.target_coverage,
    execution: { mode: 'lifecycle', waves: new Set(manifest.expected_reports.map((entry) => entry.wave || 1)).size, backend: 'panel', models: manifest.options.models, duration_ms: Date.now() - Date.parse(manifest.started_at), retries: 0, escalation_reasons: [] },
    reviewed_commit: manifest.reviewed_commit, reviewed_files_all: manifest.reviewed_files_all, reviewed_file_snapshots: manifest.reviewed_file_snapshots,
    ...synthesis, summary,
  };
  if (persistOptions.partial) {
    // A partial run must not become the project's last review result: the review-fix gate
    // reads last-result.json as truth, so an incomplete review would satisfy it. Keep the
    // salvaged synthesis inside the run directory only.
    json(join(runDir, 'partial-result.json'), result);
    return result;
  }
  json(join(runDir, 'result.json'), result);
  json(join(reviewDir, 'last-result.json'), result);
  const md = markdown(result);
  writeFileSync(join(reviewDir, 'last-result.md'), md);
  const slug = String(manifest.target.ref).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || manifest.id;
  mkdirSync(join(reviewDir, 'history'), { recursive: true });
  writeFileSync(join(reviewDir, 'history', `${timestamp.slice(0, 10)}-${slug}-${manifest.id}.md`), md);
  json(join(reviewDir, 'finding-lifecycle.json'), {
    schema: 1, reviewed_commit: manifest.reviewed_commit, reviewed_files_all: manifest.reviewed_files_all, updated_at: timestamp,
    findings: result.findings.map((f) => ({ id: f.id, finding_id: f.finding_id, severity: f.severity.toLowerCase(), file: f.file, line: f.line, summary: f.description, state: 'open', outcome: null, evidence: null, file_snapshot: null, updated_at: timestamp })),
  });
  return result;
}

function recordVerdict(runDir, manifest, result, options) {
  if (options.trace === false) return { state: 'disabled' };
  const command = options.env.XM_REVIEW_TRACE_COMMAND
    ? JSON.parse(options.env.XM_REVIEW_TRACE_COMMAND)
    : ['xm', 'trace'];
  if (!Array.isArray(command) || command.length === 0 || !command.every((part) => typeof part === 'string' && part)) {
    throw new Error('XM_REVIEW_TRACE_COMMAND must be a non-empty JSON string array');
  }
  const status = result.verdict.toLowerCase().replace(/\s+/g, '-');
  const spawned = spawnSync(command[0], [...command.slice(1), 'record', 'review', '--ref', manifest.reviewed_commit, '--status', status, '--artifact', join(runDir, 'result.json')], {
    cwd: options.cwd, env: options.env, encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  const receipt = {
    state: spawned.status === 0 ? 'recorded' : 'failed',
    command: [...command, 'record', 'review'], status: spawned.status,
    stdout: (spawned.stdout || '').trim(), stderr: (spawned.stderr || '').trim(),
  };
  json(join(runDir, 'trace-receipt.json'), receipt);
  event(runDir, 'verdict_recorded', { state: receipt.state, status }, options.trace);
  return receipt;
}

function spawnChild(command, args, options) {
  return new Promise((resolveChild) => {
    const child = spawn(command[0], args, { cwd: options.cwd, env: { ...options.env, XM_REVIEW_NATIVE_CHILD: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const append = (kind, chunk) => {
      const value = chunk.toString();
      if (Buffer.byteLength((kind === 'stdout' ? stdout : stderr) + value) > 32 * 1024 * 1024) {
        child.kill('SIGKILL');
        stderr += '\nreview child output exceeded 32 MiB';
      } else if (kind === 'stdout') stdout += value; else stderr += value;
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    child.on('error', (error) => resolveChild({ status: null, stdout, stderr: stderr + error.message }));
    child.on('close', (status) => resolveChild({ status, stdout, stderr }));
  });
}

async function execute(manifest, runDir, options) {
  verifyBytes(runDir, manifest);
  const command = commandParts(options.env);
  let failure = null;
  const runExpected = async (expected) => {
    const childPath = join(runDir, 'children', `${expected.report_id}.json`);
    const prior = readJson(childPath);
    // `completed` alone means the model replied, not that the reply is usable. A child the
    // validator rejected carries `valid: false` and is dispatched again; a child from before
    // this field existed has no verdict and keeps the old skip behaviour.
    if (prior?.status === 'completed' && prior.valid !== false) { verifyChild(runDir, manifest, expected); event(runDir, 'child_skipped', { child_id: expected.report_id }, options.trace); return null; }
    const attempt = prior ? (Number.isInteger(prior.attempt) ? prior.attempt : 1) + 1 : 1;
    if (prior?.status === 'completed') event(runDir, 'child_redispatched', { child_id: expected.report_id, attempt, invalid_codes: prior.invalid_codes || [] }, options.trace);
    verifyBytes(runDir, manifest);
    const binding = manifest.bindings[expected.report_id];
    const args = [...command.slice(1), 'review', '--engine', 'native', join(runDir, binding.target_file), '--review-prompt-file', join(runDir, binding.prompt_file), '--lens-tag', expected.lens, '--json'];
    if (options.models) args.push('--models', options.models);
    if (options.rounds) args.push('--rounds', String(options.rounds));
    event(runDir, 'child_started', { child_id: expected.report_id, lens: expected.lens, chunk_id: binding.chunk_id, attempt }, options.trace);
    const spawned = await spawnChild(command, args, options);
    let childFailure = spawned.status !== 0 ? `${expected.report_id}: panel exited ${spawned.status ?? 'unknown'}: ${(spawned.stderr || '').trim()}` : null;
    try {
      if (childFailure) throw new Error(childFailure);
      const report = panelReport(spawned.stdout, expected, readFileSync(join(runDir, binding.target_file), 'utf8'), manifest);
      const reportPath = join(runDir, 'reports', `${expected.report_id}.json`);
      json(reportPath, report);
      json(childPath, { ...expected, task_id: manifest.task_id, status: 'completed', attempt, completed_at: iso(), report_file: `reports/${expected.report_id}.json`, report_hash: hash(readFileSync(reportPath)) });
      event(runDir, 'child_completed', { child_id: expected.report_id }, options.trace);
    } catch (error) {
      childFailure = error.message;
      json(childPath, { ...expected, task_id: manifest.task_id, status: 'failed', attempt, error: childFailure, stdout: spawned.stdout || '', stderr: spawned.stderr || '' });
      event(runDir, 'child_failed', { child_id: expected.report_id, error: childFailure }, options.trace);
    }
    return childFailure;
  };
  const waves = [...new Set(manifest.expected_reports.map((entry) => entry.wave || 1))].sort((a, b) => a - b);
  const waveFailures = [];
  for (const wave of waves) {
    const waveReports = manifest.expected_reports.filter((entry) => (entry.wave || 1) === wave);
    const failures = (await Promise.all(waveReports.map(runExpected))).filter(Boolean);
    waveFailures.push(...failures);
    // One bad child used to abandon every later wave, so a single failure cost a full
    // re-dispatch of reports that were never attempted. Keep going and let resume repair
    // just the failures. A wave where nothing survived is the exception: that reads as a
    // broken panel rather than a bad report, so stop instead of burning the rest.
    if (failures.length === waveReports.length) break;
  }
  if (waveFailures.length) failure = waveFailures.join(' | ');
  const completed = manifest.expected_reports.filter((expected) => readJson(join(runDir, 'children', `${expected.report_id}.json`))?.status === 'completed');
  const missing = manifest.expected_reports.filter((expected) => !completed.some((entry) => entry.report_id === expected.report_id)).map((entry) => entry.report_id);
  if (failure || missing.length) {
    const status = { state: 'failed', updated_at: iso(), completed: completed.length, expected: manifest.expected_reports.length, missing, error: failure || 'incomplete child coverage' };
    json(join(runDir, 'status.json'), status); event(runDir, 'run_failed', status, options.trace);
    throw new Error(`${status.error}; resume with: xm review resume ${manifest.id}`);
  }
  verifyBytes(runDir, manifest);
  const rawReports = readdirSync(join(runDir, 'reports')).filter((name) => name.endsWith('.json')).sort().map((name) => ({ file: name, body: readFileSync(join(runDir, 'reports', name), 'utf8') }));
  const chunkBodies = Object.fromEntries(manifest.chunks.map((chunk) => [chunk.target_file, readFileSync(join(runDir, chunk.target_file), 'utf8')]));
  const validation = validateReviewReports(manifest, rawReports, { targetBody: readFileSync(join(runDir, 'target.patch'), 'utf8'), chunkBodies });
  json(join(runDir, 'validation.json'), validation);
  recordChildValidity(runDir, manifest, validation);
  if (!validation.ok) {
    const invalid = manifest.expected_reports.filter((entry) => !validation.valid_reports.includes(entry.report_id)).map((entry) => entry.report_id);
    const error = `report validation failed: ${validation.issues.map((entry) => entry.code).join(', ')}`;
    // A report-scoped defect costs one child, not the whole run. Salvage the reports that
    // did validate so resume repairs just that child instead of re-reviewing everything —
    // one invalid report used to discard every valid one. The run still fails, because the
    // review is incomplete; it only stops throwing away the evidence it already has.
    const blocking = Array.isArray(validation.run_blocking) ? validation.run_blocking : ['unclassified_validation_failure'];
    const partial = blocking.length === 0 && validation.valid_reports.length > 0;
    if (partial) persistResult(runDir, manifest, validation, synthesize(groundedReports(rawReports, validation)), { partial: true });
    const status = {
      state: partial ? 'partial' : 'failed', updated_at: iso(), completed: completed.length,
      expected: manifest.expected_reports.length, missing: validation.missing_reports, invalid, error,
      ...(partial ? { valid_reports: validation.valid_reports, partial_result: 'partial-result.json' } : { run_blocking: blocking }),
    };
    json(join(runDir, 'status.json'), status);
    event(runDir, partial ? 'run_partial' : 'run_failed', status, options.trace);
    throw new Error(`${error}; resume with: xm review resume ${manifest.id}`);
  }
  const result = persistResult(runDir, manifest, validation, synthesize(groundedReports(rawReports, validation)));
  result.trace = recordVerdict(runDir, manifest, result, options);
  json(join(runDir, 'result.json'), result);
  json(join(dirname(dirname(runDir)), 'last-result.json'), result);
  json(join(runDir, 'status.json'), { state: 'completed', updated_at: iso(), completed: completed.length, expected: manifest.expected_reports.length });
  event(runDir, 'run_completed', { verdict: result.verdict, findings: result.findings.length }, options.trace);
  rmSync(join(runDir, 'work'), { recursive: true, force: true });
  return result;
}

export async function startReview(options = {}) {
  const cwd = resolve(options.cwd || process.cwd());
  const xmRoot = resolve(options.xmRoot || process.env.XM_REVIEW_ROOT || join(cwd, '.xm'));
  const frozen = freezeTarget(options.target, cwd);
  const id = options.runId || `review-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)}-${randomUUID()}`;
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error('invalid review run id');
  const runDir = join(xmRoot, 'review', 'runs', id);
  if (existsSync(runDir)) throw new Error(`review run already exists: ${id}`);
  for (const name of ['chunks', 'prompts', 'children', 'reports', 'work']) mkdirSync(join(runDir, name), { recursive: true });
  const trace = options.trace !== false && options.env?.XM_REVIEW_TRACE !== '0';
  writeFileSync(join(runDir, 'target.patch'), frozen.body);
  event(runDir, 'target_frozen', { target_kind: frozen.kind, target_ref: frozen.ref, target_hash: hash(frozen.body) }, trace);
  const config = readJson(join(cwd, '.xm-review.json')) || {};
  const filtered = filterGeneratedCopies(frozen.body, config.generated_copy_roots || []);
  const plan = planReview(frozen.body, { maxProfiles: options.maxProfiles || DEFAULT_PROFILES, targetFiles: frozen.kind === 'file' ? [frozen.ref] : [], chunkTokenBudget: options.chunkTokenBudget || DEFAULT_TOKEN_BUDGET, chunkFileBudget: options.chunkFileBudget || DEFAULT_FILE_BUDGET, maxConcurrentReports: options.maxConcurrentReports || DEFAULT_CONCURRENT_REPORTS, generatedCopyRoots: config.generated_copy_roots || [] });
  if (!plan.reviewable) throw new Error(plan.incomplete_reason || 'review target cannot be chunked safely');
  const plannedChunks = chunkFrozenTarget(filtered.body, options.chunkTokenBudget || DEFAULT_TOKEN_BUDGET, { targetFiles: frozen.kind === 'file' ? [frozen.ref] : [], fileBudget: options.chunkFileBudget || DEFAULT_FILE_BUDGET });
  const actualChunks = plannedChunks.length ? plannedChunks : [{ id: 'chunk-001', body: filtered.body, files: plan.files, target_hash: hash(filtered.body) }];
  const chunks = actualChunks.map((chunk) => ({ id: chunk.id, files: chunk.files || [], target_hash: chunk.target_hash || hash(chunk.body), target_file: `chunks/${chunk.id}.patch` }));
  chunks.forEach((chunk, index) => writeFileSync(join(runDir, chunk.target_file), actualChunks[index].body));
  const lenses = options.lenses?.length ? options.lenses : plan.profiles.map((entry) => entry.profile);
  const prompts = lenses.map((lens) => { const body = promptFor(lens); const file = `prompts/${lens}.md`; writeFileSync(join(runDir, file), body); return { lens, file, prompt_hash: hash(body) }; });
  const expectedReports = [];
  const bindings = {};
  // The plan floors its own value at the number of profiles IT picked, which is not the lens
  // set actually being run (--lenses overrides it). Prefer the caller's value so a requested
  // concurrency is not silently raised back up by the planner's profile count.
  const maxConcurrentReports = Math.max(lenses.length, options.maxConcurrentReports || plan.max_concurrent_reports || lenses.length);
  const chunksPerWave = Math.max(1, Math.floor(maxConcurrentReports / lenses.length));
  for (const lens of lenses) for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
    const reportId = `${lens}-${chunk.id}`;
    const prompt = prompts.find((entry) => entry.lens === lens);
    const chunkFields = chunks.length > 1 ? { chunk_id: chunk.id, target_file: chunk.target_file, wave: Math.floor(chunkIndex / chunksPerWave) + 1 } : { wave: 1 };
    expectedReports.push({ report_id: reportId, lens, target_hash: chunk.target_hash, target_files: chunk.files, prompt_hash: prompt.prompt_hash, ...chunkFields });
    bindings[reportId] = { task_id: id, chunk_id: chunk.id, target_file: chunk.target_file, target_hash: chunk.target_hash, prompt_file: prompt.file, prompt_hash: prompt.prompt_hash };
  }
  const files = [...new Set(plan.files.map(normalizedPath))].sort();
  const commit = git(cwd, ['rev-parse', 'HEAD']);
  if (!commit || !/^[0-9a-f]{40}$/i.test(commit)) throw new Error('unable to bind review to a full HEAD commit');
  const manifest = {
    schema: 'xm.review.run.v2', schema_version: 1, id, task_id: id, created_at: iso(), started_at: iso(), cwd,
    target_hash: hash(frozen.body), target_files: files, context_status: 'absent', target: { kind: frozen.kind, ref: frozen.ref, hash: hash(frozen.body), file: 'target.patch' },
    reviewed_commit: commit, reviewed_files_all: files, reviewed_file_snapshots: snapshots(cwd, files),
    profiles: lenses.map((profile) => ({ profile })), chunks, prompts, expected_reports: expectedReports, bindings,
    plan: { profiles: lenses, chunks: chunks.map(({ id: chunkId, files: chunkFiles, target_hash }) => ({ id: chunkId, files: chunkFiles, target_hash })) },
    options: { cross_vendor: true, models: options.models ? options.models.split(',').filter(Boolean) : [], rounds: options.rounds || 1, trace, max_concurrent_reports: maxConcurrentReports },
  };
  json(join(runDir, 'run.json'), manifest); json(join(runDir, 'plan.json'), plan);
  json(join(runDir, 'status.json'), { state: 'running', updated_at: iso(), completed: 0, expected: expectedReports.length });
  event(runDir, 'run_started', { run_id: id, children: expectedReports.length }, trace);
  verifyBytes(runDir, manifest);
  return { runDir, manifest, result: await execute(manifest, runDir, { cwd, env: options.env || process.env, models: options.models, rounds: options.rounds || 1, trace }) };
}

export async function resumeReview(id, options = {}) {
  if (!/^[a-zA-Z0-9._-]+$/.test(id || '')) throw new Error('invalid review run id');
  const cwd = resolve(options.cwd || process.cwd());
  const xmRoot = resolve(options.xmRoot || process.env.XM_REVIEW_ROOT || join(cwd, '.xm'));
  const runDir = join(xmRoot, 'review', 'runs', id);
  const manifest = readJson(join(runDir, 'run.json'));
  if (!manifest || manifest.schema !== 'xm.review.run.v2' || manifest.schema_version !== 1) throw new Error(`invalid review run manifest: ${runDir}`);
  verifyBytes(runDir, manifest);
  const trace = options.trace ?? manifest.options.trace;
  event(runDir, 'run_resumed', { run_id: id }, trace);
  return { runDir, manifest, result: await execute(manifest, runDir, { cwd: manifest.cwd || cwd, env: options.env || process.env, models: options.models || manifest.options.models.join(','), rounds: options.rounds || manifest.options.rounds, trace }) };
}
