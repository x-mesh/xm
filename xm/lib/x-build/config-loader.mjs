import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ROOT } from './root.mjs';

export function loadSharedConfig() {
  const sharedPath = join(ROOT, '..', 'config.json');
  if (existsSync(sharedPath)) {
    try { return JSON.parse(readFileSync(sharedPath, 'utf8')); }
    catch (e) { process.stderr.write('[x-build] config parse error (' + sharedPath + '): ' + (e?.message || e) + '\n'); }
  }
  const globalPath = join(homedir(), '.xm', 'config.json');
  if (existsSync(globalPath)) {
    try { return JSON.parse(readFileSync(globalPath, 'utf8')); }
    catch (e) { process.stderr.write('[x-build] config parse error (' + globalPath + '): ' + (e?.message || e) + '\n'); }
  }
  return {};
}
