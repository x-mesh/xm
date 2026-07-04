# Subcommand: compare

A judge panel compares two outputs and determines a winner. Usage: `/xm:eval compare <output-a> <output-b> [--judges N] [--rubric <name>]`.

## Subcommand: compare

**A judge panel compares two outputs and determines a winner.**

### Parsing

From `$ARGUMENTS`:
- First argument after `compare` = output-a (text or file path)
- Second argument = output-b (text or file path)
- `--judges N` = number of judges (default 3)
- `--rubric <name>` = comparison rubric (default `general`)
- `--model` = judge model (default sonnet)

### Position Bias Prevention

Randomly flip A/B order for each judge:

```
Judge 1: [Output A] vs [Output B]
Judge 2: [Output B] vs [Output A]   ← order reversed
Judge 3: [Output A] vs [Output B]
```

Judge prompts refer to "First Output" / "Second Output" only (A/B labels hidden).
During aggregation, restore original order to compute correct A/B mapping.

### Judge Prompt

See `judges/comparison.md` — scores two outputs per criterion, picks winner or tie; A/B labels hidden to prevent position bias.

---

### Result Aggregation and Output

```
📊 [eval] Comparison: A vs B (3 judges)
Rubric: general

Winner: Output B (2/3 judges)

| Criterion     |   A  |   B  | Winner |
|---------------|------|------|--------|
| Accuracy      |  8.0 |  8.7 | B      |
| Completeness  |  7.3 |  8.0 | B      |
| Consistency   |  8.0 |  7.7 | A      |
| Clarity       |  8.3 |  7.0 | A      |
| Hallucination |  7.7 |  8.3 | B      |

Overall: A=7.9 vs B=7.9 → Marginal B win (tie-break: Accuracy)

Judge consensus: Medium (2/3 agree on winner)
```

**Tiebreak rule:** If overall averages are equal, decide by the rubric's first criterion (the most important one).

### Cross-Vendor Comparison (`--cross-vendor`)

Same resolution/probe/announce/provenance rules as `score.md` § Cross-Vendor Judges. The
comparison-specific part is **position-bias counterbalancing without losing the single-call
economy**: `xm panel cross` sends ONE prompt to all vendors, so a per-vendor random flip is
impossible in one call. Split instead:

1. Split the ready vendors into two halves (alternating order: 1st, 3rd, … vs 2nd, 4th, …).
2. Write TWO prompt files — `judges/comparison.md` with First=A/Second=B, and the reverse.
3. Run TWO `xm panel cross` calls (one per half, `--source eval:compare`). Every vendor still
   judges exactly once; the A/B order is counterbalanced across vendors.
4. Restore the original A/B mapping per vendor during aggregation (as in the single-vendor flow),
   report the winner with per-vendor votes, and record which order each vendor saw
   (`order_by_vendor`) in the result JSON alongside the `cross_vendor` provenance block.

With an odd vendor count the extra vendor goes to the A-first half — note it in the result so a
1-vendor imbalance is visible, not silent.

### Storage

Save results to `.xm/eval/results/{timestamp}-compare.json`.

## Applies to
Invoked via `/xm:eval compare ...`. See Subcommand: list in SKILL.md for all available commands.
