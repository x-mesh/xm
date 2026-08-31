import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const LESSON_PATH_RE = /^humble\/lessons\/(L[0-9]+)(?:\.[^/]*)?\.json$/;
const STATUS_RANK = { deprecated: 0, recorded: 1, active: 2 };

export function canonicalLessonPath(path) {
  const match = String(path || '').match(LESSON_PATH_RE);
  return match ? 'humble/lessons/' + match[1] + '.json' : null;
}

function timestampOf(lesson) {
  for (const value of [lesson?.last_confirmed, lesson?.created_at]) {
    const ms = Date.parse(value || '');
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

function lessonIdFromPath(path) {
  return basename(path, '.json').split('.')[0];
}

export function mergeLessons(canonicalPath, contents) {
  const lessons = [];
  for (const content of contents) {
    try {
      const value = typeof content === 'string' ? JSON.parse(content) : content;
      if (value && typeof value === 'object' && !Array.isArray(value)) lessons.push(value);
    } catch { /* invalid copies are ignored instead of poisoning sync */ }
  }
  if (!lessons.length) return null;
  lessons.sort((a, b) => timestampOf(a) - timestampOf(b));
  const newest = lessons[lessons.length - 1];
  const merged = { ...newest, id: newest.id || lessonIdFromPath(canonicalPath) };
  merged.confirmed_count = Math.max(0, ...lessons.map((x) => Number(x.confirmed_count) || 0));
  merged.applied_to_claudemd = lessons.some((x) => x.applied_to_claudemd === true);
  if (!newest.status) {
    merged.status = lessons.reduce((best, x) => (STATUS_RANK[x.status] ?? -1) > (STATUS_RANK[best] ?? -1) ? x.status : best, 'recorded');
  }
  const created = lessons.map((x) => x.created_at).filter(Boolean).sort();
  if (created.length) merged.created_at = created[0];
  const confirmed = lessons.map((x) => x.last_confirmed).filter(Boolean).sort();
  if (confirmed.length) merged.last_confirmed = confirmed[confirmed.length - 1];
  return JSON.stringify(merged, null, 2) + '\n';
}

function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

export function migrateLessonStore(xmDir) {
  const dir = join(xmDir, 'humble', 'lessons');
  if (!existsSync(dir)) return { groups: 0, removed: 0, invalid: 0 };
  const groups = new Map();
  let invalid = 0;
  for (const name of readdirSync(dir)) {
    const canonical = canonicalLessonPath('humble/lessons/' + name);
    if (!canonical) continue;
    let content;
    try { content = readFileSync(join(dir, name), 'utf8'); } catch { invalid++; continue; }
    if (!groups.has(canonical)) groups.set(canonical, []);
    groups.get(canonical).push({ name, content });
  }
  let removed = 0;
  for (const [canonical, files] of groups) {
    const merged = mergeLessons(canonical, files.map((f) => f.content));
    if (!merged) { invalid += files.length; continue; }
    writeAtomic(join(xmDir, canonical), merged);
    for (const file of files) {
      if (file.name === basename(canonical)) continue;
      rmSync(join(dir, file.name), { force: true });
      removed++;
    }
  }
  return { groups: groups.size, removed, invalid };
}

export function mergeLessonVersions(xmDir, canonicalPath, versions) {
  const target = join(xmDir, canonicalPath);
  const contents = [];
  let previous = null;
  if (existsSync(target)) {
    try { previous = readFileSync(target, 'utf8'); contents.push(previous); } catch { /* use remote */ }
  }
  contents.push(...versions.map((v) => v.content));
  const merged = mergeLessons(canonicalPath, contents);
  if (!merged) return { written: false, invalid: versions.length };
  if (previous === merged) return { written: false, invalid: 0 };
  writeAtomic(target, merged);
  return { written: true, invalid: 0 };
}
