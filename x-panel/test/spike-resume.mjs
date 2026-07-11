#!/usr/bin/env node
/**
 * t0 spike (x-panel ↔ term-mesh Phase 2, docs/x-panel-term-mesh-phase2.md):
 * verify that a 2-turn RESUMED conversation works per provider, print-mode only —
 * the exact mechanics round-2 session reuse (t5) SHIPS with:
 *
 *   claude:  turn1 `claude -p --session-id <uuid>` → turn2 `claude -p --resume <uuid>`
 *   codex:   turn1 `codex exec …` → session id CAPTURED from the stderr run banner
 *            via the shipped SESSION_ID_RE (adapters.mjs) → turn2 `exec … resume <id>`
 *            (argv built by adapters.buildCodexResumeArgs). NEVER `resume --last`:
 *            production forbids it (a wrong-session resume SUCCEEDS silently), so the
 *            spike must not certify a path the panel never runs. A banner-parse
 *            failure is a FAIL (exit 1) — that is the capture path production
 *            depends on, not a skippable detail.
 *
 * This is a LIVE spike, not a unit test (it spends 2 tiny model calls per
 * available provider), so the filename deliberately does not match *.test.*
 * and `bun test` never picks it up. Run manually:
 *
 *   node x-panel/test/spike-resume.mjs [--model <claude-model>] [--timeout <s>]
 *                                      [--only claude|codex] [--capture-banner [path]]
 *
 * --only        scope the spike to one provider (halves the spend).
 * --capture-banner  on a codex PASS, save turn-1's raw stderr (the banner sample)
 *               for the stub suite (default: test/fixtures/codex-banner-sample.txt)
 *               so SESSION_ID_RE is asserted against a REAL banner, not a synthetic one.
 *
 * PASS = turn 2 recalls a codeword that was only ever said in turn 1.
 * A missing CLI is SKIP, not FAIL. Exit 1 only on a real FAIL.
 * Record the resulting table in docs/x-panel-term-mesh-phase2.md §9.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildCodexResumeArgs, SESSION_ID_RE } from '../lib/x-panel/adapters.mjs';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] != null ? args[i + 1] : dflt;
};
const CLAUDE_MODEL = flag('--model', 'haiku'); // cheapest that proves the mechanism
const TIMEOUT_MS = Number(flag('--timeout', '120')) * 1000;
const ONLY = flag('--only', null); // claude | codex | null (both)
// --capture-banner [path]: value optional — a bare flag uses the default fixture path.
const captureIdx = args.indexOf('--capture-banner');
const BANNER_FIXTURE = captureIdx === -1 ? null
  : (args[captureIdx + 1] && !args[captureIdx + 1].startsWith('--'))
    ? args[captureIdx + 1]
    : join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'codex-banner-sample.txt');

// Neutral cwd so the CLIs don't ingest this repo's CLAUDE.md/plugins
// (same isolation x-panel applies to prompt runs — see commit c9536ea).
const cwd = mkdtempSync(join(tmpdir(), 'xpanel-spike-'));
process.on('exit', () => { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* tmp */ } });

function run(bin, argv) {
  const started = Date.now();
  const r = spawnSync(bin, argv, { cwd, encoding: 'utf8', timeout: TIMEOUT_MS });
  return {
    ok: !r.error && r.status === 0,
    status: r.status,
    error: r.error ? String(r.error.message || r.error) : null,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    ms: Date.now() - started,
  };
}

function detect(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000 });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || r.stderr || '').trim().split('\n')[0];
}

