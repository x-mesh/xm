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
import { fileURLToPath } from 'node:url';
import { removeMarkerBlock, renderMarkerBlock, writeMergeMarker } from '../lib/install/merge.mjs';

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const HOOKS_DIR = path.join(CLAUDE_DIR, 'hooks');
const COMMANDS_DIR = path.join(CLAUDE_DIR, 'commands');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const HOOK_FILENAME = 'xm-trace-session.mjs';
const HOOK_DEST = path.join(HOOKS_DIR, HOOK_FILENAME);
const NODE_BIN = resolveNodeBin();
const HOOK_CMD_PRE = `"${NODE_BIN}" "${HOOK_DEST}" pre`;
const HOOK_CMD_POST = `"${NODE_BIN}" "${HOOK_DEST}" post`;
// Stop closes the session the Skill call opened: PostToolUse(Skill) fires before
// the skill's own Agent calls, so it cannot be the close.
const HOOK_CMD_STOP = `"${NODE_BIN}" "${HOOK_DEST}" stop`;
const RELAY_HOOK_FILENAME = 'xm-relay-autoreply.mjs';
const RELAY_HOOK_DEST = path.join(HOOKS_DIR, RELAY_HOOK_FILENAME);
const CODEX_DIR = path.join(HOME, '.codex');
const CODEX_HOOKS = path.join(CODEX_DIR, 'hooks.json');
const CODEX_RELAY_HOOK_DEST = path.join(CODEX_DIR, 'xm', 'hooks', RELAY_HOOK_FILENAME);
// The Stop half runs `xm relay send`, which can take several seconds.
const RELAY_HOOK_TIMEOUT = 30;
const RELAY_HOOK_EVENTS = ['UserPromptSubmit', 'Stop'];
const XM_CMD_DEST = path.join(COMMANDS_DIR, 'xm.md');
const XM_PLAN_CMD_DEST = path.join(COMMANDS_DIR, 'xm-plan.md');
const XM_PLAN_CMD_BACKUP = path.join(COMMANDS_DIR, 'xm-plan.md.pre-xm');
const XM_PLAN_MARKER = '<!-- xm-managed:xm-plan -->';
const CLAUDE_MD = path.join(CLAUDE_DIR, 'CLAUDE.md');
const CODEX_MD = path.join(HOME, '.codex', 'AGENTS.md');
// Beside this script rather than searched in the cache: the cache resolvers sort
// versions as strings, and the block must match the version doing the install.
const TEMPLATES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
// The begin marker carries the template revision (`v<N>`), bumped only when the
// template text changes (test/setup-global-codex-md.test.mjs pins it). Matching
// ignores the revision, so a block written by an older xm is still found and
// replaced rather than followed by a second one. A block with no revision is
// revision 0: the format before revisions existed.
const routingMarkers = (flag, revision) => ({
  begin: `<!-- xm:routing:begin v${revision} — managed by \`xm setup ${flag}\`; edit outside this block -->`,
  beginMatch: /<!-- xm:routing:begin(?: v(\d+))?[^\n]*?-->/,
  end: '<!-- xm:routing:end -->',
});
const routingTarget = (label, flag, file, template, revision) => ({
  label, flag, file, revision,
  src: path.join(TEMPLATES_DIR, template),
  markers: routingMarkers(flag, revision),
});
const ROUTING_TARGETS = [
  routingTarget('CLAUDE.md', '--claude-md', CLAUDE_MD, 'claude-routing.md', 1),
  routingTarget('AGENTS.md', '--codex-md', CODEX_MD, 'codex-routing.md', 1),
];

// Previous format (bare `node`) — cleaned up during install so users upgrading
// from earlier xm versions don't end up with duplicate Skill hook entries.
const PREVIOUS_HOOK_CMD_PRE = `node "${HOOK_DEST}" pre`;
const PREVIOUS_HOOK_CMD_POST = `node "${HOOK_DEST}" post`;

// Legacy (pre-rename) locations — cleaned up during install for migration.
const LEGACY_HOOK_DEST = path.join(HOOKS_DIR, 'x-kit-trace-session.mjs');
const LEGACY_HOOK_CMD_PRE = `node "${LEGACY_HOOK_DEST}" pre`;
const LEGACY_HOOK_CMD_POST = `node "${LEGACY_HOOK_DEST}" post`;

