# xm init

## Commands

| Command | Description |
|---------|-------------|
| `xm init` | Install hooks + settings into `.claude/` and install x-sync client. Skips hook+settings steps automatically if a global install is detected in `~/.claude/settings.json`. |
| `xm init --dry-run` | Preview all changes without writing anything |
| `xm init --skip-sync` | Install only hooks + settings, skip x-sync |
| `xm init --with-server` | Also install x-sync server (requires Bun) |
| `xm init --force-local` | Install per-project even when global xm is detected (trace events will fire twice — use only for explicit team-shared `.claude/` setups) |
| `xm init --rollback` | Restore `.claude/settings.json` from the most recent backup |

## Status Labels

All install steps emit one of these labels per item for consistent feedback:

| Label | Meaning |
|-------|---------|
| `➕ installed` | New item written |
| `🔄 updated` | Existing item replaced with newer content |
| `✅ already installed` | Content matches, no change |
| `🚫 skipped` | User flag skipped this step |
| `🔍 would install/update` | Dry-run preview only |

## xm init

**Dry-run mode** (`--dry-run`): Execute steps 1-3 in preview mode — compute diffs, do NOT write files, do NOT run curl. Print `🔍 would <action>` lines and the full diff for settings.json. Exit with `📋 Dry run complete. Re-run without --dry-run to apply.`

**Normal mode**: Run step 0.5 (global detection) → steps 1-2 (hooks + settings, with auto-backup) → step 3 (x-sync client, unless `--skip-sync`) → step 4 if `--with-server`.

**Global detection contract:** if `~/.claude/settings.json` already wires a hook whose command references `xm-trace-session.mjs`, steps 0-2 are skipped by default (the global hook already handles trace events; installing per-project would duplicate them). Pass `--force-local` to override — used only for team-shared `.claude/` directories that must ship their own hook.

**Argument → env mapping:** when invoking the bash block below, the calling agent MUST translate flags into env vars: `--dry-run → DRY_RUN=1`, `--force-local → FORCE_LOCAL=1`. Flags not mapped here (`--skip-sync`, `--with-server`, `--rollback`) gate the step sequence, not the embedded node script.

**Step 0: Backup settings.json** (normal mode only, before any write)

Before touching `.claude/settings.json`, copy it to `.claude/settings.json.backup-{ISO8601}`. Skip if the file doesn't exist. Keep only the 5 most recent backups (prune oldest).

**Step 1-2 implementation:**

Pass `DRY_RUN=1` env when `--dry-run` is active.

