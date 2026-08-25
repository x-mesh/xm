#!/usr/bin/env node
/**
 * blind-quality-rate.mjs — blind pairwise quality rating for the x-build A/B.
 *
 * The execution benchmark answers "did it pass and how long did it take". It
 * cannot answer "is the code better", because both variants run the same model
 * on the same task and the fixture tests only pin down the happy path.
 *
 * This rater takes the artifacts captured by benchmark-execution-harness.mjs
 * and asks codex to compare each paired trial. Blinding matters more than the
 * rubric here, so:
 *   - only the produced file bodies are shown, never the workspace (a harness
 *     workspace carries .xm/build/** metadata that names the variant outright);
 *   - the two sides are labelled A and B, assigned by a seeded shuffle;
 *   - the mapping is written to the output file only AFTER the rating, so a
 *     re-read of this script's own output cannot leak into a later run.
 *
 * Usage:
 *   node scripts/blind-quality-rate.mjs <benchmark.json> [--model gpt-5.6] [--out path]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const input = args.find((arg) => !arg.startsWith('--'));
const flag = (name, fallback) => {
  const index = args.indexOf('--' + name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
// Execution ran gpt-5.6-luna at low effort. Rating with a different model AND
// a higher effort keeps this from being the same model grading its own output.
const MODEL = flag('model', 'gpt-5.6-sol');
const EFFORT = flag('effort', 'high');
// Which two variants to compare. The interesting control is native-serial vs
// x-build-worktree: it holds serialization constant, so a harness win there is
// the harness's own rather than an artefact of running one agent at a time.
const LEFT = flag('left', 'native');
const RIGHT = flag('right', 'x-build-worktree');
const OUT = flag('out', join(REPO, '.xm', 'eval', 'benchmarks', 'blind-quality-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'));

if (!input || !existsSync(input)) {
  console.error('Usage: node scripts/blind-quality-rate.mjs <benchmark.json> [--model gpt-5.6] [--out path]');
  process.exit(2);
}

// Deterministic shuffle so a rerun reproduces the same A/B assignment, and so
// the assignment does not correlate with variant order in the source file.
function seededFlip(seed) {
  let hash = 2166136261;
  for (const char of seed) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 2) === 1;
}

const SHARED_FILE_RUBRIC = [
  'Correctness beyond the stated cases: does the code handle a null/undefined record, a non-string field, or an empty collection without throwing?',
  'Preservation: does it keep every pre-existing entry/rule intact rather than replacing the collection?',
  'Structure: is the addition consistent with the file it lives in, or bolted on in a different style?',
  'Restraint: does it change only what the task asked for, without unrelated rewrites, renames, or commentary?',
  'Clarity: would a reviewer understand the intent without running it?',
].map((line, index) => (index + 1) + '. ' + line).join('\n');

const REDOS_RUBRIC = [
  'Correctness beyond the stated cases: nested and nullable groups, malformed patterns, empty input, and whole-string matching.',
  'Pathological-input safety: does the algorithm bound work without exponential backtracking, unbounded recursion, or epsilon-cycle loops?',
  'Complexity: are time and memory bounds appropriate for long pattern and text input?',
  'Restraint: does it implement only the requested matcher without delegating to RegExp or adding unrelated changes?',
  'Clarity: are parser, state transitions, and termination behavior understandable from the code?',
].map((line, index) => (index + 1) + '. ' + line).join('\n');

function rubricFor(fixture) {
  return fixture === 'redos-matcher' ? REDOS_RUBRIC : SHARED_FILE_RUBRIC;
}

function contextFor(fixture) {
  if (fixture === 'redos-matcher') {
    return 'Each candidate implemented a whole-string pattern matcher supporting literals, dot, *, +, and groups without RegExp. Both pass the public tests and the same nested-quantifier stress probe.';
  }
  return 'Three separate agents each added one piece to a shared file. Both candidates pass the project tests and satisfy the stated requirements.';
}

function renderSide(label, artifacts) {
  const parts = ['### Candidate ' + label];
  for (const [file, body] of Object.entries(artifacts)) {
    parts.push('', '`' + file + '`:', '```', body === null ? '(file missing)' : body.trimEnd(), '```');
  }
  return parts.join('\n');
}

function prompt(fixture, left, right) {
  return [
    'Two candidates independently produced the same file(s) for the same task. Judge which is higher quality.',
    '',
    'Task context (' + fixture + '): ' + contextFor(fixture) + ' Grade implementation quality beyond the public pass result.',
    '',
    'Rubric:',
    rubricFor(fixture),
    '',
    renderSide('A', left),
    '',
    renderSide('B', right),
    '',
    'Answer with one JSON object and nothing else:',
    '{"winner": "A" | "B" | "tie", "confidence": "low" | "medium" | "high", "reason": "<= 40 words", "per_criterion": {"correctness": "A"|"B"|"tie", "preservation": "A"|"B"|"tie", "structure": "A"|"B"|"tie", "restraint": "A"|"B"|"tie", "clarity": "A"|"B"|"tie"}}',
  ].join('\n');
}

function rate(text) {
  // Same invocation shape the execution benchmark uses: --ephemeral and
  // --ignore-user-config keep the rater off the user's global prompt, which
  // otherwise adds tens of thousands of tokens of unrelated context.
  const args = [
    'exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
    '--sandbox', 'read-only', '-m', MODEL, '-c', 'model_reasoning_effort=' + JSON.stringify(EFFORT), '--json', text,
  ];
  const result = spawnSync('codex', args, {
    encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' },
  });
  if (result.error) return { error: result.error.message };
  let message = '';
  for (const line of (result.stdout || '').split('\n').filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      // Only the assistant's own message. An `error` item also carries
      // `message`, and taking it would silently turn a failure into a verdict.
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') message = event.item.text;
    } catch { /* non-JSON progress line */ }
  }
  const match = message.match(/\{[\s\S]*\}/);
  if (!match) return { error: 'no JSON verdict', raw: message.slice(-500) };
  try { return JSON.parse(match[0]); } catch { return { error: 'unparseable verdict', raw: match[0].slice(0, 500) }; }
}

