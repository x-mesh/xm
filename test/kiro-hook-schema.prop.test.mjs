import { describe, test, expect } from 'bun:test';
import fc from 'fast-check';
import { buildKiroHook, renderKiroShared } from '../xm/lib/install/transform/kiro-shared.mjs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Feature: kiro-xm-compatibility, Property 1: 훅 JSON 스키마 정합성
// **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 3.1, 3.2, 3.3**

const TOOL_EVENT_NAMES = ['PreToolUse', 'PostToolUse'];
const FILE_EVENT_NAMES = ['FileCreate', 'FileSave', 'FileDelete'];
const OTHER_EVENT_NAMES = ['Stop', 'UserPromptSubmit'];
const SUPPORTED_EVENTS = [...TOOL_EVENT_NAMES, ...FILE_EVENT_NAMES, ...OTHER_EVENT_NAMES];
const TOOL_TOKENS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Read', 'WebFetch', 'Skill', '*'];
const TOOL_EVENTS = new Set(['preToolUse', 'postToolUse']);
const FILE_EVENTS = new Set(['fileEdited', 'fileCreated', 'fileDeleted']);

// Tool-event matchers must be tool-name tokens (or wildcard).
const arbToolMatcher = fc.array(fc.constantFrom(...TOOL_TOKENS), { minLength: 1, maxLength: 4 })
  .map(tokens => tokens.join('|'));
// File-event matchers must be glob-shaped patterns (extension globs, path globs).
const arbGlobMatcher = fc.array(
  fc.constantFrom('*.ts', '*.tsx', '*.js', '*.json', 'src/**/*.js', 'docs/**', '*.md', '*'),
  { minLength: 1, maxLength: 4 },
).map(patterns => patterns.join('|'));
const safeCharArb = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_./'.split(''));
const arbCommand = fc.array(safeCharArb, { minLength: 1, maxLength: 50 })
  .map(chars => `node ${chars.join('')}`);

