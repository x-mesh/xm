import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanAll } from '../xm/lib/install/scan.mjs';
import { renderCodexWithDiagnostics } from '../xm/lib/install/transform/codex.mjs';

const ROOT = join(import.meta.dirname, '..');
const XM = join(ROOT, 'xm', 'scripts', 'xm');

describe('xm plan dispatch and packaging', () => {
  test('xm plan routes to the JSON-only CLI', () => {
    const r = spawnSync('bash', [XM, 'plan', '- Add export'], { cwd: ROOT, env: { ...process.env, XM_LIB: ROOT }, encoding: 'utf8' });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.schema_version).toBe(1);
    expect(out.provenance.generator).toBe('x-plan-deterministic');
  });
  test('marketplace and manifest agree', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'x-plan', '.claude-plugin', 'plugin.json'), 'utf8'));
    const marketplace = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
    const entry = marketplace.plugins.find((plugin) => plugin.name === 'plan');
    expect(entry.source).toBe('./x-plan');
    expect(entry.version).toBe(manifest.version);
  });
  test('build and panel plan routes remain present', () => {
    const dispatcher = readFileSync(XM, 'utf8');
    const panel = readFileSync(join(ROOT, 'x-panel', 'skills', 'panel', 'SKILL.md'), 'utf8');
    expect(dispatcher).toContain('build)');
    expect(panel).toContain('`plan <goal>` | `xm:op`');
  });
  test('release mapping recognizes x-plan as plan', () => {
    const release = readFileSync(join(ROOT, 'x-build', 'lib', 'x-build', 'release.mjs'), 'utf8');
    expect(release).toContain(`'x-plan'`);
    expect(release).toContain(`'x-plan': 'plan'`);
  });
  test('Codex renderer exposes the $xm-plan standalone alias', () => {
    const skills = scanAll({ skillsDir: join(ROOT, 'xm', 'skills'), libDir: join(ROOT, 'xm', 'lib') });
    const rendered = renderCodexWithDiagnostics(skills, { scope: 'local', installRoot: ROOT, pluginVersion: '0.0.0' });
    const alias = rendered.outputs.find((item) => item.relativePath.endsWith('.agents/skills/xm-plan/SKILL.md'));
    expect(alias).toBeTruthy();
    expect(alias.content).toMatch(/^---\nname: xm-plan\n/);
  });
});
