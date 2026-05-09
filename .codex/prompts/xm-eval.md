---
description: "Agent output quality evaluation — multi-rubric scoring, strategy benchmarking, and A/B prompt experiments"
---

<Purpose>
x-eval structurally evaluates the quality of AI agent outputs. Independent judge agents score outputs using multi-dimensional rubrics, supporting strategy/model benchmarking and A/B prompt experiments.
No external dependencies. Evaluation results are stored in `.xm/eval/`.
</Purpose>

<Use_When>
- User wants to score or grade agent output against a rubric
- User says "evaluate", "grade", "quality check", "score", "eval"
- User wants to compare two outputs and pick the better one
- User says "compare", "which is better?", "A vs B"
- User wants to benchmark strategies or models on the same task
- User says "bench", "benchmark", "which strategy is better?"
- User wants to create or list evaluation rubrics
- User says "rubric", "evaluation criteria"
</Use_When>

<Do_Not_Use_When>
- Simple factual questions that don't need quality evaluation
- Strategy execution without evaluation (use x-op instead)
- Project lifecycle management (use x-build instead)
</Do_Not_Use_When>

# x-eval — Agent Output Quality Evaluation

Multi-dimensional rubric scoring, strategy benchmarking, A/B prompt experiments.
Judge agents fan out for independent evaluation, then aggregate results.

## Mode Detection

Read mode from `.xm/config.json` (`mode` field). Default: `developer`.

**Developer mode**: Use technical terms (rubric, benchmark, verdict, score, dimension). Concise.

**Normal mode**: Guide in plain, accessible language.
- "rubric" → "평가 기준", "benchmark" → "비교 평가", "verdict" → "판정", "dimension" → "평가 항목"
- "score" → "점수", "judge" → "심사", "adversarial judge" → "검증 심사", "standard judge" → "기본 심사"
- "bias check" → "교차 검증", "sigma" → "일치도", "consensus" → "합의"
- Use polite tone ("~하세요" style), lead with the most important information

## Arguments

User provided: $ARGUMENTS

## AskUserQuestion Dark-Theme Rule

See `references/ask-user-question-rule.md` — the `question` field is invisible on dark terminals; put context in markdown, use `header`/`label`/`description` for user-facing text.

## Routing

First word of `$ARGUMENTS`:
- `score` → [Subcommand: score]
- `compare` → [Subcommand: compare]
- `bench` → [Subcommand: bench]
- `consistency` → [Subcommand: consistency]
- `diff` → [Subcommand: diff]
- `rubric` → [Subcommand: rubric]
- `report` → [Subcommand: report]
- `calibrate` → [Subcommand: calibrate]
- `list` or empty input → [Subcommand: list]

---

## Subcommand: list

```
x-eval — Agent Output Quality Evaluation

Commands:
  score <content> --rubric <name|criteria>     Score content against rubric
       [--assert "<statement>"]                  Add binary outcome assertions (repeatable)
  compare <output-a> <output-b> [--judges N]   Compare two outputs with judge panel
  bench <task> --strategies "s1,s2"            Benchmark with pass@k/pass^k
       [--models "m1,m2"] [--trials N]          reliability metrics
  consistency [plugin] [--trials N]             Measure plugin output consistency (default: all changed)
  diff [--from <commit>] [--to <commit>]      Measure skill/plugin changes + quality delta
       [--baseline <tag>]                       Regression check vs pinned tag (implies --quality)
  rubric create <name> --criteria "c1,c2,c3"  Create custom rubric
  rubric list                                   List available rubrics
  report [session] [--sample-transcript N]     Show evaluation report;
                                                optionally dump N judge transcripts
  calibrate --rubric <name> [--samples N]      Human-vs-judge calibration: surface per-criterion bias
  list                                          Show this help

Options:
  --rubric <name>           Built-in or custom rubric name
  --judges N                Number of judge agents (default 3)
  --model sonnet|opus|haiku Judge model (default sonnet)
  --trials N                Repetitions per strategy (default 3, for bench)
  --strategies "s1,s2"      Comma-separated strategy names (for bench)
  --models "m1,m2"          Comma-separated model names (for bench)

Built-in Rubrics:
  code-quality    correctness, readability, maintainability, security, test-coverage
  review-quality  coverage, actionability, severity-accuracy, false-positive-rate
  plan-quality    completeness, actionability, scope-fit, risk-coverage
  general         accuracy, completeness, consistency, clarity, hallucination-risk

Examples:
  /xm:eval score "function add(a,b){return a+b}" --rubric code-quality
  /xm:eval compare output-a.md output-b.md --judges 5
  /xm:eval bench "find the bug" --strategies "refine,debate,tournament" --trials 3
  /xm:eval diff                                  # Analyze changes: latest release vs HEAD
  /xm:eval diff --from abc1234 --to HEAD         # Analyze changes between specific commits
  /xm:eval rubric create strict-code --criteria "correctness,edge-cases,complexity"
  /xm:eval report
```

