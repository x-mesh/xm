/**
 * x-build/hooks — `x-build hooks <install|uninstall|status>`.
 *
 * Installs the two native Claude Code blocking hooks (scope-guard on PreToolUse,
 * stop-gate on Stop) into the project's .claude/, making x-build's review-fix scope
 * and Critical/High obligation machine-enforced instead of prompt convention (빅뱃4).
 * The settings.json merge is non-destructive and idempotent.
 */

import {
  join, existsSync, readFileSync, writeFileSync, mkdirSync, C, repoRoot, PLUGIN_ROOT,
} from './core.mjs';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, sep } from 'node:path';

// Refuse to write anywhere that resolves OUTSIDE the project. lstat'ing only the leaf
// hook file missed a symlinked `.claude` or `.claude/hooks` DIRECTORY, through which
// mkdir + writeFileSync happily escape the repo (re-review N1, codex: critical). Resolve
// the nearest EXISTING ancestor (before any mkdir) and require it to stay under root.
function assertInsideRepo(target, root) {
  const realRoot = realpathSync(root);
  let probe = target;
  // lstat-based existence: existsSync FOLLOWS symlinks, so a DANGLING link at
  // .claude/hooks looked "absent", skipped the check, and later died with a raw EEXIST
  // instead of the intended refusal (re-review L2). lexists() sees the link itself.
  while (!lexists(probe) && dirname(probe) !== probe) probe = dirname(probe);
  let real;
  try {
    real = realpathSync(probe);
  } catch (e) {
    // A dangling symlink lstat's fine but realpath's ENOENT — refuse, don't leak errno.
    if (e.code === 'ENOENT') throw new Error(`${probe} is a broken symlink — refusing to write. Remove it and re-run.`);
    throw e;
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new Error(`${target} resolves outside the project (${real}) — refusing to write. Remove the symlink and re-run.`);
  }
}

function lexists(p) {
  try { lstatSync(p); return true; } catch { return false; }
}

function isSymlink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

// Scripts shipped with the plugin, copied verbatim into <repo>/.claude/hooks/.
const HOOK_FILES = ['hook-state.mjs', 'xm-build-scope-guard.mjs', 'xm-build-stop-gate.mjs'];

// The exact command strings we own — the identity used for idempotency + uninstall.
const SCOPE_CMD = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/xm-build-scope-guard.mjs"';
const STOP_CMD = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/xm-build-stop-gate.mjs"';

function templateHooksDir() { return join(PLUGIN_ROOT, 'templates', 'hooks'); }
function settingsPath(root) { return join(root, '.claude', 'settings.json'); }

function readSettings(root) {
  const p = settingsPath(root);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    // Loud fail (L6): never silently overwrite a settings file we can't parse.
    throw new Error(`.claude/settings.json is not valid JSON (${e.message}) — fix it before running hooks install`);
  }
}

// True when `event` already contains an entry whose hooks list carries `cmd`.
function hasCommand(settings, event, cmd) {
  const entries = settings?.hooks?.[event];
  if (!Array.isArray(entries)) return false;
  return entries.some(e => Array.isArray(e.hooks) && e.hooks.some(h => h && h.command === cmd));
}

