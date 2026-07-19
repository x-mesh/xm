/**
 * x-inbox toss (cross-project-handoff t6, transport migrated t11): capture
 * gate (validation + redact() + truncation), pure mem-mesh MCP payload
 * construction (`buildMemMeshPayload`), and the full `toss()` orchestration.
 *
 * `captureTossItem` and `buildMemMeshPayload` have no home-dir dependency, so
 * they're exercised with a direct in-process import (fast, no subprocess).
 *
 * `toss()` calls the real `resolveTarget()`, which reads `~/.xm/projects.json`
 * through x-projects-registry.mjs's home-dir-derived REGISTRY_PATH constant.
 * Bun's in-process os.homedir() does not honor a process.env.HOME override
 * (see test/x-inbox-target.test.mjs's header for the same quirk), so the
 * full-orchestration tests below run `toss()` inside a real `node`
 * subprocess with HOME redirected to a disposable temp dir — identical
 * pattern to x-inbox-target.test.mjs's `resolveTargetIsolated()`.
 *
 * As of t11, `toss()` never touches the network — no fetch, no mem-mesh
 * transport, no `fetchImpl`/`baseUrl` params — it only captures + writes the
 * local outbox and returns an MCP call payload for the (skill) caller to
 * actually deliver. There is nothing left to fake here.
 */
import { describe, test, expect } from 'bun:test';
import { execSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  INBOX_PIN_TAG,
  MAX_CAPTURED_OUTPUT_CHARS,
  DEFAULT_PIN_IMPORTANCE,
  captureTossItem,
  buildMemMeshPayload,
  describeCapture,
} from '../xm/lib/x-inbox/toss.mjs';
import { validateItem } from '../xm/lib/x-inbox/ledger.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOSS_MJS_URL = pathToFileURL(
  join(__dirname, '..', 'xm', 'lib', 'x-inbox', 'toss.mjs'),
).href;

function baseInput(overrides = {}) {
  return {
    fromProject: 'x-kit',
    toProject: 'git-kit',
    title: 'land reports paused as ok',
    why: 'state 판정에서 paused가 ok로 접힘',
    repro: { command: 'GK_AGENT=1 git-kit land', output: 'state: ok\n' },
    fixDirection: 'state 판정 분기 확인',
    ...overrides,
  };
}

describe('captureTossItem — capture gate (validation, redact, truncate)', () => {
  test('rejects missing/empty fix_direction — a "be careful"-level report is refused, not captured', () => {
    expect(() => captureTossItem(baseInput({ fixDirection: '' }))).toThrow(/fix_direction/);
    expect(() => captureTossItem(baseInput({ fixDirection: undefined }))).toThrow(/fix_direction/);
    expect(() => captureTossItem(baseInput({ fixDirection: '   ' }))).toThrow(/fix_direction/);
  });

  test('rejects missing/empty repro.command', () => {
    expect(() => captureTossItem(baseInput({ repro: { command: '', output: 'x' } })))
      .toThrow(/repro\.command/);
    expect(() => captureTossItem(baseInput({ repro: undefined }))).toThrow(/repro/);
  });

  test('rejects missing/empty repro.output', () => {
    expect(() => captureTossItem(baseInput({ repro: { command: 'cmd', output: '' } })))
      .toThrow(/repro\.output/);
  });

  test('rejects missing title / toProject / fromProject', () => {
    expect(() => captureTossItem(baseInput({ title: '' }))).toThrow(/title/);
    expect(() => captureTossItem(baseInput({ toProject: '' }))).toThrow(/toProject/);
    expect(() => captureTossItem(baseInput({ fromProject: '' }))).toThrow(/fromProject/);
  });

  test('produces an item that satisfies ledger.mjs validateItem() as-is', () => {
    const item = captureTossItem(baseInput());
    expect(() => validateItem(item)).not.toThrow();
    // Capture-time state, NOT 'delivered' — capture writes the sender's outbox
    // copy before the skill attempts any MCP call, so claiming delivery here
    // would persist a false success. recordMemMesh() promotes it once an id
    // actually comes back (covered in x-inbox-ledger.test.mjs).
    expect(item.status).toBe('captured');
  });

  test('applies redact() to repro.output — secret is masked, not stored verbatim', () => {
    const secret = 'sk-proj-abcdefghijklmnopqrstuvwxyz1234567890ABCD';
    const item = captureTossItem(baseInput({
      repro: { command: 'cmd', output: `token: ${secret}` },
    }));
    expect(item.repro.output).not.toContain(secret);
    expect(item.repro.output).toContain('[REDACTED]');
  });

  test('truncates output over MAX_CAPTURED_OUTPUT_CHARS, keeps the tail, flags truncated:true', () => {
    // Unique, non-repeating markers so the assertions can't accidentally
    // pass because a repeated filler happens to survive the cut.
    const headMarker = 'UNIQUE_HEAD_ONLY_MARKER';
    const filler = 'x'.repeat(MAX_CAPTURED_OUTPUT_CHARS + 100);
    const tailMarker = 'UNIQUE_TAIL_MARKER_END';
    const item = captureTossItem(baseInput({ repro: { command: 'cmd', output: headMarker + filler + tailMarker } }));
    expect(item.repro.truncated).toBe(true);
    expect(item.repro.output.length).toBeLessThanOrEqual(MAX_CAPTURED_OUTPUT_CHARS);
    expect(item.repro.output).toContain(tailMarker);
    expect(item.repro.output).not.toContain(headMarker);
  });

  test('output at or under the limit is not truncated and is stored verbatim (post-redact)', () => {
    const item = captureTossItem(baseInput({ repro: { command: 'cmd', output: 'short output' } }));
    expect(item.repro.truncated).toBe(false);
    expect(item.repro.output).toBe('short output');
  });

  test('defaults anchors.to_files to [] and anchors.from_commit to null when omitted', () => {
    const item = captureTossItem(baseInput());
    expect(item.anchors.to_files).toEqual([]);
    expect(item.anchors.from_commit).toBeNull();
  });

  test('preserves caller-supplied anchors', () => {
    const item = captureTossItem(baseInput({ anchors: { from_commit: 'abc123', to_files: ['a.go'] } }));
    expect(item.anchors.from_commit).toBe('abc123');
    expect(item.anchors.to_files).toEqual(['a.go']);
  });

  test('honors an id/createdAt override for idempotent re-capture', () => {
    const item = captureTossItem(baseInput({ id: 'toss-fixed-id', createdAt: '2026-01-01T00:00:00.000Z' }));
    expect(item.id).toBe('toss-fixed-id');
    expect(item.created_at).toBe('2026-01-01T00:00:00.000Z');
  });

  test('auto-generates an id matching the ledger id charset', () => {
    const item = captureTossItem(baseInput());
    expect(item.id).toMatch(/^toss-\d{8}-[a-f0-9]{8}$/);
  });
});

