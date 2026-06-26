/**
 * x-recall/scan — enumerate and normalize .xm/ artifacts into a single shape.
 *
 * Every artifact, whatever its on-disk format, normalizes to:
 *   { type, id, title, status, created_at, project, path, format, meta }
 *
 * - type:       review | op | plan | eval | probe | humble | solver | research | prd | handoff
 * - id:         stable, host-stripped selector (e.g. "op:council-2026-04-06-xsync")
 * - title:      one-line human label
 * - status:     verdict / phase / state (type-specific)
 * - created_at: ISO timestamp, primary sort key
 * - project:    build/solver project name, else null
 * - path:       canonical file (or project dir) to read for `show`
 * - format:     json | md | project
 * - meta:       type-specific extras
 *
 * Missing directories and malformed files degrade gracefully (never throw):
 * legacy artifacts may lack self_score, topic, line, etc.
 */

import {
  join, existsSync, readText, readJSON, listFiles, listDirs,
  dedupeByHost, stripHostSuffix, stripExt, firstHeading, isoFromMtime,
  normalizeVerdict, toMillis, parseSince,
} from './core.mjs';

const ALL_TYPES = ['review', 'op', 'plan', 'eval', 'probe', 'humble', 'solver', 'research', 'prd', 'handoff', 'panel'];

export function knownTypes() {
  return ALL_TYPES.slice();
}

// ── per-type scanners ────────────────────────────────────────────────

function scanReview(root) {
  const dir = join(root, 'review');
  const out = [];
  // Latest structured result (drives `show review --last`).
  const latest = dedupeByHost(listFiles(dir, ['.json']).filter(f => f.name.startsWith('last-result')));
  for (const f of latest) {
    const j = readJSON(f.path) || {};
    out.push({
      type: 'review', id: 'review:last',
      title: `${j.target?.ref || j.reviewed_commit || 'review'} — ${normalizeVerdict(j.verdict) || '?'}`,
      status: normalizeVerdict(j.verdict),
      created_at: j.date || isoFromMtime(f.mtimeMs),
      project: null, path: f.path, format: 'json',
      meta: { target: j.target?.ref || null, lenses: j.lenses || [], findings: (j.findings || []).length },
    });
  }
  // History archive (one entry per past review).
  for (const f of dedupeByHost(listFiles(join(dir, 'history'), ['.md']))) {
    const m = f.name.match(/^(\d{4}-\d{2}-\d{2})-(.+)\.md$/);
    out.push({
      type: 'review', id: 'review:' + stripExt(stripHostSuffix(f.name)),
      title: firstHeading(f.path) || (m ? m[2] : stripExt(f.name)),
      status: '', created_at: m ? m[1] : isoFromMtime(f.mtimeMs),
      project: null, path: f.path, format: 'md', meta: {},
    });
  }
  return out;
}

function scanOp(root) {
  const dir = join(root, 'op');
  return dedupeByHost(listFiles(dir, ['.json'])).map(f => {
    const j = readJSON(f.path) || {};
    return {
      type: 'op', id: 'op:' + stripExt(stripHostSuffix(f.name)),
      // canonical key is `topic`; tolerate legacy question/problem/subject/theme
      title: j.topic || j.question || j.problem || j.subject || j.theme || stripExt(f.name),
      status: (j.outcome && j.outcome.verdict) || j.status || '',
      // tolerate legacy op artifacts that carry only `date` or `timestamp`
      created_at: j.created_at || j.completed_at || j.date || j.timestamp || isoFromMtime(f.mtimeMs),
      project: null, path: f.path, format: 'json',
      meta: { strategy: j.strategy || null, score: (j.self_score && j.self_score.overall) ?? null },
    };
  });
}

function scanPlan(root) {
  const base = join(root, 'build', 'projects');
  const out = [];
  for (const d of listDirs(base)) {
    const mf = dedupeByHost(listFiles(d.path, ['.json']).filter(f => f.name.startsWith('manifest')))[0];
    const j = mf ? readJSON(mf.path) : null;
    if (!j) continue;
    out.push({
      type: 'plan', id: 'plan:' + d.name,
      title: j.display_name || j.name || d.name,
      status: j.current_phase || '',
      created_at: j.updated_at || j.created_at || isoFromMtime(d.mtimeMs),
      project: d.name, path: d.path, format: 'project',
      meta: { phase: j.current_phase || null, dir: d.path },
    });
  }
  return out;
}

function scanEval(root) {
  const dir = join(root, 'eval', 'results');
  return dedupeByHost(listFiles(dir, ['.json'])).map(f => {
    const j = readJSON(f.path) || {};
    return {
      type: 'eval', id: 'eval:' + stripExt(stripHostSuffix(f.name)),
      title: j.target || j.rubric || stripExt(f.name),
      status: j.overall != null ? `score ${j.overall}` : (j.type || ''),
      created_at: j.timestamp || isoFromMtime(f.mtimeMs),
      project: null, path: f.path, format: 'json',
      meta: { rubric: j.rubric || null, overall: j.overall ?? null, sigma: j.sigma ?? null },
    };
  });
}

