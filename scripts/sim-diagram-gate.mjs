#!/usr/bin/env node
/**
 * sim-diagram-gate.mjs — Deterministic validation of the Section 8 diagram gate
 * + the `<!-- prd-template-version: N -->` retroactive downgrade policy.
 *
 * Background (CLAUDE.md L9): the gate rule and its retroactive exemption must
 * be validated against REAL data (the repo's own PRD.md files) plus synthetic
 * adversarial fixtures, not decided by reading the template and assuming it
 * works. This is a STANDALONE simulator (per interface contract: no
 * production-code imports) — the detection rules are reimplemented here.
 *
 * Primary rule candidate (from x-build/skills/build/references/prd-template.md:103):
 *   "prd-check blocks Execute entry if Section 8 contains no `■ Diagram:`
 *    marker followed by a fenced diagram block."
 *   Implemented as: within the Section 8 scope (from the `## 8.` heading line
 *   up to the next `## ` heading, exclusive), a `■ Diagram:` marker line is
 *   present AND at least one fenced code block in that same scope has
 *   non-whitespace content. (Section 9's own diagram marker must NOT count —
 *   scope is bounded to Section 8 only.)
 *
 * Auxiliary rule candidates (tested for adoption, not assumed):
 *   (a) box-drawing characters in a fenced block, WITHOUT requiring the
 *       ■ marker — candidate for accepting diagrams that don't follow the
 *       literal marker convention.
 *   (b) Mermaid keyword/tag in a fenced block, WITHOUT requiring the marker.
 *
 * Retroactive policy: no `<!-- prd-template-version: N -->` marker anywhere
 * in the PRD text, OR a stamped N below PRD_TEMPLATE_VERSION -> any
 * "blocking" verdict from the primary/aux rules is downgraded to "warning"
 * (never blocks Execute entry for pre-existing PRDs).
 *
 * Usage: node scripts/sim-diagram-gate.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// ═══════════════════════════════════════════════════════════════════════════
// RULE IMPLEMENTATIONS (standalone — mirrors prd-template.md's gate spec, does
// NOT import x-build/lib/x-build/plan.mjs)
// ═══════════════════════════════════════════════════════════════════════════

// Fence-aware (F2) + space-symmetric end boundary (F8) + CommonMark
// delimiter-length matching (F9) — mirrors
// x-build/lib/x-build/plan.mjs:extractSectionScope exactly, per the
// interface contract that this simulator's rules stay in lockstep with the
// production implementation it validates.
const NEXT_HEADING_RE = /^##(?!#)/;

// Same delimiter-length rule as plan.mjs:matchFenceDelim (F9): a closing
// fence only counts when its backtick run is >= the opening run's length, so
// a nested ``` shown as literal content inside a ```` fence doesn't
// prematurely close it.
const FENCE_DELIM_RE = /^`{3,}/;
function matchFenceDelim(trimmedLine) {
  const m = FENCE_DELIM_RE.exec(trimmedLine);
  return m ? m[0] : null;
}

function extractSection(fullText, headingNum) {
  const lines = fullText.split('\n');
  const headRe = new RegExp(`^##\\s*${headingNum}\\.`);
  let start = -1;
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (fence) {
      const closeDelim = matchFenceDelim(trimmed);
      if (closeDelim && closeDelim.length >= fence.length) fence = null;
      continue;
    }
    const openDelim = matchFenceDelim(trimmed);
    if (openDelim) { fence = openDelim; continue; }
    if (headRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  fence = null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (fence) {
      const closeDelim = matchFenceDelim(trimmed);
      if (closeDelim && closeDelim.length >= fence.length) fence = null;
      continue;
    }
    const openDelim = matchFenceDelim(trimmed);
    if (openDelim) { fence = openDelim; continue; }
    if (NEXT_HEADING_RE.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

// Line-based scan (mirrors plan.mjs:extractFencedBlocks) rather than a
// regex, so the same CommonMark delimiter-length rule applies here too — the
// prior regex-based version treated ANY ``` as a closing delimiter,
// mis-closing a ```` (4-backtick) fence at a nested ``` shown as literal
// content.
function extractFences(text) {
  const out = [];
  const lines = text.split('\n');
  let fence = null;
  let lang = '';
  let body = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (fence) {
      const closeDelim = matchFenceDelim(trimmed);
      if (closeDelim && closeDelim.length >= fence.length) {
        out.push({ lang, body: body.join('\n') });
        fence = null;
        continue;
      }
      body.push(raw);
      continue;
    }
    const openDelim = matchFenceDelim(trimmed);
    if (openDelim) {
      fence = openDelim;
      lang = trimmed.slice(openDelim.length).trim().toLowerCase();
      body = [];
    }
  }
  return out;
}

const MARKER_RE = /■\s*Diagram\s*:/;
// Captures the version number (F3) — production blocks only when the
// stamped version is >= PRD_TEMPLATE_VERSION, not merely "a marker exists".
const VERSION_MARKER_RE = /<!--\s*prd-template-version\s*:\s*(\d+)\s*-->/;
const BOX_CHAR_RE = /[─│┌┐└┘├┤┬┴┼╌▶]/;
const MERMAID_KEYWORD_RE = /graph\s+(td|lr|tb|rl)\b|sequencediagram|classdiagram|statediagram|erdiagram/i;

// Mirrors x-build/lib/x-build/plan.mjs:PRD_TEMPLATE_VERSION — kept as a
// local constant per the "standalone, no production imports" interface
// contract; update both if the template version ever bumps.
const PRD_TEMPLATE_VERSION = 2;

// F3: production's isNewTemplate = versionMatch != null && version >=
// PRD_TEMPLATE_VERSION — "has a marker" alone is not sufficient.
function isNewTemplateVersion(fullText) {
  const m = fullText.match(VERSION_MARKER_RE);
  if (!m) return false;
  return parseInt(m[1], 10) >= PRD_TEMPLATE_VERSION;
}

/** Primary rule: marker line present in scope AND a non-empty fence in scope. */
function primaryRule(section8Text) {
  if (!section8Text) return { pass: false, reason: 'no Section 8 found' };
  if (!MARKER_RE.test(section8Text)) return { pass: false, reason: 'no ■ Diagram: marker in Section 8 scope' };
  const fences = extractFences(section8Text);
  const nonEmpty = fences.some((f) => f.body.trim().length > 0);
  if (!nonEmpty) return { pass: false, reason: 'marker present but no non-empty fenced block in scope' };
  return { pass: true, reason: 'marker + non-empty fenced block' };
}

