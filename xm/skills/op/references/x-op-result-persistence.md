# Result Persistence

After every strategy completes (after Self-Score), the leader MUST save the result to `.xm/op/`.

## Save workflow

1. `mkdir -p .xm/op/` (Bash)
2. Generate filename: `{strategy}-{YYYY-MM-DD}-{slug}.json` (slug from topic, max 40 chars, lowercase, hyphens)
3. Generate `run_id`: `{strategy}-{YYYY-MM-DD}T{HH-mm-ss}-{slug}` and store it in the result JSON
4. Write JSON file with the schema below
5. If `--verify` or `eval.auto` runs x-eval, pass the same `run_id` and `source_result_path` to the eval result; then write the eval result path back into `evaluation`

## Result schema

```json
{
  "schema_version": 1,
  "run_id": "debate-2026-04-04T10-00-00-redis-vs-postgres",
  "strategy": "debate",
  "topic": "Redis vs Postgres for queue",
  "status": "completed",
  "created_at": "2026-04-04T10:00:00.000Z",
  "completed_at": "2026-04-04T10:12:34.000Z",
  "options": {
    "rounds": 4,
    "agents": 4,
    "model": "sonnet",
    "preset": null
  },
  "outcome": {
    "verdict": "Redis",
    "summary": "Low latency + pub/sub requirements favor Redis",
    "confidence": 7.8
  },
  "self_score": {
    "overall": 7.8,
    "criteria": {
      "accuracy": 8,
      "completeness": 7,
      "consistency": 8,
      "clarity": 8
    }
  },
  "participants": [
    { "role": "advocate", "position": "Redis" },
    { "role": "advocate", "position": "Postgres" },
    { "role": "judge" }
  ],
  "rounds_summary": [
    { "round": 1, "phase": "opening", "summary": "PRO: low latency; CON: durability" },
    { "round": 2, "phase": "rebuttal", "summary": "PRO addressed durability with AOF" }
  ],
  "evaluation": {
    "status": "pass",
    "result_path": ".xm/eval/results/2026-04-04T10-12-35-score.json",
    "overall": 7.8,
    "rubric": "general"
  }
}
```

## Eval link contract

When x-op delegates verification to x-eval, the two result files MUST be linkable without scanning file contents:

| Field | Location | Description |
|-------|----------|-------------|
| `run_id` | `.xm/op/*.json` and `.xm/eval/results/*.json` | Stable ID for the strategy execution |
| `source_plugin` | `.xm/eval/results/*.json` | `"x-op"` for x-op-initiated evaluations |
| `source_strategy` | `.xm/eval/results/*.json` | Strategy name, e.g. `"debate"` |
| `source_result_path` | `.xm/eval/results/*.json` | Path to the originating `.xm/op/*.json` file |
| `evaluation.result_path` | `.xm/op/*.json` | Back-link to the eval result file when verification ran |

If x-eval fails or is skipped, keep `evaluation.status` as `"skipped"` or `"failed"` with a short `reason`. Do not omit the `evaluation` object for completed x-op runs.

## Per-strategy outcome mapping

| Strategy | outcome.verdict | outcome.summary |
|----------|----------------|-----------------|
| debate | PRO or CON | Winning argument summary |
| tournament | Winner name | Winning solution summary |
| refine | "adopted" | Final adopted solution summary |
| review | "{N} issues" | Critical/High issue summary |
| red-team | "{N} vulns ({open} open)" | Top vulnerability summary |
| hypothesis | "H{N} survived" | Strongest surviving hypothesis |
| investigate | "{N} findings, {G} gaps" | Key insights summary |
| council | CONSENSUS / NO CONSENSUS | Consensus statement |
| brainstorm | "{N} ideas, {T} themes" | Top-voted ideas summary |
| scaffold | "{N} modules" | Module structure summary |
| decompose | "{N} leaves" | Assembly result summary |
| chain | "completed" | Final step output summary |
| persona | "{N} perspectives" | Unified recommendation summary |
| socratic | "{N} rounds" | Final refined position summary |
| monitor | "{alerts} alerts" | Decision + dispatch summary |
| distribute | "{N} subtasks" | Merge result summary |
| compose | "{N} strategies" | Last strategy result summary |

## What NOT to save

- Full agent outputs (too large) — only summaries in `rounds_summary`
- Checkpoint in-progress state — that stays in `.xm/op-checkpoints/`
- Eval judge transcripts — those belong in `.xm/eval/results/` as `judge_rationales`

## Applies to

x-op (all strategies)
