#!/usr/bin/env node

/**
 * xm-solver setup script
 * Initializes .xm/solver/ in the current working directory
 */

import { mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
const CWD = process.cwd();
const TARGET = join(CWD, '.xm', 'solver');

if (existsSync(TARGET)) {
  console.log('✅ .xm/solver/ already exists in this directory.');
  process.exit(0);
}

mkdirSync(TARGET, { recursive: true });
mkdirSync(join(TARGET, 'problems'), { recursive: true });

// Copy default config
const defaultConfig = join(PLUGIN_ROOT, 'lib', 'default-config.json');
if (existsSync(defaultConfig)) {
  copyFileSync(defaultConfig, join(TARGET, 'config.json'));
} else {
  writeFileSync(join(TARGET, 'config.json'), JSON.stringify({
    gates: {
      "intake-exit": "auto",
      "classify-exit": "human-verify",
      "solve-exit": "auto",
      "verify-exit": "human-verify",
      "close-exit": "auto"
    },
    solving: { max_iterations: 3, max_candidates: 5, parallel_agents: 3 }
  }, null, 2) + '\n');
}

console.log('✅ .xm/solver/ initialized.');
console.log(`   Config: ${join(TARGET, 'config.json')}`);
console.log('   Run: /xm-solver init "problem description"');
