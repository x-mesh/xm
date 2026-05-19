import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '..', 'x-build', 'lib', 'x-config-cli.mjs');

function run(args, root) {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    env: { ...process.env, XM_ROOT: root },
    encoding: 'utf8',
    timeout: 10000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

function withRoot(fn) {
  const tmp = mkdtempSync(join(tmpdir(), 'xm-config-'));
  try {
    return fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('xm config CLI', () => {
  test('set then get round-trips a scalar (with type coercion)', () => {
    withRoot((root) => {
      const w = run(['set', 'agent_max_count', '8'], root);
      expect(w.exitCode).toBe(0);
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.agent_max_count).toBe(8); // coerced to number, not "8"

      const r = run(['get', 'agent_max_count'], root);
      expect(r.stdout.trim()).toBe('8');
    });
  });

  test('set writes nested dotted keys', () => {
    withRoot((root) => {
      run(['set', 'budget.max_usd', '5'], root);
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.budget.max_usd).toBe(5);
    });
  });

  test('reset clears config to empty object', () => {
    withRoot((root) => {
      run(['set', 'mode', 'normal'], root);
      const w = run(['reset'], root);
      expect(w.exitCode).toBe(0);
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written).toEqual({});
    });
  });

  test('show renders effective config', () => {
    withRoot((root) => {
      const r = run(['show'], root);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('Effective');
    });
  });

  test('unknown subcommand prints usage', () => {
    withRoot((root) => {
      const r = run(['bogus'], root);
      expect(r.stdout + r.stderr).toContain('Usage');
    });
  });

  test('prototype-pollution keys are rejected', () => {
    withRoot((root) => {
      run(['set', '__proto__.polluted', 'yes'], root);
      expect({}.polluted).toBeUndefined();
    });
  });
});