/**
 * Resolve a stable absolute path to a node binary. Bare `node` in hook
 * commands is fragile because Claude Code spawns hook subprocesses with
 * a PATH that may not include version-manager shims (fnm/nvm) — and
 * those shims live in ephemeral per-shell directories that disappear
 * when the parent shell exits, producing `node:internal/modules/cjs/loader:1478`
 * style failures at runtime.
 *
 * Prefer well-known system locations (Homebrew, Linux distro paths) over
 * `process.execPath`, which is absolute but might be the ephemeral shim.
 */
function resolveNodeBin() {
  const stable = [
    '/opt/homebrew/bin/node',  // macOS Apple Silicon Homebrew
    '/usr/local/bin/node',     // macOS Intel Homebrew / Linux manual install
    '/usr/bin/node',           // Linux distro packages
  ];
  for (const p of stable) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return process.execPath;
}

// Both `xm setup` (canonical) and `xm init` (legacy, no-arg only) land here.
// The dispatcher passes the verb the user actually typed so the log prefix and
// usage text never tell them to run a command they did not invoke.
const VERB = process.env.XM_SETUP_VERB === 'setup' ? 'setup' : 'init';

function log(msg) { process.stdout.write(`[xm ${VERB}] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[xm ${VERB}] ${msg}\n`); }
function die(msg) { warn(msg); process.exit(1); }

