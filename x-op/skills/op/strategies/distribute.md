# Strategy: distribute

Split a large task into independent subtasks → parallel execution → merge.

## Phase 1: SPLIT
`--splits "role:task,role:task"` or auto-split by the leader.

**Call AskUserQuestion to confirm before Phase 2. Show phase results first.**

## Phase 2: DISPATCH
fan-out with unique subtasks per agent:
"Overall task: {original}. Your assignment: {subtask}. Confirm scope-clarity and interface-completeness per Dimension Anchors before starting. Do not modify anything outside your scope."

**Call AskUserQuestion to confirm before Phase 3. Show phase results first.**

## Phase 3: MERGE
Leader merges all results: check for conflicts, synthesize by theme.

## Final Output
```
📦 [distribute] {N} subtasks, {completed} succeeded
| # | Agent | Subtask | Status |
```

## Final Step: Persist (REQUIRED)

After emitting the Final Output above and the Self-Score block, MUST save the result to `.xm/op/` (see `references/x-op-result-persistence.md`):

1. `mkdir -p .xm/op/` (Bash)
2. Filename: `distribute-{YYYY-MM-DD}-{slug}.json` (slug from topic, ≤ 40 chars, lowercase, hyphens)
3. Write JSON per the result schema (include `outcome.verdict="{N} subtasks"`, `outcome.summary` with merge result, `self_score`, `rounds_summary`)
4. Surface path: `💾 Saved: .xm/op/{filename}`

Do not end the strategy until the file is written and the path is shown.
