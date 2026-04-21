# Subcommand: report

Output a summary of evaluation results for the current or a specific session. Reads from `.xm/eval/results/` and `.xm/eval/benchmarks/`.

## Subcommand: report

**Output a summary of evaluation results for the current or a specific session.**

### Parsing

- `report` (no arguments) = all results from current session
- `report <session-id>` = specific session results
- `report --all` = full history
- `report --sample-transcript N` = after the summary, randomly sample N results and dump their full judge rationales (requires `eval.persist_transcripts` = true, which is the default)

Reads and aggregates from both `.xm/eval/results/` and `.xm/eval/benchmarks/`.

### Output

```
📊 [eval] Evaluation Report (current session)

Scores (3):
  2026-03-25 14:30  code-quality  7.8/10   src/auth.ts
  2026-03-25 14:45  general       8.2/10   "refactoring proposal"
  2026-03-25 15:00  plan-quality  6.9/10   sprint plan v2

Comparisons (1):
  2026-03-25 15:20  general       Winner: B  "response style A vs B"

Benchmarks (1):
  2026-03-25 15:40  3 strategies  Best: tournament (8.5)  Rec: debate

Session avg score: 7.6/10
```

### Transcript sampling (`--sample-transcript N`)

Appended after the summary. Randomly samples N results (uniform across `results/` + `benchmarks/`) and prints the preserved judge rationales.

```
📝 Transcript samples (2 of 5, randomly selected):

─── 2026-03-25 14:30 — code-quality — 7.8/10 (passed, threshold 7.5) ───
Content: "function add(a,b)..."

Judge-1 (standard):
  correctness: 9 — "Handles edge cases; tested with negative numbers."
  readability: 7 — "Short variable names reduce clarity."
  …
  Overall reasoning: "Solid implementation; minor naming concerns."

Judge-3 (adversarial):
  correctness: 5 — "Silent integer overflow on MAX_INT inputs."
  …
  Overall reasoning: "Surface-correct but misses overflow boundary."

─── 2026-03-25 15:40 — bench tournament — Best 8.5, pass^k = 3/3 ───
Trial 2 (winning, score 8.9):
  Output: "Identified bug at line 47 — off-by-one in pagination..."
  Judge rationale (aggregated): "Correct diagnosis; adversarial judge confirmed no fabrication."
```

**Why this exists:** every 5–10 bench/score runs, read at least one sampled transcript. Rubric scores collapse nuance; reading raw judge reasoning reveals shared bias, hallucinated findings, and score inflation that aggregate metrics hide. (Article H — direct quote: "누군가 트랜스크립트를 읽기 전에는 점수를 액면 그대로 믿지 말라.")

**Missing transcripts:** Results written before Tier 1 Dec 2025 / `eval.persist_transcripts: false` sessions show `[transcript not preserved]` in place of rationales.

## Applies to
Invoked via `/x-eval report ...`. See Subcommand: list in SKILL.md for all available commands.