function resolveHookSource(file = 'trace-session.mjs') {
  if (file === 'trace-session.mjs' && process.env.XM_HOOK_SRC && fs.existsSync(process.env.XM_HOOK_SRC)) {
    return process.env.XM_HOOK_SRC;
  }
  const candidates = [];
  if (process.env.XM_LIB) {
    candidates.push(path.join(process.env.XM_LIB, 'xm', 'hooks', file));
  }
  // Local repo (cwd)
  candidates.push(path.join(process.cwd(), 'xm', 'hooks', file));
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
      candidates.push(path.join(cacheRoot, v, 'hooks', file));
    }
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function resolveXmCommandSource() {
  const candidates = [];
  // Explicit source-repo override, used by the terminal dispatcher and tests.
  if (process.env.XM_LIB) {
    candidates.push(path.join(process.env.XM_LIB, 'xm', 'commands', 'xm.md'));
  }
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

function resolveXmPlanCommandSource() {
  const candidates = [];
  if (process.env.XM_LIB) candidates.push(path.join(process.env.XM_LIB, 'xm', 'commands', 'xm-plan.md'));
  candidates.push(path.join(process.cwd(), 'xm', 'commands', 'xm-plan.md'));
  for (const cacheRoot of [
    path.join(HOME, '.claude', 'plugins', 'cache', 'xm', 'xm'),
    path.join(HOME, '.claude', 'plugins', 'cache', 'x-kit', 'x-kit'),
  ]) {
    if (!fs.existsSync(cacheRoot)) continue;
    const versions = fs.readdirSync(cacheRoot).filter((v) => fs.statSync(path.join(cacheRoot, v)).isDirectory()).sort().reverse();
    for (const v of versions) candidates.push(path.join(cacheRoot, v, 'commands', 'xm-plan.md'));
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function backupCopy(file) {
  const backup = `${file}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(file, backup);
  return backup;
}

function readRoutingFile(target) {
  return fs.existsSync(target.file) ? fs.readFileSync(target.file, 'utf8') : '';
}

/** Revision of the block in `text`: its number, 0 when unversioned, null when there is no block. */
function installedRevision(text, markers) {
  const match = markers.beginMatch.exec(text);
  return match ? Number(match[1] ?? 0) : null;
}

function withoutRoutingBlock(text, markers) {
  const match = markers.beginMatch.exec(text);
  const end = text.indexOf(markers.end);
  if (!match || end === -1 || match.index > end) return text;
  return text.slice(0, match.index) + text.slice(end + markers.end.length);
}

/**
 * The `--claude-md` / `--codex-md` flag is the opt-in. Afterwards the block's
 * presence is the consent, so a bare install (what `xm update` runs) refreshes
 * it and never adds it.
 */
function syncRouting(target, optIn) {
  const { label, flag, file, src, markers, revision } = target;
  const current = readRoutingFile(target);
  const installed = installedRevision(current, markers);
  if (!optIn && installed === null) {
    log(`${label} routing: not enabled (opt in: xm ${VERB} ${flag})`);
    return;
  }
  // An older xm must not overwrite a block that a newer xm wrote.
  if (installed !== null && installed > revision) {
    warn(`${label} routing: ${file} has block v${installed}, newer than v${revision} in this xm. Left unchanged; update xm.`);
    return;
  }
  if (!fs.existsSync(src)) {
    warn(`${src} not found (skipped the routing block in ${file})`);
    return;
  }
  const body = fs.readFileSync(src, 'utf8');
  if (current.includes(renderMarkerBlock(body, markers))) {
    log(`${label} routing: up to date (${file})`);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const backup = fs.existsSync(file) ? backupCopy(file) : null;
    try {
      writeMergeMarker(file, body, { markers, backup: false });
    } catch (e) {
      die(`${label} routing: ${e.message}`);
    }
    log(`${label} routing: wrote the managed block in ${file}`
      + (backup ? ` (backup: ${path.basename(backup)}; edits inside the block are replaced)` : ''));
  }
  if (/^## xm routing\b/m.test(withoutRoutingBlock(readRoutingFile(target), markers))) {
    warn(`${file} also has a hand-written "## xm routing" section outside the managed block. Remove it to avoid duplicate rules.`);
  }
}

function routingStatus(target) {
  const { flag, file, src, markers, revision } = target;
  const text = readRoutingFile(target);
  const installed = installedRevision(text, markers);
  if (installed === null) return `(not enabled — opt in: xm ${VERB} ${flag})`;
  if (installed > revision) return `newer than this xm (v${installed} > v${revision}; update xm)`;
  if (!fs.existsSync(src)) return `(template missing: ${src})`;
  if (text.includes(renderMarkerBlock(fs.readFileSync(src, 'utf8'), markers))) return `current (v${revision}, ${file})`;
  return `outdated (${installed === revision ? `v${revision}, content differs` : `v${installed} → v${revision}`}; re-run xm ${VERB})`;
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

// One group per event with a combined matcher: Skill (session boundaries) and
// Agent (one agent_step per subagent call inside an open session). A single
// group keeps the command unique per event, which `xm install --target codex`
// relies on when it translates settings into Codex hooks. Pre-Agent installs
// registered the same command under a bare 'Skill' matcher; install removes every
// entry for the command (any matcher) and re-adds exactly one, so a duplicated or
// corrupted registration cannot survive as "already present".
const HOOK_MATCHER = 'Skill|Agent';
// [event, command, matcher] — Stop has no matcher.
const HOOK_REGISTRATIONS = [
  ['PreToolUse', HOOK_CMD_PRE, HOOK_MATCHER],
  ['PostToolUse', HOOK_CMD_POST, HOOK_MATCHER],
  ['Stop', HOOK_CMD_STOP, null],
];

const sameMatcher = (group, matcher) => (group?.matcher ?? null) === (matcher ?? null);

/** Executable registrations of `command` across every group of an event. */
function countHook(entries, command) {
  if (!Array.isArray(entries)) return 0;
  return entries.reduce((n, group) => n + (Array.isArray(group?.hooks)
    ? group.hooks.filter((h) => h?.type === 'command' && h?.command === command).length
    : 0), 0);
}

function hasHook(entries, command, matcher = 'Skill') {
  if (!Array.isArray(entries)) return false;
  return entries.some((group) =>
    sameMatcher(group, matcher) &&
    Array.isArray(group?.hooks) &&
    group.hooks.some((h) => h?.command === command)
  );
}

function addHook(entries, command, matcher = 'Skill') {
  const list = Array.isArray(entries) ? entries : [];
  if (hasHook(list, command, matcher)) return list;
  list.push({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: 'command', command }],
  });
  return list;
}

function removeHook(entries, command, matcher = 'Skill') {
  if (!Array.isArray(entries)) return entries;
  return entries
    .map((group) => {
      if (!sameMatcher(group, matcher) || !Array.isArray(group?.hooks)) return group;
      const hooks = group.hooks.filter((h) => h?.command !== command);
      if (hooks.length === 0) return null;
      return { ...group, hooks };
    })
    .filter(Boolean);
}

/** Remove `command` from every group, whatever its matcher. */
function removeHookCommand(entries, command) {
  if (!Array.isArray(entries)) return entries;
  return entries
    .map((group) => {
      if (!Array.isArray(group?.hooks)) return group;
      const hooks = group.hooks.filter((h) => h?.command !== command);
      if (hooks.length === 0) return null;
      return { ...group, hooks };
    })
    .filter(Boolean);
}

/** Drop every hook whose command runs `file`, whatever node path an earlier install used. */
function withoutHookFile(entries, file) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((group) => {
      if (!Array.isArray(group?.hooks)) return group;
      const hooks = group.hooks.filter((h) => !(typeof h?.command === 'string' && h.command.includes(file)));
      return hooks.length ? { ...group, hooks } : null;
    })
    .filter(Boolean);
}

/** Wire `node <dest> <agent>` into UserPromptSubmit and Stop of a hooks document, replacing earlier copies. */
function withRelayHook(document, dest, agent) {
  const hooks = { ...(document.hooks || {}) };
  for (const event of RELAY_HOOK_EVENTS) {
    hooks[event] = [...withoutHookFile(hooks[event], dest),
      { hooks: [{ type: 'command', command: `"${NODE_BIN}" "${dest}" ${agent}`, timeout: RELAY_HOOK_TIMEOUT }] }];
  }
  return { ...document, hooks };
}

function withoutRelayHook(document, dest) {
  if (!document.hooks) return document;
  const hooks = { ...document.hooks };
  for (const event of RELAY_HOOK_EVENTS) {
    if (!(event in hooks)) continue;
    hooks[event] = withoutHookFile(hooks[event], dest);
    if (hooks[event].length === 0) delete hooks[event];
  }
  return { ...document, hooks };
}

function readCodexHooks() {
  if (!fs.existsSync(CODEX_HOOKS)) return { hooks: {} };
  try { return JSON.parse(fs.readFileSync(CODEX_HOOKS, 'utf8')); }
  catch (e) { die(`cannot parse ${CODEX_HOOKS}: ${e.message}`); }
}

function writeCodexHooks(document) {
  const backup = `${CODEX_HOOKS}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  if (fs.existsSync(CODEX_HOOKS)) fs.copyFileSync(CODEX_HOOKS, backup);
  fs.writeFileSync(CODEX_HOOKS, JSON.stringify(document, null, 2) + '\n');
  return backup;
}

function installRelayHook() {
  const src = resolveHookSource('relay-autoreply.mjs');
  // An xm build older than the hook has no source; the trace hook above still installs.
  if (!src) {
    warn('relay auto-reply hook skipped: relay-autoreply.mjs not found. Update the xm plugin, then re-run xm init.');
    return;
  }
  fs.copyFileSync(src, RELAY_HOOK_DEST);
  fs.chmodSync(RELAY_HOOK_DEST, 0o755);
  const backup = writeSettings(withRelayHook(readSettings(), RELAY_HOOK_DEST, 'claude'));
  log(`relay auto-reply hook: ${RELAY_HOOK_DEST} (settings backup: ${path.basename(backup)})`);

  if (!fs.existsSync(CODEX_DIR)) {
    log('relay auto-reply hook: ~/.codex not found, Codex skipped');
    return;
  }
  fs.mkdirSync(path.dirname(CODEX_RELAY_HOOK_DEST), { recursive: true });
  fs.copyFileSync(src, CODEX_RELAY_HOOK_DEST);
  fs.chmodSync(CODEX_RELAY_HOOK_DEST, 0o755);
  const codexBackup = writeCodexHooks(withRelayHook(readCodexHooks(), CODEX_RELAY_HOOK_DEST, 'codex'));
  log(`relay auto-reply hook: ${CODEX_RELAY_HOOK_DEST} (hooks.json backup: ${path.basename(codexBackup)})`);
  log('Codex asks each session once to trust new or changed hooks; choose "Trust all and continue".');
}

function uninstallRelayHook() {
  let removed = false;
  for (const dest of [RELAY_HOOK_DEST, CODEX_RELAY_HOOK_DEST]) {
    if (!fs.existsSync(dest)) continue;
    fs.unlinkSync(dest);
    log(`removed ${dest}`);
    removed = true;
  }
  if (fs.existsSync(SETTINGS)) {
    const settings = readSettings();
    const cleaned = withoutRelayHook(settings, RELAY_HOOK_DEST);
    if (JSON.stringify(cleaned) !== JSON.stringify(settings)) {
      log(`cleaned relay hook from ${SETTINGS} (backup: ${path.basename(writeSettings(cleaned))})`);
      removed = true;
    }
  }
  if (fs.existsSync(CODEX_HOOKS)) {
    const document = readCodexHooks();
    const cleaned = withoutRelayHook(document, CODEX_RELAY_HOOK_DEST);
    if (JSON.stringify(cleaned) !== JSON.stringify(document)) {
      log(`cleaned relay hook from ${CODEX_HOOKS} (backup: ${path.basename(writeCodexHooks(cleaned))})`);
      removed = true;
    }
  }
  return removed;
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
      // Drop renamed-hook entries (pre-rename: x-kit-trace-session.mjs)
      s.hooks.PreToolUse = removeHook(s.hooks.PreToolUse, LEGACY_HOOK_CMD_PRE);
      s.hooks.PostToolUse = removeHook(s.hooks.PostToolUse, LEGACY_HOOK_CMD_POST);
      // Drop bare-`node` entries from earlier xm versions so we don't end up
      // with both formats wired after this install rewrites with absolute path.
      s.hooks.PreToolUse = removeHook(s.hooks.PreToolUse, PREVIOUS_HOOK_CMD_PRE);
      s.hooks.PostToolUse = removeHook(s.hooks.PostToolUse, PREVIOUS_HOOK_CMD_POST);
      const changed = JSON.stringify(s.hooks.PreToolUse || []) !== beforePre
        || JSON.stringify(s.hooks.PostToolUse || []) !== beforePost;
      if (changed) {
        writeSettings(s);
        log('migrated: removed superseded hook entries from settings');
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
    for (const [event, command, matcher] of HOOK_REGISTRATIONS) {
      settings.hooks[event] = removeHookCommand(settings.hooks[event], command);
      settings.hooks[event] = addHook(settings.hooks[event], command, matcher);
    }
    const backup = writeSettings(settings);
    log(`updated ${SETTINGS} (backup: ${path.basename(backup)})`);
    log('hook installed. Skill sessions (closed at Stop) + Agent spans → <project>/.xm/traces/');
    installRelayHook();
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
  const xmPlanSrc = resolveXmPlanCommandSource();
  if (xmPlanSrc) {
    if (fs.existsSync(XM_PLAN_CMD_DEST)) {
      const existing = fs.readFileSync(XM_PLAN_CMD_DEST, 'utf8');
      if (!existing.includes(XM_PLAN_MARKER)) {
        if (fs.existsSync(XM_PLAN_CMD_BACKUP)) {
          let archive = `${XM_PLAN_CMD_BACKUP}.1`;
          for (let i = 2; fs.existsSync(archive); i += 1) archive = `${XM_PLAN_CMD_BACKUP}.${i}`;
          fs.renameSync(XM_PLAN_CMD_BACKUP, archive);
          log(`archived previous plan backup: ${archive}`);
        }
        fs.copyFileSync(XM_PLAN_CMD_DEST, XM_PLAN_CMD_BACKUP);
        log(`preserved existing plan command: ${XM_PLAN_CMD_BACKUP}`);
      }
    }
    fs.copyFileSync(xmPlanSrc, XM_PLAN_CMD_DEST);
    log(`copied plan alias: ${XM_PLAN_CMD_DEST}`);
  } else {
    warn('xm-plan.md not found (skipped /xm-plan alias). Plugin-qualified form /xm:plan still works.');
  }

  // Refresh the bash CLI binary (~/.local/bin/xm) from the freshest xm/scripts/xm
  // available. Previously this was install.sh's responsibility; doing it here
  // too ensures users who only ran `xm init` end up with a dispatcher matching
  // their installed plugin version (doctor, update, etc.).
  try {
    const bashSrc = resolveBashDispatcher();
    if (bashSrc) {
      const binDir = process.env.XM_BIN_DIR || path.join(HOME, '.local', 'bin');
      const binDest = path.join(binDir, 'xm');
      // Compare to avoid a no-op write & noisy log line
      const existing = fs.existsSync(binDest) ? fs.readFileSync(binDest, 'utf8') : null;
      const incoming = fs.readFileSync(bashSrc, 'utf8');
      if (existing !== incoming) {
        fs.mkdirSync(binDir, { recursive: true });
        fs.copyFileSync(bashSrc, binDest);
        fs.chmodSync(binDest, 0o755);
        log(`refreshed CLI binary: ${binDest}`);
      }
    }
  } catch (e) {
    warn(`CLI binary refresh skipped: ${e.message}`);
  }

  // Last: a failure here exits, and must not cost the steps above.
  for (const target of ROUTING_TARGETS) syncRouting(target, opts.routingFlags.has(target.flag));

  log('done.');
}

/** Resolve the newest xm/scripts/xm dispatcher source (local repo > plugin cache). */
function resolveBashDispatcher() {
  const candidates = [];
  if (process.env.XM_LIB) {
    candidates.push(path.join(process.env.XM_LIB, 'xm', 'scripts', 'xm'));
  }
  // Local repo
  candidates.push(path.join(process.cwd(), 'xm', 'scripts', 'xm'));
  // Plugin cache (sorted semver desc)
  for (const cacheRoot of [
    path.join(HOME, '.claude', 'plugins', 'cache', 'xm', 'xm'),
    path.join(HOME, '.claude', 'plugins', 'cache', 'x-kit', 'x-kit'),
  ]) {
    if (!fs.existsSync(cacheRoot)) continue;
    const versions = fs.readdirSync(cacheRoot)
      .filter((v) => fs.statSync(path.join(cacheRoot, v)).isDirectory())
      .sort()
      .reverse();
    for (const v of versions) {
      candidates.push(path.join(cacheRoot, v, 'scripts', 'xm'));
    }
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function uninstall() {
  let removed = uninstallRelayHook();
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
  if (fs.existsSync(XM_PLAN_CMD_DEST)) {
    const managed = fs.readFileSync(XM_PLAN_CMD_DEST, 'utf8').includes(XM_PLAN_MARKER);
    if (managed && fs.existsSync(XM_PLAN_CMD_BACKUP)) {
      fs.copyFileSync(XM_PLAN_CMD_BACKUP, XM_PLAN_CMD_DEST);
      fs.unlinkSync(XM_PLAN_CMD_BACKUP);
      log(`restored ${XM_PLAN_CMD_DEST}`);
      removed = true;
    } else if (managed) {
      fs.unlinkSync(XM_PLAN_CMD_DEST);
      log(`removed ${XM_PLAN_CMD_DEST}`);
      removed = true;
    } else {
      log(`preserved user-owned ${XM_PLAN_CMD_DEST}`);
    }
  }
  if (fs.existsSync(SETTINGS)) {
    const settings = readSettings();
    if (settings.hooks) {
      const snapshot = () => JSON.stringify(HOOK_REGISTRATIONS.map(([event]) => settings.hooks[event] || []));
      const before = snapshot();
      for (const [event, command] of HOOK_REGISTRATIONS) {
        settings.hooks[event] = removeHookCommand(settings.hooks[event], command);
      }
      const changed = snapshot() !== before;
      if (changed) {
        const backup = writeSettings(settings);
        log(`cleaned ${SETTINGS} (backup: ${path.basename(backup)})`);
        removed = true;
      }
    }
  }
  for (const target of ROUTING_TARGETS) {
    if (installedRevision(readRoutingFile(target), target.markers) === null) continue;
    const backup = backupCopy(target.file);
    try {
      removeMarkerBlock(target.file, { markers: target.markers, backup: false });
    } catch (e) {
      die(`${target.label} routing: ${e.message}`);
    }
    log(`removed the routing block from ${target.file} (backup: ${path.basename(backup)})`);
    removed = true;
  }
  log(removed ? 'uninstalled.' : 'nothing to remove.');
}

function status() {
  const hookExists = fs.existsSync(HOOK_DEST);
  const xmCmdExists = fs.existsSync(XM_CMD_DEST);
  const xmPlanCmdExists = fs.existsSync(XM_PLAN_CMD_DEST)
    && fs.readFileSync(XM_PLAN_CMD_DEST, 'utf8').includes(XM_PLAN_MARKER);
  const settings = readSettings();
  const legacySkillOnly = hasHook(settings.hooks?.PreToolUse, HOOK_CMD_PRE, 'Skill') || hasHook(settings.hooks?.PostToolUse, HOOK_CMD_POST, 'Skill');
  log(`hook file        : ${hookExists ? HOOK_DEST : '(missing)'}`);
  log(`xm dispatcher    : ${xmCmdExists ? XM_CMD_DEST : '(missing)'}`);
  log(`xm-plan alias    : ${xmPlanCmdExists ? XM_PLAN_CMD_DEST : '(missing)'}`);
  // Opt-in, so it is reported but never counted toward `overall`.
  for (const target of ROUTING_TARGETS) log(`${target.label} routing: ${routingStatus(target)}`);
  // Exactly one executable registration per event is "registered"; more than one
  // runs the hook twice per call, none is missing.
  let hooksOk = true;
  for (const [event, command, matcher] of HOOK_REGISTRATIONS) {
    const count = countHook(settings.hooks?.[event], command);
    // The one executable registration must itself sit in the right matcher group;
    // a stray typeless entry in the right group plus an executable one elsewhere
    // is not "installed".
    const matched = countHook((settings.hooks?.[event] || []).filter((group) => sameMatcher(group, matcher)), command) === 1;
    const state = count === 1 && matched ? 'registered'
      : count > 1 ? `duplicate (${count} registrations — re-run xm setup)`
        : legacySkillOnly && event !== 'Stop' ? '(Skill-only — re-run xm setup to add Agent spans)'
          : event === 'Stop' && legacySkillOnly ? '(missing — re-run xm setup; sessions never close without it)'
            : '(missing)';
    if (state !== 'registered') hooksOk = false;
    log(`${event}${matcher ? `/${matcher}` : ''}`.padEnd(21) + `: ${state}`);
  }
  const ok = hookExists && xmCmdExists && xmPlanCmdExists && hooksOk;
  log(`overall          : ${ok ? 'OK' : 'NOT installed'}`);
  process.exit(ok ? 0 : 1);
}

// `xm setup --claude-md` reaches here without a subcommand. Only known install
// flags imply install: `xm init --dry-run` must still fail, not install.
const INSTALL_FLAGS = new Set(['--no-hooks', ...ROUTING_TARGETS.map((t) => t.flag)]);
const args = process.argv.slice(2);
const flagOnly = INSTALL_FLAGS.has(args[0]);
const cmd = flagOnly ? 'install' : (args[0] || 'install');
const flags = new Set(flagOnly ? args : args.slice(1));

switch (cmd) {
  case 'install':
    install({ withHooks: !flags.has('--no-hooks'), routingFlags: flags });
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
    process.stdout.write(`xm ${VERB} — install global hooks into ~/.claude/ (once per machine)\n\n`
      + `Usage:\n`
      + `  xm ${VERB}                 # install trace-session and relay auto-reply hooks globally\n`
      + `  xm ${VERB} --no-hooks      # skip hook install (CLI only)\n`
      + `  xm ${VERB} --claude-md     # also add the xm routing block to ~/.claude/CLAUDE.md\n`
      + `                           #   (later installs and xm update refresh it while it exists)\n`
      + `  xm ${VERB} --codex-md      # also add the xm routing block to ~/.codex/AGENTS.md\n`
      + `  xm ${VERB} status          # check install state\n`
      + `  xm ${VERB} uninstall       # remove hook + settings entries + routing block\n\n`
      + `To start a PROJECT (not a machine install):\n`
      + `  xm init <name>          # create .xm/build/projects/<name> + register it\n`
      + `  xm init . | --here      # name it after the current directory\n\n`
      + `Env:\n`
      + `  XM_HOOK_SRC   override hook source path\n`
      + `  XM_LIB        override lib root (used for resolving hook source)\n`);
    break;
  default:
    die(`unknown subcommand: ${cmd}. Try 'xm ${VERB} --help'.`);
}
