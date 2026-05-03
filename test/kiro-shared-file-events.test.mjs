import { describe, test, expect } from 'bun:test';
import { translateEvent, buildKiroHook } from '../xm/lib/install/transform/kiro-shared.mjs';

// ── translateEvent() — file event mappings (Req 2.1–2.5) ──

describe('translateEvent — file event mappings', () => {
  test('FileCreate → fileCreated', () => {
    expect(translateEvent('FileCreate')).toBe('fileCreated');
  });
  test('FileSave → fileEdited', () => {
    expect(translateEvent('FileSave')).toBe('fileEdited');
  });
  test('FileDelete → fileDeleted', () => {
    expect(translateEvent('FileDelete')).toBe('fileDeleted');
  });
  // Existing mappings still work
  test('PreToolUse → preToolUse', () => {
    expect(translateEvent('PreToolUse')).toBe('preToolUse');
  });
  test('PostToolUse → postToolUse', () => {
    expect(translateEvent('PostToolUse')).toBe('postToolUse');
  });
  test('Stop → agentStop', () => {
    expect(translateEvent('Stop')).toBe('agentStop');
  });
  test('UserPromptSubmit → promptSubmit', () => {
    expect(translateEvent('UserPromptSubmit')).toBe('promptSubmit');
  });
  test('SessionStart → null', () => {
    expect(translateEvent('SessionStart')).toBeNull();
  });
});

// ── buildKiroHook() — file events use when.patterns (Req 3.1, 3.3) ──

describe('buildKiroHook — file events produce when.patterns', () => {
  const cmd = { command: 'node lint.mjs' };

  test('FileCreate hook has when.patterns and no when.toolTypes', () => {
    const { json } = buildKiroHook('xm-filecreate-0', 'FileCreate', '*.ts|*.tsx', cmd);
    expect(json).not.toBeNull();
    expect(json.when.type).toBe('fileCreated');
    expect(json.when.patterns).toEqual(['*.ts', '*.tsx']);
    expect(json.when.toolTypes).toBeUndefined();
  });

  test('FileSave hook has when.patterns and no when.toolTypes', () => {
    const { json } = buildKiroHook('xm-filesave-0', 'FileSave', 'src/**/*.js', cmd);
    expect(json).not.toBeNull();
    expect(json.when.type).toBe('fileEdited');
    expect(json.when.patterns).toEqual(['src/**/*.js']);
    expect(json.when.toolTypes).toBeUndefined();
  });

  test('FileDelete hook has when.patterns and no when.toolTypes', () => {
    const { json } = buildKiroHook('xm-filedelete-0', 'FileDelete', undefined, cmd);
    expect(json).not.toBeNull();
    expect(json.when.type).toBe('fileDeleted');
    expect(json.when.patterns).toEqual(['*']);
    expect(json.when.toolTypes).toBeUndefined();
  });

  test('file event with empty matcher defaults to ["*"]', () => {
    const { json } = buildKiroHook('xm-filesave-1', 'FileSave', '', cmd);
    expect(json.when.patterns).toEqual(['*']);
  });

  test('file event with comma-separated patterns splits correctly', () => {
    const { json } = buildKiroHook('xm-filecreate-1', 'FileCreate', '*.ts,*.tsx,*.js', cmd);
    expect(json.when.patterns).toEqual(['*.ts', '*.tsx', '*.js']);
  });
});

// ── buildKiroHook() — tool events still use when.toolTypes (Req 3.2) ──

describe('buildKiroHook — tool events still use when.toolTypes', () => {
  const cmd = { command: 'node check.mjs' };

  test('PreToolUse hook has when.toolTypes and no when.patterns', () => {
    const { json } = buildKiroHook('xm-pretooluse-0', 'PreToolUse', 'Edit|Write', cmd);
    expect(json).not.toBeNull();
    expect(json.when.type).toBe('preToolUse');
    expect(json.when.toolTypes).toEqual(['write']);
    expect(json.when.patterns).toBeUndefined();
  });

  test('PostToolUse hook has when.toolTypes and no when.patterns', () => {
    const { json } = buildKiroHook('xm-posttooluse-0', 'PostToolUse', 'Bash', cmd);
    expect(json).not.toBeNull();
    expect(json.when.type).toBe('postToolUse');
    expect(json.when.toolTypes).toEqual(['shell']);
    expect(json.when.patterns).toBeUndefined();
  });
});

// ── buildKiroHook() — other events have neither toolTypes nor patterns (Req 3.3) ──