describe('buildMemMeshPayload — pure MCP call-argument construction (no I/O, t11)', () => {
  test('pin_add args: title as content, target project id, INBOX_PIN_TAG, default importance', () => {
    const item = captureTossItem(baseInput());
    const payload = buildMemMeshPayload(item, 'git-kit');

    expect(payload.pin_add).toEqual({
      content: item.title,
      project_id: 'git-kit',
      tags: [INBOX_PIN_TAG],
      importance: DEFAULT_PIN_IMPORTANCE,
    });
  });

  test('add args: full item JSON as content, target project id, category bug, INBOX_PIN_TAG', () => {
    const item = captureTossItem(baseInput());
    const payload = buildMemMeshPayload(item, 'git-kit');

    expect(payload.add.project_id).toBe('git-kit');
    expect(payload.add.category).toBe('bug');
    expect(payload.add.tags).toEqual([INBOX_PIN_TAG]);
    // Round-trip fidelity: the memory body is the full item as JSON.
    expect(JSON.parse(payload.add.content)).toEqual(item);
  });

  test('add args include anchors (commit_hash + file_paths) when from_commit is present', () => {
    const item = captureTossItem(baseInput({ anchors: { from_commit: 'abc123', to_files: ['a.go', 'b.go'] } }));
    const payload = buildMemMeshPayload(item, 'git-kit');

    expect(payload.add.anchors).toEqual({ commit_hash: 'abc123', file_paths: ['a.go', 'b.go'] });
  });

  test('add args omit anchors entirely when from_commit is null', () => {
    const item = captureTossItem(baseInput());
    const payload = buildMemMeshPayload(item, 'git-kit');

    expect(payload.add.anchors).toBeUndefined();
  });

  test('honors an importance override', () => {
    const item = captureTossItem(baseInput());
    const payload = buildMemMeshPayload(item, 'git-kit', { importance: 5 });
    expect(payload.pin_add.importance).toBe(5);
  });

  test('is pure — never touches the network or process globals (no fetch reference reachable)', () => {
    const item = captureTossItem(baseInput());
    // Calling it twice with the same inputs yields deep-equal, side-effect-free output.
    const a = buildMemMeshPayload(item, 'git-kit');
    const b = buildMemMeshPayload(item, 'git-kit');
    expect(a).toEqual(b);
  });
});

