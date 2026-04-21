#!/usr/bin/env node
// setup-global.mjs — install/uninstall xm global hooks into ~/.claude/
//
// Invoked by `xm init` dispatcher. Idempotent: safe to re-run.
//
// Install:   node setup-global.mjs install [--no-hooks]
// Uninstall: node setup-global.mjs uninstall
// Status:    node setup-global.mjs status

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const HOOKS_DIR = path.join(CLAUDE_DIR, 'hooks');
const COMMANDS_DIR = path.join(CLAUDE_DIR, 'commands');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const HOOK_FILENAME = 'xm-trace-session.mjs';
const HOOK_DEST = path.join(HOOKS_DIR, HOOK_FILENAME);
const HOOK_CMD_PRE = `node "${HOOK_DEST}" pre`;
const HOOK_CMD_POST = `node "${HOOK_DEST}" post`;
const XM_CMD_DEST = path.join(COMMANDS_DIR, 'xm.md');

// Legacy (pre-rename) locations — cleaned up during install for migration.
const LEGACY_HOOK_DEST = path.join(HOOKS_DIR, 'x-kit-trace-session.mjs');
const LEGACY_HOOK_CMD_PRE = `node "${LEGACY_HOOK_DEST}" pre`;
const LEGACY_HOOK_CMD_POST = `node "${LEGACY_HOOK_DEST}" post`;

function log(msg) { process.stdout.write(`[xm init] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[xm init] ${msg}\n`); }
function die(msg) { warn(msg); process.exit(1); }

