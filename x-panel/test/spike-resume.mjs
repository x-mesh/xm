#!/usr/bin/env node
/**
 * t0 spike (x-panel ↔ term-mesh Phase 2, docs/x-panel-term-mesh-phase2.md):
 * verify that a 2-turn RESUMED conversation works per provider, print-mode only —
 * the exact mechanics round-2 session reuse (t5) will use:
 *
 *   claude:  turn1 `claude -p --session-id <uuid>` → turn2 `claude -p --resume <uuid>`
 *   codex:   turn1 `codex exec …` → turn2 `codex exec … resume --last`
 *            (argv built by adapters.buildCodexResumeArgs — the no-consumer contract)
 *
 * This is a LIVE spike, not a unit test (it spends 2 tiny model calls per
 * available provider), so the filename deliberately does not match *.test.*
 * and `bun test` never picks it up. Run manually:
 *
 *   node x-panel/test/spike-resume.mjs [--model <claude-model>] [--timeout <s>]
 *
 * PASS = turn 2 recalls a codeword that was only ever said in turn 1.
 * A missing CLI is SKIP, not FAIL. Exit 1 only on a real FAIL.
 * Record the resulting table in docs/x-panel-term-mesh-phase2.md §9.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildCodexResumeArgs } from '../lib/x-panel/adapters.mjs';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] != null ? args[i + 1] : dflt;
};
const CLAUDE_MODEL = flag('--model', 'haiku'); // cheapest that proves the mechanism
const TIMEOUT_MS = Number(flag('--timeout', '120')) * 1000;

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
{
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

// ── codex: exec → exec resume --last (buildCodexResumeArgs) ─────────────────
{
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
      const [bin, argv] = buildCodexResumeArgs({
        execFlags: ['--sandbox', 'read-only', '--skip-git-repo-check'],
        sessionId: null, // → resume --last, per the adapters contract
        prompt: 'What was the codeword I gave you? Reply with just the codeword.',
      });
      const t2 = run(bin, argv);
      if (!t2.ok) {
        record('codex', version, 'FAIL',
          `turn2 (resume --last) exit=${t2.status} err=${t2.error || t2.stderr.slice(0, 200)}`);
      } else if (t2.stdout.includes(codeword)) {
        record('codex', version, 'PASS',
          `resumed session recalled codeword (t1 ${t1.ms}ms, t2 ${t2.ms}ms)`);
      } else {
        record('codex', version, 'FAIL',
          `turn2 ran but did not recall codeword; got: ${t2.stdout.slice(0, 120)}`);
      }
    }
  }
}

// ── summary ──────────────────────────────────────────────────────────────────
console.log('\n== t0 spike summary ==');
for (const r of results) console.log(`  ${r.provider}: ${r.verdict} (${r.version})`);
process.exit(results.some((r) => r.verdict === 'FAIL') ? 1 : 0);
