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

Auto quality verification after strategy completion. x-op delegates final scoring to x-eval so every plugin uses the same evaluation path.

### Verification flow

```
Strategy complete → Self-Score (self-assessment)
  │
  ├─ --verify not specified → Output Self-Score only, end
  │
  └─ --verify specified →
      1. Persist final strategy output to .xm/op/
      2. Invoke x-eval score with the persisted output
      3. Use the strategy's default rubric from self-score-protocol.md
      4. Use --grounded for code-facing strategies (review, red-team, monitor)
      5. Store the x-eval result under .xm/eval/results/
```

### Rubric mapping

`--verify` uses the same Strategy-Rubric mapping as the Self-Score Protocol:
- `review`, `red-team`, `monitor` → `code-quality` with grounded evaluation
- `scaffold`, `decompose`, `distribute`, `chain` → `plan-quality`
- `compose` → last sub-strategy's rubric
- all other strategies → `general`

`--threshold N` is passed to x-eval as the passing threshold. x-op does not run an inline judge panel or retry loop.

### Verification result output

```
## Verification
x-eval: PASS
Score: 7.8/10
Rubric: general
Saved: .xm/eval/results/{result-id}.json
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
