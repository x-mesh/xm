/**
 * skill-frontmatter-sync.mjs unit + integration tests
 * Covers: inherit semantics ("absence = inherit") — frontmatter model: line
 * removal, drift inversion (field present = drift), body-marker token
 * removal/re-insertion, and full roundtrip idempotency via the CLI against a
 * fixture repo tree. First coverage for this script (was 0 tests).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  splitFrontmatter, parseSimple, rewriteFrontmatter, removeModelLine,
  rewriteBodyModels, removeBodyModelToken,
} from '../xm/lib/skill-frontmatter-sync.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'xm', 'lib', 'skill-frontmatter-sync.mjs');

// ── removeModelLine ─────────────────────────────────────────────────────

describe('removeModelLine — inherit removes the model: line', () => {
  test('removes model: and keeps every other line', () => {
    const front = 'name: build\ndescription: harness\nmodel: opus\nallowed-tools:\n  - AskUserQuestion';
    const out = removeModelLine(front);
    expect(out).toBe('name: build\ndescription: harness\nallowed-tools:\n  - AskUserQuestion');
  });

  test('no model: line → unchanged (idempotent)', () => {
    const front = 'name: build\ndescription: harness';
    expect(removeModelLine(front)).toBe(front);
  });
});

// ── parseSimple / drift inversion inputs ────────────────────────────────

describe('parseSimple — model absence reads as null', () => {
  test('absent model: → null (the inherit target state)', () => {
    expect(parseSimple('name: x\ndescription: y').model).toBe(null);
  });

  test('present model: → value (drift when target is inherit)', () => {
    expect(parseSimple('name: x\nmodel: opus').model).toBe('opus');
  });
});

// ── rewriteFrontmatter (concrete target restores the field) ─────────────

describe('rewriteFrontmatter — concrete tier re-inserts after description', () => {
  test('inserts model: after description when absent', () => {
    const out = rewriteFrontmatter('name: x\ndescription: y', 'sonnet');
    expect(out).toBe('name: x\ndescription: y\nmodel: sonnet');
  });

  test('replaces an existing model: line', () => {
    const out = rewriteFrontmatter('name: x\nmodel: opus', 'haiku');
    expect(out).toBe('name: x\nmodel: haiku');
  });
});

// ── body marker token removal ───────────────────────────────────────────

describe('removeBodyModelToken — keeps the example valid JS', () => {
  test('leading position: token + trailing comma', () => {
    const line = 'Agent tool: { model: "opus", prompt: "..." } <!-- managed-model: architect -->';
    expect(removeBodyModelToken(line))
      .toBe('Agent tool: { prompt: "..." } <!-- managed-model: architect -->');
  });

  test('trailing position: leading comma + token', () => {
    const line = 'Agent tool: { prompt: "...", model: "sonnet" } <!-- managed-model: critic -->';
    expect(removeBodyModelToken(line))
      .toBe('Agent tool: { prompt: "..." } <!-- managed-model: critic -->');
  });

  test('middle position: token + trailing comma between params', () => {
    const line = '{ description: "d", model: "opus", prompt: "p" }';
    expect(removeBodyModelToken(line)).toBe('{ description: "d", prompt: "p" }');
  });
});

// ── rewriteBodyModels (profile-driven; default routes architect→inherit) ─

describe('rewriteBodyModels — inherit removes, concrete restores', () => {
  test('default profile: judgment marker token is removed', () => {
    const body = '\nAgent tool: { model: "opus", prompt: "..." } <!-- managed-model: architect -->\n';
    const { newBody, changes } = rewriteBodyModels(body, 'default');
    expect(newBody).toContain('{ prompt: "..." }');
    expect(newBody).not.toMatch(/model:\s*"/);
    expect(changes.length).toBe(1);
    expect(changes[0].to).toContain('omit');
  });

  test('default profile: already-omitted judgment marker is a no-op (idempotent)', () => {
    const body = '\nAgent tool: { prompt: "..." } <!-- managed-model: architect -->\n';
    const { newBody, changes } = rewriteBodyModels(body, 'default');
    expect(newBody).toBe(body);
    expect(changes.length).toBe(0);
  });

  test('economy profile: omitted token is re-inserted after { (roundtrip restore)', () => {
    const body = '\nAgent tool: { prompt: "..." } <!-- managed-model: architect -->\n';
    const { newBody, changes } = rewriteBodyModels(body, 'economy');
    expect(newBody).toContain('{ model: "sonnet", prompt: "..." }');
    expect(changes[0].from).toBe('(omitted)');
    expect(changes[0].to).toBe('sonnet');
  });

  test('concrete → concrete replacement still works (explorer stays mechanical)', () => {
    const body = 'x: { model: "haiku", prompt: "p" } <!-- managed-model: explorer -->';
    const { newBody } = rewriteBodyModels(body, 'default'); // default explorer = sonnet
    expect(newBody).toContain('model: "sonnet"');
  });

  test('full roundtrip is lossless: concrete → inherit → concrete', () => {
    const original = 'Agent tool: { model: "sonnet", prompt: "..." } <!-- managed-model: architect -->';
    const removed = rewriteBodyModels(original, 'default').newBody;   // architect → inherit
    const restored = rewriteBodyModels(removed, 'economy').newBody;   // architect → sonnet
    expect(restored).toBe(original);
  });

  test('marker-less lines are never touched', () => {
    const body = 'Agent tool: { model: "opus", prompt: "manual example" }';
    expect(rewriteBodyModels(body, 'default').newBody).toBe(body);
  });
});

// ── CLI integration against a fixture repo tree ─────────────────────────

describe('CLI integration — apply/check against a fixture repo', () => {
  let fixtureRoot;
  const skillPath = () => join(fixtureRoot, 'x-foo', 'skills', 'foo', 'SKILL.md');

  const FIXTURE_SKILL = `---
name: foo
description: fixture skill
model: opus
---

# foo

Agent tool: { model: "opus", prompt: "..." } <!-- managed-model: architect -->
`;

  const runSync = (...flags) => spawnSync(
    process.execPath, [SCRIPT, '--repo-root', fixtureRoot, ...flags],
    { encoding: 'utf8' },
  );

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'fm-sync-test-'));
    mkdirSync(join(fixtureRoot, 'xm', 'lib'), { recursive: true });
    mkdirSync(dirname(skillPath()), { recursive: true });
    writeFileSync(join(fixtureRoot, 'xm', 'lib', 'skill-model-map.json'), JSON.stringify({
      version: 2,
      skills: { foo: { economy: 'sonnet', default: 'inherit', max: 'inherit' } },
    }));
    writeFileSync(skillPath(), FIXTURE_SKILL);
  });

  afterAll(() => { rmSync(fixtureRoot, { recursive: true, force: true }); });

  test('--check reports drift while the field is still present', () => {
    const r = runSync('--check', '--profile', 'default');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('DRIFT');
  });

  test('apply removes the frontmatter field AND the body token', () => {
    const r = runSync('--profile', 'default');
    expect(r.status).toBe(0);
    const text = readFileSync(skillPath(), 'utf8');
    const { front, rest } = splitFrontmatter(text);
    expect(parseSimple(front).model).toBe(null);
    expect(rest).toContain('{ prompt: "..." }');
    expect(rest).not.toContain('model: "opus"');
  });

  test('second apply is idempotent; --check exits 0', () => {
    const before = readFileSync(skillPath(), 'utf8');
    runSync('--profile', 'default');
    expect(readFileSync(skillPath(), 'utf8')).toBe(before);
    expect(runSync('--check', '--profile', 'default').status).toBe(0);
  });

  test('economy roundtrip restores field and token', () => {
    const r = runSync('--profile', 'economy');
    expect(r.status).toBe(0);
    const text = readFileSync(skillPath(), 'utf8');
    const { front, rest } = splitFrontmatter(text);
    expect(parseSimple(front).model).toBe('sonnet');
    expect(rest).toContain('model: "sonnet", prompt: "..."');
  });

  test('managed: false opts out of inherit removal too', () => {
    writeFileSync(skillPath(), FIXTURE_SKILL.replace('---\n\n# foo', 'managed: false\n---\n\n# foo'));
    const r = runSync('--profile', 'default');
    expect(r.stdout).toContain('skip');
    const { front } = splitFrontmatter(readFileSync(skillPath(), 'utf8'));
    expect(parseSimple(front).model).toBe('opus');
  });
});
