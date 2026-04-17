# x-kit init

## Commands

| Command | Description |
|---------|-------------|
| `x-kit init` | Install hooks + settings into `.claude/` and install x-sync client |
| `x-kit init --dry-run` | Preview all changes without writing anything |
| `x-kit init --skip-sync` | Install only hooks + settings, skip x-sync |
| `x-kit init --with-server` | Also install x-sync server (requires Bun) |
| `x-kit init --rollback` | Restore `.claude/settings.json` from the most recent backup |

## Status Labels

All install steps emit one of these labels per item for consistent feedback:

| Label | Meaning |
|-------|---------|
| `➕ installed` | New item written |
| `🔄 updated` | Existing item replaced with newer content |
| `✅ already installed` | Content matches, no change |
| `🚫 skipped` | User flag skipped this step |
| `🔍 would install/update` | Dry-run preview only |

## x-kit init

**Dry-run mode** (`--dry-run`): Execute steps 1-3 in preview mode — compute diffs, do NOT write files, do NOT run curl. Print `🔍 would <action>` lines and the full diff for settings.json. Exit with `📋 Dry run complete. Re-run without --dry-run to apply.`

**Normal mode**: Run steps 1-2 (hooks + settings, with auto-backup) → step 3 (x-sync client, unless `--skip-sync`) → step 4 if `--with-server`.

**Step 0: Backup settings.json** (normal mode only, before any write)

Before touching `.claude/settings.json`, copy it to `.claude/settings.json.backup-{ISO8601}`. Skip if the file doesn't exist. Keep only the 5 most recent backups (prune oldest).

**Step 1-2 implementation:**

Pass `DRY_RUN=1` env when `--dry-run` is active.

```bash
DRY_RUN="${DRY_RUN:-0}" node -e "
const fs = require('fs');
const path = require('path');

const DRY = process.env.DRY_RUN === '1';
const MARKETPLACE = path.join(process.env.HOME, '.claude/plugins/marketplaces/x-kit');
const PROJECT = process.cwd();

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
// x-kit-repo-specific and intentionally omitted from per-project install.
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

  // Skip entries that reference x-kit-repo-specific hooks (not distributed to other projects).
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
curl -fsSL https://raw.githubusercontent.com/x-mesh/x-kit/main/x-sync/install.sh | bash -s client
```

After install, remind the user:
```
💡 Run `x-sync setup` to configure server URL and API key.
   Ensure $HOME/.local/bin is in your PATH.
```

**Step 4: Install x-sync server** (only when `--with-server` is passed)

```bash
curl -fsSL https://raw.githubusercontent.com/x-mesh/x-kit/main/x-sync/install.sh | bash -s server
```

Display the output of each step to the user. Final line: `✅ x-kit init complete.` (or the dry-run message).

**Step 3 dry-run:** Check `command -v x-sync` — if present, print `✅ already installed  x-sync`. Otherwise print `🔍 would install     x-sync client (curl ... | bash -s client)`. Do NOT execute curl.

## x-kit init --rollback

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
