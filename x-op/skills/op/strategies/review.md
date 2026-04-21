# Strategy: review

All agents review code from multiple perspectives.

## Phase 1: TARGET
- `--target <file>` → Read the file with Read tool
- If absent → `git diff HEAD` (Bash tool)

**Call AskUserQuestion to confirm before Phase 2. Show phase results first.**

## Phase 2: ASSIGN
Dynamically assign perspectives based on agent count (`--agents N` or `agent_max_count`):

| Agents | Perspectives |
|--------|-------------|
| 3 (default) | Security, Logic, Performance |
| 4 | + Error handling/Resilience |
| 5 | + Testability/Coverage |
| 6 | + Consistency/Code conventions |
| 7+ | + DX/Readability, Dependencies/Compatibility, etc. — leader assigns additional |

**Call AskUserQuestion to confirm before Phase 3. Show phase results first.**

## Phase 3: REVIEW
fan-out (each agent gets a different perspective prompt):
```
"## Code Review: {perspective}
{code}
Report issues in [Critical|High|Medium|Low] file:line — description format. Each finding must be evidence-based and falsifiable per the Agent Output Quality Contract. Tag each with a dimension from Code Analysis Anchors.
End with self-assessment: review thoroughness 1-10, CONFIDENT or UNCERTAIN."
```

**Call AskUserQuestion to confirm before Phase 4. Show phase results first.**

## Phase 4: SYNTHESIZE
Leader synthesizes: deduplicate, sort by severity, highlight issues found by multiple agents.

## Final Output
```
🔍 [review] Complete — {N} agents, {M} issues
| # | Severity | Location | Issue | Found by |
```

## Final Step: Persist (REQUIRED)

After emitting the Final Output above and the Self-Score block, MUST save the result to `.xm/op/` (see `references/x-op-result-persistence.md`):

1. `mkdir -p .xm/op/` (Bash)
2. Filename: `review-{YYYY-MM-DD}-{slug}.json` (slug from target file or topic, ≤ 40 chars, lowercase, hyphens)
3. Write JSON per the result schema (include `outcome.verdict="{M} issues"`, `outcome.summary` listing Critical/High counts, `self_score`, `rounds_summary`)
4. Surface path: `💾 Saved: .xm/op/{filename}`

Do not end the strategy until the file is written and the path is shown.