---

## Subcommand: score

See `subcommands/score.md` — standard + adversarial judge panel; sigma-based bias detection; `--grounded` for tool-assisted verification; saves to `.xm/eval/results/`.

---

## Subcommand: compare

See `subcommands/compare.md` — randomized A/B order per judge (position bias prevention); tiebreak by rubric's first criterion; saves to `.xm/eval/results/`.

---

## Subcommand: bench

See `subcommands/bench.md` — strategies × models × trials matrix; recommends best quality and best value (Score/$); supports x-op compose pipelines via `|` separator.

---

## Subcommand: consistency

See `subcommands/consistency.md` — deterministic vs exploratory metric systems; PASS ≥ 0.80, WARN 0.70–0.79, FAIL < 0.70; saves to `benchmarks/{plugin}-consistency.json`.

---

## Subcommand: diff

See `subcommands/diff.md` — git-based quantitative analysis (Phase 1–2) + optional judge-panel quality comparison (`--quality`); saves to `.xm/eval/diffs/`.

---

## Subcommand: rubric

See `subcommands/rubric.md` — `rubric create <name> --criteria "c1,c2,c3"` saves to `.xm/eval/rubrics/`; `rubric list` shows built-in and custom rubrics.

---

## Subcommand: report

See `subcommands/report.md` — aggregates `.xm/eval/results/` and `.xm/eval/benchmarks/`; supports current session, `<session-id>`, or `--all`.

---

## Subcommand: calibrate

See `subcommands/calibrate.md` — human-vs-judge scoring loop; per-criterion bias_delta table; systematic bias threshold ≥ 1.0; gates automated judge use when |Δ| ≥ 1.5 on high-weight criteria.

---

## Built-in Rubrics + Domain Rubric Presets

See `references/rubrics.md` — 4 built-in rubrics (code-quality, review-quality, plan-quality, general) and 5 domain presets (api-design, frontend-design, data-pipeline, security-audit, architecture-review) with full criterion/weight tables.

---

## Bias-Aware Judging

See `references/bias-aware.md` — x-humble integration; injects confirmed bias warnings (confirmed_count ≥ 3, status active) into judge prompts without altering rubric weights; deactivates if `.xm/humble/lessons/` is missing or empty.

---

## Storage Layout

See `references/storage-layout.md` — `.xm/eval/` directory tree; result schemas for score/compare/bench/diff; rubric JSON schema.

---

## Shared Config Integration

x-eval references shared settings from `.xm/config.json`:

| Setting | Key | Default | Effect |
|------|----|--------|------|
| Agent count | `agent_max_count` | `4` | Default judge count |

Judge count is specified via `--judges N`, or uses the agent_max_count value (default 4).

### Config Resolution Priority

1. CLI flag (`--judges N`) — highest priority when specified
2. Shared config (`agent_max_count`)
3. Default (4)

---

## Trace Recording

See `references/trace-recording.md` — session_start/session_end are automatic via `.claude/hooks/trace-session.mjs`; emit best-effort `agent_step` entries for long sub-operations.

## Natural Language Mapping