function resolveHookSource() {
  if (process.env.XM_HOOK_SRC && fs.existsSync(process.env.XM_HOOK_SRC)) {
    return process.env.XM_HOOK_SRC;
  }
  const candidates = [];
  if (process.env.XM_LIB) {
    candidates.push(path.join(process.env.XM_LIB, 'xm', 'hooks', 'trace-session.mjs'));
  }
  // Local repo (cwd)
  candidates.push(path.join(process.cwd(), 'xm', 'hooks', 'trace-session.mjs'));
  // Plugin cache: ~/.claude/plugins/cache/xm/xm/<ver>/hooks/trace-session.mjs (new) or legacy xm path
  for (const cacheRoot of [
    path.join(HOME, '.claude', 'plugins', 'cache', 'xm', 'xm'),
    // Legacy cache path, kept for migration from pre-rename installs:
    path.join(HOME, '.claude', 'plugins', 'cache', 'x-kit', 'x-kit'),
  ]) {
    if (!fs.existsSync(cacheRoot)) continue;
    const versions = fs.readdirSync(cacheRoot)
      .filter((v) => fs.statSync(path.join(cacheRoot, v)).isDirectory())
      .sort()
      .reverse();
    for (const v of versions) {
      candidates.push(path.join(cacheRoot, v, 'hooks', 'trace-session.mjs'));
    }
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function resolveXmCommandSource() {
  const candidates = [];
  // Local repo (cwd)
  candidates.push(path.join(process.cwd(), 'xm', 'commands', 'xm.md'));
  // Plugin cache: ~/.claude/plugins/cache/xm/xm/<ver>/commands/xm.md (new) or legacy xm path
  for (const cacheRoot of [
    path.join(HOME, '.claude', 'plugins', 'cache', 'xm', 'xm'),
    // Legacy cache path, kept for migration from pre-rename installs:
    path.join(HOME, '.claude', 'plugins', 'cache', 'x-kit', 'x-kit'),
  ]) {
    if (!fs.existsSync(cacheRoot)) continue;
    const versions = fs.readdirSync(cacheRoot)
      .filter((v) => fs.statSync(path.join(cacheRoot, v)).isDirectory())
      .sort()
      .reverse();
    for (const v of versions) {
      candidates.push(path.join(cacheRoot, v, 'commands', 'xm.md'));
    }
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function readSettings() {
  if (!fs.existsSync(SETTINGS)) return {};
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); }
  catch (e) { die(`cannot parse ${SETTINGS}: ${e.message}`); }
}

function writeSettings(obj) {
  const backup = `${SETTINGS}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, backup);
  fs.writeFileSync(SETTINGS, JSON.stringify(obj, null, 2) + '\n');
  return backup;
}

function hasSkillHook(entries, command) {
  if (!Array.isArray(entries)) return false;
  return entries.some((group) =>
    group?.matcher === 'Skill' &&
    Array.isArray(group?.hooks) &&
    group.hooks.some((h) => h?.command === command)
  );
}

function addSkillHook(entries, command) {
  const list = Array.isArray(entries) ? entries : [];
  if (hasSkillHook(list, command)) return list;
  list.push({
    matcher: 'Skill',
    hooks: [{ type: 'command', command }],
  });
  return list;
}

function removeSkillHook(entries, command) {
  if (!Array.isArray(entries)) return entries;
  return entries
    .map((group) => {
      if (group?.matcher !== 'Skill' || !Array.isArray(group?.hooks)) return group;
      const hooks = group.hooks.filter((h) => h?.command !== command);
      if (hooks.length === 0) return null;
      return { ...group, hooks };
    })
    .filter(Boolean);
}

function install(opts) {
  fs.mkdirSync(HOOKS_DIR, { recursive: true });
  fs.mkdirSync(COMMANDS_DIR, { recursive: true });

  // Migration: clean up legacy x-kit-trace-session.mjs hook and its settings entries
  // so we don't run both the old and new hook after users upgrade.
  if (fs.existsSync(LEGACY_HOOK_DEST)) {
    fs.unlinkSync(LEGACY_HOOK_DEST);
    log(`migrated: removed legacy ${LEGACY_HOOK_DEST}`);
  }
  if (fs.existsSync(SETTINGS)) {
    const s = readSettings();
    if (s.hooks) {
      const beforePre = JSON.stringify(s.hooks.PreToolUse || []);
      const beforePost = JSON.stringify(s.hooks.PostToolUse || []);
      s.hooks.PreToolUse = removeSkillHook(s.hooks.PreToolUse, LEGACY_HOOK_CMD_PRE);
      s.hooks.PostToolUse = removeSkillHook(s.hooks.PostToolUse, LEGACY_HOOK_CMD_POST);
      const changed = JSON.stringify(s.hooks.PreToolUse || []) !== beforePre
        || JSON.stringify(s.hooks.PostToolUse || []) !== beforePost;
      if (changed) {
        writeSettings(s);
        log('migrated: removed legacy hook entries from settings');
      }
    }
  }

  if (opts.withHooks) {
    const src = resolveHookSource();
    if (!src) die('trace-session.mjs not found. Set XM_HOOK_SRC or run from repo root.');
    fs.copyFileSync(src, HOOK_DEST);
    fs.chmodSync(HOOK_DEST, 0o755);
    log(`copied hook: ${HOOK_DEST}`);

    const settings = readSettings();
    settings.hooks = settings.hooks || {};
    settings.hooks.PreToolUse = addSkillHook(settings.hooks.PreToolUse, HOOK_CMD_PRE);
    settings.hooks.PostToolUse = addSkillHook(settings.hooks.PostToolUse, HOOK_CMD_POST);
    const backup = writeSettings(settings);
    log(`updated ${SETTINGS} (backup: ${path.basename(backup)})`);
    log('hook installed. Skill traces → <project>/.xm/traces/');
  } else {
    log('hooks skipped (--no-hooks). CLI dispatcher install is handled by install.sh.');
  }

  // Install /xm user-level dispatcher command (allows `/xm <subcommand>` form)
  const xmSrc = resolveXmCommandSource();
  if (xmSrc) {
    fs.copyFileSync(xmSrc, XM_CMD_DEST);
    log(`copied dispatcher: ${XM_CMD_DEST}`);
  } else {
    warn('xm.md not found (skipped user-level dispatcher). Plugin-qualified form /xm:<cmd> still works.');
  }

  log('done.');
}

function uninstall() {
  let removed = false;
  if (fs.existsSync(HOOK_DEST)) {
    fs.unlinkSync(HOOK_DEST);
    log(`removed ${HOOK_DEST}`);
    removed = true;
  }
  if (fs.existsSync(XM_CMD_DEST)) {
    fs.unlinkSync(XM_CMD_DEST);
    log(`removed ${XM_CMD_DEST}`);
    removed = true;
  }
  if (fs.existsSync(SETTINGS)) {
    const settings = readSettings();
    if (settings.hooks) {
      const beforePre = JSON.stringify(settings.hooks.PreToolUse || []);
      const beforePost = JSON.stringify(settings.hooks.PostToolUse || []);
      settings.hooks.PreToolUse = removeSkillHook(settings.hooks.PreToolUse, HOOK_CMD_PRE);
      settings.hooks.PostToolUse = removeSkillHook(settings.hooks.PostToolUse, HOOK_CMD_POST);
      const changed = JSON.stringify(settings.hooks.PreToolUse || []) !== beforePre
        || JSON.stringify(settings.hooks.PostToolUse || []) !== beforePost;
      if (changed) {
        const backup = writeSettings(settings);
        log(`cleaned ${SETTINGS} (backup: ${path.basename(backup)})`);
        removed = true;
      }
    }
  }
  log(removed ? 'uninstalled.' : 'nothing to remove.');
}

function status() {
  const hookExists = fs.existsSync(HOOK_DEST);
  const xmCmdExists = fs.existsSync(XM_CMD_DEST);
  const settings = readSettings();
  const pre = hasSkillHook(settings.hooks?.PreToolUse, HOOK_CMD_PRE);
  const post = hasSkillHook(settings.hooks?.PostToolUse, HOOK_CMD_POST);
  log(`hook file        : ${hookExists ? HOOK_DEST : '(missing)'}`);
  log(`xm dispatcher    : ${xmCmdExists ? XM_CMD_DEST : '(missing)'}`);
  log(`PreToolUse/Skill : ${pre ? 'registered' : '(missing)'}`);
  log(`PostToolUse/Skill: ${post ? 'registered' : '(missing)'}`);
  const ok = hookExists && xmCmdExists && pre && post;
  log(`overall          : ${ok ? 'OK' : 'NOT installed'}`);
  process.exit(ok ? 0 : 1);
}

const cmd = process.argv[2] || 'install';
const flags = new Set(process.argv.slice(3));

switch (cmd) {
  case 'install':
    install({ withHooks: !flags.has('--no-hooks') });
    break;
  case 'uninstall':
    uninstall();
    break;
  case 'status':
    status();
    break;
  case '--help':
  case '-h':
  case 'help':
    process.stdout.write(`xm init — install global hooks into ~/.claude/\n\n`
      + `Usage:\n`
      + `  xm init                 # install trace-session hook globally\n`
      + `  xm init --no-hooks      # skip hook install (CLI only)\n`
      + `  xm init status          # check install state\n`
      + `  xm init uninstall       # remove hook + settings entries\n\n`
      + `Env:\n`
      + `  XM_HOOK_SRC   override hook source path\n`
      + `  XM_LIB        override lib root (used for resolving hook source)\n`);
    break;
  default:
    die(`unknown subcommand: ${cmd}. Try 'xm init --help'.`);
}