const results = [];
function record(provider, version, verdict, detail) {
  results.push({ provider, version: version || 'n/a', verdict, detail });
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad(verdict, 6)} ${pad(provider, 8)} ${detail}`);
}

// ── claude: --session-id → --resume ─────────────────────────────────────────
if (!ONLY || ONLY === 'claude') {
  const version = detect('claude');
  if (!version) {
    record('claude', null, 'SKIP', 'claude CLI not on PATH');
  } else {
    const sessionId = randomUUID();
    const codeword = `zebra-${randomUUID().slice(0, 8)}`;
    const t1 = run('claude', [
      '-p', '--model', CLAUDE_MODEL, '--session-id', sessionId,
      `Remember this codeword: ${codeword}. Reply with exactly: OK`,
    ]);
    if (!t1.ok) {
      record('claude', version, 'FAIL',
        `turn1 (--session-id) exit=${t1.status} err=${t1.error || t1.stderr.slice(0, 200)}`);
    } else {
      const t2 = run('claude', [
        '-p', '--model', CLAUDE_MODEL, '--resume', sessionId,
        'What was the codeword I gave you? Reply with just the codeword.',
      ]);
      if (!t2.ok) {
        record('claude', version, 'FAIL',
          `turn2 (--resume) exit=${t2.status} err=${t2.error || t2.stderr.slice(0, 200)}`);
      } else if (t2.stdout.includes(codeword)) {
        record('claude', version, 'PASS',
          `resumed session recalled codeword (t1 ${t1.ms}ms, t2 ${t2.ms}ms)`);
      } else {
        record('claude', version, 'FAIL',
          `turn2 ran but did not recall codeword; got: ${t2.stdout.slice(0, 120)}`);
      }
    }
  }
}

// ── codex: exec → banner-captured id → exec resume <id> (the SHIPPED contract) ──
if (!ONLY || ONLY === 'codex') {
  const version = detect('codex');
  if (!version) {
    record('codex', null, 'SKIP', 'codex CLI not on PATH');
  } else {
    const codeword = `otter-${randomUUID().slice(0, 8)}`;
    const t1 = run('codex', [
      'exec', '--sandbox', 'read-only', '--skip-git-repo-check',
      `Remember this codeword: ${codeword}. Reply with exactly: OK`,
    ]);
    if (!t1.ok) {
      record('codex', version, 'FAIL',
        `turn1 (exec) exit=${t1.status} err=${t1.error || t1.stderr.slice(0, 200)}`);
    } else {
      // The load-bearing step: production only resumes an id CAPTURED from the
      // stderr banner. No banner match → the whole session-reuse path is dead,
      // so this is a hard FAIL, never a fallback to --last.
      const sessionId = (SESSION_ID_RE.exec(t1.stderr) || [])[1] || null;
      if (!sessionId) {
        record('codex', version, 'FAIL',
          `banner parse failed — SESSION_ID_RE matched nothing in turn-1 stderr (head: ${t1.stderr.slice(0, 160)})`);
      } else {
        const [bin, argv] = buildCodexResumeArgs({
          execFlags: ['--sandbox', 'read-only', '--skip-git-repo-check'],
          sessionId, // the captured id — never --last (adapters forbids it in production)
          prompt: 'What was the codeword I gave you? Reply with just the codeword.',
        });
        const t2 = run(bin, argv);
        if (!t2.ok) {
          record('codex', version, 'FAIL',
            `turn2 (resume ${sessionId.slice(0, 8)}…) exit=${t2.status} err=${t2.error || t2.stderr.slice(0, 200)}`);
        } else if (t2.stdout.includes(codeword)) {
          record('codex', version, 'PASS',
            `banner-captured session ${sessionId.slice(0, 8)}… recalled codeword (t1 ${t1.ms}ms, t2 ${t2.ms}ms)`);
          if (BANNER_FIXTURE) {
            // Persist the REAL banner (turn-1 stderr) for the stub suite, so
            // SESSION_ID_RE is regression-tested against production output.
            writeFileSync(BANNER_FIXTURE, t1.stderr.slice(0, 4000) + '\n');
            console.log(`       banner sample saved → ${BANNER_FIXTURE}`);
          }
        } else {
          record('codex', version, 'FAIL',
            `turn2 ran but did not recall codeword; got: ${t2.stdout.slice(0, 120)}`);
        }
      }
    }
  }
}

// ── summary ──────────────────────────────────────────────────────────────────
console.log('\n== t0 spike summary ==');
for (const r of results) console.log(`  ${r.provider}: ${r.verdict} (${r.version})`);
process.exit(results.some((r) => r.verdict === 'FAIL') ? 1 : 0);
