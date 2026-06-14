export const meta = {
  name: 'x-agent-flow',
  description: 'Generic fan-out engine for x-agent flow: optional in-script decompose -> Kahn topo-batch -> parallel leaves (deps respected) -> merge. Fully driven by args; ships no task knowledge of its own.',
  phases: [
    { title: 'Decompose', detail: 'optional in-script decomposer agent (pattern b)' },
    { title: 'Fan-out', detail: 'parallel leaves, level by level (deps)' },
    { title: 'Merge', detail: 'synthesize leaf results into one answer' },
  ],
}

// ----------------------------------------------------------------------------
// Pure helpers — no Workflow runtime globals, no FS, no Date.now/Math.random.
// The leader stamps timestamps (passed via args.created_at) and persists the
// return value to .xm/flow/ AFTER this script resolves (sandbox cannot write).
// ----------------------------------------------------------------------------

// args may arrive as a JSON string OR a real object — guard both.
// (Learned the hard way: a stringified args list reaches the script as one
// string, so PLUGINS.map / cfg.leaves silently break without this.)
function parseArgs(a) {
  if (a === undefined || a === null) throw new Error('x-agent-flow: args missing')
  return typeof a === 'string' ? JSON.parse(a) : a
}

// Kahn-style level grouping: every leaf whose deps are all satisfied joins the
// current level; levels run sequentially, leaves within a level run in parallel.
// No declared dep => same level (maximize parallelism). Throws on cycle / unknown dep.
function topoLevels(leaves) {
  const ids = new Set()
  for (const l of leaves) {
    if (!l || !l.id) throw new Error('x-agent-flow: every leaf needs an id')
    if (ids.has(l.id)) throw new Error('x-agent-flow: duplicate leaf id ' + l.id)
    ids.add(l.id)
  }
  for (const l of leaves) {
    for (const d of (l.deps || [])) {
      if (!ids.has(d)) throw new Error('x-agent-flow: leaf ' + l.id + ' depends on unknown id ' + d)
    }
  }
  const done = new Set()
  const levels = []
  let remaining = leaves.slice()
  while (remaining.length) {
    const ready = remaining.filter(l => (l.deps || []).every(d => done.has(d)))
    if (ready.length === 0) {
      throw new Error('x-agent-flow: dependency cycle among ' + remaining.map(l => l.id).join(','))
    }
    levels.push(ready)
    ready.forEach(l => done.add(l.id))
    const readySet = new Set(ready)
    remaining = remaining.filter(l => !readySet.has(l))
  }
  return levels
}

// Inject upstream dependency results into a leaf prompt.
function depBlock(leaf, results) {
  const deps = leaf.deps || []
  if (deps.length === 0) return ''
  const body = deps.map(d => {
    const r = results[d]
    const text = r ? (r.summary || JSON.stringify(r)) : 'n/a'
    return '### Dependency ' + d + '\n' + text
  }).join('\n\n')
  return '\n\n## Dependency results (read before answering)\n' + body
}

// Leaf output schema: mandates only the cross-op invariants (id/status/summary,
// evidence on every finding per agent-output-contract.md). Open object so each
// op may add its own fields without a schema change.
const LEAF_SCHEMA = {
  type: 'object',
  properties: {
    leaf_id: { type: 'string' },
    role: { type: 'string' },
    status: { type: 'string', enum: ['completed', 'failed'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          evidence: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
          dimension: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['claim', 'evidence'],
      },
    },
    verdict: { type: ['string', 'null'] },
  },
  required: ['leaf_id', 'status', 'summary'],
}

// Decomposer output schema (pattern b): a flat leaf list with deps.
const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    leaves: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          role: { type: 'string' },
          prompt: { type: 'string' },
          deps: { type: 'array', items: { type: 'string' } },
          model: { type: 'string', enum: ['haiku', 'sonnet', 'opus'] },
        },
        required: ['id', 'prompt', 'deps'],
      },
    },
  },
  required: ['leaves'],
}