const report = JSON.parse(readFileSync(input, 'utf8'));
const pairs = [];
for (const row of report.rows) {
  if (row.variant !== LEFT) continue;
  const partner = report.rows.find((item) => item.fixture === row.fixture && item.trial === row.trial && item.variant === RIGHT);
  if (partner) pairs.push({ fixture: row.fixture, trial: row.trial, left: row.artifacts, right: partner.artifacts });
}
if (!pairs.length) {
  console.error('no ' + LEFT + ' / ' + RIGHT + ' pairs found in ' + input);
  process.exit(2);
}

const results = [];
for (const [index, pair] of pairs.entries()) {
  const flip = seededFlip(pair.fixture + ':' + pair.trial + ':' + LEFT + ':' + RIGHT);
  const left = flip ? pair.right : pair.left;
  const right = flip ? pair.left : pair.right;
  process.stderr.write('[' + (index + 1) + '/' + pairs.length + '] ' + pair.fixture + ' trial ' + pair.trial + '\n');
  const verdict = rate(prompt(pair.fixture, left, right));
  // Unblind only now, after the verdict exists.
  const map = { A: flip ? RIGHT : LEFT, B: flip ? LEFT : RIGHT };
  const winner = verdict.winner === 'tie' || !verdict.winner ? 'tie' : map[verdict.winner] || 'tie';
  results.push({ fixture: pair.fixture, trial: pair.trial, label_map: map, verdict, winner, error: Boolean(verdict.error) });
  process.stderr.write('  → ' + winner + (verdict.error ? ' (' + verdict.error + ')' : '') + '\n');
}

const tally = { [LEFT]: 0, [RIGHT]: 0, tie: 0, errors: 0 };
for (const row of results) {
  if (row.verdict.error) tally.errors += 1;
  else tally[row.winner] = (tally[row.winner] || 0) + 1;
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ schema: 1, created_at: new Date().toISOString(), source: input, rater_model: MODEL, rater_effort: EFFORT, left: LEFT, right: RIGHT, pairs: results, tally }, null, 2));
console.log(JSON.stringify({ output: OUT, tally }, null, 2));
