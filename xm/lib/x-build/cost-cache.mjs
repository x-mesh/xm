/** Cache lifecycle commands for `xm cost cache`. */

import { join } from 'node:path';
import { ROOT, loadSharedConfig, parseOptions } from './core.mjs';
import { gcCache } from '../cost/index.mjs';

function numericOption(value, name) {
  if (value === undefined) return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) throw new TypeError(`${name} must be a positive finite number`);
  return numeric;
}

export function cmdCostCache(args) {
  if (args[0] !== 'gc') {
    console.error('Usage: xm cost cache gc [--dry-run] [--model model] [--ttl-days days] [--cache-dir path] [--json]');
    process.exitCode = 1;
    return null;
  }
  const { opts, positional } = parseOptions(args.slice(1));
  if (positional.length) {
    console.error('Usage: xm cost cache gc [--dry-run] [--model model] [--ttl-days days] [--cache-dir path] [--json]');
    process.exitCode = 1;
    return null;
  }
  try {
    const config = loadSharedConfig();
    const result = gcCache({
      cacheDir: typeof opts['cache-dir'] === 'string' ? opts['cache-dir'] : join(ROOT, '..', 'cache'),
      model: typeof opts.model === 'string' ? opts.model : undefined,
      ttlDays: numericOption(opts['ttl-days'], '--ttl-days'),
      config,
      dryRun: opts['dry-run'] === true,
    });
    if (opts.json === true) console.log(JSON.stringify(result));
    else {
      const prefix = result.dry_run ? 'Cache GC dry-run' : 'Cache GC';
      console.log(`${prefix}: pruned ${result.pruned}, compacted ${result.index_rows_before} → ${result.index_rows_after} index rows`);
      if (result.retained_unverifiable) console.log(`Retained ${result.retained_unverifiable} timestamp-unverifiable entries`);
    }
    return result;
  } catch (error) {
    console.error(`xm cost cache gc: ${error?.message || error}`);
    process.exitCode = 1;
    return null;
  }
}