describe('buildKiroHook — other events have no toolTypes or patterns', () => {
  const cmd = { command: 'node notify.mjs' };

  test('Stop (agentStop) has no toolTypes and no patterns', () => {
    const { json } = buildKiroHook('xm-stop-0', 'Stop', undefined, cmd);
    expect(json).not.toBeNull();
    expect(json.when.type).toBe('agentStop');
    expect(json.when.toolTypes).toBeUndefined();
    expect(json.when.patterns).toBeUndefined();
  });

  test('UserPromptSubmit (promptSubmit) has no toolTypes and no patterns', () => {
    const { json } = buildKiroHook('xm-userpromptsubmit-0', 'UserPromptSubmit', undefined, cmd);
    expect(json).not.toBeNull();
    expect(json.when.type).toBe('promptSubmit');
    expect(json.when.toolTypes).toBeUndefined();
    expect(json.when.patterns).toBeUndefined();
  });
});

// ── buildKiroHook() — Skill matcher mixed with mapped tools (L1 fix policy) ──
//
// Pins the policy that when `Skill` is combined with mapped tool tokens, the
// Kiro hook keeps the mapped tools (not '*') AND its description is annotated
// best-effort to surface that Skill coverage was dropped. Skill-only is the
// existing best-effort wildcard branch.

describe('buildKiroHook — Skill matcher mixed with mapped tools', () => {
  const cmd = { command: 'node check.mjs' };

  test('"Skill|Edit" → toolTypes=["write"], description flags best-effort', () => {
    const { json } = buildKiroHook('xm-pretool-mix-0', 'PreToolUse', 'Skill|Edit', cmd);
    expect(json).not.toBeNull();
    expect(json.when.toolTypes).toEqual(['write']);
    expect(json.description).toContain('best-effort');
    expect(json.description).toContain('Skill matcher');
  });

  test('"Edit|Skill" → toolTypes=["write"], description flags best-effort (order-independent)', () => {
    const { json } = buildKiroHook('xm-pretool-mix-1', 'PreToolUse', 'Edit|Skill', cmd);
    expect(json.when.toolTypes).toEqual(['write']);
    expect(json.description).toContain('best-effort');
  });

  test('"Skill|Bash|Write" → toolTypes contains both mapped tools, no \'*\'', () => {
    const { json } = buildKiroHook('xm-pretool-mix-2', 'PreToolUse', 'Skill|Bash|Write', cmd);
    expect(json.when.toolTypes.sort()).toEqual(['shell', 'write']);
    expect(json.when.toolTypes).not.toContain('*');
    expect(json.description).toContain('best-effort');
  });

  test('mapped-only matcher (no Skill) does NOT flag best-effort', () => {
    const { json } = buildKiroHook('xm-pretool-clean-0', 'PreToolUse', 'Edit|Bash', cmd);
    expect(json.description).not.toContain('best-effort');
  });
});

// ── buildKiroHook() — file event matcher edge cases (L2 fix) ──

describe('buildKiroHook — file event matcher edge cases', () => {
  const cmd = { command: 'node lint.mjs' };

  test('null matcher defaults to ["*"]', () => {
    const { json } = buildKiroHook('xm-filesave-null', 'FileSave', null, cmd);
    expect(json.when.patterns).toEqual(['*']);
  });

  test('whitespace-only matcher defaults to ["*"]', () => {
    const { json } = buildKiroHook('xm-filesave-ws', 'FileSave', '   ', cmd);
    expect(json.when.patterns).toEqual(['*']);
  });

  test('only-separators matcher (e.g. ",,,") defaults to ["*"]', () => {
    const { json } = buildKiroHook('xm-filesave-seps', 'FileSave', ',,,', cmd);
    expect(json.when.patterns).toEqual(['*']);
  });
});

// ── buildKiroHook() — unsupported events still return null (Req 2.6) ──

describe('buildKiroHook — unsupported events return null', () => {
  test('SessionStart returns null with note', () => {
    const { json, note } = buildKiroHook('xm-sessionstart-0', 'SessionStart', undefined, { command: 'node x.mjs' });
    expect(json).toBeNull();
    expect(note).toBeTruthy();
  });

  test('unknown event returns null with note', () => {
    const { json, note } = buildKiroHook('xm-unknown-0', 'SomeNewEvent', undefined, { command: 'node x.mjs' });
    expect(json).toBeNull();
    expect(note).toBeTruthy();
  });
});
