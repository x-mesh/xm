#!/usr/bin/env node

/**
 * x-config — xm shared config CLI
 * Thin entry point over cmdConfig() in shared-config.mjs.
 *
 * Usage: node x-config-cli.mjs [show | get <key> | set <key> <value> | reset]
 *        (no subcommand → interactive wizard)
 *
 * Flags:
 *   --local    operate on project .xm/config.json
 *   --global   operate on ~/.xm/config.json
 *   Default scope: global (except budget → local)
 */

import { cmdConfig } from './shared-config.mjs';

const raw = process.argv.slice(2);
const flags = {};
const args = [];
for (const a of raw) {
  if (a === '--local') flags.local = true;
  else if (a === '--global') flags.global = true;
  else args.push(a);
}

try {
  await cmdConfig(args, flags);
} catch (err) {
  process.stderr.write(`xm config: ${err.message}\n`);
  process.exit(1);
}