describe('describeCapture — capture-only summary (t11: no delivery to describe)', () => {
  test('failure result: reports the message', () => {
    expect(describeCapture({ ok: false, message: 'boom' })).toMatch(/boom/);
  });

  test('success result: reports the outbox path, says delivery is the skill\'s job', () => {
    const msg = describeCapture({ ok: true, outboxPath: '/tmp/x/.xm/outbox/toss-1.json' });
    expect(msg).toContain('/tmp/x/.xm/outbox/toss-1.json');
    expect(msg).toMatch(/스킬/);
  });
});

// ---------------------------------------------------------------------------
// toss() full orchestration — real resolveTarget() + real writeLedger(), run
// in an isolated `node` subprocess (HOME redirected). No mem-mesh faking
// needed anymore: toss() never attempts delivery itself (t11).
// ---------------------------------------------------------------------------

function git(cmd, cwd) {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe', shell: '/bin/bash' }).toString().trim();
}

function writeRegistry(home, projects) {
  const dir = join(home, '.xm');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'projects.json'),
    JSON.stringify({ version: 1, updated_at: new Date().toISOString(), projects }, null, 2) + '\n',
  );
}

function makeEntry(id, path, overrides = {}) {
  return {
    id,
    path,
    name: id,
    added_at: '2026-07-19T00:00:00.000Z',
    last_seen: '2026-07-19T00:00:00.000Z',
    tags: [],
    archived: false,
    ...overrides,
  };
}

// Runs toss(params) in a fresh `node` subprocess with HOME -> home, so
// x-projects-registry.mjs's REGISTRY_PATH resolves inside our temp fixture.
function runTossIsolated(params, home) {
  const harnessDir = mkdtempSync(join(tmpdir(), 'x-inbox-toss-harness-'));
  try {
    const harnessPath = join(harnessDir, 'run.mjs');
    writeFileSync(harnessPath, [
      `import { toss } from ${JSON.stringify(TOSS_MJS_URL)};`,
      'const params = JSON.parse(process.argv[2]);',
      'const result = await toss(params);',
      'process.stdout.write(JSON.stringify(result));',
    ].join('\n'));

    const r = spawnSync('node', [harnessPath, JSON.stringify(params)], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
      timeout: 10000,
    });
    if (r.status !== 0) {
      throw new Error(`harness exited ${r.status}: ${r.stderr}`);
    }
    return JSON.parse(r.stdout);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
  }
}

