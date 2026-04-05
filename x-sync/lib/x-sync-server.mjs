#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { homedir } from "os";
import { mkdirSync } from "fs";
import { join } from "path";

// --- Config ---
const PORT = (() => {
  const idx = process.argv.indexOf("--port");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 19842;
})();
const API_KEY = process.env.XM_SYNC_API_KEY ?? "";
const DB_PATH = join(homedir(), ".xm", "sync", "sync.db");

mkdirSync(join(homedir(), ".xm", "sync"), { recursive: true });

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
    pushed_at  INTEGER NOT NULL,
    UNIQUE(project_id, path, machine_id)
  );
  CREATE INDEX IF NOT EXISTS idx_pushed_at ON sync_files(pushed_at);
  CREATE INDEX IF NOT EXISTS idx_project   ON sync_files(project_id);
`);

const stmtGetHash = db.prepare(
  "SELECT hash FROM sync_files WHERE project_id=? AND path=? AND machine_id=?"
);
const stmtUpsert = db.prepare(
  `INSERT OR REPLACE INTO sync_files (project_id, machine_id, path, content, hash, pushed_at)
   VALUES (?, ?, ?, ?, ?, ?)`
);
const stmtPull = db.prepare(
  "SELECT path, content, hash, machine_id, pushed_at FROM sync_files WHERE project_id=? AND pushed_at>?"
);
const stmtPullAll = db.prepare(
  "SELECT path, content, hash, machine_id, pushed_at FROM sync_files WHERE project_id=?"
);
const stmtProjects = db.prepare(
  `SELECT project_id,
          COUNT(*) AS file_count,
          MAX(pushed_at) AS last_push
   FROM sync_files GROUP BY project_id`
);
const stmtMachines = db.prepare(
  "SELECT DISTINCT machine_id FROM sync_files WHERE project_id=?"
);
const stmtTotalFiles = db.prepare("SELECT COUNT(*) AS n FROM sync_files");
const stmtTotalProjects = db.prepare(
  "SELECT COUNT(DISTINCT project_id) AS n FROM sync_files"
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
  if (!API_KEY) return true; // no key configured → open
  return req.headers.get("X-Api-Key") === API_KEY;
}

// --- Handlers ---
async function handlePush(req) {
  if (!checkAuth(req)) return authError();
  const body = await req.json();
  const { machine_id, project_id, files } = body;
  if (!machine_id || !project_id || !Array.isArray(files)) {
    return json({ error: "Bad request" }, 400);
  }

  let accepted = 0;
  let skipped = 0;
  const now = Date.now();

  for (const { path, content, hash } of files) {
    const existing = stmtGetHash.get(project_id, path, machine_id);
    if (existing?.hash === hash) {
      skipped++;
    } else {
      stmtUpsert.run(project_id, machine_id, path, content, hash, now);
      accepted++;
    }
  }

  console.error(
    `[x-sync] POST /sync/push project=${project_id} files=${files.length} accepted=${accepted} skipped=${skipped}`
  );
  return json({ accepted, skipped });
}

function handlePull(req) {
  if (!checkAuth(req)) return authError();
  const url = new URL(req.url);
  const project_id = url.searchParams.get("project_id");
  const since = url.searchParams.get("since");

  if (!project_id) return json({ error: "project_id required" }, 400);

  const files = since
    ? stmtPull.all(project_id, parseInt(since, 10))
    : stmtPullAll.all(project_id);

  console.error(
    `[x-sync] GET /sync/pull project=${project_id} since=${since ?? "all"} returned=${files.length}`
  );
  return json({ files, server_time: Date.now() });
}

function handleDashboardProjects() {
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

function handleDashboardHealth() {
  const files = stmtTotalFiles.get().n;
  const projects = stmtTotalProjects.get().n;
  return json({ status: "ok", version: "0.1.0", files, projects });
}

// --- Router ---
function router(req) {
  const url = new URL(req.url);
  const { pathname } = url;

  if (req.method === "POST" && pathname === "/sync/push") return handlePush(req);
  if (req.method === "GET"  && pathname === "/sync/pull") return handlePull(req);
  if (req.method === "GET"  && pathname === "/dashboard/projects") return handleDashboardProjects();
  if (req.method === "GET"  && pathname === "/dashboard/health") return handleDashboardHealth();

  return json({ error: "Not found" }, 404);
}

// --- Start ---
Bun.serve({ port: PORT, fetch: router });
console.error(`[x-sync] listening on http://localhost:${PORT}  db=${DB_PATH}`);
