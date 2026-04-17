# x-kit version / update

## Commands

| Command | Description |
|---------|-------------|
| `x-kit version` | Compare installed plugin versions with latest available versions |
| `x-kit update` | Batch update all x-kit plugins |
| `x-kit update <plugin>` | Update a specific plugin only (e.g. `x-kit update x-build`) |

## x-kit version

Run the following bash command to show version comparison:

```bash
node -e "
const fs = require('fs');
const path = require('path');

const INSTALLED_PATH = path.join(process.env.HOME, '.claude/plugins/installed_plugins.json');
const MARKETPLACE_DIR = path.join(process.env.HOME, '.claude/plugins/marketplaces/x-kit');
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
  const key = name + '@x-kit';
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

## x-kit update

**MANDATORY: Always execute steps 1→2→3 in order. Never skip step 1 even if you think versions are current — the marketplace is a git clone and must be pulled before any comparison.**

1. Pull latest from remote (MUST run — do not skip):
```bash
cd ~/.claude/plugins/marketplaces/x-kit && git pull origin main 2>&1
```

2. Then update plugins. If a specific plugin name is given (e.g. `x-kit update x-build`), update only that one:
```bash
claude plugin update <plugin>@x-kit -s user
```

If no specific plugin is given, update ALL installed x-kit plugins by reading `installed_plugins.json` and running update for each:
```bash
node -e "
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const INSTALLED_PATH = path.join(process.env.HOME, '.claude/plugins/installed_plugins.json');
const installed = JSON.parse(fs.readFileSync(INSTALLED_PATH, 'utf8'));

const xmPlugins = Object.keys(installed.plugins || {}).filter(k => k.endsWith('@x-kit'));
const validKey = /^[a-zA-Z0-9@._-]+$/;
console.log('Updating ' + xmPlugins.length + ' x-kit plugins...\n');

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

3. After update, remind the user: "Run `/reload-plugins` or restart Claude Code to activate."

4. After plugins are updated, check if hooks need updating too:
```
💡 Hooks may have changed. Run `x-kit init` to update hooks and settings.
```