// ----------------------------------------------------------------------------
// Orchestration — executed by the Workflow runtime (agent/parallel/phase/log/args
// are runtime globals; the runtime wraps this body so top-level await/return work).
// This file is NOT importable in Node: the top-level `return` below is a parse
// error outside the runtime wrapper. Tests read it as text, never import-and-run.
// ----------------------------------------------------------------------------

const cfg = parseArgs(args)
const op = cfg.op || 'generic'
const topic = cfg.topic || op

let leaves = Array.isArray(cfg.leaves) ? cfg.leaves : []

// Pattern (b): no pre-supplied leaves -> run the in-script decomposer agent.
if (leaves.length === 0) {
  if (!cfg.decompose || !cfg.decompose.prompt) {
    throw new Error('x-agent-flow: provide cfg.leaves (pattern a) or cfg.decompose.prompt (pattern b)')
  }
  phase('Decompose')
  const plan = await agent(cfg.decompose.prompt, {
    label: op + ':decompose',
    phase: 'Decompose',
    schema: PLAN_SCHEMA,
    model: cfg.decompose.model || 'opus',
  })
  // Distinguish a dead/invalid decomposer from a genuinely empty plan — don't
  // collapse a null/schema-failure into a misleading 'no leaves' throw.
  if (!plan || !Array.isArray(plan.leaves)) {
    throw new Error('x-agent-flow: decomposer returned null or an invalid plan (missing leaves[])')
  }
  leaves = plan.leaves
  log('decomposed into ' + leaves.length + ' leaves')
}
if (leaves.length === 0) throw new Error('x-agent-flow: no leaves to execute')

const levels = topoLevels(leaves)
log('topo: ' + leaves.length + ' leaves in ' + levels.length + ' level(s)')

const results = {}
for (let i = 0; i < levels.length; i++) {
  const level = levels[i]
  const out = await parallel(level.map(l => () =>
    agent(l.prompt + depBlock(l, results), {
      label: op + ':' + l.id,
      phase: 'Fan-out',
      schema: LEAF_SCHEMA,
      model: l.model || 'sonnet',
    }).then(r => r
      ? { ...r, leaf_id: r.leaf_id || l.id, role: r.role || l.role || null }
      : { leaf_id: l.id, role: l.role || null, status: 'failed', summary: 'agent returned null' }
    ).catch((e) => ({ leaf_id: l.id, role: l.role || null, status: 'failed', summary: 'agent threw', error: String((e && e.message) || e) }))
  ))
  level.forEach((l, idx) => {
    results[l.id] = out[idx] || { leaf_id: l.id, role: l.role || null, status: 'failed', summary: 'agent threw' }
  })
}

const leafResults = leaves.map(l => results[l.id])
const failedCount = leafResults.filter(r => r && r.status === 'failed').length
if (failedCount > 0) log(failedCount + '/' + leafResults.length + ' leaves failed')

// Top-level run health so callers don't have to scan every leaf — failures must be visible.
const base = {
  op,
  topic,
  created_at: cfg.created_at || null,
  status: failedCount > 0 ? 'partial' : 'completed',
  failed_count: failedCount,
  options: { agents: leaves.length, levels: levels.length, preset: cfg.op || null },
  level_ids: levels.map(lv => lv.map(l => l.id)),
  leaf_results: leafResults,
}

// --no-merge: return raw leaf results, skip the synthesis step.
if (cfg.no_merge) return { ...base, merge: null }

phase('Merge')
const mergeCfg = cfg.merge || {}
const merge = await agent(
  (mergeCfg.prompt || 'Synthesize the leaf results into one coherent answer. Resolve conflicts, dedupe, and state the verdict.') +
    '\n\n## Leaf results (JSON)\n' + JSON.stringify(leafResults, null, 2),
  { label: op + ':merge', phase: 'Merge', model: mergeCfg.model || 'opus' }
)
// A null merge from the synthesis agent means it died — fail loud. (The --no-merge
// path above returns merge:null intentionally; this guard only covers the synthesis path.)
if (merge == null) throw new Error('x-agent-flow: merge agent returned null (synthesis failed)')

return { ...base, merge }