function probeRecord(id, f, j) {
  return {
    type: 'probe', id,
    title: j.idea || stripExt(f.name),
    status: j.verdict || '',
    created_at: j.timestamp || isoFromMtime(f.mtimeMs),
    project: null, path: f.path, format: 'json',
    meta: { variant: j.variant || null, ambiguity: j.ambiguity_score ?? null },
  };
}

function scanProbe(root) {
  const dir = join(root, 'probe');
  const out = [];
  for (const f of dedupeByHost(listFiles(dir, ['.json']).filter(f => f.name.startsWith('last-verdict')))) {
    out.push(probeRecord('probe:last', f, readJSON(f.path) || {}));
  }
  for (const f of dedupeByHost(listFiles(join(dir, 'history'), ['.json']))) {
    out.push(probeRecord('probe:' + stripExt(stripHostSuffix(f.name)), f, readJSON(f.path) || {}));
  }
  return out;
}

function scanHumble(root) {
  const out = [];
  for (const f of dedupeByHost(listFiles(join(root, 'humble', 'lessons'), ['.json']))) {
    const j = readJSON(f.path) || {};
    out.push({
      type: 'humble', id: 'humble:' + stripExt(stripHostSuffix(f.name)),
      title: j.content || j.id || stripExt(f.name),
      status: j.type || 'lesson',
      created_at: j.created_at || j.last_confirmed || isoFromMtime(f.mtimeMs),
      project: null, path: f.path, format: 'json',
      meta: { confirmed: j.confirmed_count ?? null },
    });
  }
  for (const f of dedupeByHost(listFiles(join(root, 'humble', 'retrospectives'), ['.json']))) {
    const j = readJSON(f.path) || {};
    out.push({
      type: 'humble', id: 'humble:' + stripExt(stripHostSuffix(f.name)),
      title: j.session_summary || stripExt(f.name),
      status: 'retro',
      created_at: j.timestamp || isoFromMtime(f.mtimeMs),
      project: null, path: f.path, format: 'json', meta: {},
    });
  }
  return out;
}

function scanSolver(root) {
  const base = join(root, 'solver', 'problems');
  const out = [];
  for (const d of listDirs(base)) {
    const mf = dedupeByHost(listFiles(d.path, ['.json']).filter(f => f.name.startsWith('manifest')))[0];
    const j = mf ? readJSON(mf.path) : null;
    if (!j) continue;
    out.push({
      type: 'solver', id: 'solver:' + d.name,
      title: j.display_name || j.name || d.name,
      status: j.state || j.current_phase || '',
      created_at: j.updated_at || j.created_at || isoFromMtime(d.mtimeMs),
      project: d.name, path: d.path, format: 'project',
      meta: { strategy: j.strategy || null, phase: j.current_phase || null, dir: d.path },
    });
  }
  return out;
}

