import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __filename_root = fileURLToPath(import.meta.url);
const __dirname_root = dirname(__filename_root);

const XM_GLOBAL = process.argv.includes('--global');
export const ROOT = process.env.X_BUILD_ROOT
  ? new URL('file://' + process.env.X_BUILD_ROOT).pathname
  : XM_GLOBAL
    ? join(homedir(), '.xm', 'build')
    : join(process.cwd(), '.xm', 'build');
