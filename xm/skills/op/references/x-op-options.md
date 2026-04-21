# Options Reference

Detailed behavior for all x-op execution options: `--dry-run`, `--resume`, `--explain`, `--verify`, `--vote`.

## Options: --dry-run

Output execution plan only without running any agents.

### Usage
```
/xm:op refine "topic" --dry-run
```

### Output
```
📋 [dry-run] refine "topic"

Execution Plan:
  Rounds: 4 (preset: thorough)
  Agents: 10 (agent_max_count: 10)
  Model: sonnet

  Round 1 (Diverge):  8 agents × fan-out
  Round 2 (Converge): 8 agents × fan-out + leader synthesis
  Round 3 (Verify):   8 agents × fan-out
  Round 4 (Verify):   8 agents × fan-out (if needed)

  Estimated tokens: ~120K input, ~48K output
  Estimated cost: ~$3.24
```

Returns immediately without invoking any agents. The leader constructs the plan based on the strategy documentation.

---

## Options: --resume

Resume an interrupted strategy execution from a checkpoint.

### Checkpoint schema

After each round/phase completes, the leader auto-saves to `.xm/op-checkpoints/{run-id}.json`:

```json
{
  "version": 1,
  "run_id": "refine-2026-03-27T12-30-00-000Z",
  "strategy": "refine",
  "topic": "Payment API design",
  "status": "in_progress",
  "created_at": "2026-03-27T12:30:00.000Z",
  "updated_at": "2026-03-27T12:35:42.000Z",
  "options": {
    "rounds": 4,
    "agents": 4,
    "model": "sonnet",
    "preset": "thorough"
  },
  "progress": {
    "total_rounds": 4,
    "completed_rounds": 2,
    "current_phase": "converge",
    "early_exit": false
  },
  "results": [
    {
      "round": 1,
      "phase": "diverge",
      "completed_at": "2026-03-27T12:32:10.000Z",
      "agent_outputs": [
        { "agent_id": "agent-1", "role": "engineer", "output_summary": "REST-based approach" },
        { "agent_id": "agent-2", "role": "architect", "output_summary": "GraphQL approach" }
      ],
      "summary": "3 approaches identified: REST, GraphQL, gRPC"
    }
  ],
  "verification": {
    "enabled": false,
    "rubric": "general",
    "threshold": 7,
    "attempts": [
      {
        "attempt": 1,
        "score": 6.2,
        "criteria_scores": { "accuracy": 7, "completeness": 5, "consistency": 6, "clarity": 7, "hallucination-risk": 8 },
        "feedback": "completeness scored lowest — missing edge cases",
        "timestamp": "2026-03-27T12:34:00.000Z"
      }
    ],
    "final_score": 7.8,
    "passed": true
  }
}
```

`run-id` generation: `{strategy}-{ISO timestamp}` (created on first run, reused thereafter).

### Save workflow

After each round/phase completes, the leader:
1. `mkdirSync('.xm/op-checkpoints/', { recursive: true })` (Bash)
2. Append current round result to the `results` array
3. Increment `progress.completed_rounds`, update `updated_at`
4. Save JSON file (atomic write)
5. When `--verify` is enabled: save verification results to the checkpoint
   - Record each attempt's score, criteria_scores, and feedback
   - Record the final selected version's score in final_score

### Resume workflow

```
/xm:op --resume
```

1. Select the most recent `status: "in_progress"` file from `.xm/op-checkpoints/` by `updated_at`
2. Read `progress.completed_rounds` → `resume_from = completed_rounds + 1`
3. Inject `results[].summary` as context before the next round's prompt:
   ```
   "## Previous Execution Context (Round 1~{N} results)
   {results summary}"
   ```
4. Restore `options` and resume execution from that round
5. On completion: write `status: "completed"` → excluded from resume targets

### When no checkpoint exists
If `--resume` is used with no checkpoint: output `"⚠ No checkpoint found. Run a strategy first."`.

---

## Options: --explain

Output the decision-making process transparently alongside the final result.

### Usage
```
/xm:op tournament "topic" --explain
```

