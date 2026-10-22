import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { resolveXmRoot } from './xm-root.mjs';

const __filename_root = fileURLToPath(import.meta.url);
const __dirname_root = dirname(__filename_root);

const XM_GLOBAL = process.argv.includes('--global');
let defaultRoot;

// X_BUILD_ROOT is read on every call. A root bound at first import kept
// whatever the first importer saw, so a test that set X_BUILD_ROOT after another
// test file had loaded this module read and deleted the repository's .xm/build.
export function buildRoot() {
  if (process.env.X_BUILD_ROOT) return new URL('file://' + process.env.X_BUILD_ROOT).pathname;
  defaultRoot ??= XM_GLOBAL ? join(homedir(), '.xm', 'build') : join(resolveXmRoot(), 'build');
  return defaultRoot;
}