function scanResearch(root) {
  const base = join(root, 'research');
  const out = [];
  for (const d of listDirs(base)) {
    const m = d.name.match(/(\d{8})-(\d{6})/);
    let created = isoFromMtime(d.mtimeMs);
    if (m) {
      const [, ymd, hms] = m;
      created = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4, 6)}`;
    }
    out.push({
      type: 'research', id: 'research:' + d.name,
      title: d.name, status: '', created_at: created,
      project: null, path: d.path, format: 'project', meta: { dir: d.path },
    });
  }
  return out;
}

function scanPrd(root) {
  const dir = join(root, 'prd');
  return dedupeByHost(listFiles(dir, ['.md'])).map(f => ({
    type: 'prd', id: 'prd:' + stripExt(stripHostSuffix(f.name)),
    title: firstHeading(f.path) || stripExt(f.name),
    status: '', created_at: isoFromMtime(f.mtimeMs),
    project: null, path: f.path, format: 'md', meta: {},
  }));
}

function scanHandoff(root) {
  const dir = join(root, 'build');
  const out = [];
  for (const f of dedupeByHost(listFiles(dir, ['.json']).filter(f => f.name.startsWith('SESSION-STATE')))) {
    const j = readJSON(f.path) || {};
    const md = join(dir, 'HANDOFF.md');
    out.push({
      type: 'handoff', id: 'handoff:session-state',
      title: (j.narrative && j.narrative.intent) || (j.context && j.context.current_focus) || 'Session handoff',
      status: j.why_stopped || '',
      created_at: j.saved_at || isoFromMtime(f.mtimeMs),
      project: null,
      path: existsSync(md) ? md : f.path,
      format: existsSync(md) ? 'md' : 'json',
      meta: { branch: j.where && j.where.branch, source: f.path },
    });
  }
  return out;
}

// x-panel cross-model review verdicts under .xm/panel/<run>/verdict.json
function compactPanelText(value, max = 96) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '...' : text;
}

function firstPanelClaim(j) {
  const consensus = Array.isArray(j.consensus) ? j.consensus : [];
  for (const c of consensus) {
    if (c && typeof c.claim === 'string' && c.claim.trim()) return c.claim;
    const claims = Array.isArray(c && c.claims) ? c.claims : [];
    for (const claim of claims) {
      if (claim && typeof claim.claim === 'string' && claim.claim.trim()) return claim.claim;
    }
  }
  for (const key of ['confirmed', 'contested', 'unreviewed']) {
    const items = Array.isArray(j[key]) ? j[key] : [];
    for (const item of items) {
      if (item && typeof item.claim === 'string' && item.claim.trim()) return item.claim;
    }
  }
  return '';
}

function panelTitle(j, runName, counts = {}) {
  const explicit = compactPanelText(j.title || j.target_title || j.request_title || j.summary);
  if (explicit) return explicit;
  const claim = compactPanelText(firstPanelClaim(j));
  if (claim) return `Panel review: ${claim}`;
  if (counts.unique === 0) return 'Panel review: no issues found';
  if (j.target_ref) return `Panel review: ${String(j.target_ref).split('/').pop()}`;
  const models = Array.isArray(j.models) && j.models.length ? j.models.join('+') : runName;
  return `Panel review: ${models}`;
}

function scanPanel(root) {
  const out = [];
  for (const d of listDirs(join(root, 'panel'))) {
    const vf = join(d.path, 'verdict.json');
    if (!existsSync(vf)) continue;
    const j = readJSON(vf) || {};
    const counts = j.counts || {};
    out.push({
      type: 'panel', id: 'panel:' + d.name,
      title: panelTitle(j, d.name, counts),
      status: counts.unique != null ? `${counts.unique} issues / ${counts.contested ?? 0} contested` : '',
      created_at: j.created_at || isoFromMtime(d.mtimeMs),
      project: null, path: vf, format: 'json',
      meta: { models: j.models || [], unique: counts.unique ?? null, target_kind: j.target_kind || null },
    });
  }
  return out;
}

const SCANNERS = {
  review: scanReview, op: scanOp, plan: scanPlan, eval: scanEval, probe: scanProbe,
  humble: scanHumble, solver: scanSolver, research: scanResearch, prd: scanPrd, handoff: scanHandoff,
  panel: scanPanel,
};

// ── public API ───────────────────────────────────────────────────────

export function scanAll(root, { type, project, since } = {}) {
  const types = type ? [type] : ALL_TYPES;
  let arts = [];
  for (const t of types) {
    const fn = SCANNERS[t];
    if (fn) arts.push(...fn(root));
  }
  if (project) arts = arts.filter(a => a.project === project);
  if (since) {
    const floor = parseSince(since);
    arts = arts.filter(a => toMillis(a.created_at) >= floor);
  }
  arts.sort((a, b) => toMillis(b.created_at) - toMillis(a.created_at));
  return arts;
}

export function findById(root, id) {
  return scanAll(root).find(a => a.id === id) || null;
}

export function latestOfType(root, type) {
  return scanAll(root, { type })[0] || null;
}

/** Resolve a selector to one artifact: exact id (`op:...`) or a type name (latest of type). */
export function resolveSelector(root, selector) {
  if (!selector) return null;
  if (selector.includes(':')) return findById(root, selector);
  if (ALL_TYPES.includes(selector)) return latestOfType(root, selector);
  // Fall back to a fuzzy id match (e.g. partial filename).
  return scanAll(root).find(a => a.id.endsWith(selector) || a.id.includes(selector)) || null;
}

export function search(root, query, opts = {}) {
  const arts = scanAll(root, opts);
  const q = String(query || '').toLowerCase();
  if (!q) return arts;
  return arts.filter(a => {
    const meta = [a.title, a.id, a.status, a.type, a.project, JSON.stringify(a.meta)].join(' ').toLowerCase();
    if (meta.includes(q)) return true;
    // For project artifacts the path is a dir — search its most readable file instead.
    const body = a.format === 'project' ? readableContent(a).text : readText(a.path);
    return body ? body.toLowerCase().includes(q) : false;
  });
}

/** Resolve the most human-readable file for an artifact (prefer markdown siblings). */
export function readableContent(art) {
  let path = art.path;
  if (art.format === 'json') {
    const md = path.replace(/\.json$/, '.md');
    if (existsSync(md)) path = md;
  } else if (art.format === 'project') {
    const dir = art.meta && art.meta.dir;
    if (dir) {
      // x-build writes the PRD under phases/02-plan/ (newer) or context/ (older).
      for (const cand of ['phases/02-plan/PRD.md', 'context/PRD.md', 'STATE.md', 'context/CONTEXT.md', 'board.jsonl']) {
        const c = join(dir, cand);
        if (existsSync(c)) { path = c; break; }
      }
    }
  }
  const text = readText(path);
  return { path, text: text != null ? text : '(unreadable or empty)' };
}