### Additional output
Adds a `## Decision Trace` section to each strategy's final output:
```
## Decision Trace
| Step | Input | Decision | Rationale |
|------|-------|----------|-----------|
| Diverge | 8 proposals | 3 clusters identified | Grouped similar approaches |
| Converge | 3 clusters | Cluster B adopted (5/8 votes) | Feasibility + scalability |
| Verify | Cluster B | 2 issues found, 1 fixed | Security issue corrected |
```

The leader records why each decision was made at each step and includes it in the final output.

---

## Options: --verify

Auto quality verification after strategy completion. A judge panel scores the result and re-runs with feedback if below threshold.

### Verification flow

```
Strategy complete → Self-Score (self-assessment)
  │
  ├─ --verify not specified → Output Self-Score only, end
  │
  └─ --verify specified →
      1. Summon Judge Panel (3 agents, fan-out)
      2. Each judge scores against rubric criteria
      3. Calculate weighted average + σ (agreement level)
      │
      ├─ score >= threshold → ✅ PASS, final output
      │
      └─ score < threshold →
          ├─ retries < max-retries →
          │   a. Extract feedback for the lowest-scoring criterion
          │   b. Inject feedback as context
          │   c. Re-run strategy (same options + feedback)
          │   d. Increment retry counter
          │
          └─ retries >= max-retries →
              ⚠ Select highest-scoring version, output with warning
```

### Judge Prompt Template

Prompt sent to each judge agent (follows x-eval scoring format):

```
"## Quality Evaluation
Rubric: {rubric_name}
Output to evaluate:
{strategy final output (excluding Self-Score)}

Score on a 1-10 scale per the criteria below (1=fail, 5=baseline, 7=good, 10=excellent):

{rubric criteria + weights}

Output format (follow exactly):
Criterion: {name} | Score: {N} | Reason: {one-line rationale}
...
Final: {weighted average}/10"
```

### Agreement assessment

| σ | Agreement | Action |
|---|-----------|--------|
| < 0.8 | High — reliable | Use score as-is |
| 0.8–1.5 | Medium | Use score, flag caution |
| > 1.5 | Low | Summon 1 additional judge and re-score |

### Feedback injection on retry

Context added to the re-run prompt:
```
"## Previous Execution Feedback
Previous score: {score}/10
Items needing improvement:
- {lowest criterion}: {score}/10 — {judge reason}
- {second lowest criterion}: {score}/10 — {judge reason}
Focus on improving the above items in the re-run."
```

### Verification result output

```
## Verification
| Attempt | Score | Verdict | Feedback |
|---------|-------|---------|----------|
| 1 | 6.2/10 | ❌ retry | Insufficient completeness |
| 2 | 7.8/10 | ✅ pass | - |

Consensus: σ=0.6 (High)
Rubric: general
```

---

## Options: --vote (Self-Consistency)

Run N independent agents with the SAME prompt, then synthesize by majority vote. Divergence reveals uncertainty.

### Usage
Append `--vote` to any strategy that uses fan-out:
- `/xm:op refine "topic" --vote` — each diverge agent's conclusion is voted on
- `/xm:op brainstorm "topic" --vote` — already supported (existing --vote for idea selection)
- `/xm:op hypothesis "topic" --vote` — each hypothesis is independently generated N times; only hypotheses appearing in 2+ agents survive

### Mechanism
1. Fan-out N agents with identical prompt (no role differentiation)
2. Collect all responses
3. Cluster similar conclusions (leader groups by semantic similarity)
4. Count: conclusions appearing in ≥50% of agents = HIGH CONFIDENCE
5. Conclusions in 25-49% = MEDIUM CONFIDENCE
6. Conclusions in <25% = LOW CONFIDENCE (divergence signal — flag uncertainty)

### Output addition
When --vote is active, append to the strategy's final output:
```
## Confidence Map (Self-Consistency)
| Conclusion | Agents | Confidence |
|-----------|--------|------------|
| {conclusion} | {N}/{total} | HIGH/MEDIUM/LOW |

Agreement rate: {percentage}%
Divergence areas: {list areas where agents disagreed}
```

### When NOT to use
- Strategies that intentionally assign different roles (persona, council) — role diversity is the point, not convergence
- Strategies with < 3 agents — insufficient sample for voting

## Applies to

x-op (all strategies that support the respective flag)