| User says | Command |
|-----------|---------|
| "evaluate this", "grade this", "score this" | `score <content>` |
| "which is better?", "compare A vs B" | `compare <a> <b>` |
| "strategy comparison", "benchmark", "which strategy is better?" | `bench <task> --strategies "..."` |
| "create a rubric" | `rubric create <name>` |
| "list rubrics", "what criteria are available?" | `rubric list` |
| "show evaluation results", "report" | `report` |
| "what changed?", "change analysis", "diff" | `diff` |
| "compare with previous version", "how much did it improve?" | `diff --quality` |
| "check if output satisfies X", "must handle empty input" | `score ... --assert "<requirement>"` |
| "regression check vs release", "did quality drop?" | `diff --baseline <tag>` |
| "are judges accurate?", "calibrate judges", "human vs judge" | `calibrate --rubric <name>` |
| "what's in eval?", "help" | `list` |

---

## Reusable Judge Prompt

See `judges/reusable.md` — standard inline judge for plugins that intentionally need an inline panel, such as x-build prd-gate. x-op `--verify` delegates to x-eval scoring instead.

---

## Interaction Protocol

**CRITICAL: x-eval MUST use AskUserQuestion before executing evaluations and after showing results.**

Rules:
1. Before running evaluation judges → AskUserQuestion to confirm rubric and target
2. After showing evaluation results → AskUserQuestion to confirm next action (re-run, accept, adjust)
3. For A/B experiments → AskUserQuestion to confirm both variants before running

Anti-patterns:
- ❌ Auto-run evaluation without confirming what to evaluate
- ✅ Show rubric + target, AskUserQuestion("Run evaluation with these settings?")
| general | accuracy (0.25), completeness (0.25), consistency (0.20), clarity (0.20), hallucination-risk (0.10) |

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The output looks good to me" | Subjective evaluation is not evaluation — it's a vibe check. Use a rubric so the judgment is reproducible. |
| "One sample is enough to judge" | N=1 is anecdote. Benchmark across at least 3-5 examples; single-sample eval fools you. |
| "LLM-as-judge is probably accurate" | LLM-as-judge has biases (positional, verbosity, self-preference). Validate it against ground truth before trusting it for gating decisions. |
| "Evaluation slows down iteration" | Un-measured iteration is a random walk. Evals are the compass — without them you can't tell if a change is an improvement. |
| "I'll just eyeball the differences" | Differences small enough to eyeball are usually noise. Quantify or move on. |
| "The rubric is overkill for this task" | The rubric is how "good" becomes inspectable. If you skip it, "good" lives only in your head and can't be argued with. |
| "I trust my gut on this one" | Gut is useful for hypothesis generation. It is not useful for gating decisions — those need numbers. |

---
<!-- [See: bias-aware] -->

# Bias-Aware Judging Reference

Integration with x-humble to surface confirmed bias patterns into judge prompts, improving evaluation accuracy without altering rubric weights.

## Bias-Aware Judging (x-humble Integration)

Selectively expose high-confidence lessons from x-humble as context in judge prompts. This does not alter rubric weights; it helps judges recognize known bias patterns.

### Activation Conditions

- Only lessons with `confirmed_count >= 3` AND `status: "active"` are eligible
- Inject only when the lesson's `bias_tags` are relevant to the current evaluation target

### Judge Prompt Injection Format

Append after rubric criteria in the existing Judge Prompt:

```
## Known Bias Warnings (from x-humble, confirmed ≥3 times)
- ⚠ anchoring: "Pattern of fixating on the first approach" (confirmed 5x) — avoid rating only the first suggestion highly
- ⚠ confirmation_bias: "Preference for existing tech stack" (confirmed 3x) — fairly evaluate the merits of alternative technologies

These warnings are for reference only. Score independently according to the rubric, but self-check whether the above biases are influencing your judgment.
```

### Deactivation Conditions

- If `.xm/humble/lessons/` directory does not exist or is empty, skip this section
- Ignore lessons with `confirmed_count < 3` (insufficient verification)
- Ignore lessons with `status: "deprecated"`

