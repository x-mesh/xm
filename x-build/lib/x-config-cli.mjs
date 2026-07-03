#!/usr/bin/env node

/**
 * x-config — xm shared config CLI
 * Thin entry point over cmdConfig() in shared-config.mjs.
 *
 * Usage: node x-config-cli.mjs [show | get <key> | set <key> <value> | reset]
 *        (no subcommand → interactive wizard)
 *
 * Flags:
 *   --local        operate on project .xm/config.json
 *   --global       operate on ~/.xm/config.json
 *   --lang <ko|en> output language (overrides XM_LANG / config lang / locale)
 *   Default scope: global (except budget → local)
 */

import { cmdConfig } from './shared-config.mjs';

const raw = process.argv.slice(2);
const flags = {};
const args = [];
for (let i = 0; i < raw.length; i++) {
  const a = raw[i];
  if (a === '--local') flags.local = true;
  else if (a === '--global') flags.global = true;
  else if (a === '--lang') flags.lang = raw[++i];
  else if (a.startsWith('--lang=')) flags.lang = a.slice('--lang='.length);
  else args.push(a);
}

try {
  await cmdConfig(args, flags);
} catch (err) {
  process.stderr.write(`xm config: ${err.message}\n`);
  process.exit(1);
}
