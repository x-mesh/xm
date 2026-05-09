/**
 * x-memory/commands — CLI command implementations
 */

import {
  C, ROOT, INDEX_PATH, MEMORIES_DIR, MEMORY_TYPES,
  isExpired, parseDuration, readJSON, modifyJSON,
  join, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync,
  dirname, execSync,
} from './core.mjs';
import {
  readIndex, saveEntry, readMemory, writeMemory, deleteMemory, searchIndex,
} from './store.mjs';

// ── save ─────────────────────────────────────────────────────────────

export function cmdSave(args) {
  const title = args[0];
  if (!title) {
    console.error(`${C.red}❌ Usage: save <title> --type <type> [--why "..."] [--tags "t1,t2"] [--ttl 30d]${C.reset}`);
    process.exit(1);
  }

  const opts = parseOpts(args.slice(1));
  const entry = saveEntry(title, opts);

  console.log(`${C.green}[memory]${C.reset} Saved: ${C.bold}${entry.id}${C.reset} "${entry.title}"`);
  console.log(`  Type: ${entry.type} | Tags: ${entry.tags.join(', ') || '(none)'}`);
  console.log(`  Stored: ${join(MEMORIES_DIR, entry.id + '.md')}`);
}

// ── show ─────────────────────────────────────────────────────────────

export function cmdShow(args) {
  const id = args[0];
  if (!id) {
    console.error(`${C.red}❌ Usage: show <id>${C.reset}`);
    process.exit(1);
  }

  const index = readIndex();
  const entry = index.find(e => e.id === id);
  if (!entry) {
    console.error(`${C.yellow}⚠ Memory "${id}" not found.${C.reset}`);
    return;
  }

  const mem = readMemory(id);
  console.log(`${C.green}[memory]${C.reset} ${C.bold}${entry.id}${C.reset} — ${entry.title}`);
  console.log(`  Type: ${entry.type} | Confidence: ${entry.confidence}`);
  console.log(`  Tags: ${entry.tags.join(', ') || '(none)'}`);
  console.log(`  Created: ${entry.created} | TTL: ${entry.ttl || 'none'}`);
  if (entry.source) console.log(`  Source: ${entry.source}`);
  if (entry.related_files && entry.related_files.length > 0) {
    console.log(`  Related files: ${entry.related_files.join(', ')}`);
  }
  console.log('');
  if (mem && mem.body) {
    console.log('---');
    console.log(mem.body.trim());
  }
}

// ── list ─────────────────────────────────────────────────────────────

export function cmdList(args) {
  const opts = parseOpts(args);
  const index = readIndex();

  let filtered = index;

  // Filter expired
  if (!opts.expired) {
    filtered = filtered.filter(e => !isExpired(e));
  }

  // Filter by type
  if (opts.type) {
    filtered = filtered.filter(e => e.type === opts.type);
  }

  // Filter by tag
  if (opts.tag) {
    const tagLower = opts.tag.toLowerCase();
    filtered = filtered.filter(e =>
      e.tags && e.tags.some(t => t.toLowerCase().includes(tagLower))
    );
  }

  // Filter by since
  if (opts.since) {
    const ms = parseDuration(opts.since);
    if (ms) {
      const cutoff = new Date(Date.now() - ms);
      filtered = filtered.filter(e => new Date(e.created) >= cutoff);
    }
  }

  const typeLabel = opts.type ? `${opts.type}s` : 'memories';
  const sinceLabel = opts.since ? ` (last ${opts.since})` : '';
  console.log(`${C.green}[memory]${C.reset} ${filtered.length} ${typeLabel}${sinceLabel}\n`);

  if (filtered.length === 0) {
    console.log('  (none)');
    return;
  }

  for (const e of filtered) {
    const tags = e.tags && e.tags.length > 0 ? e.tags.join(',') : '';
    const date = e.created ? e.created.slice(0, 10) : '';
    const expired = isExpired(e) ? ` ${C.dim}(expired)${C.reset}` : '';
    console.log(`  ${C.bold}${e.id}${C.reset}  ${e.title.padEnd(30)}  ${date}  ${tags}${expired}`);
  }
}

// ── forget ───────────────────────────────────────────────────────────

export function cmdForget(args) {
  const id = args[0];
  if (!id) {
    console.error(`${C.red}❌ Usage: forget <id>${C.reset}`);
    process.exit(1);
  }

  let found = false;
  modifyJSON(INDEX_PATH, (index) => {
    const data = index || [];
    const idx = data.findIndex(e => e.id === id);
    if (idx >= 0) {
      found = true;
      data.splice(idx, 1);
    }
    return data;
  });

  const fileDeleted = deleteMemory(id);

  if (!found && !fileDeleted) {
    console.error(`${C.yellow}⚠ Memory "${id}" not found.${C.reset}`);
    return;
  }

  if (!fileDeleted && found) {
    console.error(`${C.yellow}⚠ Index entry removed but .md file was already missing.${C.reset}`);
  }

  console.log(`${C.green}[memory]${C.reset} Deleted: ${C.bold}${id}${C.reset}`);
}

