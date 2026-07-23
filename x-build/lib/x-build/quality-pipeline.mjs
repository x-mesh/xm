/** Shared, fail-closed quality/evidence primitives. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const sha = (value) => createHash('sha256').update(String(value)).digest('hex');

function jsonFile(path) {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) {
    return { __malformed: true, __error: error.message };
  }
}

/** Merge build config by key. Legacy gate_scripts win when both layers set a key. */
export function resolveEffectiveQualityConfig(cwd = process.cwd(), { shared = null, local = null } = {}) {
  const root = resolve(cwd);
  const sharedConfig = shared || jsonFile(join(root, '.xm', 'config.json'));
  const localConfig = local || jsonFile(join(root, '.xm', 'build', 'config.json'));
  const sharedBuild = sharedConfig.build || {};
  const localBuild = localConfig.build || {};
  const sharedGates = sharedConfig.gate_scripts || sharedBuild.gate_scripts || {};
  const localGates = localConfig.gate_scripts || localBuild.gate_scripts || {};
  return {
    ...sharedBuild,
    ...localBuild,
    gate_scripts: { ...sharedGates, ...localGates },
    config_error: Boolean(sharedConfig.__malformed || localConfig.__malformed),
  };
}

export function commandDescriptor(command, cwd = process.cwd(), env = {}) {
  const canonicalCwd = resolve(cwd);
  const text = typeof command === 'string' ? command : JSON.stringify(command ?? '');
  return { command: text, cwd: canonicalCwd, env, command_hash: sha(JSON.stringify({ command: text, env })) };
}

/** Fingerprint tracked/staged/working content, deliberately excluding HEAD. */
export function contentFingerprint(cwd = process.cwd()) {
  const opts = { cwd, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 };
  const diff = spawnSync('git', ['diff', '--binary', 'HEAD'], opts);
  const staged = spawnSync('git', ['diff', '--cached', '--binary'], opts);
  const files = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], opts);
  if ([diff, staged, files].some((r) => r.status !== 0)) return null;
  const hash = createHash('sha256');
  hash.update(diff.stdout || ''); hash.update(staged.stdout || '');
  for (const file of (files.stdout || '').split('\0').filter(Boolean).sort()) {
    if (file.startsWith('.xm/') || file === 'TASK-CONTEXT.md') continue;
    const blob = spawnSync('git', ['hash-object', '--no-filters', '--', file], opts);
    if (blob.status !== 0) return null;
    hash.update(`\0${file}\0${blob.stdout.trim()}`);
  }
  return hash.digest('hex');
}

export function evidenceKey({ content_fingerprint, command_hash, cwd }) {
  return sha(JSON.stringify({ content_fingerprint, command_hash, cwd: resolve(cwd || process.cwd()) }));
}

/** Only an exact, successful, non-skipped evidence record can be reused. */
export function validateEvidence(evidence, expected = {}) {
  if (!evidence || evidence.passed !== true || evidence.skipped === true || evidence.failed === true) return { valid: false, reason: 'not_passing' };
  if (evidence.malformed || evidence.error) return { valid: false, reason: 'malformed' };
  const cwd = resolve(expected.cwd || process.cwd());
  if (evidence.cwd !== cwd || evidence.command_hash !== expected.command_hash || evidence.content_fingerprint !== expected.content_fingerprint) {
    return { valid: false, reason: 'fingerprint_mismatch' };
  }
  return { valid: true, reason: null };
}

/**
 * Pull the sole authoritative serial-quality record out of a persisted Verify
 * result.  Treat an incomplete or malformed envelope as unusable rather than
 * guessing from another check in the file: callers can then fail closed by
 * rerunning the command through validateEvidence().
 */
export function serialQualityEvidence(qualityResults) {
  if (!qualityResults || qualityResults.malformed || qualityResults.error || !Array.isArray(qualityResults.results)) return null;
  const serial = qualityResults.results.filter((result) => result && typeof result === 'object' && result.check === 'serial-quality');
  return serial.length === 1 ? serial[0] : null;
}

/** Read persisted Verify evidence without JSON recovery; malformed evidence reruns. */
export function readPersistedSerialQualityEvidence(path) {
  if (!existsSync(path)) return { exists: false, evidence: null };
  try {
    const payload = JSON.parse(readFileSync(path, 'utf8'));
    const evidence = serialQualityEvidence(payload);
    return {
      exists: true,
      evidence: evidence && !evidence.checked_at && payload.timestamp
        ? { ...evidence, checked_at: payload.timestamp }
        : evidence,
    };
  } catch {
    return { exists: true, evidence: null };
  }
}

/** Execute the authoritative quality command, fail-closed on config/timeout. */
export function runQualityPipeline({ cwd = process.cwd(), config = {}, evidence = null } = {}) {
  const root = resolve(cwd);
  if (config.config_error) return [{ check: 'quality-config', passed: false, failed: true, exit_code: 2, output: 'invalid quality configuration' }];
  const command = config.serial_quality_command;
  if (!command) return [{ check: 'quality-config', passed: false, failed: true, exit_code: 2, output: 'serial_quality_command is required' }];
  const descriptor = commandDescriptor(command, root, config.serial_quality_env || {});
  const fingerprint = contentFingerprint(root);
  if (!fingerprint) return [{ check: 'quality-fingerprint', passed: false, failed: true, exit_code: 2, output: 'unable to fingerprint workspace' }];
  const expected = { cwd: root, command_hash: descriptor.command_hash, content_fingerprint: fingerprint };
  if (validateEvidence(evidence, expected).valid) return [{ ...evidence, check: evidence.check || 'quality', reused: true }];
  const out = spawnSync(command, [], { shell: true, cwd: root, env: { ...process.env, ...descriptor.env }, encoding: 'utf8', timeout: Number(config.quality_timeout_ms || 300000) });
  const timedOut = out.error?.code === 'ETIMEDOUT' || out.signal === 'SIGTERM';
  const passed = !timedOut && out.status === 0;
  return [{ check: 'serial-quality', command, cwd: root, command_hash: descriptor.command_hash, content_fingerprint: fingerprint,
    passed, failed: !passed, exit_code: passed ? 0 : 2, timeout: timedOut, reused: false,
    output: `${out.stdout || ''}${out.stderr || ''}`.slice(-2000) }];
}
