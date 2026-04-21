# Strategy: decompose

Recursive decomposition → leaf parallel execution → bottom-up assembly.

## Phase 1: DECOMPOSE
> 🧩 [decompose] Phase 1: Decompose

delegate (foreground, opus recommended):
```
"## Decompose: {TOPIC}
Recursively decompose this task:
- Each subtask must be independently executable
- If a subtask is still complex, decompose one level further
- Final leaves must be completable by a single agent in one pass
- Specify dependency order (which leaves must complete first)
- Each leaf must pass scope-clarity and parallelizability checks from Task Decomposition Dimension Anchors

Output format:
- Tree structure (indentation for hierarchy)
- Each leaf: [ID] task name (deps: none or list of IDs)"
```

**Call AskUserQuestion to confirm before Phase 2. Show phase results first.**

## Phase 2: EXECUTE LEAVES
> 🧩 [decompose] Phase 2: Execute Leaves

fan-out leaves in dependency order:
- Execute leaves with no dependencies first in parallel
- Once complete, execute the next level of leaves in parallel
- Each leaf agent prompt:
```
"## Leaf Task: {leaf task name}
Overall structure:
{Phase 1 tree}

Dependency results:
{predecessor leaf results, or 'none'}

Complete this leaf task. Do not exceed scope."
```

**Call AskUserQuestion to confirm before Phase 3. Show phase results first.**

## Phase 3: ASSEMBLE
> 🧩 [decompose] Phase 3: Assemble

Assemble results bottom-up (delegate, foreground):
```
"## Bottom-up Assembly
Overall tree:
{Phase 1 tree}

Leaf results:
{Phase 2 each leaf result}

Assemble the leaf results bottom-up following the tree structure:
- Integrate from lower to upper levels
- Resolve conflicts between leaves
- Output the final integrated result"
```

## Final Output
```
🧩 [decompose] Complete — {depth} levels, {leaves} leaves

## Decomposition Tree
{tree structure}

## Execution Results
| Level | Leaf | Status |
|-------|------|--------|
| L2 | {leaf name} | ✅ |

## Final Assembly Result
{integrated result}
```

## Final Step: Persist (REQUIRED)

After emitting the Final Output above and the Self-Score block, MUST save the result to `.xm/op/` (see `references/x-op-result-persistence.md`):

1. `mkdir -p .xm/op/` (Bash)
2. Filename: `decompose-{YYYY-MM-DD}-{slug}.json` (slug from topic, ≤ 40 chars, lowercase, hyphens)
3. Write JSON per the result schema (include `outcome.verdict="{N} leaves"`, `outcome.summary` with assembly result, `self_score`, `rounds_summary`)
4. Surface path: `💾 Saved: .xm/op/{filename}`

Do not end the strategy until the file is written and the path is shown.
