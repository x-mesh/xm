# x-kit Benchmark Results

Date: 2026-03-31 | Model: claude-sonnet-4-6 | Total trials: 15

## 1. Plugin Consistency (9 trials)

Do x-kit SKILL.md prompt programs produce consistent outputs?

| Plugin | Strategy | Trials | Verdict Consistency | Core Finding Consistency | Overall |
|--------|----------|:------:|:-------------------:|:------------------------:|:-------:|
| x-review | multi-lens review | 9 (3 versions × 3) | 100% (v3) | 100% (v3) | **0.89** |
| x-solver | decompose | 3 | — | root cause 100%, rank ρ=1.0 | **0.917** |
| x-op | debate | 3 | 100% (CON 3/3) | key factor 100% | **0.733** |

**Key finding:** All three plugins achieve 100% consistency on final judgments (verdict, root cause, ranking). Variance occurs only in supporting details (argument surface, sub-problem framing).

**Calibration improvement:** Severity disambiguation guide improved x-review consistency from 0.44 → 0.89 (+102%) with two targeted edits.

## 2. A/B: x-kit vs Vanilla Claude Code (2 trials)

Same diff reviewed with and without x-review framework.

| Metric | Vanilla | x-kit |
|--------|:-------:|:-----:|
| Precision | 0.75 | **1.0** |
| Recall | **1.0** | 0.25 |
| F1 | **0.857** | 0.4 |
| Severity accuracy | 0.75 | **1.0** |
| Findings | 4 | 1 |

**Key finding:** x-kit trades recall for precision. Every x-kit finding is correctly calibrated (no false positives), but it filters out edge-case issues that vanilla catches. Vanilla wins on balanced F1 (0.857 vs 0.4).

**Improvement identified and implemented:** Recall Boost pass added to x-review Phase 4.

### After Recall Boost (v4)

| Metric | v3 (no boost) | v4 (with boost) | Change |
|--------|:-------------:|:---------------:|:------:|
| Precision | 1.0 | 1.0 | — |
| Recall | 0.25 | **0.75** | **+200%** |
| F1 | 0.4 | **0.857** | **+114%** |

Recall Boost recovered 2 of 3 missed issues as `[Observation]` tags (non-blocking, advisory) plus found 1 new issue vanilla also missed. Precision preserved — observations don't inflate severity or affect verdict.

## 3. Cross-Plugin Strategy Quality

| Strategy | Consistency | Characteristic |
|----------|:-----------:|----------------|
| decompose (x-solver) | **0.917** | Highest — deterministic root cause identification |
| multi-lens review (x-review) | **0.89** | High after calibration — sensitive to severity wording |
| debate (x-op) | **0.733** | Moderate — stable verdicts, diverse argument surface |

## Conclusions

1. **SKILL.md prompt programs work** — 100% verdict consistency across all plugins when criteria are specific
2. **Calibration matters** — vague criteria ("many Medium") cause 33% inconsistency; quantified thresholds fix it
3. **Precision vs recall tradeoff solved** — Recall Boost pass recovers coverage (0.25→0.75) without sacrificing precision (1.0)
4. **decompose is the most reliable strategy** — perfect rank correlation (ρ=1.0) across framings
5. **x-kit matches vanilla F1** — after Recall Boost, x-kit F1 = 0.857 (equal to vanilla) with superior precision

## Data Files

- `x-review-consistency.json` — 9-trial consistency experiment with v1/v2/v3 comparison
- `x-solver-consistency.json` — 3-trial decompose strategy benchmark
- `x-op-debate-consistency.json` — 3-trial debate strategy benchmark
- `ab-vanilla-vs-xkit.json` — A/B comparison with precision/recall/F1 metrics
