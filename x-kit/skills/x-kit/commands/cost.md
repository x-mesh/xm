# x-kit cost

## Commands

| Command | Description |
|---------|-------------|
| `x-kit cost` | Show accumulated cost from metrics ledger |
| `x-kit cost --session` | Show cost for current session only |

## x-kit cost

Read `.xm/build/metrics/sessions.jsonl` and aggregate `cost_usd` fields:

```bash
node -e "
const fs = require('fs');
const path = require('path');
const mp = path.join(process.cwd(), '.xm/build/metrics/sessions.jsonl');
if (!fs.existsSync(mp)) { console.log('No metrics data yet.'); process.exit(0); }
const lines = fs.readFileSync(mp, 'utf8').trim().split('\n').filter(Boolean);
let total = 0; const byType = {}; const byModel = {};
for (const line of lines) {
  try {
    const m = JSON.parse(line);
    if (typeof m.cost_usd === 'number') {
      total += m.cost_usd;
      byType[m.type] = (byType[m.type] || 0) + m.cost_usd;
      if (m.model) byModel[m.model] = (byModel[m.model] || 0) + m.cost_usd;
    }
  } catch {}
}
console.log('💰 x-kit Cost Summary\n');
console.log('  Total: \$' + total.toFixed(4));
console.log('\n  By type:');
for (const [k, v] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
  console.log('    ' + k.padEnd(20) + '\$' + v.toFixed(4));
}
if (Object.keys(byModel).length) {
  console.log('\n  By model:');
  for (const [k, v] of Object.entries(byModel).sort((a, b) => b[1] - a[1])) {
    console.log('    ' + k.padEnd(12) + '\$' + v.toFixed(4));
  }
}
"
```
