# Result Persistence

After every strategy completes (after Self-Score), the leader MUST save the result to `.xm/op/`.

## Save workflow

1. `mkdir -p .xm/op/` (Bash)
2. Generate filename: `{strategy}-{YYYY-MM-DD}-{slug}.json` (slug from topic, max 40 chars, lowercase, hyphens)
3. Generate `run_id`: `{strategy}-{YYYY-MM-DD}T{HH-mm-ss}-{slug}` and store it in the result JSON
4. Write JSON file with the schema below
5. If `--verify` or `eval.auto` runs x-eval, pass the same `run_id` and `source_result_path` to the eval result; then write the eval result path back into `evaluation`

## Result schema

### Required canonical meta keys (every strategy)

Regardless of a strategy's internal vocabulary (debate→question, persona→subject, decompose/scaffold→problem, brainstorm→theme, chain/distribute→task, refine→focus, red-team→claim|target, monitor→scenario, …), the SAVED result JSON MUST use the canonical top-level keys below. Internal terms may be added alongside, but they cannot REPLACE the canonical key.

| Canonical key | Type | Why it must be present |
|---|---|---|
| `topic` | string | What the user asked. The dashboard Ops list reads `topic` first; missing → row shows `—` in Topic. |
| `created_at`, `completed_at` | ISO8601 string | Sort order + duration. Missing → Date column shows `—`. |
| `options.agents` | number | Agent count actually used. Missing → Agents column shows `—`. |
| `self_score` | object (`{overall, criteria}`) | See `self-score-protocol.md`. Missing → Score column shows `—`. |
| `status` | "completed" \| "failed" \| ... | Lifecycle. Currently optional but recommended. |

Omitting any of the above is the root cause of `—` placeholders in the dashboard Ops list. Strategies that historically used `question`/`problem`/`subject` MUST still write `topic` (you may keep the original key for backward compatibility, but `topic` is the contract with the dashboard).

### Cross-vendor provenance (REQUIRED when the run used `--cross-vendor`)

An adversarial reviewer must be able to verify — from the saved JSON alone — that each
vendor-attributed passage came from a real CLI call, not one model simulating vendors
("author-attribution hallucination", flagged by an x-eval adversarial judge 2026-07-04).
A cross-vendor result without these fields is unauditable:

| Key | Type | Why |
|---|---|---|
| `cross_vendor.requested` / `cross_vendor.effective` | number | 5 requested ≠ 4 usable — a failed vendor must not silently vanish (L6). |
| `cross_vendor.failed[]` | `[{vendor, reason}]` | Name each failed/invalid vendor and why its output was excluded. |
| `cross_vendor.run_ref` | string | The `.xm/cross/<run>/` directory of the actual `xm panel cross` run — where per-vendor raw outputs, status.json (real per-vendor start/end/elapsed) live. |
| `cross_vendor.per_vendor_raw[]` | string[] | Raw response filenames inside `run_ref` (e.g. `codex.json`) so attribution is checkable per vendor. |

Timing rule: `created_at`/`completed_at` MUST come from the cross run's actual start/end
(status.json), NEVER from the moment the summary JSON was written — identical
microsecond timestamps are how a reviewer detects (and distrusts) a stamped-at-write
artifact.

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

## Common rule: preserve diverged content

**Every strategy MUST preserve the full body of its divergence-phase outputs.** `outcome.summary` is a digest only — it cannot replace the source material. The dashboard needs the body to show the diverge→converge flow.

### Divergence body keys by strategy

Each strategy records its diverged outputs under a body key inside `themes[i]` or `rounds_summary[i]`:

| Strategy | Body key | Field that carries the content |
|----------|----------|-------------------------------|
| brainstorm | `themes[i].ideas[]` | `id`, `title`, `description`, `dimension` |
| tournament | `themes[i]` | `id`, `name`, `description`, `score`, `rank`, `voter_rationales[]`, `selected` |
| council | `rounds_summary[i].positions[]` | `participant`, `statement`, `dissent` |
| investigate | `rounds_summary[i].findings[]` | `claim`, `evidence`, `confidence` |
| debate | `rounds_summary[i]` | `summary` (argument text per side) |
| persona | `rounds_summary[i]` | `summary` (perspective text per persona) |
| red-team | `rounds_summary[i]` | `summary` (attack vector text) |
| hypothesis | `rounds_summary[i]` | `summary` (hypothesis text + test result) |
| other strategies | `rounds_summary[i]` | `summary` (phase output text) |

### Selection/vote inline recording

Selection results MUST be recorded **inline inside the divergence data**, not only in `outcome.summary`:

- Vote counts → `votes: <N>` on the chosen item
- Ranking → `rank: <position>` on each item
- Winner flag → `selected: true` on the winning item
- Voter rationales → `voter_rationales: ["<reason>"]` alongside the candidate

**Forbidden:** storing selection results only in `outcome.summary` text while leaving `themes[]` / `rounds_summary[]` body-free.

### Rule for future strategies

Any new strategy MUST follow this rule on its first run. When writing a new strategy SKILL.md:

1. Identify the divergence phase (fan-out or broadcast that produces candidates/positions/findings).
2. Define a body key (`ideas[]`, `positions[]`, `findings[]`, `candidates[]`, or `outputs[]`) under `themes[i]` or `rounds_summary[i]`.
3. Specify the schema (minimum: an `id` or `participant` field + a content text field).
4. In the Persist section, state explicitly: "`<body-key>` body required — `summary` alone does not suffice."

The 13 strategies without result files today (chain, debate, decompose, distribute, hypothesis, monitor, persona, red-team, refine, review, scaffold, socratic, compose) are subject to a follow-up audit. They must comply with this rule on their next run that produces a result file.

## What NOT to save

- Full agent outputs (too large) — only summaries in `rounds_summary`
- Checkpoint in-progress state — that stays in `.xm/op-checkpoints/`
- Eval judge transcripts — those belong in `.xm/eval/results/` as `judge_rationales`

## Applies to

x-op (all strategies)
