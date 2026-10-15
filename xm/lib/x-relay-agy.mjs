import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveSessionFiles } from './x-relay-live.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function agyTransport() {
  const root = process.env.XM_RELAY_AGY_DATA_DIR || join(homedir(), '.gemini', 'antigravity-cli');
  const binary = process.env.XM_RELAY_AGY_AGENTAPI_BIN || join(root, 'bin', 'agentapi');
  const address = process.env.ANTIGRAVITY_LS_ADDRESS;
  if (!address) return { available: false, reason: 'AGY agentapi requires ANTIGRAVITY_LS_ADDRESS from the running AGY backend.' };
  const match = /^(localhost|127\.0\.0\.1|\[::1\]):([0-9]+)$/.exec(address);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) return { available: false, reason: 'AGY backend address must be a local loopback host:port.' };
  try {
    if (!statSync(binary).isFile()) throw new Error('not a file');
    accessSync(binary, constants.X_OK);
  } catch { return { available: false, reason: 'AGY agentapi executable is unavailable.' }; }
  return { available: true, binary };
}

export function agyApi(args) {
  const transport = agyTransport();
  if (!transport.available) throw new Error(transport.reason);
  const result = spawnSync(transport.binary, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('AGY agentapi command failed');
  let output;
  try { output = JSON.parse(result.stdout); }
  catch { throw new Error('AGY agentapi returned invalid JSON'); }
  if (!output || typeof output !== 'object' || Array.isArray(output) || output.error) throw new Error(output?.error || 'AGY agentapi rejected the request');
  if (!output.response || typeof output.response !== 'object' || Array.isArray(output.response)) throw new Error('AGY agentapi returned no response');
  return output.response;
}

export function verifyAgyRecipient(sessionId) {
  const response = agyApi(['get-conversation-metadata', sessionId]);
  const metadata = response.conversationMetadata?.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('AGY backend did not confirm the recipient conversation');
  if (metadata.conversationId && metadata.conversationId !== sessionId) throw new Error('AGY backend returned a different conversation');
}

function workspacePaths(value) {
  try {
    const uris = JSON.parse(value || '[]');
    if (!Array.isArray(uris)) return [];
    return uris.flatMap(uri => {
      try {
        const url = new URL(uri);
        return url.protocol === 'file:' && !url.hostname ? [fileURLToPath(url)] : [];
      } catch { return []; }
    });
  } catch { return []; }
}

export function agySessions({ matchesProject = null, liveFiles = liveSessionFiles } = {}) {
  const root = process.env.XM_RELAY_AGY_DATA_DIR || join(homedir(), '.gemini', 'antigravity-cli');
  const database = join(root, 'conversation_summaries.db');
  const cachePath = join(root, 'cache', 'last_conversations.json');
  const cached = new Map();
  const notes = [];
  const live = liveFiles(join(root, 'presence'), 'agy');
  const transport = agyTransport();
  if (!live.size) return { ok: true, provider: 'agy', sessions: [], partial: false, notes,
    note: 'Only conversations held open by a running local AGY process are listed.' };
  let cacheAvailable = false;
  if (existsSync(cachePath)) {
    try {
      const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (!cache || typeof cache !== 'object' || Array.isArray(cache)) throw new Error('expected a workspace map');
      cacheAvailable = true;
      for (const [cwd, id] of Object.entries(cache)) {
        if (!UUID.test(id || '') || !cwd.startsWith('/')) continue;
        cached.set(id, [...(cached.get(id) || []), cwd]);
      }
    } catch (error) { notes.push(`AGY workspace cache unavailable: ${error.message}`); }
  }
  let rows = [];
  let partial = true;
  if (existsSync(database)) {
    const query = 'SELECT conversation_id, title, workspace_uris, status, last_modified_time FROM conversation_summaries WHERE killed = 0 AND nesting_depth = 0 AND parent_conversation_id = \'\' AND app_data_dir = \'antigravity-cli\' ORDER BY last_modified_time DESC';
    const result = spawnSync('sqlite3', ['-readonly', '-json', database, query], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024,
    });
    try {
      if (result.error || result.status !== 0) throw new Error((result.stderr || result.error?.message || 'sqlite3 failed').trim());
      rows = JSON.parse(result.stdout || '[]');
      if (!Array.isArray(rows)) throw new Error('expected a conversation list');
      partial = false;
    } catch (error) { notes.push(`AGY summaries unavailable: ${error.message}`); }
  }
  if (partial) {
    if (!cacheAvailable) throw new Error('AGY conversation inventory unavailable: no readable summaries or workspace cache');
    rows = [...cached.keys()].map(conversation_id => ({ conversation_id }));
    notes.push('Only the latest cached conversation per workspace is listed; older conversations may be missing.');
  }
  const sessions = rows.flatMap(row => {
    const id = row.conversation_id;
    if (!UUID.test(id || '') || !live.has(id) || !existsSync(join(root, 'conversations', `${id}.db`))) return [];
    const paths = workspacePaths(row.workspace_uris);
    const workspaces = paths.length ? paths : cached.get(id) || [];
    const cwd = matchesProject ? workspaces.find(matchesProject) : workspaces[0];
    if (matchesProject && !cwd) return [];
    return [{ session_id: id, name: row.title || null, cwd: cwd || null, workspaces,
      updated_at: row.last_modified_time || null, status: row.status || 'unknown',
      live_status: 'running', pids: live.get(id), transport: 'live_local_process',
      capabilities: { send: transport.available }, unavailable_reason: transport.reason || null }];
  });
  return { ok: true, provider: 'agy', sessions, partial, notes,
    note: 'Only conversations held open by a running local AGY process are listed. Sending requires the local agentapi backend context; no conversation is resumed.' };
}