describe('Property 1: 훅 JSON 스키마 정합성 — tool events', () => {
  test('tool event + tool matcher → schema-conformant toolTypes', () => {
    const arbToolEvent = fc.constantFrom(...TOOL_EVENT_NAMES);
    fc.assert(
      fc.property(arbToolEvent, arbToolMatcher, arbCommand, (event, matcher, command) => {
        const { json } = buildKiroHook('xm-test-tool', event, matcher, { command });
        if (json === null) return;

        expect(json.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(json).not.toHaveProperty('enabled');
        expect(json.when).not.toHaveProperty('tool');

        expect(TOOL_EVENTS.has(json.when.type)).toBe(true);
        expect(Array.isArray(json.when.toolTypes)).toBe(true);
        json.when.toolTypes.forEach(t => expect(typeof t).toBe('string'));
        expect(json.when.patterns).toBeUndefined();
      }),
      { numRuns: 200 }
    );
  });
});

describe('Property 1: 훅 JSON 스키마 정합성 — file events', () => {
  test('file event + glob matcher → schema-conformant patterns', () => {
    const arbFileEvent = fc.constantFrom(...FILE_EVENT_NAMES);
    fc.assert(
      fc.property(arbFileEvent, arbGlobMatcher, arbCommand, (event, matcher, command) => {
        const { json } = buildKiroHook('xm-test-file', event, matcher, { command });
        expect(json).not.toBeNull();

        expect(json.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(json).not.toHaveProperty('enabled');
        expect(json.when).not.toHaveProperty('tool');

        expect(FILE_EVENTS.has(json.when.type)).toBe(true);
        expect(Array.isArray(json.when.patterns)).toBe(true);
        json.when.patterns.forEach(p => expect(typeof p).toBe('string'));
        expect(json.when.toolTypes).toBeUndefined();
      }),
      { numRuns: 200 }
    );
  });
});

describe('Property 1: 훅 JSON 스키마 정합성 — other events', () => {
  test('agentStop / promptSubmit → no toolTypes, no patterns', () => {
    const arbOtherEvent = fc.constantFrom(...OTHER_EVENT_NAMES);
    fc.assert(
      fc.property(arbOtherEvent, arbCommand, (event, command) => {
        const { json } = buildKiroHook('xm-test-other', event, undefined, { command });
        expect(json).not.toBeNull();

        expect(json.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(json).not.toHaveProperty('enabled');
        expect(json.when).not.toHaveProperty('tool');

        expect(TOOL_EVENTS.has(json.when.type)).toBe(false);
        expect(FILE_EVENTS.has(json.when.type)).toBe(false);
        expect(json.when.toolTypes).toBeUndefined();
        expect(json.when.patterns).toBeUndefined();
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: kiro-xm-compatibility, Property 2: 미지원 이벤트 스킵
// **Validates: Requirements 2.6**

describe('Property 2: 미지원 이벤트 스킵', () => {
  test('unsupported events return null JSON with non-empty note', () => {
    const unsupportedArb = fc.string({ minLength: 1, maxLength: 30 })
      .filter(s => !SUPPORTED_EVENTS.includes(s));
    
    fc.assert(
      fc.property(unsupportedArb, arbCommand, (event, command) => {
        const { json, note } = buildKiroHook('xm-test-unsupported', event, '*', { command });
        expect(json).toBeNull();
        expect(typeof note).toBe('string');
        expect(note.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: kiro-xm-compatibility, Property 5: Skill 매처 Best-Effort 변환
// **Validates: Requirements 6.1, 6.2**

describe('Property 5: Skill 매처 Best-Effort 변환', () => {
  test('Skill matcher produces best-effort hook with toolTypes: ["*"]', () => {
    // Only use tool events (PreToolUse, PostToolUse) since Skill is a tool matcher
    const toolEventArb = fc.constantFrom('PreToolUse', 'PostToolUse');
    
    fc.assert(
      fc.property(toolEventArb, arbCommand, (event, command) => {
        const { json } = buildKiroHook('xm-test-skill', event, 'Skill', { command });
        expect(json).not.toBeNull();
        expect(json.when.toolTypes).toEqual(['*']);
        // Description must include the user-facing rationale, not just the
        // marker word — otherwise a future refactor could drop the explanation
        // and this test would still pass.
        expect(json.description).toContain('best-effort');
        expect(json.description).toContain('Kiro has no Skill matcher');
        expect(json.description).toContain('Original Claude hook targeted Skill matcher');
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: kiro-xm-compatibility, Property 6: 훅 파일 고유성
// **Validates: Requirements 7.1, 7.3**

describe('Property 6: 훅 파일 고유성', () => {
  test('renderKiroShared() outputs have unique relativePaths', () => {
    const eventArb = fc.constantFrom('PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit');
    const matcherArb = fc.constantFrom('Edit|Write', 'Bash', 'Read', 'WebFetch', '*');
    const hookArb = fc.record({
      command: arbCommand,
    });
    const entryArb = fc.record({
      matcher: matcherArb,
      hooks: fc.array(hookArb, { minLength: 1, maxLength: 3 }),
    });
    const settingsArb = fc.record({
      hooks: fc.dictionary(eventArb, fc.array(entryArb, { minLength: 1, maxLength: 3 })),
    });

    fc.assert(
      fc.property(settingsArb, (settings) => {
        const tmp = mkdtempSync(join(tmpdir(), 'xm-prop6-'));
        mkdirSync(join(tmp, '.claude'), { recursive: true });
        writeFileSync(join(tmp, '.claude', 'settings.json'), JSON.stringify(settings));

        const { outputs } = renderKiroShared({ projectRoot: tmp, scope: 'local' });
        const paths = outputs.map(o => o.relativePath);
        const uniquePaths = new Set(paths);
        expect(uniquePaths.size).toBe(paths.length);
      }),
      { numRuns: 100 }
    );
  });
});