## Applies to

`score` and `compare` subcommands — injected into each judge agent's prompt when x-humble lessons meet the activation conditions above.

---
<!-- [See: rubrics] -->

# Rubrics Reference

Built-in rubrics and domain-specific presets available in x-eval. Use with `--rubric <name>` or `rubric list`.

Each rubric declares a `pass_threshold` — the weighted overall score (1–10 scale) at which a single trial is counted as "pass" for `pass@k` / `pass^k` metrics in `bench`. Custom rubrics may override this in their JSON (`storage-layout.md`). Default: **7.0**.

## Built-in Rubrics

### code-quality

| Criterion | Description | Weight |
|-----------|-------------|--------|
| correctness | Logic is correct, handles edge cases, no bugs | 0.30 |
| readability | Clear naming, structure, minimal cognitive load | 0.20 |
| maintainability | Extensible, follows patterns, low coupling | 0.20 |
| security | No injection, input validated, secrets safe | 0.20 |
| test-coverage | Critical paths have tests or are testable | 0.10 |

**Pass threshold**: 7.0

### review-quality

| Criterion | Description | Weight |
|-----------|-------------|--------|
| coverage | All important issues found, nothing critical missed | 0.30 |
| actionability | Each finding has a clear fix suggestion | 0.30 |
| severity-accuracy | Critical bugs labeled critical, nits labeled nits | 0.25 |
| false-positive-rate | No valid code flagged as problematic | 0.15 |

**Pass threshold**: 7.0

### plan-quality

| Criterion | Description | Weight |
|-----------|-------------|--------|
| completeness | All requirements addressed by tasks | 0.30 |
| actionability | Each task is concrete and executor can start immediately | 0.30 |
| scope-fit | Plan fits the stated goal — not over or under | 0.20 |
| risk-coverage | Key risks and dependencies identified | 0.20 |

**Pass threshold**: 7.0

### general

| Criterion | Description | Weight |
|-----------|-------------|--------|
| accuracy | Factually correct, no errors | 0.25 |
| completeness | All aspects of the question addressed | 0.25 |
| consistency | No internal contradictions | 0.20 |
| clarity | Easy to follow, well structured | 0.20 |
| hallucination-risk | No unsupported claims or fabricated facts | 0.10 |

**Pass threshold**: 7.0

---

## Domain Rubric Presets

Domain-specific presets beyond the built-in rubrics. Viewable via `rubric list`.

### api-design

| Criterion | Description | Weight |
|-----------|-------------|--------|
| consistency | Naming, patterns, error format uniform across endpoints | 0.25 |
| completeness | All CRUD + edge cases covered, pagination, filtering | 0.25 |
| security | Auth, rate limiting, input validation, OWASP compliance | 0.25 |
| developer-experience | Clear errors, self-documenting, discoverable | 0.15 |
| extensibility | Versioning strategy, backward compatibility | 0.10 |

**Pass threshold**: 7.0

### frontend-design

| Criterion | Description | Weight |
|-----------|-------------|--------|
| visual-coherence | Color, typography, spacing create unified identity | 0.25 |
| originality | Custom decisions vs template defaults, avoids generic patterns | 0.25 |
| craft | Typography hierarchy, spacing rhythm, color harmony, contrast | 0.20 |
| usability | Intuitive navigation, accessible, responsive | 0.20 |
| performance | Minimal layout shift, fast paint, optimized assets | 0.10 |

**Pass threshold**: 7.0

### data-pipeline

| Criterion | Description | Weight |
|-----------|-------------|--------|
| correctness | Data transformations produce expected output, no data loss | 0.30 |
| reliability | Error handling, retry logic, idempotency, dead-letter queues | 0.25 |
| observability | Logging, metrics, alerting, data lineage tracking | 0.20 |
| efficiency | Batch sizing, parallelism, resource utilization | 0.15 |
| schema-safety | Schema evolution handled, backward/forward compatibility | 0.10 |

**Pass threshold**: 7.0

### security-audit

