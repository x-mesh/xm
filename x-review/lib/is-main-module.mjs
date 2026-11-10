import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Node resolves symlinks in import.meta.url but keeps process.argv[1] as typed,
// so a plain comparison is false for a symlinked install (e.g. a relocated
// ~/.codex) and the CLI exits 0 without output.
export function isMainModule(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch (error) {
    // argv[1] is not a file path when a runner (e.g. `bun test`) imports this module.
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
