# Subcommand: gate

Regression gate between two bench results: did a SKILL.md / prompt / model change make an arm worse on the fixed case set? Usage: `/xm:eval gate --run <id> --baseline latest|<run-id>|<file> [--max-avg-drop 0.5]`.

> **⚠ Call `xm eval gate …` directly via the dispatcher (see `subcommands/case.md` for the fallback block). Never define a shell helper across Bash calls.**

## What it compares

For every arm in the baseline:

| Blocker | Condition |
|---|---|
| `pass_hat_k_lost` | baseline passed every trial, current did not |
| `avg_drop_over_threshold` | `current.avg − baseline.avg ≤ −max_avg_drop` (default 0.5 — the same bar as `diff --baseline`) |
| `arm_missing` | the arm was not run at all |
| `insufficient_records` | current run is partial (unrecorded jobs) |
| `broken_task` | current run tripped the broken-task warning |

Arms only in the current run are reported as `new`, never as a pass. The gate never re-runs anything; it compares two saved files and records both sha256s.

## Flow

```bash
xm eval bench finish --run <id> --baseline latest      # finish + gate in one step, or
xm eval gate --run <id> --baseline <earlier-run-id>     # gate an already-finished run
xm eval gate --current a-bench.json --baseline b-bench.json --json
```

Exit 0 = pass, **3 = regression** (blockers listed), 2 = usage. Print the table `finish`/`gate` returns; do not recompute deltas. On exit 3: do not release the SKILL.md change — re-run with more trials if σ is high, otherwise fix the regression or raise the case's bar deliberately and say so.

## Storage

`.xm/eval/gates/{timestamp}-gate.json`: `{ type: "gate", current: {run_id, path, sha256}, baseline: {…}, passed, max_avg_drop, blockers[], arms[] }`.

## Applies to
Invoked via `/xm:eval gate …` or `bench finish --baseline`. Typical use: CI step after editing any `SKILL.md` under `x-op/` or `x-eval/`.
