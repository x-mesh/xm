import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  HANDOFF_MARKDOWN_PATH,
  HANDOFF_STATE_PATH,
  isExcludedHandoffPath,
  reconcileHandoff,
  selectNewestRemoteHandoff,
} from '../xm/lib/x-sync/sync-handoff.mjs';

const state = (savedAt, focus, generation) => JSON.stringify({
  v: 1,
  saved_at: savedAt,
  ...(generation ? { handoff_generation: generation } : {}),
  context: { current_focus: focus },
});

const remote = (machine, savedAt, focus, pushedAt = 1, generation) => ({
  path: HANDOFF_STATE_PATH,
  machine_id: machine,
  content: state(savedAt, focus, generation),
  pushed_at: pushedAt,
  deleted: 0,
});

describe('x-sync cross-machine handoff reconciliation', () => {
  let xmDir;

  beforeEach(() => {
    xmDir = join(tmpdir(), `xm-sync-handoff-${process.pid}-${Date.now()}`);
    mkdirSync(xmDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(xmDir, { recursive: true, force: true });
  });

  test('promotes a remote handoff to the canonical path on a new machine', () => {
    const result = reconcileHandoff(xmDir, [
      remote('linux-a', '2026-08-08T01:00:00.000Z', 'portable'),
      {
        path: HANDOFF_MARKDOWN_PATH,
        machine_id: 'linux-a',
        content: '# portable handoff',
        pushed_at: 1,
        deleted: 0,
      },
    ]);

    expect(result.status).toBe('updated');
    expect(result.machine_id).toBe('linux-a');
    expect(JSON.parse(readFileSync(join(xmDir, HANDOFF_STATE_PATH), 'utf8')).context.current_focus).toBe('portable');
    expect(readFileSync(join(xmDir, HANDOFF_MARKDOWN_PATH), 'utf8')).toContain('canonical, atomic session state');
  });

  test('selects the newest saved_at across heterogeneous machines', () => {
    const result = reconcileHandoff(xmDir, [
      remote('mac-a', '2026-08-08T01:00:00.000Z', 'old', 20),
      remote('linux-b', '2026-08-08T02:00:00.000Z', 'new', 10),
    ]);

    expect(result.status).toBe('updated');
    expect(result.machine_id).toBe('linux-b');
    expect(JSON.parse(readFileSync(join(xmDir, HANDOFF_STATE_PATH), 'utf8')).context.current_focus).toBe('new');
  });

  test('does not overwrite a newer local handoff', () => {
    const localPath = join(xmDir, HANDOFF_STATE_PATH);
    mkdirSync(join(xmDir, 'build'), { recursive: true });
    writeFileSync(localPath, state('2026-08-08T03:00:00.000Z', 'local-newer'));

    const result = reconcileHandoff(xmDir, [
      remote('windows-a', '2026-08-08T02:00:00.000Z', 'remote-older'),
    ]);

    expect(result.status).toBe('kept-local');
    expect(JSON.parse(readFileSync(localPath, 'utf8')).context.current_focus).toBe('local-newer');
    expect(readFileSync(join(xmDir, HANDOFF_MARKDOWN_PATH), 'utf8')).toContain('canonical, atomic session state');
  });

  test('uses handoff generation before wall-clock time after machines have synchronized', () => {
    const result = reconcileHandoff(xmDir, [
      remote('clock-ahead', '2026-08-08T10:00:00.000Z', 'generation-4', 20, 4),
      remote('clock-behind', '2026-08-08T01:00:00.000Z', 'generation-5', 10, 5),
    ]);

    expect(result.status).toBe('updated');
    expect(result.machine_id).toBe('clock-behind');
    expect(JSON.parse(readFileSync(join(xmDir, HANDOFF_STATE_PATH), 'utf8')).context.current_focus).toBe('generation-5');
  });

  test('falls back across the complete candidate set when local state is legacy', () => {
    const localPath = join(xmDir, HANDOFF_STATE_PATH);
    mkdirSync(join(xmDir, 'build'), { recursive: true });
    writeFileSync(localPath, state('2026-08-08T02:00:00.000Z', 'legacy-local'));

    const result = reconcileHandoff(xmDir, [
      remote('generation-5', '2026-08-08T01:00:00.000Z', 'logical-newest', 20, 5),
      remote('generation-4', '2026-08-08T10:00:00.000Z', 'timestamp-newest', 10, 4),
    ]);

    expect(result.status).toBe('updated');
    expect(result.machine_id).toBe('generation-4');
    expect(JSON.parse(readFileSync(localPath, 'utf8')).context.current_focus).toBe('timestamp-newest');
  });

  test('ignores remote tombstones instead of deleting a restorable local state', () => {
    const localPath = join(xmDir, HANDOFF_STATE_PATH);
    mkdirSync(join(xmDir, 'build'), { recursive: true });
    writeFileSync(localPath, state('2026-08-08T03:00:00.000Z', 'keep-me'));

    const result = reconcileHandoff(xmDir, [{
      path: HANDOFF_STATE_PATH,
      machine_id: 'linux-a',
      content: '',
      pushed_at: 4,
      deleted: 1,
    }]);

    expect(result.status).toBe('none');
    expect(existsSync(localPath)).toBe(true);
  });

  test('ignores malformed remote handoffs', () => {
    const selected = selectNewestRemoteHandoff([{
      path: HANDOFF_STATE_PATH,
      machine_id: 'linux-a',
      content: '{bad json',
      pushed_at: 1,
      deleted: 0,
    }]);

    expect(selected.candidate).toBeNull();
    expect(selected.invalid).toHaveLength(1);
  });

  test('replaces stale local HANDOFF.md with a canonical JSON pointer', () => {
    const buildDir = join(xmDir, 'build');
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(join(buildDir, 'SESSION-STATE.json'), state(
      '2026-08-08T01:00:00.000Z',
      'old-local',
      1,
    ));
    writeFileSync(join(buildDir, 'HANDOFF.md'), '# stale local handoff');

    const result = reconcileHandoff(xmDir, [
      remote('legacy-linux', '2026-08-08T02:00:00.000Z', 'new-remote', 2, 2),
    ]);

    expect(result.status).toBe('updated');
    expect(result.markdown).toBe(true);
    expect(readFileSync(join(buildDir, 'HANDOFF.md'), 'utf8')).toContain('SESSION-STATE.json');
    expect(JSON.parse(readFileSync(join(buildDir, 'SESSION-STATE.json'), 'utf8')).context.current_focus)
      .toBe('new-remote');
  });

  test('excludes mem-mesh bookkeeping and legacy namespaced handoffs', () => {
    expect(isExcludedHandoffPath('build/memmesh-mirror.json')).toBe(true);
    expect(isExcludedHandoffPath('build/SESSION-STATE.mac-a.json')).toBe(true);
    expect(isExcludedHandoffPath('build/HANDOFF.linux-b.md')).toBe(true);
    expect(isExcludedHandoffPath(HANDOFF_STATE_PATH)).toBe(false);
  });
});
