// @ts-check

import { existsSync, readFileSync } from 'node:fs';
import { writeOverwrite } from './merge.mjs';

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}

function readMarketplace(path, seedName = 'personal') {
  if (!existsSync(path)) {
    return { name: seedName, interface: { displayName: seedName === 'personal' ? 'Personal' : 'xm Project' }, plugins: [] };
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`codex marketplace must be a JSON object: ${path}`);
  }
  if (typeof parsed.name !== 'string' || parsed.name.length === 0) {
    throw new Error(`codex marketplace is missing a non-empty name: ${path}`);
  }
  if (!Array.isArray(parsed.plugins)) {
    throw new Error(`codex marketplace plugins must be an array: ${path}`);
  }
  return parsed;
}

export function writeCodexMarketplaceEntry(path, entry, mode, seedName) {
  const marketplace = readMarketplace(path, seedName);
  const index = marketplace.plugins.findIndex((plugin) => plugin?.name === entry.name);
  if (index === -1) marketplace.plugins.push(entry);
  else marketplace.plugins[index] = entry;
  const result = writeOverwrite(path, JSON.stringify(marketplace, null, 2) + '\n', { mode });
  return { ...result, marketplaceName: marketplace.name, managedContent: canonicalJson(entry) };
}

export function removeCodexMarketplaceEntry(path, pluginName, mode) {
  if (!existsSync(path)) return { removed: false, action: 'unchanged' };
  const marketplace = readMarketplace(path);
  const nextPlugins = marketplace.plugins.filter((plugin) => plugin?.name !== pluginName);
  if (nextPlugins.length === marketplace.plugins.length) return { removed: false, action: 'unchanged' };
  marketplace.plugins = nextPlugins;
  const result = writeOverwrite(path, JSON.stringify(marketplace, null, 2) + '\n', { mode });
  return { removed: true, action: result.action };
}

export function readCodexMarketplaceEntry(path, pluginName) {
  if (!existsSync(path)) return null;
  const marketplace = readMarketplace(path);
  return marketplace.plugins.find((plugin) => plugin?.name === pluginName) ?? null;
}
