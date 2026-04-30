# xm version / update

## Commands

| Command | Description |
|---------|-------------|
| `xm version` | Compare installed plugin versions with latest available versions |
| `xm update` | Batch update all xm plugins |
| `xm update <plugin>` | Update a specific plugin only (e.g. `xm update x-build`) |

## xm version

Run the following bash command to show version comparison:

```bash
node -e "
const fs = require('fs');
const path = require('path');

const INSTALLED_PATH = path.join(process.env.HOME, '.claude/plugins/installed_plugins.json');
const MARKETPLACE_DIR = path.join(process.env.HOME, '.claude/plugins/marketplaces/xm:kit');
const MARKETPLACE_JSON = path.join(MARKETPLACE_DIR, '.claude-plugin/marketplace.json');

const installed = JSON.parse(fs.readFileSync(INSTALLED_PATH, 'utf8'));
const marketplace = JSON.parse(fs.readFileSync(MARKETPLACE_JSON, 'utf8'));

function semverCmp(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i]||0) > (pb[i]||0)) return 1;
    if ((pa[i]||0) < (pb[i]||0)) return -1;
  }
  return 0;
}

const available = {};
for (const p of marketplace.plugins) available[p.name] = p.version;

console.log('x-mesh Toolkit — Version Status\n');
console.log('  Plugin        Installed    Available    Status');
console.log('  ' + '─'.repeat(58));

const names = Object.keys(available).sort();
for (const name of names) {
  const key = name + '@xm';
  const entry = installed.plugins?.[key]?.[0];
  const inst = entry ? entry.version : '—';
  const avail = available[name];
  let status;
  if (!entry) status = '⬜ not installed';
  else if (inst === avail) status = '✅ latest';
  else if (semverCmp(inst, avail) > 0) status = '⚡ newer than available';
  else status = '🔄 update available';
  console.log('  ' + name.padEnd(14) + ' ' + inst.padEnd(12) + ' ' + avail.padEnd(12) + ' ' + status);
}
console.log();
"
```

Display the output to the user.

## xm update

**MANDATORY: Always execute steps 1→2→3→4→5 in order. Never skip step 1 (marketplace must be pulled before comparison) or step 2 (`claude plugin update` aborts on a single malformed entry in `known_marketplaces.json`, and v1.x → v2.x leftovers like `x-mesh-x-kit`, `x-kit`, `xm-kit` cause exactly this failure).**

1. Pull latest from remote (MUST run — do not skip):
```bash
cd ~/.claude/plugins/marketplaces/xm:kit && git pull origin main 2>&1
```

2. Pre-flight — sanitize `known_marketplaces.json` (MUST run — do not skip):

`claude plugin update` validates the entire registry before doing anything. A single entry without `source`/`lastUpdated` aborts every update. The v2.0.0 marketplace rename (`x-kit` → `xm`) left orphan entries on users who installed during the `x-mesh/x-kit`, `xm-kit`, or `xm:kit` README eras. The sanitizer auto-removes only entries that are unambiguously broken (missing `source` AND with an install dir that is absent or empty); anything else is flagged for manual review. On a parse error it exits non-zero so you can inspect the file before continuing.

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/sanitize-marketplaces.mjs"
```

3. Then update plugins. If a specific plugin name is given (e.g. `xm update x-build`), update only that one:
```bash
claude plugin update <plugin>@xm -s user
```

If no specific plugin is given, update ALL installed xm plugins by reading `installed_plugins.json` and running update for each:
```bash
node -e "
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const INSTALLED_PATH = path.join(process.env.HOME, '.claude/plugins/installed_plugins.json');
const installed = JSON.parse(fs.readFileSync(INSTALLED_PATH, 'utf8'));

const xmPlugins = Object.keys(installed.plugins || {}).filter(k => k.endsWith('@xm'));
const validKey = /^[a-zA-Z0-9@._-]+$/;
console.log('Updating ' + xmPlugins.length + ' xm plugins...\n');

for (const key of xmPlugins) {
  if (!validKey.test(key)) { console.error('  ⚠ Skipped invalid key: ' + key); continue; }
  console.log('  → ' + key);
  try {
    spawnSync('claude', ['plugin', 'update', key, '-s', 'user'], { stdio: 'inherit' });
  } catch (e) {
    console.error('  ⚠ Failed: ' + key);
  }
}
console.log('\n✅ Update complete. Run /reload-plugins to activate.');
"
```

4. After update, remind the user: "Run `/reload-plugins` or restart Claude Code to activate."

5. After plugins are updated, check if hooks need updating too:
```
💡 Hooks may have changed. Run `xm init` to update hooks and settings.
```