| Criterion | Description | Weight |
|-----------|-------------|--------|
| vulnerability-coverage | OWASP Top 10 addressed, injection/XSS/CSRF checked | 0.30 |
| auth-correctness | Authentication + authorization logic sound, no bypasses | 0.25 |
| data-protection | Secrets management, encryption at rest/transit, PII handling | 0.20 |
| attack-surface | Unnecessary endpoints/ports closed, minimal exposure | 0.15 |
| compliance | Relevant standards (GDPR, SOC2, HIPAA) addressed if applicable | 0.10 |

**Pass threshold**: 8.0  (security-critical — higher bar)

### architecture-review

| Criterion | Description | Weight |
|-----------|-------------|--------|
| modularity | Clear boundaries, low coupling, high cohesion | 0.25 |
| scalability | Handles growth in data, users, features without redesign | 0.25 |
| simplicity | No unnecessary abstractions, appropriate complexity for requirements | 0.20 |
| resilience | Failure handling, degradation strategy, recovery mechanisms | 0.15 |
| operability | Deployable, observable, configurable without code changes | 0.15 |

**Pass threshold**: 7.0

## Applies to

`score`, `compare`, `bench` subcommands — any command accepting `--rubric <name>`.
Custom rubrics created via `rubric create` are stored in `.xm/eval/rubrics/` and appear alongside built-ins in `rubric list`.

---
<!-- [See: storage-layout] -->

# Storage Layout Reference

File system layout for x-eval outputs, result schemas, and rubric definitions stored under `.xm/eval/`.

## Storage Layout

```
.xm/eval/
├── rubrics/               # Custom rubric definitions
│   └── <name>.json
├── results/               # Score and compare results
│   ├── {timestamp}-score.json
│   └── {timestamp}-compare.json
├── benchmarks/            # Benchmark results
│   └── {timestamp}-bench.json
└── diffs/                 # Diff analysis results
    └── {timestamp}-diff.json
```

### Result Schema (score)

```json
{
  "type": "score",
  "run_id": "debate-2026-04-04T10-00-00-redis-vs-postgres",
  "timestamp": "ISO8601",
  "source_plugin": "x-op",
  "source_strategy": "debate",
  "source_result_path": ".xm/op/debate-2026-04-04-redis-vs-postgres.json",
  "rubric": "code-quality",
  "judges": 3,
  "scores": {
    "correctness": [9, 8, 9],
    "readability": [7, 8, 7]
  },
  "averages": { "correctness": 8.7, "readability": 7.3 },
  "overall": 7.8,
  "sigma": 0.6,
  "pass_threshold": 7.5,
  "passed": true,
  "na_criteria": ["security"],
  "assertion_results": [
    { "assertion": "function handles head=None", "result": "PASS",      "confidence": "3/3" },
    { "assertion": "no global mutable state",    "result": "HARD_FAIL", "confidence": "0/3" }
  ],
  "content_preview": "function add(a,b)...",
  "judge_rationales": [
    {
      "judge": "judge-1 (standard)",
      "per_criterion": { "correctness": "Handles edge cases; tested with negatives.", "readability": "..." },
      "overall_reasoning": "Solid implementation; minor naming concerns."
    }
  ]
}
```

- `pass_threshold` — copied from rubric at evaluation time (allows rubric tuning without invalidating old results).
- `passed` — `overall >= pass_threshold`. Used by `bench` for `pass_at_k` aggregation.
- `run_id` — stable execution ID copied from the caller when x-eval scores an x-op result. Required when `source_plugin: "x-op"`.
- `source_plugin` — optional caller identifier. Use `"x-op"` for x-op `--verify` / `eval.auto` scoring.
- `source_strategy` — x-op strategy name when `source_plugin: "x-op"`.
- `source_result_path` — path to the originating `.xm/op/*.json` file. Consumers use this to link eval results back to the strategy run.
- `na_criteria` — list of criteria skipped by all judges due to insufficient context. Empty array when all criteria were scored. Consumers must not treat absence as implicit 0.
- `assertion_results` — present only when `--assert` flags were used. Each entry: `assertion` (text), `result` (`PASS` / `UNCERTAIN` / `HARD_FAIL`), `confidence` (judge agreement, e.g. `"2/3"`). A `HARD_FAIL` entry forces `passed = false`.
- `judge_rationales` — preserved for `report --sample-transcript` (article H: "누군가 트랜스크립트를 읽기 전에는 점수를 액면 그대로 믿지 말라"). Optional — skip when `eval.persist_transcripts: false`.

