#!/usr/bin/env node

/**
 * x-build setup script
 * Initializes .xm/build/ in the current working directory
 * (aligned with CLI ROOT resolution: cwd/.xm/build/)
 */

import { mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
const CWD = process.cwd();
const TARGET = join(CWD, '.xm', 'build');

if (existsSync(TARGET)) {
  console.log('✅ .xm/build/ already exists in this directory.');
  process.exit(0);
}

mkdirSync(TARGET, { recursive: true });
mkdirSync(join(TARGET, 'projects'), { recursive: true });

// Copy default config to shared .xm/ location (where CLI reads it)
const sharedConfig = join(CWD, '.xm', 'config.json');
if (!existsSync(sharedConfig)) {
  const defaultConfig = join(PLUGIN_ROOT, 'lib', 'default-config.json');
  if (existsSync(defaultConfig)) {
    copyFileSync(defaultConfig, sharedConfig);
  } else {
    writeFileSync(sharedConfig, JSON.stringify({
      gates: {
        "research-exit": "human-verify",
        "plan-exit": "decision",
        "execute-exit": "auto",
        "verify-exit": "quality",
        "close-exit": "auto"
      }
      // No execution.* here: config-schema.mjs lists it among the dead keys and
      // default-config.json no longer carries it. Writing it back in the fallback
      // path recreated a setting nothing reads and users could mistake for real.
    }, null, 2) + '\n');
  }
}

console.log('✅ .xm/build/ initialized.');
console.log(`   Config: ${sharedConfig}`);
console.log('   Run: /x-build init <project-name>');
