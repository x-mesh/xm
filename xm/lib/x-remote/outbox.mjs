import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class JsonlOutbox {
  constructor(path) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }

  append(event) {
    appendFileSync(this.path, JSON.stringify(event) + '\n', { encoding: 'utf8', mode: 0o600 });
  }

  pending() {
    if (!existsSync(this.path)) return [];
    const byId = new Map();
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record.op === 'put') byId.set(record.event.event_id, record.event);
        if (record.op === 'ack') byId.delete(record.event_id);
      } catch {}
    }
    return [...byId.values()].sort((a, b) => a.seq - b.seq);
  }

  put(event) { this.append({ op: 'put', event }); }
  ack(eventId) { this.append({ op: 'ack', event_id: eventId }); }

  compact() {
    const tmp = `${this.path}.tmp`;
    const body = this.pending().map((event) => JSON.stringify({ op: 'put', event })).join('\n');
    writeFileSync(tmp, body ? body + '\n' : '', { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

export class ProcessedLedger {
  constructor(path) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.ids = new Set(existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []);
  }
  has(eventId) { return this.ids.has(eventId); }
  add(eventId) {
    if (this.ids.has(eventId)) return false;
    appendFileSync(this.path, `${eventId}\n`, { encoding: 'utf8', mode: 0o600 });
    this.ids.add(eventId);
    return true;
  }
}