### Result Schema (compare)

```json
{
  "type": "compare",
  "timestamp": "ISO8601",
  "rubric": "general",
  "judges": 3,
  "winner": "B",
  "judge_votes": ["B", "B", "A"],
  "scores": { "A": 7.9, "B": 7.9 },
  "tiebreak": "accuracy",
  "content_previews": { "A": "...", "B": "..." }
}
```

### Rubric Schema

```json
{
  "name": "strict-code",
  "description": "Strict code evaluation",
  "criteria": ["correctness", "edge-cases", "complexity"],
  "weights": [0.5, 0.3, 0.2],
  "pass_threshold": 7.5,
  "created_at": "ISO8601"
}
```

- `pass_threshold` — optional, default **7.0**. Single trial is "pass" when `overall >= pass_threshold`. Used by `bench` pass@k / pass^k metrics. Built-in rubric thresholds: see `rubrics.md`.

### Result Schema (bench)

```json
{
  "type": "bench",
  "timestamp": "ISO8601",
  "task": "Find the bug in this code",
  "rubric": "general",
  "pass_threshold": 7.0,
  "strategies": [
    {
      "name": "debate",
      "trials": 3,
      "avg_score": 7.8,
      "sigma": 0.8,
      "pass_at_k": 2,
      "pass_hat_k": 0,
      "pass_at_k_rate": 0.67,
      "per_trial_overall": [8.2, 7.9, 5.4],
      "est_cost_usd": 0.08,
      "avg_time_sec": 30
    }
  ],
  "broken_task_warning": false,
  "recommendation": { "best_quality": "tournament", "best_value": "debate", "final": "tournament" }
}
```

- `pass_at_k` — count of trials with `overall >= pass_threshold`. Capability signal.
- `pass_hat_k` — 1 if all trials pass, else 0. Reliability signal.
- `pass_at_k_rate` — `pass_at_k / trials`. Normalized.
- `per_trial_overall` — per-trial weighted overall. Enables post-hoc re-scoring without re-running agents.
- `broken_task_warning` — true when ALL strategies have `pass_at_k_rate == 0` AND their `avg_score < 4.5` AND `trials >= 2`. Empirically validated false-alarm rate = 0% on merely-weak strategies.

### Result Schema (calibrate)

```json
{
  "type": "calibrate",
  "timestamp": "ISO8601",
  "rubric": "code-quality",
  "samples": 5,
  "criteria": {
    "correctness":     { "judge_avg": 8.2, "human_avg": 7.8, "bias_delta": 0.4,  "status": "slight" },
    "security":        { "judge_avg": 6.5, "human_avg": 8.1, "bias_delta": -1.6, "status": "systematic" }
  },
  "systematic_criteria": ["security"],
  "sample_ids": ["2026-04-21T11:00:00-score.json"]
}
```

- `bias_delta` — `judge_avg - human_avg`. Positive = inflation, negative = deflation.
- `status` — `"calibrated"` (|Δ| < 0.5), `"slight"` (0.5–0.9), `"systematic"` (≥ 1.0).
- `systematic_criteria` — list of criteria with `status == "systematic"`. Consumed by `report` to surface calibration warnings.
- Stored in `.xm/eval/calibrations/{timestamp}-calibrate.json`.

## Applies to

All subcommands that write output: `score`, `compare`, `bench`, `consistency`, `diff`, `calibrate`. The `report` subcommand reads from `results/`, `benchmarks/`, and `calibrations/`. Custom rubrics are read/written from `rubrics/`.
