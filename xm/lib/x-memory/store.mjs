/**
 * x-memory/store — Index and memory file management
 */

import {
  ROOT, INDEX_PATH, MEMORIES_DIR,
  MEMORY_TYPES, DEFAULT_TTL, CONFIDENCE_LEVELS,
  C, ensureDir, readJSON, writeJSON, modifyJSON, readMD, writeMD,
  quoteYAML, parseFrontmatter, computeExpiresAt, isExpired,
  join, existsSync, unlinkSync,
} from './core.mjs';

// ── Ensure storage exists ────────────────────────────────────────────

export function ensureStorage() {
  ensureDir(ROOT);
  ensureDir(MEMORIES_DIR);
  if (!existsSync(INDEX_PATH)) {
    writeJSON(INDEX_PATH, []);
  }
}

// ── Index operations ─────────────────────────────────────────────────

export function readIndex() {
  ensureStorage();
  return readJSON(INDEX_PATH) || [];
}

export function writeIndex(data) {
  ensureStorage();
  writeJSON(INDEX_PATH, data);
}

export function nextId(index) {
  if (!index || index.length === 0) return 'mem-001';
  let maxNum = 0;
  for (const entry of index) {
    const m = entry.id.match(/^mem-(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxNum) maxNum = n;
    }
  }
  return `mem-${String(maxNum + 1).padStart(3, '0')}`;
}

// ── Memory file operations ───────────────────────────────────────────

export function buildMemoryContent(entry, body) {
  const tags = entry.tags && entry.tags.length > 0
    ? `[${entry.tags.join(', ')}]`
    : '[]';
  const relFiles = entry.related_files && entry.related_files.length > 0
    ? entry.related_files.map(f => `  - ${f}`).join('\n')
    : null;

  let frontmatter = `---
id: ${entry.id}
title: ${quoteYAML(entry.title)}
type: ${entry.type}
tags: ${tags}
created: ${entry.created}
ttl: ${entry.ttl || 'null'}
expires_at: ${entry.expires_at || 'null'}
confidence: ${entry.confidence}
source: ${entry.source || 'manual'}`;

  if (relFiles) {
    frontmatter += `\nrelated_files:\n${relFiles}`;
  } else {
    frontmatter += `\nrelated_files: []`;
  }

  frontmatter += `\nwhy: ${quoteYAML(entry.why || '')}
---

${body || `## ${entry.title}

### Background (WHY)


### Details (WHAT)


### Impact (IMPACT)

`}`;

  return frontmatter;
}

export function readMemory(id) {
  const filepath = join(MEMORIES_DIR, `${id}.md`);
  const content = readMD(filepath);
  if (!content) return null;
  return parseFrontmatter(content);
}

export function writeMemory(id, content) {
  const filepath = join(MEMORIES_DIR, `${id}.md`);
  writeMD(filepath, content);
}

export function deleteMemory(id) {
  const filepath = join(MEMORIES_DIR, `${id}.md`);
  if (existsSync(filepath)) {
    unlinkSync(filepath);
    return true;
  }
  return false;
}

// ── Save entry (atomic) ──────────────────────────────────────────────

export function saveEntry(title, opts = {}) {
  const type = opts.type;
  if (!type || !MEMORY_TYPES.includes(type)) {
    console.error(`${C.red}❌ --type is required. Valid types: ${MEMORY_TYPES.join(', ')}${C.reset}`);
    process.exit(1);
  }

  const confidence = opts.confidence || 'high';
  if (!CONFIDENCE_LEVELS.includes(confidence)) {
    console.error(`${C.red}❌ Invalid confidence: ${confidence}. Valid: ${CONFIDENCE_LEVELS.join(', ')}${C.reset}`);
    process.exit(1);
  }

  const ttl = opts.ttl || DEFAULT_TTL[type];
  const created = new Date().toISOString();
  const expires_at = computeExpiresAt(created, ttl);
  const tags = opts.tags ? opts.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
  const related_files = opts.files ? opts.files.split(',').map(f => f.trim()).filter(Boolean) : [];

  let entry;
  modifyJSON(INDEX_PATH, (index) => {
    const data = index || [];
    const id = nextId(data);
    entry = {
      id,
      title,
      type,
      tags,
      created,
      ttl: ttl || null,
      expires_at: expires_at || null,
      related_files,
      confidence,
      source: opts.source || 'manual',
      why: opts.why || '',
    };
    data.push(entry);
    // Write .md file
    const content = buildMemoryContent(entry);
    writeMemory(id, content);
    return data;
  });

  return entry;
}

// ── Search helpers ───────────────────────────────────────────────────

export function tokenize(text) {
  if (!text) return [];
  return text.toLowerCase().split(/[\s/\-_.,:;()[\]{}]+/).filter(t => t.length > 1);
}

export function searchIndex(query, { includeExpired = false } = {}) {
  const index = readIndex();
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const results = [];
  for (const entry of index) {
    if (!includeExpired && isExpired(entry)) continue;

    const titleTokens = tokenize(entry.title);
    const tagTokens = (entry.tags || []).map(t => t.toLowerCase());
    const whyTokens = tokenize(entry.why);

    let score = 0;
    for (const qt of queryTokens) {
      for (const tt of titleTokens) {
        if (tt.includes(qt) || qt.includes(tt)) score += 2;
      }
      for (const tag of tagTokens) {
        if (tag.includes(qt) || qt.includes(tag)) score += 3;
      }
      for (const wt of whyTokens) {
        if (wt.includes(qt) || qt.includes(wt)) score += 1;
      }
    }

    if (score > 0) {
      results.push({ ...entry, score });
    }
  }

  // Also search .md body for deeper matches
  for (const r of results) {
    const mem = readMemory(r.id);
    if (mem && mem.body) {
      const bodyTokens = tokenize(mem.body);
      for (const qt of queryTokens) {
        for (const bt of bodyTokens) {
          if (bt === qt) r.score += 0.5;
        }
      }
    }
  }

  return results.sort((a, b) => b.score - a.score);
}
