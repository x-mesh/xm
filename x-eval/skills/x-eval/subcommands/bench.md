# Subcommand: bench

Run the same task with multiple strategies/models, evaluate each output, and find the optimal one. Usage: `/x-eval bench <task> --strategies "s1,s2" [--models "m1,m2"] [--trials N]`.

## Subcommand: bench

**Run the same task with multiple strategies/models, evaluate each output, and find the optimal one.**

### Parsing

From `$ARGUMENTS`:
- After `bench` = task description (quoted text)
- `--strategies "s1,s2,s3"` = strategies to benchmark (comma-separated)
- `--models "m1,m2"` = models to benchmark (default: current model)
- `--trials N` = repetitions per strategy (default 3)
- `--rubric <name>` = evaluation rubric (default `general`)
- `--judges N` = number of judges (default 3)

### Execution Flow

1. **Matrix generation**: Build list of `strategies × models × trials` combinations
2. **Parallel execution**: Run each combination via x-op strategy (concurrently when possible)
3. **Evaluation**: Score each output using [Subcommand: score] logic
4. **Aggregation**: Compute per-strategy average score, cost, and elapsed time
5. **Recommendation**: Recommend optimal strategy by efficiency metrics like score/$, score/time

**Strategy name → x-op mapping:**

| bench strategy | x-op subcommand |
|------------|----------------|
| `refine` | `/x-op refine` |
| `debate` | `/x-op debate` |
| `tournament` | `/x-op tournament` |
| `chain` | `/x-op chain` |
| `review` | `/x-op review` |
| `brainstorm` | `/x-op brainstorm` |
| unregistered name | fallback to direct Agent invocation |

If x-op is unavailable, fall back to executing each strategy as a simple Agent prompt.

### Result Aggregation and Output

```
📊 [eval] Benchmark: 3 strategies × 3 trials
Task: "Find the bug in this code"
Rubric: general  (pass_threshold = 7.0)

| Strategy   | Avg  | σ   | pass@k | pass^k | Trials | Cost  | Score/$ |
|------------|------|-----|--------|--------|--------|-------|---------|
| refine     |  8.2 | 0.3 |  3/3   |   ✓    |      3 | $0.12 |   68.3  |
| debate     |  7.8 | 0.8 |  2/3   |   ·    |      3 | $0.08 |   97.5  |
| tournament |  8.5 | 0.2 |  3/3   |   ✓    |      3 | $0.15 |   56.7  |

Best quality:   tournament (8.5/10, pass^k=3/3)
Best value:     refine (Score/$=68.3, pass^k=3/3)
Recommendation: refine — passes reliably AND cheapest reliable option
                (debate has higher Score/$ but pass^k=0 — unreliable)
```

**Metric definitions:**
- `pass@k` = count of trials with `overall >= pass_threshold`. Capability upper bound ("can it ever succeed?").
- `pass^k` = `✓` if ALL trials pass, else `·`. Reliability lower bound ("does it succeed every time?").
- `k` = trial count (`--trials N`). `pass_threshold` comes from the rubric (default 7.0; see `references/rubrics.md`).

**Why both:** avg score hides the "8.2 avg but 0/3 pass^k" failure mode — a strategy that occasionally scores 10 but often scores 5. `pass^k` separates capability from reliability. Empirically, ~25% of high-avg-high-variance strategies fall into this trap.

**Broken-task warning** (printed above the table when triggered):

```
⚠ 0% pass across all strategies at threshold=7.0, and avg_score < 4.5 for all.
   This pattern suggests a broken TASK, not failing strategies.
   Check: task prompt ambiguity, rubric fit, pass_threshold setting.
   (Empirical: false-alarm rate on merely-weak strategies = 0%.)
```

**Warning trigger (strict, empirically tuned):**
```
ALL strategies have pass_at_k_rate == 0
  AND ALL strategies have avg_score < 4.5
  AND trials >= 2
```

Rationale: `pass_at_k == 0` alone has a 35% false-alarm rate on merely-mediocre strategies (k=3). Adding `avg < 4.5` eliminates false alarms (0% on `mediocre` profile mean=6.5, `barely-failing` mean=5.5) while still catching 100% of truly broken tasks (mean=3.0).

**Recommendation logic (pass-aware + σ-aware):**
- `best quality`: strategy with `pass^k = 1` (all trials pass) AND highest Avg Score. If no strategy has `pass^k = 1`, fall back to highest Avg Score with a ⚠ flaky-best warning.
- `best value`: strategy with `pass_at_k_rate >= 0.67` AND highest Score/$. Prevents recommending a high-Score/$ strategy that rarely passes.
- `recommendation`: strategy with `pass^k = 1`, tiebroken by **(1) lowest σ**, then **(2) highest Score/$**. Rationale: at `trials = 3`, a flaky-high-avg strategy can pass all three by luck (~13/30 seeds in sim); picking low-σ among pass^k=1 candidates prefers the genuinely reliable one over the lucky one. If no strategy has `pass^k = 1`, print:
  ```
  ⚠ No strategy passed all trials. No reliable recommendation.
     Suggestion: increase --trials or lower pass_threshold if threshold is unreasonable.
     Best-effort pick: <strategy with highest pass_at_k_rate, tiebreak by avg>.
  ```

**Low-confidence advisory** (printed alongside the recommendation, not in place of):
- When `trials <= 3` AND the recommended strategy has `σ >= 1.0`, append:
  ```
  ⚠ Recommendation is from a small sample (trials=3) with high variance (σ>=1.0).
     A single all-pass result at this trial count has ~43% probability for flaky-high-avg strategies.
     Increase --trials to 5+ for higher-confidence recommendations.
  ```

Do NOT silently recommend an unreliable strategy. Flaky high-avg strategies were the original motivation for `pass^k`.

### Storage

Save results to `.xm/eval/benchmarks/{timestamp}-bench.json`.

### x-op compose Integration

Leverage bench results to optimize x-op compose pipelines:

**Compose preset benchmarking:**
```bash
/x-eval bench "v2 feature plan" --strategies "brainstorm|tournament|refine,brainstorm|refine,brainstorm|council" --trials 2
```

Each strategy is a compose pipeline separated by `|`. Bench executes each pipeline via x-op compose and scores the final output.

| Pipeline | Avg Score | Cost | Score/$ |
|----------|-----------|------|---------|
| brainstorm\|tournament\|refine | 8.5 | $0.45 | 18.9 |
| brainstorm\|refine | 7.2 | $0.25 | 28.8 |
| brainstorm\|council | 7.8 | $0.35 | 22.3 |

**Using results:**
- Recommend the optimal pipeline as the `--strategy` value for x-build tasks
- Include the compose pipeline in the bench result's `recommendation` field

## Applies to
Invoked via `/x-eval bench ...`. See Subcommand: list in SKILL.md for all available commands.