function countBoxChars(str) {
  const m = str.match(new RegExp(BOX_CHAR_RE.source, 'g'));
  return m ? m.length : 0;
}
function linesWithBoxChar(str) {
  return str.split('\n').filter((l) => BOX_CHAR_RE.test(l)).length;
}

/** Aux rule (a): fenced block with box-drawing chars, marker NOT required. */
function auxBoxRule(section8Text, { minChars = 6, minLines = 2 } = {}) {
  if (!section8Text) return { pass: false, reason: 'no Section 8 found' };
  for (const { body } of extractFences(section8Text)) {
    const chars = countBoxChars(body);
    const lines = linesWithBoxChar(body);
    if (chars >= minChars && lines >= minLines) {
      return { pass: true, reason: `fenced block: ${chars} box-chars across ${lines} lines` };
    }
  }
  return { pass: false, reason: `no fenced block meets box-char threshold (>=${minChars} chars, >=${minLines} lines)` };
}

/** Aux rule (b): fenced ```mermaid block or mermaid keyword, marker NOT required. */
function auxMermaidRule(section8Text) {
  if (!section8Text) return { pass: false, reason: 'no Section 8 found' };
  for (const { lang, body } of extractFences(section8Text)) {
    // F1: an empty ```mermaid fence must not count as a diagram — mirrors
    // plan.mjs:sectionHasDiagram's non-empty-body check on the mermaid path.
    if (lang === 'mermaid' && body.trim().length > 0) return { pass: true, reason: 'fenced ```mermaid block' };
    if (MERMAID_KEYWORD_RE.test(body)) return { pass: true, reason: 'mermaid keyword inside fenced block' };
  }
  return { pass: false, reason: 'no mermaid tag/keyword found' };
}

/**
 * Full gate verdict for one PRD text, under a given rule-set variant.
 * `useBox`/`useMermaid` toggle whether the aux rules count as an alternate pass path.
 */
function evaluate(fullText, { useBox = false, useMermaid = false } = {}) {
  const section8 = extractSection(fullText, 8);
  const primary = primaryRule(section8);
  const box = useBox ? auxBoxRule(section8) : { pass: false, reason: 'aux rule not enabled' };
  const mermaid = useMermaid ? auxMermaidRule(section8) : { pass: false, reason: 'aux rule not enabled' };
  const diagramPresent = primary.pass || box.pass || mermaid.pass;
  const versioned = isNewTemplateVersion(fullText);
  // Gate only ever "blocks" when diagram is absent; if it's present there's
  // nothing to downgrade in the first place.
  const wouldBlock = !diagramPresent;
  const finalBlocked = wouldBlock && versioned; // retroactive downgrade when unversioned/below-threshold
  const verdict = diagramPresent ? 'pass' : finalBlocked ? 'block' : 'warning';
  return { diagramPresent, versioned, verdict, primary, box, mermaid, hasSection8: !!section8 };
}

