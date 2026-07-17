import { Database } from 'bun:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

export class GatewayStore {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY, host_id TEXT NOT NULL, session_id TEXT,
        type TEXT NOT NULL, seq INTEGER NOT NULL, ts_ms INTEGER NOT NULL, body TEXT NOT NULL,
        discord_delivered INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);
      CREATE TABLE IF NOT EXISTS hosts (
        host_id TEXT PRIMARY KEY, status TEXT NOT NULL, last_seen_ms INTEGER NOT NULL, metadata TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY, host_id TEXT NOT NULL, provider TEXT NOT NULL,
        status TEXT NOT NULL, updated_ms INTEGER NOT NULL, metadata TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS decisions (
        decision_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL,
        prompt TEXT NOT NULL, answer TEXT, updated_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS commands (
        event_id TEXT PRIMARY KEY, host_id TEXT NOT NULL, seq INTEGER NOT NULL,
        body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', updated_ms INTEGER NOT NULL
      );
    `);
    if (!this.db.prepare('PRAGMA table_info(events)').all().some((c) => c.name === 'discord_delivered')) {
      this.db.exec('ALTER TABLE events ADD COLUMN discord_delivered INTEGER NOT NULL DEFAULT 0');
    }
    this.insertEvent = this.db.prepare('INSERT OR IGNORE INTO events (event_id, host_id, session_id, type, seq, ts_ms, body) VALUES (?, ?, ?, ?, ?, ?, ?)');
  }

  ingest(event) {
    const result = this.insertEvent.run(event.event_id, event.host_id, event.session_id, event.type, event.seq, event.ts_ms, JSON.stringify(event));
    if (!result.changes) return false;
    if (event.type.startsWith('host.')) {
      const status = event.type === 'host.offline' ? 'offline' : 'online';
      this.db.prepare('INSERT OR REPLACE INTO hosts VALUES (?, ?, ?, ?)').run(event.host_id, status, event.ts_ms, JSON.stringify(event.payload));
    }
    if (event.session_id && event.provider && ['session.start', 'session.complete', 'session.failed'].includes(event.type)) {
      const status = event.type === 'session.start' ? 'running' : event.type.slice('session.'.length);
      this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET status=excluded.status, updated_ms=excluded.updated_ms, metadata=excluded.metadata')
        .run(event.session_id, event.host_id, event.provider, status, event.ts_ms, JSON.stringify(event.payload));
    }
    if (event.type === 'decision.required' || event.type === 'decision.local_required') {
      const id = String(event.payload.decisionId || event.event_id);
      this.db.prepare('INSERT OR REPLACE INTO decisions VALUES (?, ?, ?, ?, NULL, ?)')
        .run(id, event.session_id, event.type === 'decision.local_required' ? 'local_required' : 'pending', JSON.stringify(event.payload.original), event.ts_ms);
    }
    if (event.type === 'decision.answer') {
      this.db.prepare('UPDATE decisions SET status=?, answer=?, updated_ms=? WHERE decision_id=?')
        .run('answered', JSON.stringify(event.payload.answer), event.ts_ms, String(event.payload.decisionId));
    }
    return true;
  }

  sessions() { return this.db.prepare('SELECT * FROM sessions ORDER BY updated_ms DESC').all(); }
  pendingDecisions() { return this.db.prepare("SELECT * FROM decisions WHERE status='pending' ORDER BY updated_ms").all(); }
  needsDiscordDelivery(eventId) { return this.db.prepare('SELECT discord_delivered FROM events WHERE event_id=?').get(eventId)?.discord_delivered === 0; }
  markDiscordDelivered(eventId) { this.db.prepare('UPDATE events SET discord_delivered=1 WHERE event_id=?').run(eventId); }
  queueCommand(event) {
    this.db.prepare("INSERT OR IGNORE INTO commands (event_id, host_id, seq, body, status, updated_ms) VALUES (?, ?, ?, ?, 'pending', ?)")
      .run(event.event_id, event.host_id, event.seq, JSON.stringify(event), Date.now());
  }
  ackCommand(eventId) { this.db.prepare("UPDATE commands SET status='acked', updated_ms=? WHERE event_id=?").run(Date.now(), eventId); }
  pendingCommands(hostId) { return this.db.prepare("SELECT body FROM commands WHERE host_id=? AND status='pending' ORDER BY seq").all(hostId).map((row) => JSON.parse(row.body)); }
  nextCommandSeq() { return Number(this.db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM commands').get().seq); }
  close() { this.db.close(); }
}