```bash
DRY_RUN="${DRY_RUN:-0}" FORCE_LOCAL="${FORCE_LOCAL:-0}" node -e "
const fs = require('fs');
const path = require('path');

const DRY = process.env.DRY_RUN === '1';
const FORCE_LOCAL = process.env.FORCE_LOCAL === '1';
const MARKETPLACE = path.join(process.env.HOME, '.claude/plugins/marketplaces/xm:kit');
const PROJECT = process.cwd();

// Step 0.5: Global install detection
// If ~/.claude/settings.json already references the xm trace-session hook,
// per-project install would duplicate hook firings. Skip by default; --force-local overrides.
const globalSettingsPath = path.join(process.env.HOME, '.claude/settings.json');
let globalInstalled = false;
if (fs.existsSync(globalSettingsPath)) {
  try {
    const globalSettings = JSON.parse(fs.readFileSync(globalSettingsPath, 'utf8'));
    const allEntries = Object.values(globalSettings.hooks || {}).flat();
    globalInstalled = allEntries.some((entry) =>
      Array.isArray(entry && entry.hooks) &&
      entry.hooks.some((h) => /xm-trace-session\.mjs/.test((h && h.command) || ''))
    );
  } catch {}
}

if (globalInstalled && !FORCE_LOCAL) {
  const label = DRY ? '🔍 would skip        ' : '⏭  skipped           ';
  console.log('  ' + label + 'per-project hook+settings (global xm detected)');
  console.log('     ~/.claude/settings.json already wires xm-trace-session.mjs.');
  console.log('     Re-run with --force-local to install anyway (events will fire twice).');
  console.log(DRY ? '\n📋 Dry run complete (no project changes planned). x-sync check still runs below.' : '\n✅ Per-project install skipped — global hook is active.');
  process.exit(0);
}

if (globalInstalled && FORCE_LOCAL) {
  console.log('  ⚠ global xm detected, --force-local overrides — trace events will duplicate');
}

// Step 0: Backup settings.json (skip in dry-run)
const settingsPath = path.join(PROJECT, '.claude/settings.json');
if (!DRY && fs.existsSync(settingsPath)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = settingsPath + '.backup-' + stamp;
  fs.copyFileSync(settingsPath, backupPath);
  console.log('  💾 backup → ' + path.basename(backupPath));

  // Prune to 5 most recent backups
  const dir = path.dirname(settingsPath);
  const backups = fs.readdirSync(dir)
    .filter(f => f.startsWith('settings.json.backup-'))
    .sort()
    .reverse();
  for (const old of backups.slice(5)) {
    fs.unlinkSync(path.join(dir, old));
    console.log('  🗑  pruned ' + old);
  }
}

// Step 1: Copy hooks
const hooksDir = path.join(PROJECT, '.claude/hooks');
if (!DRY) fs.mkdirSync(hooksDir, { recursive: true });

// trace-session.mjs is project-agnostic; block-marketplace-copy.mjs is
// xm-repo-specific and intentionally omitted from per-project install.
const hookFiles = ['trace-session.mjs'];
for (const f of hookFiles) {
  const src = path.join(MARKETPLACE, '.claude/hooks', f);
  const dst = path.join(hooksDir, f);
  if (!fs.existsSync(src)) continue;
  const srcContent = fs.readFileSync(src, 'utf8');
  const exists = fs.existsSync(dst);
  const dstContent = exists ? fs.readFileSync(dst, 'utf8') : '';
  if (srcContent === dstContent) {
    console.log('  ✅ already installed  ' + f);
  } else if (DRY) {
    console.log('  🔍 would ' + (exists ? 'update' : 'install') + '    ' + f);
  } else {
    fs.writeFileSync(dst, srcContent);
    console.log('  ' + (exists ? '🔄 updated           ' : '➕ installed         ') + f);
  }
}

// Step 2: Merge hook entries into settings.json
const srcSettingsPath = path.join(MARKETPLACE, '.claude/settings.json');
if (fs.existsSync(srcSettingsPath)) {
  const srcSettings = JSON.parse(fs.readFileSync(srcSettingsPath, 'utf8'));
  let dstSettings = {};
  if (fs.existsSync(settingsPath)) {
    try { dstSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
  }

  const before = JSON.stringify(dstSettings, null, 2);
  const srcHooks = srcSettings.hooks || {};
  if (!dstSettings.hooks) dstSettings.hooks = {};

  // Skip entries that reference xm-repo-specific hooks (not distributed to other projects).
  const REPO_ONLY_HOOK_RE = /block-marketplace-copy\.mjs/;
  const refsRepoOnly = (entry) =>
    Array.isArray(entry?.hooks) && entry.hooks.some((h) => REPO_ONLY_HOOK_RE.test(h?.command || ''));

  for (const [phase, entries] of Object.entries(srcHooks)) {
    if (!dstSettings.hooks[phase]) dstSettings.hooks[phase] = [];
    for (const entry of entries) {
      if (refsRepoOnly(entry)) continue;
      const present = dstSettings.hooks[phase].some(
        e => e.matcher === entry.matcher && JSON.stringify(e.hooks) === JSON.stringify(entry.hooks)
      );
      if (present) {
        console.log('  ✅ already installed  settings.json[' + phase + '] ' + entry.matcher);
      } else {
        dstSettings.hooks[phase].push(entry);
        console.log('  ' + (DRY ? '🔍 would add         ' : '➕ added             ') + 'settings.json[' + phase + '] ' + entry.matcher);
      }
    }
  }

  const after = JSON.stringify(dstSettings, null, 2);
  if (DRY && before !== after) {
    console.log('\n  --- settings.json diff (preview) ---');
    console.log(after);
    console.log('  ---');
  } else if (!DRY && before !== after) {
    fs.writeFileSync(settingsPath, after + '\n');
  }
} else {
  console.log('  ⚠ No source settings.json found in marketplace');
}

console.log(DRY ? '\n📋 Dry run complete. Re-run without --dry-run to apply.' : '\n✅ Hooks and settings installed.');
"
```

**Step 3: Install x-sync client** (skip if user passed `--skip-sync`)

First check if already installed: `command -v x-sync >/dev/null 2>&1 && x-sync --version 2>/dev/null`. If present, print `✅ already installed  x-sync` and move on.

Otherwise run:

```bash
curl -fsSL https://raw.githubusercontent.com/x-mesh/xm/main/x-sync/install.sh | bash -s client
```

After install, remind the user:
```
💡 Run `x-sync setup` to configure server URL and API key.
   Ensure $HOME/.local/bin is in your PATH.
```

**Step 4: Install x-sync server** (only when `--with-server` is passed)

```bash
curl -fsSL https://raw.githubusercontent.com/x-mesh/xm/main/x-sync/install.sh | bash -s server
```

Display the output of each step to the user. Final line: `✅ xm init complete.` (or the dry-run message).

**Step 3 dry-run:** Check `command -v x-sync` — if present, print `✅ already installed  x-sync`. Otherwise print `🔍 would install     x-sync client (curl ... | bash -s client)`. Do NOT execute curl.

## xm init --rollback

Restore `.claude/settings.json` from the most recent backup.

```bash
node -e "
const fs = require('fs');
const path = require('path');

const dir = path.join(process.cwd(), '.claude');
const settingsPath = path.join(dir, 'settings.json');
if (!fs.existsSync(dir)) { console.log('⚠ No .claude directory.'); process.exit(1); }

const backups = fs.readdirSync(dir)
  .filter(f => f.startsWith('settings.json.backup-'))
  .sort()
  .reverse();

if (backups.length === 0) { console.log('⚠ No backup found.'); process.exit(1); }

const latest = backups[0];
fs.copyFileSync(path.join(dir, latest), settingsPath);
console.log('✅ Restored settings.json from ' + latest);
console.log('  Remaining backups: ' + backups.length);
"
```
