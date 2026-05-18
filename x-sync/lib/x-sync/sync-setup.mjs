#!/usr/bin/env node
/**
 * sync-setup.mjs — Configure x-sync credentials non-interactively.
 * Usage:
 *   node sync-setup.mjs --server-url <URL> --api-key <KEY> [--machine-id <ID>]
 *   node sync-setup.mjs --show
 *
 * For interactive setup, use the /xm:sync setup slash command which routes
 * through AskUserQuestion before calling this script.
 */

import { readSyncConfig, writeSyncConfig } from './sync-config.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[k.slice(2)] = true;
    } else {
      args[k.slice(2)] = next;
      i++;
    }
  }
  return args;
}

async function testConnection(url, key) {
  try {
    const res = await fetch(`${url}/dashboard/health`, {
      headers: { 'X-Api-Key': key },
      signal: AbortSignal.timeout(3000),
    });
    return res.ok ? res.status : `HTTP ${res.status}`;
  } catch (err) {
    return `error: ${err.message}`;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.show) {
    const cfg = readSyncConfig();
    const masked = { ...cfg, api_key: cfg.api_key ? '****' : null };
    console.log(JSON.stringify(masked, null, 2));
    return;
  }

  if (!args['server-url'] && !args['api-key'] && !args['machine-id']) {
    console.error('Usage: node sync-setup.mjs --server-url <URL> --api-key <KEY> [--machine-id <ID>]');
    console.error('       node sync-setup.mjs --show');
    console.error('');
    console.error('For interactive setup, use:  /xm:sync setup');
    process.exit(1);
  }

  const config = readSyncConfig();
  if (args['server-url']) config.server_url = args['server-url'];
  if (args['api-key']) config.api_key = args['api-key'];
  if (args['machine-id']) config.machine_id = args['machine-id'];

  writeSyncConfig(config);

  const masked = { ...config, api_key: config.api_key ? '****' : null };
  console.log('✅ Sync configured:');
  console.log(JSON.stringify(masked, null, 2));

  if (config.server_url && config.api_key) {
    const result = await testConnection(config.server_url, config.api_key);
    if (result === 200) {
      console.log('✅ 서버 연결 확인');
    } else {
      console.log(`❌ 서버 연결 실패 (${result})`);
    }
  }
}

main().catch((err) => {
  console.error(`[x-sync setup] ${err.message}`);
  process.exit(1);
});