// ═══════════════════════════════════════════════════════════════════════════
// REAL DATA — every PRD.md the repo currently has
// ═══════════════════════════════════════════════════════════════════════════

function findRealPrds() {
  const projectsDir = join(REPO_ROOT, '.xm', 'build', 'projects');
  const out = [];
  let entries;
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(projectsDir, name, 'phases', '02-plan', 'PRD.md');
    try {
      if (statSync(p).isFile()) out.push({ name: `real: ${name}`, text: readFileSync(p, 'utf8') });
    } catch { /* no PRD for this project */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ═══════════════════════════════════════════════════════════════════════════
// SYNTHETIC FIXTURES — adversarial + edge cases the real corpus doesn't cover
// ═══════════════════════════════════════════════════════════════════════════

const VERSION_STAMP = '<!-- prd-template-version: 1 -->';

const synthetic = [
  {
    name: 'synth: TS snippet only, no marker (true-negative probe)',
    text: `${VERSION_STAMP}
# PRD: fixture

## 8. Architecture

Here is illustrative code:

\`\`\`typescript
interface Foo {
  bar: string;
}
function baz(x: Foo): string {
  return x.bar;
}
\`\`\`

## 9. Key Scenarios
n/a
`,
    expectDiagram: false,
  },
  {
    name: 'synth: marker + EMPTY fenced block (gaming probe)',
    text: `${VERSION_STAMP}
# PRD: fixture

## 8. Architecture

■ Diagram: nothing here
■ Purpose: placeholder only

\`\`\`
\`\`\`

## 9. Key Scenarios
n/a
`,
    expectDiagram: false,
  },
  {
    name: 'synth: marker + normal ASCII block (template-conformant)',
    text: `${VERSION_STAMP}
# PRD: fixture

## 8. Architecture

■ Diagram: System Architecture
■ Purpose: client calls server which calls db

\`\`\`
[Client] ──▶ [Server] ──▶ [(DB)]
\`\`\`

■ Legend:
  - ──▶ : synchronous call

## 9. Key Scenarios
n/a
`,
    expectDiagram: true,
  },
  {
    name: 'synth: marker only in Section 9 (scope-leak probe)',
    text: `${VERSION_STAMP}
# PRD: fixture

## 8. Architecture

This section has no diagram, only a prose description of the design.

## 9. Key Scenarios

■ Diagram: Sequence
■ Purpose: login flow

\`\`\`
User   Server   DB
 │─req─▶│       │
 │      │─q────▶│
\`\`\`

## 10. Data Model
n/a
`,
    expectDiagram: false, // for the SECTION 8 gate specifically
  },
  {
    name: 'synth: box-drawing diagram, NO marker (aux-box probe)',
    text: `${VERSION_STAMP}
# PRD: fixture

## 8. Architecture

The system flow:

\`\`\`
┌────────┐     ┌────────┐     ┌────────┐
│ Client │────▶│ Server │────▶│   DB   │
└────────┘     └────────┘     └────────┘
\`\`\`

## 9. Key Scenarios
n/a
`,
    expectDiagram: 'aux-box-only',
  },
  {
    name: 'synth: mermaid graph, NO marker (aux-mermaid probe)',
    text: `${VERSION_STAMP}
# PRD: fixture

## 8. Architecture

\`\`\`mermaid
graph LR
  Client --> Server --> DB
\`\`\`

## 9. Key Scenarios
n/a
`,
    expectDiagram: 'aux-mermaid-only',
  },
  {
    name: 'synth: decorative single-line divider (box false-positive stress test)',
    text: `${VERSION_STAMP}
# PRD: fixture

## 8. Architecture

Some prose before a divider.

\`\`\`
──────────────────────────────
\`\`\`

More prose after.

## 9. Key Scenarios
n/a
`,
    expectDiagram: false, // 1 line only -> must NOT satisfy aux-box (density guard)
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// RUN
// ═══════════════════════════════════════════════════════════════════════════

const realPrds = findRealPrds();
const allCases = [...realPrds, ...synthetic];

const variants = [
  { key: 'P0 (primary only)', useBox: false, useMermaid: false },
  { key: 'P1 (primary + auxBox)', useBox: true, useMermaid: false },
  { key: 'P2 (primary + auxMermaid)', useBox: false, useMermaid: true },
  { key: 'P3 (primary + auxBox + auxMermaid)', useBox: true, useMermaid: true },
];

console.log('# Diagram-Gate Simulation\n');
console.log(`Real PRDs found: ${realPrds.length}   Synthetic fixtures: ${synthetic.length}\n`);

// ── Matrix: real corpus, retroactive policy check (must be 0 blocks always) ──
console.log('## Real Corpus — retroactive policy check (expect: 0 blocked, any verdict of pass/warning only)\n');
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('Project', 34) + pad('has §8', 8) + pad('versioned', 11) + pad('primary', 9) + pad('P0 verdict', 12) + 'P3 verdict (primary+box+mermaid)');
console.log('─'.repeat(34 + 8 + 11 + 9 + 12 + 32));
let realBlocked = 0;
for (const c of realPrds) {
  const p0 = evaluate(c.text, { useBox: false, useMermaid: false });
  const p3 = evaluate(c.text, { useBox: true, useMermaid: true });
  if (p0.verdict === 'block' || p3.verdict === 'block') realBlocked++;
  console.log(
    pad(c.name.replace('real: ', ''), 34) +
      pad(p0.hasSection8 ? 'yes' : 'NO', 8) +
      pad(p0.versioned ? 'yes' : 'no', 11) +
      pad(p0.primary.pass ? 'PASS' : 'fail', 9) +
      pad(p0.verdict, 12) +
      p3.verdict
  );
}
console.log(`\nReal corpus blocked count: ${realBlocked} / ${realPrds.length} (target: 0)\n`);

// ── Matrix: synthetic fixtures across all 4 rule variants ──
console.log('## Synthetic Fixtures — rule-variant matrix\n');
console.log(pad('Fixture', 58) + pad('expect', 16) + variants.map((v) => pad(v.key, 26)).join(''));
console.log('─'.repeat(58 + 16 + 26 * variants.length));
let falsePos = { P0: 0, P1: 0, P2: 0, P3: 0 };
let falseNeg = { P0: 0, P1: 0, P2: 0, P3: 0 };
const variantShortKeys = ['P0', 'P1', 'P2', 'P3'];
for (const c of synthetic) {
  const results = variants.map((v) => evaluate(c.text, v));
  const row = pad(c.name.replace('synth: ', ''), 58) + pad(String(c.expectDiagram), 16) +
    results.map((r) => pad(r.diagramPresent ? 'DIAGRAM-DETECTED' : 'no-diagram', 26)).join('');
  console.log(row);
  // Score false pos/neg per variant against the intended ground truth.
  // Ground truth for "should this fixture read as a real diagram":
  //   expectDiagram === true            -> should detect
  //   expectDiagram === false           -> should NOT detect
  //   expectDiagram === 'aux-box-only'  -> should NOT detect under P0/P2, SHOULD under P1/P3
  //   expectDiagram === 'aux-mermaid-only' -> should NOT detect under P0/P1, SHOULD under P2/P3
  results.forEach((r, i) => {
    const key = variantShortKeys[i];
    let shouldDetect;
    if (c.expectDiagram === true) shouldDetect = true;
    else if (c.expectDiagram === false) shouldDetect = false;
    else if (c.expectDiagram === 'aux-box-only') shouldDetect = key === 'P1' || key === 'P3';
    else if (c.expectDiagram === 'aux-mermaid-only') shouldDetect = key === 'P2' || key === 'P3';
    if (r.diagramPresent && !shouldDetect) falsePos[key]++;
    if (!r.diagramPresent && shouldDetect) falseNeg[key]++;
  });
}

console.log('\n## Synthetic false-positive / false-negative counts per variant (of 7 fixtures)\n');
console.log(pad('Variant', 40) + pad('false-positive', 16) + 'false-negative');
for (const v of variants) {
  const key = v.key.split(' ')[0];
  console.log(pad(v.key, 40) + pad(String(falsePos[key]), 16) + String(falseNeg[key]));
}

console.log('\n## Decision\n');
console.log('| Rule | False-positive (of 7 synthetic) | False-negative (of 7) | Adopt? |');
console.log('|---|---|---|---|');
console.log(`| Primary (marker + non-empty fence) | ${falsePos.P0} | ${falseNeg.P0} | baseline — always on |`);
console.log(`| + auxBox (box-chars, no marker required) | ${falsePos.P1} | ${falseNeg.P1} | ${falsePos.P1 === 0 ? 'YES — 0 false positives, catches real marker-less diagrams' : 'reject — introduces false positives'} |`);
console.log(`| + auxMermaid (mermaid tag/keyword, no marker required) | ${falsePos.P2} | ${falseNeg.P2} | ${falsePos.P2 === 0 ? 'YES — 0 false positives, catches mermaid diagrams' : 'reject — introduces false positives'} |`);
console.log(`| + both (P3) | ${falsePos.P3} | ${falseNeg.P3} | ${falsePos.P3 === 0 ? 'YES — combined, 0 false positives' : 'reject'} |`);

console.log(`\nReal corpus blocked count under recommended variant (P3): still 0 = ${realBlocked === 0}`);