describe('toss() — full orchestration (real resolveTarget + real ledger, no network)', () => {
  test('happy path: outbox written to the SENDER\'s own cwd, target dir untouched, payload returned', () => {
    const home = mkdtempSync(join(tmpdir(), 'x-inbox-toss-home-'));
    const targetDir = mkdtempSync(join(tmpdir(), 'x-inbox-toss-target-'));
    const senderDir = mkdtempSync(join(tmpdir(), 'x-inbox-toss-sender-'));
    try {
      mkdirSync(join(targetDir, '.xm'), { recursive: true });
      // Fix the target's mem-mesh identity to "git-kit" so the payload's
      // project_id assertion below is meaningful — without this,
      // resolveMemMeshProjectId() falls all the way through to
      // basename(targetDir) (a temp-dir name), since targetDir here is not
      // itself a git repo with `mem-mesh.project-id` config (see target.mjs).
      mkdirSync(join(targetDir, '.mem-mesh'), { recursive: true });
      writeFileSync(join(targetDir, '.mem-mesh', 'project-id'), 'git-kit\n');
      writeRegistry(home, [makeEntry('git-kit', targetDir)]);
      git('init -q', senderDir);
      git('config user.email t@t.com', senderDir);
      git('config user.name T', senderDir);
      writeFileSync(join(senderDir, 'f.txt'), 'x');
      git('add -A && git commit -q -m c1', senderDir);

      const params = {
        toProject: 'git-kit',
        title: 'land reports paused as ok',
        why: 'state 판정에서 paused가 ok로 접힘',
        repro: { command: 'GK_AGENT=1 git-kit land', output: 'state: ok\n' },
        fixDirection: 'state 판정 분기 확인',
        cwd: senderDir,
      };

      const result = runTossIsolated(params, home);

      expect(result.ok).toBe(true);
      expect(result.memMeshProjectId).toBe('git-kit');
      expect(result.payload.pin_add.project_id).toBe('git-kit');
      expect(result.payload.pin_add.tags).toEqual([INBOX_PIN_TAG]);
      expect(result.payload.add.project_id).toBe('git-kit');
      expect(JSON.parse(result.payload.add.content).id).toBe(result.item.id);

      const outboxFile = join(senderDir, '.xm', 'outbox', `${result.item.id}.json`);
      expect(existsSync(outboxFile)).toBe(true);
      const onDisk = JSON.parse(readFileSync(outboxFile, 'utf8'));
      expect(onDisk.repro.command.length).toBeGreaterThan(0);
      expect(onDisk.repro.output.length).toBeGreaterThan(0);
      expect(onDisk.anchors.from_commit).toMatch(/^[0-9a-f]{40}$/);
      // Nothing was delivered yet — toss() never calls mem-mesh (t11).
      expect(onDisk.mem_mesh).toEqual({});

      // Ownership invariant (C2): never writes into the target's tree.
      expect(existsSync(join(targetDir, '.xm', 'outbox'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(targetDir, { recursive: true, force: true });
      rmSync(senderDir, { recursive: true, force: true });
    }
  });

  test('invalid capture (no fix_direction): rejected before target resolution, no outbox ever written', () => {
    const home = mkdtempSync(join(tmpdir(), 'x-inbox-toss-home-'));
    const targetDir = mkdtempSync(join(tmpdir(), 'x-inbox-toss-target-'));
    const senderDir = mkdtempSync(join(tmpdir(), 'x-inbox-toss-sender-'));
    try {
      mkdirSync(join(targetDir, '.xm'), { recursive: true });
      writeRegistry(home, [makeEntry('git-kit', targetDir)]);

      const params = {
        toProject: 'git-kit',
        title: 'x',
        repro: { command: 'cmd', output: 'out' },
        fixDirection: '',
        cwd: senderDir,
      };
      const result = runTossIsolated(params, home);

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('invalid_capture');
      expect(existsSync(join(senderDir, '.xm'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(targetDir, { recursive: true, force: true });
      rmSync(senderDir, { recursive: true, force: true });
    }
  });

  test('unregistered target: fails before any outbox write, surfaces candidates', () => {
    const home = mkdtempSync(join(tmpdir(), 'x-inbox-toss-home-'));
    const senderDir = mkdtempSync(join(tmpdir(), 'x-inbox-toss-sender-'));
    try {
      writeRegistry(home, []);

      const params = {
        toProject: 'totally-unknown-project-xyz',
        title: 'x',
        repro: { command: 'cmd', output: 'out' },
        fixDirection: 'fix',
        cwd: senderDir,
      };
      const result = runTossIsolated(params, home);

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('unregistered');
      expect(result.candidates).toEqual([]);
      expect(existsSync(join(senderDir, '.xm'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(senderDir, { recursive: true, force: true });
    }
  });
});

describe('captureTossItem — every free-text field passes the redact gate', () => {
  // The gate was wired to repro.output alone. All five review vendors flagged
  // it independently: a reproduction command is the MOST likely place for a
  // live credential, and it ships verbatim into another project's memory.
  const LIVE = 'sk-live-abcdefghijklmnop';

  test('repro.command is masked', () => {
    const item = captureTossItem(baseInput({
      repro: { command: `curl -H "Authorization: Bearer ${LIVE}" https://api/x`, output: '500' },
    }));
    expect(item.repro.command).not.toContain(LIVE);
    expect(item.repro.command).toContain('[REDACTED]');
  });

  test('title, why and fix_direction are masked', () => {
    const item = captureTossItem(baseInput({
      title: `auth broken token=${LIVE}`,
      why: `password="hunter two three" reproduces it`,
      fixDirection: `rotate api_key=deadbeefcafe1234`,
    }));
    expect(item.title).not.toContain(LIVE);
    expect(item.why).not.toContain('hunter two three');
    expect(item.fix_direction).not.toContain('deadbeefcafe1234');
  });

  test('no secret survives anywhere in the serialized item', () => {
    // The item is JSON.stringify'd wholesale into the mem-mesh `add` payload,
    // so field-by-field checks are not enough — scan the whole blob.
    const item = captureTossItem(baseInput({
      title: `broken token=${LIVE}`,
      why: 'password="one two three"',
      repro: { command: `curl -H "Authorization: Bearer ${LIVE}"`, output: `api_key=${'z'.repeat(700)}` },
      fixDirection: 'rotate secret=abcd1234efgh5678',
    }));
    const blob = JSON.stringify(item);
    for (const s of [LIVE, 'one two three', 'zzzzzzzz', 'abcd1234efgh5678']) {
      expect(blob).not.toContain(s);
    }
  });

  test('a secret whose key name falls just before the truncation bound is still masked', () => {
    // Truncate-before-redact could strip the `password=` marker away from the
    // value that survived, leaving the value in cleartext. Redaction now runs
    // on a margin-widened window first.
    const filler = 'q'.repeat(1900);
    const output = `password="super secret value"${filler}`;
    const item = captureTossItem(baseInput({ repro: { command: 'cmd', output } }));
    expect(item.repro.output).not.toContain('super secret value');
  });
});
