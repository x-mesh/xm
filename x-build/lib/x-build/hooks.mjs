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
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(settingsPath(root), JSON.stringify(settings, null, 2) + '\n', 'utf8');
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
  mkdirSync(dest, { recursive: true });
  for (const f of HOOK_FILES) {
    const s = join(src, f);
    if (!existsSync(s)) throw new Error(`missing template ${s} (plugin templates/hooks not found)`);
    writeFileSync(join(dest, f), readFileSync(s, 'utf8'), 'utf8');
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
