#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { homedir } from "os";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join, dirname, resolve, relative, isAbsolute } from "path";

// --- Config ---
const PORT = (() => {
  const idx = process.argv.indexOf("--port");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 19842;
})();
const API_KEY = process.env.XM_SYNC_API_KEY ?? "";
const VERSION = process.env.XM_SYNC_VERSION ?? "dev";
const DB_PATH = process.env.XM_SYNC_DB_PATH ?? join(homedir(), ".xm", "sync", "sync.db");
const MATERIALIZE_DIR = process.env.XM_SYNC_DATA_DIR ?? join(homedir(), ".xm", "sync", "data");
const DASHBOARD_URL = process.env.XM_DASHBOARD_URL ?? "http://localhost:19841";

mkdirSync(dirname(DB_PATH), { recursive: true });
mkdirSync(MATERIALIZE_DIR, { recursive: true });

// --- DB ---
const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode=WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS sync_files (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    path       TEXT NOT NULL,
    content    TEXT NOT NULL,
    hash       TEXT NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0,
    pushed_at  INTEGER NOT NULL,
    UNIQUE(project_id, path, machine_id)
  );
  CREATE INDEX IF NOT EXISTS idx_pushed_at ON sync_files(pushed_at);
  CREATE INDEX IF NOT EXISTS idx_project   ON sync_files(project_id);