// ── recall ───────────────────────────────────────────────────────────

export function cmdRecall(args) {
  const query = args.join(' ');
  if (!query) {
    console.error(`${C.red}❌ Usage: recall <query>${C.reset}`);
    process.exit(1);
  }

  const results = searchIndex(query);

  console.log(`${C.green}[memory]${C.reset} ${results.length} memories found for "${query}"\n`);

  if (results.length === 0) return;

  for (const r of results) {
    const tags = r.tags && r.tags.length > 0 ? r.tags.join(', ') : '';
    const date = r.created ? r.created.slice(0, 10) : '';
    console.log(`  ${C.bold}${r.id}${C.reset} [${r.type}] ${r.title} (${date})`);
    if (tags) console.log(`    Tags: ${tags} | Confidence: ${r.confidence}`);
    if (r.why) console.log(`    → ${r.why}`);
    console.log('');
  }
}

// ── inject ───────────────────────────────────────────────────────────

export function cmdInject() {
  const signals = collectContextSignals();
  const signalTokens = tokenizeSignals(signals);

  const index = readIndex();
  const scored = [];

  for (const entry of index) {
    if (isExpired(entry)) continue;

    let score = 0;
    const titleTokens = (entry.title || '').toLowerCase().split(/[\s/\-_.]+/).filter(t => t.length > 1);
    const tagTokens = (entry.tags || []).map(t => t.toLowerCase());
    const whyTokens = (entry.why || '').toLowerCase().split(/[\s/\-_.]+/).filter(t => t.length > 1);

    for (const st of signalTokens) {
      for (const tt of titleTokens) {
        if (tt.includes(st) || st.includes(tt)) score += 2;
      }
      for (const tag of tagTokens) {
        if (tag.includes(st) || st.includes(tag)) score += 3;
      }
      for (const wt of whyTokens) {
        if (wt.includes(st) || st.includes(wt)) score += 1;
      }
    }

    if (score > 0) scored.push({ ...entry, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 5);

  if (top.length === 0) return; // Silent if no matches

  console.log(`${C.green}[memory]${C.reset} Injected ${top.length} relevant memories:`);
  for (const e of top) {
    console.log(`  - ${e.id}: ${e.title} (${e.type})`);
  }
  console.log('');

  // Print full content
  for (const e of top) {
    const mem = readMemory(e.id);
    if (mem && mem.body) {
      console.log(`--- ${e.id}: ${e.title} ---`);
      console.log(mem.body.trim());
      console.log('');
    }
  }
}

function collectContextSignals() {
  const signals = [];

  // 1. Recent git changes
  try {
    const gitDiff = execSync('git diff --name-only HEAD~5 HEAD 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
    signals.push(...gitDiff.trim().split('\n').filter(Boolean));
  } catch { /* git unavailable or too few commits */ }

  // 2. Recent git commit messages
  try {
    const gitLog = execSync('git log --oneline -10 --format="%s" 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
    signals.push(...gitLog.trim().split('\n').filter(Boolean));
  } catch { /* ignore */ }

  // 3. Active x-build project
  try {
    const buildRoot = join(process.cwd(), '.xm', 'build', 'projects');
    if (existsSync(buildRoot)) {
      const projects = readdirSync(buildRoot);
      signals.push(...projects);
    }
  } catch { /* ignore */ }

  return signals;
}

function tokenizeSignals(signals) {
  const tokens = new Set();
  for (const s of signals) {
    const parts = s.toLowerCase().split(/[\s/\-_.,:;()[\]{}]+/).filter(t => t.length > 1);
    for (const p of parts) tokens.add(p);
  }
  return [...tokens];
}

// ── export ───────────────────────────────────────────────────────────

export function cmdExport(args) {
  const opts = parseOpts(args);
  const format = opts.format || 'md';
  const index = readIndex().filter(e => !isExpired(e));

  let output;
  if (format === 'json') {
    const memories = {};
    for (const entry of index) {
      const filepath = join(MEMORIES_DIR, `${entry.id}.md`);
      if (existsSync(filepath)) {
        memories[entry.id] = readFileSync(filepath, 'utf8');
      }
    }
    output = JSON.stringify({ index, memories }, null, 2);
  } else {
    const parts = [];
    for (const entry of index) {
      const filepath = join(MEMORIES_DIR, `${entry.id}.md`);
      if (existsSync(filepath)) {
        parts.push(readFileSync(filepath, 'utf8'));
      }
    }
    output = parts.join('\n---\n\n');
  }

  if (opts.output) {
    mkdirSync(dirname(opts.output), { recursive: true });
    writeFileSync(opts.output, output, 'utf8');
    console.log(`${C.green}[memory]${C.reset} Exported ${index.length} memories → ${opts.output}`);
  } else {
    console.log(output);
  }
}

// ── import ───────────────────────────────────────────────────────────

export function cmdImport(args) {
  const file = args[0];
  if (!file || !existsSync(file)) {
    console.error(`${C.red}❌ Usage: import <file>${C.reset}`);
    if (file) console.error(`${C.red}   File not found: ${file}${C.reset}`);
    process.exit(1);
  }

  const content = readFileSync(file, 'utf8');
  let importData;
  try {
    importData = JSON.parse(content);
  } catch {
    console.error(`${C.red}❌ Failed to parse import file. Only JSON format is supported.${C.reset}`);
    process.exit(1);
  }

  const importIndex = importData.index || [];
  const importMemories = importData.memories || {};

  let imported = 0, skipped = 0, errors = 0;
  const existingIndex = readIndex();

  for (const entry of importIndex) {
    // Dedup check: case-insensitive title+type
    const isDup = existingIndex.some(e =>
      e.title.toLowerCase() === entry.title.toLowerCase() && e.type === entry.type
    );
    if (isDup) {
      skipped++;
      continue;
    }

    try {
      const newEntry = saveEntry(entry.title, {
        type: entry.type,
        why: entry.why,
        tags: (entry.tags || []).join(','),
        ttl: entry.ttl,
        files: (entry.related_files || []).join(','),
        confidence: entry.confidence,
        source: entry.source,
      });

      // Overwrite .md with original content if available
      if (importMemories[entry.id]) {
        const origContent = importMemories[entry.id];
        const updatedContent = origContent.replace(
          /^id: .*/m,
          `id: ${newEntry.id}`
        );
        writeMemory(newEntry.id, updatedContent);
      }

      imported++;
    } catch {
      errors++;
    }
  }

  console.log(`${C.green}[memory]${C.reset} Import complete`);
  console.log(`  Imported: ${imported} | Skipped (duplicate): ${skipped} | Errors: ${errors}`);
}

// ── stats ────────────────────────────────────────────────────────────

export function cmdStats() {
  const index = readIndex();

  const typeCounts = {};
  const typeAges = {};
  const tagCounts = {};
  let expired = 0;
  let expiringIn7d = 0;
  const now = Date.now();
  const sevenDays = 7 * 86400 * 1000;

  for (const entry of index) {
    // Type counts
    typeCounts[entry.type] = (typeCounts[entry.type] || 0) + 1;

    // Type ages
    if (!typeAges[entry.type]) typeAges[entry.type] = [];
    const ageMs = now - new Date(entry.created).getTime();
    typeAges[entry.type].push(ageMs);

    // Tag counts
    for (const tag of (entry.tags || [])) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }

    // Expiry
    if (isExpired(entry)) {
      expired++;
    } else if (entry.expires_at) {
      const remaining = new Date(entry.expires_at).getTime() - now;
      if (remaining > 0 && remaining < sevenDays) expiringIn7d++;
    }
  }

  console.log(`${C.green}[memory]${C.reset} Statistics\n`);
  console.log(`| Type     | Count | Avg Age |`);
  console.log(`|----------|-------|---------|`);

  for (const type of MEMORY_TYPES) {
    const count = typeCounts[type] || 0;
    const ages = typeAges[type] || [];
    const avgAge = ages.length > 0
      ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length / 86400000)
      : 0;
    console.log(`| ${type.padEnd(8)} | ${String(count).padEnd(5)} | ${avgAge}d`.padEnd(9) + ' |');
  }

  console.log('');
  console.log(`Total: ${index.length} memories | ${expired} expired | ${expiringIn7d} expiring within 7d`);

  // Tag frequency
  const sortedTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);
  if (sortedTags.length > 0) {
    const tagStr = sortedTags.slice(0, 10).map(([t, c]) => `${t}(${c})`).join(', ');
    console.log(`Tags: ${tagStr}`);
  }

  console.log(`Storage: ${ROOT} | Index: ${index.length} entries`);
}

// ── Option parser ────────────────────────────────────────────────────

function parseOpts(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (key === 'expired') {
        opts.expired = true;
      } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        opts[key] = args[++i];
      } else {
        opts[key] = true;
      }
    }
  }
  return opts;
}
