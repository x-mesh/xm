import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as realFs from 'node:fs';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { SCHEMA } from '../x-build/lib/config-schema.mjs';
import {
  COST_EVENT_MAX_BYTES, appendCostEvent, checkHardCap, computeSpend,
  buildCacheKeyInput, cacheEntryPath, getCacheKey, getRequestCacheKey,
  prepareCacheEntry, readCacheEntry, readCostEvents, writeCacheEntry,
  cacheExpiry, gcCache, recordCacheHit, resolveCacheTtlMs,
} from '../x-build/lib/cost/index.mjs';
const bundledCore = await import('../xm/lib/cost/index.mjs');
// Capture values before mock.module mutates the process-wide module registry.
const originalFs = { ...realFs };

const tempDirs = [];
let isolatedImportSequence = 0;
function isolatedCoreImport(label) {
  isolatedImportSequence += 1;
  return import(`../x-build/lib/cost/index.mjs?${label}-${isolatedImportSequence}`);
}

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), 'xm-cost-core-'));
  tempDirs.push(dir);
  return join(dir, 'events.jsonl');
}
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('shared cost core', () => {
  test('R16 registers cache.store_content as a local false-by-default setting', () => {
    expect(SCHEMA.find((entry) => entry.key === 'cache.store_content')).toMatchObject({
      group: 'misc', type: 'boolean', scope: 'local', default: false,
    });
    expect(JSON.parse(readFileSync('x-build/lib/default-config.json', 'utf8')).cache.store_content).toBe(false);
    expect(JSON.parse(readFileSync('xm/lib/default-config.json', 'utf8')).cache.store_content).toBe(false);
  });

  test('bundled xm/lib/cost entry exports the shared cost and cache APIs', () => {
    const publicFunctions = [
      'readCostEvents', 'appendCostEvent', 'computeSpend', 'getCacheKey', 'checkHardCap',
      'buildCacheKeyInput', 'getRequestCacheKey', 'cacheEntryPath', 'writeCacheEntry', 'readCacheEntry', 'prepareCacheEntry',
      'cacheExpiry', 'gcCache', 'recordCacheHit', 'resolveCacheTtlMs',
    ];
    for (const name of publicFunctions) expect(typeof bundledCore[name]).toBe('function');
  });

  test('readCostEvents returns valid JSONL rows and skips a torn row', () => {
    const filePath = tempFile();
    writeFileSync(filePath, '{"cost_usd":0.1}\n{torn}\n{"cost_usd":0.2}\n');
    expect(readCostEvents({ filePath })).toEqual([{ cost_usd: 0.1 }, { cost_usd: 0.2 }]);
  });

  test('appendCostEvent writes atomically-sized JSONL events', () => {
    const filePath = tempFile();
    const event = { type: 'task_complete', cost_usd: 0.1 };
    expect(appendCostEvent({ filePath, event })).toBe(event);
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(event);
    expect(() => appendCostEvent({ filePath, event: { detail: 'x'.repeat(COST_EVENT_MAX_BYTES) } })).toThrow(/4096 bytes.*refs-out/i);
  });

  test('appendCostEvent keeps the 4KB ceiling when maxBytes requests more', () => {
    const filePath = tempFile();
    const oversized = { detail: 'x'.repeat(COST_EVENT_MAX_BYTES) };
    expect(() => appendCostEvent({ filePath, event: oversized, maxBytes: COST_EVENT_MAX_BYTES * 2 })).toThrow(/4096 bytes.*refs-out/i);
    expect(() => appendCostEvent({ filePath, event: oversized, maxBytes: Infinity })).toThrow(/maxBytes.*finite/i);
    expect(() => appendCostEvent({ filePath, event: oversized, maxBytes: NaN })).toThrow(/maxBytes.*finite/i);
  });

  test('appendCostEvent still records the active log when rotation conflicts', () => {
    const filePath = tempFile();
    writeFileSync(filePath, JSON.stringify({ type: 'old' }) + '\n');
    mkdirSync(filePath + '.1'); // rename target conflict (EISDIR on supported filesystems)

    appendCostEvent({ filePath, event: { type: 'new', cost_usd: 0.1 }, rotateAtBytes: 0 });

    expect(readCostEvents({ filePath })).toEqual([
      { type: 'old' },
      { type: 'new', cost_usd: 0.1 },
    ]);
  });

  test('appendCostEvent still records the active log when statSync races', async () => {
    const filePath = tempFile();
    writeFileSync(filePath, JSON.stringify({ type: 'old' }) + '\n');
    mock.module('node:fs', () => ({
      ...originalFs,
      statSync(path, ...args) {
        if (path === filePath) throw new Error('simulated exists-to-stat race');
        return originalFs.statSync(path, ...args);
      },
    }));
    try {
      const isolatedCore = await isolatedCoreImport('stat-race');
      isolatedCore.appendCostEvent({ filePath, event: { type: 'new', cost_usd: 0.1 }, rotateAtBytes: 0 });

      expect(readCostEvents({ filePath })).toEqual([
        { type: 'old' },
        { type: 'new', cost_usd: 0.1 },
      ]);
    } finally {
      // mock.module is process-global. Always restore before this test exits,
      // including when the dynamic import or an assertion throws.
      mock.module('node:fs', () => originalFs);
    }

    const restoredCore = await isolatedCoreImport('stat-restored');
    restoredCore.appendCostEvent({ filePath, event: { type: 'after-restore' }, rotateAtBytes: 0 });
    expect(readCostEvents({ filePath })).toEqual([{ type: 'after-restore' }]);
    expect(readCostEvents({ filePath: filePath + '.1' })).toEqual([
      { type: 'old' },
      { type: 'new', cost_usd: 0.1 },
    ]);
  });

  test('computeSpend applies a timestamp cutoff and project subtotals', () => {
    const now = Date.now();
    const result = computeSpend([
      { cost_usd: 0.1, project: 'api', timestamp: now - 1_000 },
      { cost_usd: 0.3, project: 'web', timestamp: now - 100_000 },
      { cost_usd: 'invalid', project: 'api', timestamp: now },
    ], { since: now - 10_000 });
    expect(result).toEqual({ spent: 0.1, projectSpentMap: { api: 0.1 } });
  });

  test('getCacheKey uses canonical object keys and preserves array semantics', () => {
    const first = getCacheKey({ model: 'sonnet', options: { temperature: 0, system: 'a' } });
    const same = getCacheKey({ options: { system: 'a', temperature: 0 }, model: 'sonnet' });
    const changed = getCacheKey({ model: 'sonnet', options: { temperature: 0, system: 'b' } });
    expect(first).toBe(same);
    expect(first).not.toBe(changed);
    expect(getCacheKey({ files: ['a', 'b'] })).not.toBe(getCacheKey({ files: ['b', 'a'] }));
  });

  test('R14 cache input canonicalizes defaults, text, temperature, and file descriptors only', () => {
    const shaA = 'A'.repeat(64);
    const shaB = 'b'.repeat(64);
    const first = buildCacheKeyInput({
      model: 'gpt-5.6',
      model_version: '2026-07',
      temperature: '0.0',
      system_prompt_hash: 'system',
      tool_schema_hash: 'tools',
      prompt: 'cafe\u0301\r\nnext',
      file_hashes: [
        { file_path: './src\\b.mjs', content_sha: shaB },
        { file_path: 'src/a.mjs', content_sha: shaA },
      ],
    });
    const same = buildCacheKeyInput({
      model: 'gpt-5.6',
      model_version: '2026-07',
      temperature: -0,
      system_prompt_hash: 'system',
      tool_schema_hash: 'tools',
      prompt: 'cafe\u0301\r\nnext',
      file_hashes: [
        { file_path: 'src/a.mjs', content_sha: shaA },
        { file_path: 'src/b.mjs', content_sha: shaB },
      ],
    });
    expect(first).toEqual(same);
    expect(first.file_hashes.map((file) => file.file_path)).toEqual(['src/a.mjs', 'src/b.mjs']);
    expect(getCacheKey(first)).toBe(getRequestCacheKey({
      model: 'gpt-5.6', model_version: '2026-07', temperature: 0,
      system_prompt_hash: 'system', tool_schema_hash: 'tools', prompt: 'cafe\u0301\r\nnext',
      file_hashes: same.file_hashes,
    }));
    expect(buildCacheKeyInput({ model: 'gpt-5.6', prompt: 'x' })).toMatchObject({
      model_version: '', temperature: 0, system_prompt_hash: '', tool_schema_hash: '', file_hashes: [],
    });
    expect(getRequestCacheKey({ model: 'gpt-5.6', prompt: 'caf\u00e9\nnext' }))
      .not.toBe(getRequestCacheKey({ model: 'gpt-5.6', prompt: 'cafe\u0301\r\nnext' }));
  });

  test('R14 rejects ambiguous file descriptors and malformed temperatures', () => {
    const sha = 'a'.repeat(64);
    expect(() => buildCacheKeyInput({
      model: 'gpt-5.6', file_hashes: [
        { file_path: 'src/a.mjs', content_sha: sha },
        { file_path: './src/a.mjs', content_sha: sha },
      ],
    })).toThrow(/duplicate file_path/i);
    expect(() => buildCacheKeyInput({
      model: 'gpt-5.6', file_hashes: [{ file_path: '../secret', content_sha: sha }],
    })).toThrow(/must not escape/i);
    expect(() => buildCacheKeyInput({ model: 'gpt-5.6', temperature: 'warm' })).toThrow(/temperature/i);
  });

  test('R15 stores entries atomically under model/hash shards and appends observations', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'xm-cache-'));
    tempDirs.push(cacheDir);
    const model = 'gpt-5.6';
    const hash = getRequestCacheKey({ model, prompt: 'hello' });
    const first = writeCacheEntry({
      cacheDir, model, hash, entry: { response_hash: 'first' }, now: 1_700_000_000_000,
    });
    const second = writeCacheEntry({
      cacheDir, model, hash, entry: { response_hash: 'must-not-overwrite' }, now: 1_700_000_001_000,
    });
    const expectedPath = join(cacheDir, model, hash.slice(0, 2), hash.slice(2, 4), `${hash}.json`);
    expect(first.path).toBe(expectedPath);
    expect(cacheEntryPath({ cacheDir, model, hash })).toBe(expectedPath);
    expect(first.written).toBe(true);
    expect(second.written).toBe(false);
    expect(second.created).toBe(first.created);
    expect(second.last_hit).not.toBe(first.last_hit);
    expect(second.size).toBe(statSync(expectedPath).size);
    expect(readCacheEntry({ cacheDir, model, hash, now: 1_700_000_001_000 })).toMatchObject({
      schema_v: 1, hash, created: first.created, last_hit: second.last_hit,
      entry: { response_hash: 'first' },
    });
    const rows = readFileSync(first.index_path, 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows).toEqual([
      expect.objectContaining({ hash, created: first.created, last_hit: first.last_hit, size: first.size }),
      expect.objectContaining({ hash, created: first.created, last_hit: second.last_hit, size: second.size }),
    ]);
  });

  test('R15 rejects unsafe model path components', () => {
    const hash = 'a'.repeat(64);
    for (const model of ['..', 'a/b', 'a\\b', '/tmp', 'C:\\tmp']) {
      expect(() => buildCacheKeyInput({ model })).toThrow(/safe path segment/i);
      expect(() => cacheEntryPath({ cacheDir: '/tmp/cache', model, hash })).toThrow(/safe path segment/i);
    }
  });

  test('R16 stores content hashes by default and preserves raw content only on explicit opt-in', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'xm-cache-pii-'));
    tempDirs.push(cacheDir);
    const model = 'gpt-5.6';
    const hash = getRequestCacheKey({ model, prompt: 'safe prompt' });
    const rawResponse = 'customer@example.test: private answer';
    const rawFile = 'const privateValue = 1;';

    const first = writeCacheEntry({
      cacheDir, model, hash,
      entry: { response: rawResponse, nested: { file_content: rawFile }, label: 'private label', response_hash: 'known-response' },
      now: 1_700_000_000_000,
    });
    const disk = readFileSync(first.path, 'utf8');
    expect(disk).not.toContain(rawResponse);
    expect(disk).not.toContain(rawFile);
    expect(disk).not.toContain('private label');
    expect(readCacheEntry({ cacheDir, model, hash, now: 1_700_000_000_000 }).entry).toMatchObject({
      response_hash: 'known-response', response_content_hash: expect.any(String), response_bytes: Buffer.byteLength(rawResponse),
      nested: { file_content_hash: expect.any(String), file_content_bytes: Buffer.byteLength(rawFile) },
      label_hash: expect.any(String), label_bytes: Buffer.byteLength('private label'),
    });

    const optInHash = getRequestCacheKey({ model, prompt: 'opt in prompt' });
    const optIn = writeCacheEntry({
      cacheDir, model, hash: optInHash, entry: { response: rawResponse },
      config: { cache: { store_content: true } }, now: 1_700_000_000_000,
    });
    expect(readFileSync(optIn.path, 'utf8')).toContain(rawResponse);
    expect(prepareCacheEntry({ response: rawResponse }, { storeContent: true })).toEqual({ response: rawResponse });
  });

  test('R16 rejects likely secrets in nested cache payloads before creating an entry or index', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'xm-cache-secret-'));
    tempDirs.push(cacheDir);
    const model = 'gpt-5.6';
    const hash = getRequestCacheKey({ model, prompt: 'safe prompt' });
    const secret = 'AKIA1234567890ABCDEF';
    const path = cacheEntryPath({ cacheDir, model, hash });

    let error;
    try {
      writeCacheEntry({ cacheDir, model, hash, entry: { nested: [{ file_content: secret }] } });
    } catch (caught) { error = caught; }
    expect(error?.code).toBe('CACHE_SECRET_DETECTED');
    expect(error?.message).not.toContain(secret);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(cacheDir, model, 'index.jsonl'))).toBe(false);

    for (const [label, payload] of [
      ['adjacent array fragments', { nested: ['AKIA12345678', '90ABCDEF'] }],
      ['whitespace-split key', { response: 'sk-abcde\nfghijklmno' }],
      ['explicit object fragments', { content_part_1: 'AKIA12345678', content_part_2: '90ABCDEF' }],
      ['lowercase PEM header', { file_content: '-----begin private key-----' }],
    ]) {
      const splitHash = getRequestCacheKey({ model, prompt: label });
      let splitError;
      try {
        writeCacheEntry({ cacheDir, model, hash: splitHash, entry: payload });
      } catch (caught) { splitError = caught; }
      expect(splitError?.code).toBe('CACHE_SECRET_DETECTED');
      expect(existsSync(cacheEntryPath({ cacheDir, model, hash: splitHash }))).toBe(false);
    }

    expect(() => writeCacheEntry({
      cacheDir, model, hash, entry: { response_hash: 'safe' }, input: { prompt: 'sk-short' },
    })).not.toThrow(); // short labels are not credentials
    expect(() => writeCacheEntry({
      cacheDir, model, hash: getRequestCacheKey({ model, prompt: 'unrelated fragments' }),
      entry: { fragments: ['AKIA12345678', 'documentation separator', '90ABCDEF'] },
    })).not.toThrow(); // only immediately adjacent structured fragments are joined
    expect(() => writeCacheEntry({
      cacheDir, model, hash: getRequestCacheKey({ model, prompt: 'pem' }), entry: { response: 'safe' },
      request: { files: [{ content: '-----BEGIN PRIVATE KEY-----' }] },
    })).toThrow(/secret-like content detected/);
  });

  test('R15 removes a newly-created entry when index append fails', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'xm-cache-rollback-new-'));
    tempDirs.push(cacheDir);
    const model = 'gpt-5.6';
    const hash = getRequestCacheKey({ model, prompt: 'new failure' });
    const filePath = cacheEntryPath({ cacheDir, model, hash });
    const indexPath = join(cacheDir, model, 'index.jsonl');
    mkdirSync(indexPath, { recursive: true }); // appendFileSync fails with EISDIR

    expect(() => writeCacheEntry({
      cacheDir, model, hash, entry: { response_hash: 'orphan' }, now: 1_700_000_000_000,
    })).toThrow();

    expect(existsSync(filePath)).toBe(false);
    expect(readdirSync(indexPath)).toEqual([]);
    expect(readdirSync(dirname(filePath)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  test('R15 atomically restores an existing entry and index after append failure', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'xm-cache-rollback-existing-'));
    tempDirs.push(cacheDir);
    const model = 'gpt-5.6';
    const hash = getRequestCacheKey({ model, prompt: 'existing failure' });
    const first = writeCacheEntry({
      cacheDir, model, hash, entry: { response_hash: 'keep-me' }, now: 1_700_000_000_000,
    });
    const entryBefore = readFileSync(first.path, 'utf8');
    const indexBefore = readFileSync(first.index_path, 'utf8');

    mock.module('node:fs', () => ({
      ...originalFs,
      appendFileSync(path, data, ...args) {
        if (path === first.index_path) {
          // Simulate the strongest failure: bytes reached disk before the API
          // reported failure. The writer must truncate to the prior boundary.
          originalFs.appendFileSync(path, data, ...args);
          throw new Error('simulated index append failure');
        }
        return originalFs.appendFileSync(path, data, ...args);
      },
    }));
    try {
      const isolatedCore = await isolatedCoreImport('cache-index-failure');
      expect(() => isolatedCore.writeCacheEntry({
        cacheDir, model, hash, entry: { response_hash: 'must-not-overwrite' }, now: 1_700_000_001_000,
      })).toThrow(/simulated index append failure/);
    } finally {
      mock.module('node:fs', () => originalFs);
    }

    expect(readFileSync(first.path, 'utf8')).toBe(entryBefore);
    expect(readFileSync(first.index_path, 'utf8')).toBe(indexBefore);
    expect(readCacheEntry({ cacheDir, model, hash, now: 1_700_000_000_000 })).toMatchObject({
      last_hit: first.last_hit, entry: { response_hash: 'keep-me' },
    });
    expect(readdirSync(dirname(first.path)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  test('R15 reports append and rollback failures without hiding the original cause', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'xm-cache-rollback-error-'));
    tempDirs.push(cacheDir);
    const model = 'gpt-5.6';
    const hash = getRequestCacheKey({ model, prompt: 'rollback failure' });
    const filePath = cacheEntryPath({ cacheDir, model, hash });
    const indexPath = join(cacheDir, model, 'index.jsonl');
    mock.module('node:fs', () => ({
      ...originalFs,
      appendFileSync(path, ...args) {
        if (path === indexPath) throw new Error('original append error');
        return originalFs.appendFileSync(path, ...args);
      },
      unlinkSync(path, ...args) {
        if (path === filePath) throw new Error('simulated rollback error');
        return originalFs.unlinkSync(path, ...args);
      },
    }));
    let failure;
    try {
      const isolatedCore = await isolatedCoreImport('cache-rollback-failure');
      try {
        isolatedCore.writeCacheEntry({
          cacheDir, model, hash, entry: { response_hash: 'left-after-failed-rollback' },
        });
      } catch (error) {
        failure = error;
      }
    } finally {
      mock.module('node:fs', () => originalFs);
    }
    expect(failure).toMatchObject({
      code: 'CACHE_ROLLBACK_FAILED',
      cause: expect.objectContaining({ message: 'original append error' }),
    });
    expect(failure.message).toMatch(/original append error.*rollback failed.*simulated rollback error/i);
  });

  test('R15 concurrent writers leave one complete entry and one index row each', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'xm-cache-concurrent-'));
    tempDirs.push(cacheDir);
    const model = 'gpt-5.6';
    const hash = getRequestCacheKey({ model, prompt: 'concurrent' });
    const moduleUrl = pathToFileURL(join(import.meta.dir, '..', 'x-build', 'lib', 'cost', 'index.mjs')).href;
    const children = Array.from({ length: 4 }, (_, i) => {
      const args = {
        cacheDir, model, hash, entry: { response_hash: `child-${i}` }, now: 1_700_000_000_000 + i,
      };
      const script = `const {writeCacheEntry}=await import(${JSON.stringify(moduleUrl)});writeCacheEntry(${JSON.stringify(args)});`;
      return Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    });
    const exits = await Promise.all(children.map((child) => child.exited));
    expect(exits).toEqual([0, 0, 0, 0]);

    const filePath = cacheEntryPath({ cacheDir, model, hash });
    const stored = JSON.parse(readFileSync(filePath, 'utf8'));
    const rows = readFileSync(join(cacheDir, model, 'index.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.hash === hash && row.created === stored.created)).toBe(true);
    expect(stored.last_hit).toBe(rows.at(-1).last_hit);
    expect(stored.entry.response_hash).toMatch(/^child-[0-3]$/);
  });

  test('R18 lookup uses a seven-day TTL with exact-expiry, config override, future, and legacy boundaries', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'xm-cache-ttl-'));
    tempDirs.push(cacheDir);
    const model = 'gpt-5.6';
    const hash = getRequestCacheKey({ model, prompt: 'ttl' });
    const start = 1_700_000_000_000;
    const ttl = 7 * 24 * 60 * 60 * 1000;
    const saved = writeCacheEntry({ cacheDir, model, hash, entry: { response_hash: 'ttl' }, now: start });
    expect(readCacheEntry({ cacheDir, model, hash, now: start + ttl - 1 })).not.toBeNull();
    expect(readCacheEntry({ cacheDir, model, hash, now: start + ttl })).toBeNull();
    expect(readCacheEntry({ cacheDir, model, hash, now: start + 24 * 60 * 60 * 1000, config: { cache: { ttl_days: 1 } } })).toBeNull();
    expect(resolveCacheTtlMs({ ttlDays: 2 })).toBe(2 * 24 * 60 * 60 * 1000);
    expect(cacheExpiry({ last_hit: new Date(start + ttl).toISOString() }, { now: start })).toMatchObject({ expired: false, reason: 'future_timestamp' });
    writeFileSync(saved.path, JSON.stringify({ schema_v: 1, hash, entry: {} }) + '\n');
    expect(readCacheEntry({ cacheDir, model, hash, now: start })).toBeNull();
    expect(cacheExpiry({ hash }, { now: start })).toMatchObject({ expired: true, prune: false, reason: 'invalid_timestamp' });
    expect(() => resolveCacheTtlMs({ ttlDays: 0 })).toThrow(/positive finite/i);
  });

  test('R18 gc deduplicates indexes, deletes only provably expired records, and keeps legacy rows', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'xm-cache-gc-'));
    tempDirs.push(cacheDir);
    const model = 'gpt-5.6';
    const now = 1_700_700_000_000;
    const oldHash = getRequestCacheKey({ model, prompt: 'old' });
    const freshHash = getRequestCacheKey({ model, prompt: 'fresh' });
    const legacyHash = getRequestCacheKey({ model, prompt: 'legacy' });
    const old = writeCacheEntry({ cacheDir, model, hash: oldHash, entry: { response_hash: 'old' }, now: now - 8 * 24 * 60 * 60 * 1000 });
    const fresh = writeCacheEntry({ cacheDir, model, hash: freshHash, entry: { response_hash: 'fresh' }, now: now - 1 });
    const legacyPath = cacheEntryPath({ cacheDir, model, hash: legacyHash });
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify({ schema_v: 1, hash: legacyHash, entry: {} }) + '\n');
    writeFileSync(old.index_path, [
      readFileSync(old.index_path, 'utf8').trim(),
      JSON.stringify({ hash: freshHash, created: fresh.created, last_hit: fresh.last_hit, size: fresh.size }),
      JSON.stringify({ hash: legacyHash, size: statSync(legacyPath).size }),
      '{torn', '',
    ].join('\n'));
    const preview = gcCache({ cacheDir, model, now, dryRun: true });
    expect(preview).toMatchObject({ pruned: 1, retained_unverifiable: 1, dry_run: true });
    expect(readFileSync(old.path, 'utf8')).toContain(oldHash);
    const result = gcCache({ cacheDir, model, now });
    expect(result).toMatchObject({ pruned: 1, retained_unverifiable: 1, index_rows_after: 2, dry_run: false });
    expect(existsSync(old.path)).toBe(false);
    const rows = readFileSync(old.index_path, 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows.map((row) => row.hash).sort()).toEqual([freshHash, legacyHash].sort());
  });

  test('R18 exposes GC through xm cost cache gc with dry-run semantics', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'xm-cache-gc-cli-'));
    tempDirs.push(cacheDir);
    const model = 'gpt-5.6';
    const hash = getRequestCacheKey({ model, prompt: 'cli-old' });
    const entry = writeCacheEntry({
      cacheDir, model, hash, entry: { response_hash: 'old' }, now: Date.now() - 8 * 24 * 60 * 60 * 1000,
    });
    const cli = join(import.meta.dir, '..', 'x-build', 'lib', 'x-build-cli.mjs');
    const run = (extra = []) => Bun.spawnSync([process.execPath, cli, 'cost', 'cache', 'gc', '--cache-dir', cacheDir, '--ttl-days', '7', '--json', ...extra]);
    const dry = run(['--dry-run']);
    expect(dry.exitCode).toBe(0);
    expect(JSON.parse(dry.stdout.toString())).toMatchObject({ dry_run: true, pruned: 1 });
    expect(existsSync(entry.path)).toBe(true);
    const actual = run();
    expect(actual.exitCode).toBe(0);
    expect(JSON.parse(actual.stdout.toString())).toMatchObject({ dry_run: false, pruned: 1 });
    expect(existsSync(entry.path)).toBe(false);
  });

  test('R18 GC ignores symlinked model trees and remains index-consistent with a writer', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'xm-cache-gc-safe-'));
    const outside = mkdtempSync(join(tmpdir(), 'xm-cache-outside-'));
    tempDirs.push(cacheDir, outside);
    const model = 'gpt-5.6';
    symlinkSync(outside, join(cacheDir, model));
    expect(gcCache({ cacheDir, now: Date.now() })).toMatchObject({ models: 0, pruned: 0 });

    rmSync(join(cacheDir, model));
    const hash = getRequestCacheKey({ model, prompt: 'race' });
    const old = writeCacheEntry({ cacheDir, model, hash, entry: { response_hash: 'old' }, now: 1_700_000_000_000 });
    const moduleUrl = pathToFileURL(join(import.meta.dir, '..', 'x-build', 'lib', 'cost', 'index.mjs')).href;
    const fresh = { cacheDir, model, hash, entry: { response_hash: 'fresh' }, now: 1_700_700_000_000 };
    const child = Bun.spawn([process.execPath, '-e', `const {writeCacheEntry}=await import(${JSON.stringify(moduleUrl)});writeCacheEntry(${JSON.stringify(fresh)});`], { stdout: 'pipe', stderr: 'pipe' });
    gcCache({ cacheDir, model, now: fresh.now });
    expect(await child.exited).toBe(0);
    const rows = readFileSync(old.index_path, 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows.every((row) => row.hash === hash)).toBe(true);
    expect(readCacheEntry({ cacheDir, model, hash, now: fresh.now })).not.toBeNull();
  });

  test('R19 records only explicit, positive cache-hit savings without raw content', () => {
    const filePath = tempFile();
    const hash = 'a'.repeat(64);
    expect(recordCacheHit({ filePath, savedUsd: undefined, model: 'gpt-5.6', hash })).toBeNull();
    expect(recordCacheHit({ filePath, savedUsd: 0, model: 'gpt-5.6', hash })).toBeNull();
    const event = recordCacheHit({ filePath, savedUsd: 0.0123, model: 'gpt-5.6', hash, timestamp: '2026-01-01T00:00:00.000Z' });
    expect(event).toEqual(expect.objectContaining({ type: 'cache_hit', saved_usd: 0.0123, cache_hash: hash }));
    expect(readCostEvents({ filePath })).toEqual([event]);
  });

  test('checkHardCap distinguishes normal, warning, and exceeded states', () => {
    expect(checkHardCap({ spent: 0.8, cap: 1 })).toMatchObject({ ok: true, level: 'normal' });
    expect(checkHardCap({ spent: 0.8, additionalCost: 0.01, cap: 1 })).toMatchObject({ ok: true, level: 'warning' });
    expect(checkHardCap({ spent: 0.9, additionalCost: 0.11, cap: 1 })).toMatchObject({ ok: false, level: 'exceeded' });
  });
});