function writeSettings(root, settings) {
  // settings.json is the THIRD write target and was left unguarded while .claude/hooks/
  // and the hook files were protected — a symlink here (or on .claude/) still wrote
  // straight through to a file outside the project (re-review R4, the other half of F5/N1).
  const claudeDir = join(root, '.claude');
  assertInsideRepo(claudeDir, root);
  mkdirSync(claudeDir, { recursive: true });
  const p = settingsPath(root);
  if (isSymlink(p)) throw new Error(`${p} is a symlink — refusing to write through it. Remove it and re-run.`);
  writeFileSync(p, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

export function cmdHooks(args) {
  const sub = args[0] || 'status';
  const root = repoRoot();
  try {
    if (sub === 'install') return installHooks(root);
    if (sub === 'uninstall') return uninstallHooks(root);
    if (sub === 'status') return statusHooks(root);
  } catch (e) {
    console.error(`${C.red}✗ hooks ${sub}: ${e.message}${C.reset}`);
    process.exitCode = 1;
    return;
  }
  console.error(`Usage: x-build hooks <install|uninstall|status>`);
  process.exitCode = 1;
}

function installHooks(root) {
  const src = templateHooksDir();
  const dest = join(root, '.claude', 'hooks');
  // BEFORE mkdir: a symlinked .claude/ would otherwise have mkdir create the tree at the
  // link's target and every write land outside the project.
  assertInsideRepo(dest, root);
  mkdirSync(dest, { recursive: true });
  // Validate EVERY destination before writing ANY of them. Checking inside the write
  // loop left a half-installed .claude/hooks when a later file turned out to be a
  // symlink — earlier files already overwritten, settings.json never merged (re-review L1).
  // Never write THROUGH a symlink either: writeFileSync follows it, so a link planted at
  // .claude/hooks/<name>.mjs would let a repo overwrite a file outside the project (F5).
  for (const f of HOOK_FILES) {
    if (!existsSync(join(src, f))) throw new Error(`missing template ${join(src, f)} (plugin templates/hooks not found)`);
    const d = join(dest, f);
    if (isSymlink(d)) throw new Error(`${d} is a symlink — refusing to write through it. Remove it and re-run.`);
  }
  // settings.json is written LAST but must be validated FIRST: checking it inside
  // writeSettings meant a symlinked settings.json aborted the install only after every
  // hook file had already been overwritten — a half-install again (re-review R5).
  const sp = settingsPath(root);
  if (isSymlink(sp)) throw new Error(`${sp} is a symlink — refusing to write through it. Remove it and re-run.`);

  for (const f of HOOK_FILES) {
    writeFileSync(join(dest, f), readFileSync(join(src, f), 'utf8'), 'utf8');
  }

  const settings = readSettings(root);
  settings.hooks = settings.hooks || {};
  let added = 0;
  if (!hasCommand(settings, 'PreToolUse', SCOPE_CMD)) {
    settings.hooks.PreToolUse = settings.hooks.PreToolUse || [];
    settings.hooks.PreToolUse.push({ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: SCOPE_CMD }] });
    added++;
  }
  if (!hasCommand(settings, 'Stop', STOP_CMD)) {
    settings.hooks.Stop = settings.hooks.Stop || [];
    settings.hooks.Stop.push({ hooks: [{ type: 'command', command: STOP_CMD }] });
    added++;
  }
  writeSettings(root, settings);

  console.log(`${C.green}✓ x-build hooks installed${C.reset} — ${added} settings entr${added === 1 ? 'y' : 'ies'} added, ${HOOK_FILES.length} scripts in .claude/hooks/`);
  console.log(`  ${C.dim}scope-guard (PreToolUse) + stop-gate (Stop). Bypass any run with XM_BUILD_HOOKS_OFF=1.${C.reset}`);
}

function uninstallHooks(root) {
  const settings = readSettings(root);
  let removed = 0;
  for (const [event, cmd] of [['PreToolUse', SCOPE_CMD], ['Stop', STOP_CMD]]) {
    const entries = settings?.hooks?.[event];
    if (!Array.isArray(entries)) continue;
    const before = entries.length;
    // Strip ONLY our command from each entry's hooks list, then drop entries left
    // empty — a shared entry (e.g. block-marketplace-copy under the same matcher)
    // keeps its own command and survives.
    settings.hooks[event] = entries
      .map(e => (Array.isArray(e.hooks) ? { ...e, hooks: e.hooks.filter(h => !h || h.command !== cmd) } : e))
      .filter(e => !Array.isArray(e.hooks) || e.hooks.length > 0);
    removed += before - settings.hooks[event].length;
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  writeSettings(root, settings);
  console.log(`${C.green}✓ x-build hooks uninstalled${C.reset} — removed ${removed} settings entr${removed === 1 ? 'y' : 'ies'} (scripts left in .claude/hooks/; other hooks untouched)`);
}

function statusHooks(root) {
  const settings = readSettings(root);
  const scope = hasCommand(settings, 'PreToolUse', SCOPE_CMD);
  const stop = hasCommand(settings, 'Stop', STOP_CMD);
  const mark = (on) => (on ? `${C.green}installed${C.reset}` : `${C.dim}not installed${C.reset}`);
  console.log(`x-build hooks — scope-guard: ${mark(scope)}, stop-gate: ${mark(stop)}`);
  process.exitCode = scope && stop ? 0 : 1;
}