`);

// Migrate: add `deleted` column to pre-existing DBs that lack it.
if (!db.prepare("PRAGMA table_info(sync_files)").all().some((c) => c.name === "deleted")) {
  db.exec("ALTER TABLE sync_files ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
  console.error("[x-sync] migrated DB: added `deleted` column");
}

const stmtGetHash = db.prepare(
  "SELECT hash, deleted FROM sync_files WHERE project_id=? AND path=? AND machine_id=?"
);
const stmtUpsert = db.prepare(
  `INSERT OR REPLACE INTO sync_files (project_id, machine_id, path, content, hash, deleted, pushed_at)
   VALUES (?, ?, ?, ?, ?, 0, ?)`
);
// Tombstone: REPLACE assigns a fresh id so cursor-based pulls observe the deletion.
const stmtTombstone = db.prepare(
  `INSERT OR REPLACE INTO sync_files (project_id, machine_id, path, content, hash, deleted, pushed_at)
   VALUES (?, ?, ?, '', '', 1, ?)`
);
const stmtListActive = db.prepare(
  "SELECT path FROM sync_files WHERE project_id=? AND machine_id=? AND deleted=0"
);
// Incremental pull by monotonic id cursor — immune to same-ms timestamp collisions.
const stmtPullCursor = db.prepare(
  "SELECT id, path, content, hash, machine_id, pushed_at, deleted FROM sync_files WHERE project_id=? AND id>? ORDER BY id"
);
// Legacy timestamp pull (kept for older clients that send ?since=).
const stmtPullSince = db.prepare(
  "SELECT id, path, content, hash, machine_id, pushed_at, deleted FROM sync_files WHERE project_id=? AND pushed_at>? ORDER BY id"
);
// Full pull skips tombstones — a first sync has nothing local to delete.
const stmtPullAll = db.prepare(
  "SELECT id, path, content, hash, machine_id, pushed_at, deleted FROM sync_files WHERE project_id=? AND deleted=0 ORDER BY id"
);
const stmtProjects = db.prepare(
  `SELECT project_id,
          COUNT(*) AS file_count,
          MAX(pushed_at) AS last_push
   FROM sync_files WHERE deleted=0 GROUP BY project_id`
);
const stmtMachines = db.prepare(
  "SELECT DISTINCT machine_id FROM sync_files WHERE project_id=? AND deleted=0"
);
const stmtTotalFiles = db.prepare("SELECT COUNT(*) AS n FROM sync_files WHERE deleted=0");
const stmtTotalProjects = db.prepare(
  "SELECT COUNT(DISTINCT project_id) AS n FROM sync_files WHERE deleted=0"
);

// --- Helpers ---
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function authError() {
  return json({ error: "Unauthorized" }, 401);
}

function checkAuth(req) {
  if (!API_KEY) return true; // no key configured → open (warned at startup)
  return timingSafeEq(req.headers.get("X-Api-Key") ?? "", API_KEY);
}

// Constant-time string compare to avoid leaking the key via response timing.
function timingSafeEq(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// A project_id must be a single, non-traversing path segment.
function isValidProjectId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 255 &&
    !id.includes("/") && !id.includes("\\") && id !== "." && id !== "..";
}

// Resolve `parts` under `base` and confirm the result stays inside `base`.
// Returns the absolute path, or null on traversal/absolute escape.
function safeResolve(base, ...parts) {
  if (parts.some((p) => typeof p !== "string" || p.length === 0)) return null;
  const target = resolve(base, ...parts);
  const rel = relative(base, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return target;
}

// --- Handlers ---
async function handlePush(req) {
  if (!checkAuth(req)) return authError();
  const body = await req.json();
  const { machine_id, project_id, files, full_snapshot } = body;
  if (!machine_id || !project_id || !Array.isArray(files)) {
    return json({ error: "Bad request" }, 400);
  }
  if (!isValidProjectId(project_id) || !isValidProjectId(machine_id)) {
    return json({ error: "Invalid project_id or machine_id" }, 400);
  }

  const baseDir = join(MATERIALIZE_DIR, project_id, ".xm");
  let accepted = 0;
  let skipped = 0;
  let rejected = 0;          // path traversal attempts
  let deleted = 0;           // tombstones written (full-snapshot pushes only)
  const writeErrors = [];    // materialize failures, surfaced in the response
  const pushedPaths = new Set();
  const now = Date.now();

  for (const { path, content, hash } of files) {
    if (typeof path !== "string" || typeof content !== "string") {
      rejected++;
      continue;
    }
    // Validate path BEFORE touching the DB so a malicious path can't be stored.
    const filePath = safeResolve(baseDir, path);
    if (!filePath) {
      rejected++;
      console.error(`[x-sync] REJECT traversal project=${project_id} path=${path}`);
      continue;
    }
    pushedPaths.add(path);

    const existing = stmtGetHash.get(project_id, path, machine_id);
    if (existing && existing.hash === hash && existing.deleted === 0) {
      skipped++;
      continue;
    }

    stmtUpsert.run(project_id, machine_id, path, content, hash, now);
    accepted++;
    // Materialize to disk for x-dashboard consumption
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, "utf8");
    } catch (err) {
      writeErrors.push({ path, error: err.message });
      console.error(`[x-sync] materialize failed project=${project_id} path=${path}: ${err.message}`);
    }
  }

  // Deletion propagation: a full snapshot is the authoritative file set for this
  // machine, so any active path it omits has been deleted locally — tombstone it.
  if (full_snapshot === true) {
    for (const { path } of stmtListActive.all(project_id, machine_id)) {
      if (pushedPaths.has(path)) continue;
      stmtTombstone.run(project_id, machine_id, path, now);
      deleted++;
      const fp = safeResolve(baseDir, path);
      if (fp) {
        try { rmSync(fp, { force: true }); }
        catch (err) { console.error(`[x-sync] tombstone unlink failed project=${project_id} path=${path}: ${err.message}`); }
      }
    }
  }

  // Trigger dashboard rescan if files were materialized or removed
  if (accepted > 0 || deleted > 0) {
    fetch(`${DASHBOARD_URL}/api/rescan`, { method: 'POST' }).catch(() => {});
  }

  console.error(
    `[x-sync] POST /sync/push project=${project_id} files=${files.length} accepted=${accepted} skipped=${skipped} rejected=${rejected} deleted=${deleted} write_errors=${writeErrors.length}`
  );
  return json({ accepted, skipped, rejected, deleted, write_errors: writeErrors });
}

function handlePull(req) {
  if (!checkAuth(req)) return authError();
  const url = new URL(req.url);
  const project_id = url.searchParams.get("project_id");
  const cursorParam = url.searchParams.get("cursor");
  const since = url.searchParams.get("since");

  if (!project_id) return json({ error: "project_id required" }, 400);

  let rows;
  let mode;
  if (cursorParam != null) {
    mode = `cursor=${cursorParam}`;
    rows = stmtPullCursor.all(project_id, parseInt(cursorParam, 10) || 0);
  } else if (since != null) {
    mode = `since=${since}`; // legacy timestamp clients
    rows = stmtPullSince.all(project_id, parseInt(since, 10) || 0);
  } else {
    mode = "all";
    rows = stmtPullAll.all(project_id);
  }

  // Advance the cursor to the largest id returned (rows are ORDER BY id).
  let cursor = cursorParam != null ? parseInt(cursorParam, 10) || 0 : 0;
  for (const r of rows) if (r.id > cursor) cursor = r.id;

  const files = rows.map((r) => ({
    path: r.path,
    content: r.content,
    hash: r.hash,
    machine_id: r.machine_id,
    pushed_at: r.pushed_at,
    deleted: r.deleted,
  }));

  console.error(
    `[x-sync] GET /sync/pull project=${project_id} ${mode} returned=${files.length} next_cursor=${cursor}`
  );
  return json({ files, cursor, server_time: Date.now() });
}

function handleDashboardProjects(req) {
  if (!checkAuth(req)) return authError(); // project/machine names are not public
  const rows = stmtProjects.all();
  const result = rows.map((r) => {
    const machines = stmtMachines
      .all(r.project_id)
      .map((m) => m.machine_id);
    return {
      project_id: r.project_id,
      machines,
      file_count: r.file_count,
      last_push: r.last_push,
    };
  });
  return json(result);
}

function handleDashboardHealth(req) {
  // Liveness probe stays open (used by setup/status checks); counts require auth.
  const base = { status: "ok", version: VERSION };
  if (!checkAuth(req)) return json(base);
  const files = stmtTotalFiles.get().n;
  const projects = stmtTotalProjects.get().n;
  return json({ ...base, files, projects });
}

// --- Dashboard HTML (matches x-dashboard brutalist style) ---
function handleDashboardUI() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>x-sync</title>
<style>
:root{--bg:#212121;--surface:#263238;--surface-hover:#37474f;--text:#fff;--text-muted:#B0BEC5;--accent:#FFAB40;--accent-dim:rgba(255,171,64,.12);--success:#69f0ae;--danger:#ff5252;--border:2px solid #333;--shadow:4px 4px 0 rgba(0,0,0,.5);--font-sans:'Pretendard',-apple-system,system-ui,sans-serif;--font-mono:'SF Mono','Fira Code',Consolas,monospace}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:var(--bg);color:var(--text);font-family:var(--font-sans);font-size:13px;line-height:1.5}
.layout{display:grid;grid-template-columns:180px 1fr;height:100vh;overflow:hidden}
.sidebar{background:var(--surface);border-right:3px solid var(--accent);display:flex;flex-direction:column;overflow-y:auto}
.nav-brand{padding:20px 14px 14px;font-size:14px;font-weight:700;font-family:var(--font-mono);letter-spacing:.15em;text-transform:uppercase;color:var(--accent);border-bottom:2px solid #333;text-shadow:0 0 10px rgba(255,171,64,.3)}
.nav-links{list-style:none;padding:4px 0}
.nav-links a{display:block;padding:10px 14px;color:var(--text-muted);font-size:12px;font-weight:700;font-family:var(--font-mono);letter-spacing:.08em;text-transform:uppercase;border-left:4px solid transparent;text-decoration:none;transition:all .08s}
.nav-links a:hover,.nav-links a.active{background:var(--accent-dim);color:var(--accent);border-left-color:var(--accent)}
.content{overflow-y:auto;padding:28px 32px;background:var(--bg)}
h1{font-size:18px;font-weight:700;font-family:var(--font-mono);letter-spacing:.04em;margin-bottom:1rem}
h2{font-size:14px;font-weight:700;font-family:var(--font-mono);letter-spacing:.04em}
.card{background:var(--surface);border:var(--border);box-shadow:var(--shadow);padding:1rem;margin-bottom:1rem}
.stat-row{display:flex;gap:1rem;margin-bottom:1rem}
.stat-card{text-align:center;min-width:100px;padding:1rem}
.stat-value{font-size:2rem;font-weight:700;font-family:var(--font-mono);color:var(--accent)}
.badge{display:inline-block;padding:1px 6px;font-size:11px;font-weight:700;font-family:var(--font-mono);text-transform:uppercase;letter-spacing:.04em;border:1px solid #555;color:var(--text-muted)}
.badge-green{border-color:var(--success);color:var(--success);background:rgba(105,240,174,.08)}
.badge-red{border-color:var(--danger);color:var(--danger);background:rgba(255,82,82,.08)}
.badge-accent{border-color:var(--accent);color:var(--accent);background:var(--accent-dim)}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;padding:.5rem .75rem;border-bottom:var(--border);font-family:var(--font-mono)}
td{padding:.6rem .75rem;border-bottom:1px solid #333;font-size:13px}
tr:hover td{background:var(--surface-hover)}
code{font-family:var(--font-mono);font-size:.9em;background:#1a1a1a;padding:.1em .3em;border:1px solid #333;color:var(--accent)}
.machine-badge{display:inline-block;padding:1px 6px;font-size:11px;font-family:var(--font-mono);border:1px solid #555;color:var(--text-muted);margin:1px}
</style>
</head>
<body>
<div class="layout">
  <nav class="sidebar">
    <div class="nav-brand">x-sync</div>
    <ul class="nav-links">
      <li><a href="/" class="active">Sync</a></li>
    </ul>
    <div style="padding:10px 14px;border-top:2px solid #333;margin-top:auto">
      <a href="#" onclick="window.open('//'+location.hostname+':19841/','_blank');return false" style="font-size:11px;font-family:var(--font-mono);text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);text-decoration:none;display:block">↗ FULL DASHBOARD</a>
    </div>
  </nav>
  <main class="content">
    <div id="app"><h1>Sync</h1><p style="color:var(--text-muted)">Loading...</p></div>
  </main>
</div>
<script>
async function load(){
  const app=document.getElementById('app');
  const KEY=new URLSearchParams(location.search).get('key')||'';
  const H=KEY?{'X-Api-Key':KEY}:{};
  try{
    const h=await fetch('/dashboard/health',{headers:H}).then(r=>r.json());
    const pr=await fetch('/dashboard/projects',{headers:H});
    if(pr.status===401){
      app.innerHTML='<h1>Sync <span class="badge badge-accent">LOCKED</span></h1><div class="card" style="color:var(--text-muted)">This server requires an API key. Open with <code>?key=YOUR_KEY</code> in the URL.</div>';
      return;
    }
    const projects=pr.ok?await pr.json():[];
    const machines=new Set();
    projects.forEach(p=>(p.machines||[]).forEach(m=>machines.add(m)));

    const ok=h.status==='ok';
    let html='<h1>Sync <span class="badge '+(ok?'badge-green':'badge-red')+'">'+(ok?'ONLINE':'OFFLINE')+'</span> <span style="color:var(--text-muted);font-size:12px;font-weight:400">v'+h.version+'</span></h1>';

    html+='<div class="stat-row">';
    html+='<div class="card stat-card"><div class="stat-value">'+h.projects+'</div><div style="color:var(--text-muted)">Projects</div></div>';
    html+='<div class="card stat-card"><div class="stat-value">'+h.files+'</div><div style="color:var(--text-muted)">Files</div></div>';
    html+='<div class="card stat-card"><div class="stat-value">'+machines.size+'</div><div style="color:var(--text-muted)">Machines</div></div>';
    html+='</div>';

    if(projects.length){
      html+='<div class="card"><h2 style="margin:0 0 .75rem">Projects <span class="badge">'+projects.length+'</span></h2>';
      html+='<table><thead><tr><th>Project</th><th>Machines</th><th>Files</th><th>Last Push</th></tr></thead><tbody>';
      for(const p of projects){
        const ms=(p.machines||[]).map(m=>'<span class="machine-badge">'+m+'</span>').join(' ');
        html+='<tr><td><strong>'+p.project_id+'</strong></td><td>'+ms+'</td><td>'+p.file_count+'</td><td style="color:var(--text-muted)">'+(p.last_push?new Date(p.last_push).toLocaleString():'—')+'</td></tr>';
      }
      html+='</tbody></table></div>';
    }

    if(machines.size){
      html+='<div class="card"><h2 style="margin:0 0 .75rem">Machines <span class="badge">'+machines.size+'</span></h2>';
      html+='<div style="display:flex;flex-wrap:wrap;gap:.5rem">';
      for(const m of machines){
        const cnt=projects.filter(p=>(p.machines||[]).includes(m)).length;
        html+='<div class="card" style="padding:.75rem;min-width:180px"><div style="font-weight:700;font-family:var(--font-mono);font-size:12px">'+m+'</div><div style="color:var(--text-muted);margin-top:.25rem">'+cnt+' project'+(cnt!==1?'s':'')+'</div></div>';
      }
      html+='</div></div>';
    }

    if(!projects.length) html+='<div class="card" style="text-align:center;padding:2rem;color:var(--text-muted)">No projects synced yet</div>';

    app.innerHTML=html;
  }catch(e){
    app.innerHTML='<h1>Sync <span class="badge badge-red">ERROR</span></h1><div class="card" style="color:var(--text-muted)">Failed to connect to server.</div>';
  }
}
load();
setInterval(load,10000);
</script>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// --- Proxy to x-dashboard ---
async function proxyToDashboard(req) {
  const url = new URL(req.url);
  const target = `${DASHBOARD_URL}${url.pathname}${url.search}`;
  // Strip our auth header so the sync API key never leaks to the dashboard backend.
  const headers = new Headers(req.headers);
  headers.delete("x-api-key");
  try {
    const res = await fetch(target, {
      method: req.method,
      headers,
    });
    return new Response(res.body, {
      status: res.status,
      headers: res.headers,
    });
  } catch {
    return handleDashboardUI(); // fallback to built-in sync dashboard
  }
}

// --- Router ---
function router(req) {
  const url = new URL(req.url);
  const { pathname } = url;

  // x-sync API endpoints (handle locally)
  if (req.method === "POST" && pathname === "/sync/push") return handlePush(req);
  if (req.method === "GET"  && pathname === "/sync/pull") return handlePull(req);
  if (req.method === "GET"  && pathname === "/dashboard/projects") return handleDashboardProjects(req);
  if (req.method === "GET"  && pathname === "/dashboard/health") return handleDashboardHealth(req);

  // Everything else → proxy to x-dashboard (full UI)
  return proxyToDashboard(req);
}

// --- Start ---
Bun.serve({ port: PORT, fetch: router });
console.error(`[x-sync] listening on http://localhost:${PORT}  db=${DB_PATH}`);
if (!API_KEY) {
  console.error(
    "[x-sync] ⚠ WARNING: XM_SYNC_API_KEY is not set — push/pull and dashboard are OPEN to anyone who can reach this port. Set XM_SYNC_API_KEY before exposing this server."
  );
}
