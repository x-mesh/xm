/**
 * sync-pull.test.mjs — Tests for multi-user merge logic in sync-pull
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Import the namespacePath logic inline (it's not exported, so we test via behavior)
// We'll simulate what sync-pull does by replicating the core logic

function namespacePath(filePath, machineId) {
  const ext = filePath.lastIndexOf('.') !== -1
    ? filePath.slice(filePath.lastIndexOf('.'))
    : '';
  if (ext) {
    return filePath.slice(0, -ext.length) + '.' + machineId + ext;
  }
  return filePath + '.' + machineId;
}

const SYNC_EXCLUDE = new Set(['config.json']);

function simulatePull(xmDir, files, ownMachineId) {
  const byPath = new Map();
  for (const f of files) {
    if (f.machine_id === ownMachineId) continue;
    const base = f.path.split('/').pop();
    if (SYNC_EXCLUDE.has(f.path) || SYNC_EXCLUDE.has(base)) continue;
    if (!byPath.has(f.path)) byPath.set(f.path, []);
    byPath.get(f.path).push(f);
  }

  let written = 0;
  let namespaced = 0;

  for (const [path, versions] of byPath) {
    const localExists = existsSync(join(xmDir, path));
    const needsNamespace = versions.length > 1 || localExists;

    if (!needsNamespace) {
      const f = versions[0];
      const targetPath = join(xmDir, f.path);
      mkdirSync(join(xmDir, ...f.path.split('/').slice(0, -1)), { recursive: true });
      writeFileSync(targetPath, f.content, 'utf8');
      written++;
    } else {
      for (const f of versions) {
        const nsPath = namespacePath(f.path, f.machine_id);
        const targetPath = join(xmDir, nsPath);
        mkdirSync(join(xmDir, ...nsPath.split('/').slice(0, -1)), { recursive: true });
        writeFileSync(targetPath, f.content, 'utf8');
        written++;
        namespaced++;
      }
    }
  }
  return { written, namespaced };
}

describe('sync-pull namespace logic', () => {
  let tmp;

  beforeEach(() => {
    tmp = join(tmpdir(), `sync-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('writes directly when single remote, no local file', () => {
    const files = [
      { path: 'traces/trace-001.jsonl', machine_id: 'mac-B', content: '{"line":1}' },
    ];
    const result = simulatePull(tmp, files, 'mac-A');
    expect(result.written).toBe(1);
    expect(result.namespaced).toBe(0);
    expect(existsSync(join(tmp, 'traces/trace-001.jsonl'))).toBe(true);
  });

  it('namespaces when local file exists at same path', () => {
    // Create local file first
    mkdirSync(join(tmp, 'build/projects/app'), { recursive: true });
    writeFileSync(join(tmp, 'build/projects/app/manifest.json'), '{"local":true}');

    const files = [
      { path: 'build/projects/app/manifest.json', machine_id: 'mac-B', content: '{"remote":true}' },
    ];
    const result = simulatePull(tmp, files, 'mac-A');
    expect(result.namespaced).toBe(1);
    // Local file preserved
    expect(JSON.parse(readFileSync(join(tmp, 'build/projects/app/manifest.json'), 'utf8'))).toEqual({ local: true });
    // Remote namespaced
    expect(existsSync(join(tmp, 'build/projects/app/manifest.mac-B.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(tmp, 'build/projects/app/manifest.mac-B.json'), 'utf8'))).toEqual({ remote: true });
  });

  it('namespaces when multiple remotes share same path', () => {
    const files = [
      { path: 'build/projects/app/manifest.json', machine_id: 'mac-B', content: '{"from":"B"}' },
      { path: 'build/projects/app/manifest.json', machine_id: 'mac-C', content: '{"from":"C"}' },
    ];
    const result = simulatePull(tmp, files, 'mac-A');
    expect(result.namespaced).toBe(2);
    expect(existsSync(join(tmp, 'build/projects/app/manifest.mac-B.json'))).toBe(true);
    expect(existsSync(join(tmp, 'build/projects/app/manifest.mac-C.json'))).toBe(true);
  });

  it('skips own machine files', () => {
    const files = [
      { path: 'traces/trace-001.jsonl', machine_id: 'mac-A', content: '{"own":true}' },
      { path: 'traces/trace-002.jsonl', machine_id: 'mac-B', content: '{"other":true}' },
    ];
    const result = simulatePull(tmp, files, 'mac-A');
    expect(result.written).toBe(1);
    expect(existsSync(join(tmp, 'traces/trace-001.jsonl'))).toBe(false);
    expect(existsSync(join(tmp, 'traces/trace-002.jsonl'))).toBe(true);
  });

  it('excludes config.json from sync', () => {
    const files = [
      { path: 'config.json', machine_id: 'mac-B', content: '{"model":"opus"}' },
      { path: 'traces/trace-001.jsonl', machine_id: 'mac-B', content: '{"line":1}' },
    ];
    const result = simulatePull(tmp, files, 'mac-A');
    expect(result.written).toBe(1);
    expect(existsSync(join(tmp, 'config.json'))).toBe(false);
    expect(existsSync(join(tmp, 'traces/trace-001.jsonl'))).toBe(true);
  });

  it('handles mixed unique + shared paths correctly', () => {
    // Local manifest exists
    mkdirSync(join(tmp, 'build/projects/app'), { recursive: true });
    writeFileSync(join(tmp, 'build/projects/app/manifest.json'), '{"local":true}');

    const files = [
      // Unique paths — direct write
      { path: 'traces/trace-aaa.jsonl', machine_id: 'mac-B', content: 'line1' },
      { path: 'op/refine-2026.json', machine_id: 'mac-C', content: '{"op":1}' },
      // Shared path — namespace
      { path: 'build/projects/app/manifest.json', machine_id: 'mac-B', content: '{"tasks":[1]}' },
      { path: 'build/projects/app/manifest.json', machine_id: 'mac-C', content: '{"tasks":[2]}' },
    ];
    const result = simulatePull(tmp, files, 'mac-A');
    expect(result.written).toBe(4);
    expect(result.namespaced).toBe(2);

    // Unique files written directly
    expect(existsSync(join(tmp, 'traces/trace-aaa.jsonl'))).toBe(true);
    expect(existsSync(join(tmp, 'op/refine-2026.json'))).toBe(true);

    // Shared files namespaced
    expect(JSON.parse(readFileSync(join(tmp, 'build/projects/app/manifest.json'), 'utf8'))).toEqual({ local: true });
    expect(existsSync(join(tmp, 'build/projects/app/manifest.mac-B.json'))).toBe(true);
    expect(existsSync(join(tmp, 'build/projects/app/manifest.mac-C.json'))).toBe(true);
  });
});

describe('namespacePath', () => {
  it('inserts machine_id before extension', () => {
    expect(namespacePath('build/manifest.json', 'mac-A')).toBe('build/manifest.mac-A.json');
  });

  it('handles .jsonl extension', () => {
    expect(namespacePath('traces/log.jsonl', 'mac-B')).toBe('traces/log.mac-B.jsonl');
  });

  it('appends machine_id when no extension', () => {
    expect(namespacePath('data/noext', 'mac-C')).toBe('data/noext.mac-C');
  });

  it('handles nested paths', () => {
    expect(namespacePath('build/projects/app/manifest.json', 'my-mac')).toBe('build/projects/app/manifest.my-mac.json');
  });
});

describe('readManifestMerged', () => {
  let tmp;

  beforeEach(() => {
    tmp = join(tmpdir(), `merge-test-${Date.now()}`);
    mkdirSync(join(tmp, 'projects', 'app'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('merges tasks array by id across manifests', () => {
    // Simulate local + 2 remotes
    const dir = join(tmp, 'projects', 'app');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      name: 'app',
      tasks: [
        { id: 't1', status: 'done' },
        { id: 't2', status: 'done' },
      ]
    }));
    writeFileSync(join(dir, 'manifest.mac-B.json'), JSON.stringify({
      name: 'app',
      tasks: [
        { id: 't3', status: 'done' },
        { id: 't4', status: 'done' },
      ]
    }));

    // Read all manifests and merge (simulating readManifestMerged logic)
    const files = readdirSync(dir).filter(f => /^manifest(\..+)?\.json$/.test(f)).sort();
    const manifests = files.map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')));

    // Deep merge with array union by id
    const result = {};
    for (const m of manifests) {
      for (const [key, value] of Object.entries(m)) {
        if (Array.isArray(value) && value.length > 0 && value[0]?.id != null) {
          const existing = result[key] ?? [];
          const byId = new Map(existing.map(item => [item.id, item]));
          for (const item of value) byId.set(item.id, item);
          result[key] = [...byId.values()];
        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
          result[key] = { ...(result[key] ?? {}), ...value };
        } else {
          result[key] = value;
        }
      }
    }

    expect(result.tasks).toHaveLength(4);
    expect(result.tasks.map(t => t.id)).toEqual(['t1', 't2', 't3', 't4']);
    expect(result.tasks.every(t => t.status === 'done')).toBe(true);
  });
});
