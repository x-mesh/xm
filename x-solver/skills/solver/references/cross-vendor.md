# Cross-Vendor Mode (candidate generation)

By default the solve-phase generation steps fan out `AGENT_COUNT` same-model Claude agents
(sonnet). Same model = same training priors = similar candidates: same-model fan-out for
*generation* has low diversity ROI (this is a known x-solver lesson — verify benefits from
fan-out, generation barely does). With `--cross-vendor`, the generation steps fan out across
DIFFERENT model vendors (claude + codex + cursor + …) via the shared x-panel engine, so each
candidate comes from a genuinely different model family — structurally diverse solutions a
single-vendor harness cannot produce.

**Scope: GENERATION only.** Cross-vendor applies to the steps whose job is producing diverse
candidates:

| Strategy | Cross-vendor step | What each vendor produces |
|----------|-------------------|---------------------------|
| decompose | `explore` | one solution candidate per sub-problem |
| constrain | `generate` | one candidate (each optimizing a different soft constraint) |
| iterate | `hypothesize` | a distinct hypothesis set (diverse root-cause framing) |

Everything downstream stays single-vendor: `evaluate` / scoring / `select` is the leader's job,
and the `test` phase (verify a hypothesis by execution) is execution-deterministic — running the
test gives the same answer regardless of vendor, so cross-vendor adds nothing there. **For
cross-vendor SCORING, use `x-eval --cross-vendor` (that is its domain) — do not score here.**

> **⚠ Call `xm panel …` directly via the dispatcher (Bash) — never import.** Fresh shell per Bash
> call ⇒ no helper functions persist. Always use the `xm panel` dispatcher.

## Probe + fallback (do this first)

```bash
xm panel detect --auth --json   # available = installed AND authenticated (skips logged-out CLIs)
```

If fewer than 2 vendors are ready, run the normal single-vendor Claude fan-out and tell the
user (loud, never silent — Lesson L6): "cross-vendor candidates requested but only N vendor(s)
ready (installed + signed in) (<list>) — running single-vendor; run `xm panel doctor` to fix auth,
or install another CLI (codex/cursor)."

## The primitive: `xm panel cross`

Runs ONE prompt across N vendors in parallel and returns each vendor's RAW text output. The
caller does the synthesis. Output lands in `.xm/cross/<run>/`.

```bash
xm panel cross --models "<available>" --prompt-file <gen-prompt-tmp> --json \
  --source solver:<activity> --title "<problem>"
# → {"results":[{"model","ok","output","error"}, ...]}
```

Always pass `--source solver:<activity>` (e.g. `solver:explore`, `solver:generate`,
`solver:hypothesize`) and `--title "<problem>"` to the `panel cross` call so the run is
identifiable in the dashboard panel list. NOTE: this is the **panel** `--source` (the calling
workflow) — distinct from `solver candidates add --source <vendor>` (which tags the producing
vendor). Keep both.

## Generation flow

`xm panel cross --models` takes a comma-joined vendor list (e.g. `claude,codex` — join `detect`'s
`available` JSON array yourself) and sends ONE identical prompt to every listed vendor. The base
generation prompt is the SAME one from `commands/solve.md` — do NOT rewrite it. How you fan out,
and where you register results, depends on the strategy:

**decompose → explore** (writes to the `candidates` store, per sub-problem)
The explore prompt is sub-problem-specific, so run one `cross` call PER sub-problem:
```bash
xm panel cross --models "<available>" --prompt-file <explore-prompt-for-spN> --json --source solver:explore --title "spN: <sub-problem>"
xm solver candidates add "<vendor's proposal>" --source <vendor> --sub-problem spN
```

**constrain → generate** (writes to the `candidates` store, no sub-problem)
To give each vendor a different `focus_constraint`, loop one SINGLE-vendor call per vendor — a
single `--models "<available>"` call would send every vendor the same focus. The base prompt is
unchanged; only its `focus_constraint` line varies per vendor:
```bash
# for each (vendor, focus_constraint) pair:
xm panel cross --models "<one vendor>" --prompt-file <prompt-with-that-focus> --json --source solver:generate --title "<focus_constraint>"
xm solver candidates add "<vendor's proposal>" --source <vendor>   # no --sub-problem
```

**iterate → hypothesize** (writes to the SEPARATE `hypotheses` store)
Broadcast the hypothesis-generation prompt to all vendors in one call, then merge:
```bash
xm panel cross --models "<available>" --prompt-file <hypothesize-prompt> --json --source solver:hypothesize --title "<problem>"
xm solver hypotheses add "<merged hypothesis>"   # once per distinct hypothesis
```
`hypotheses add` takes NO `--source` and NO `--sub-problem` — hypotheses carry no vendor tag, so
the Model-column matrix below does NOT apply to iterate. Preserve each vendor's raw output as a
vendor-tagged hypothesis set and dedup only obvious overlaps (same cause + same disproof).

In every case the count = number of successful vendors (× sub-problems for decompose), NOT
`AGENT_COUNT` — `AGENT_COUNT` does not apply in cross-vendor mode.

> **Per-vendor failure rule (L6 — never silent).** A failed vendor (`ok:false`) means one fewer
> candidate, not a wrong answer — but still surface the failed vendor + error to the user; do not
> silently drop it. If fewer than 2 vendors succeed, selection has nothing to compare: warn the
> user and either re-run the failed vendor, add a Claude candidate to reach ≥2, or fall back to
> single-vendor generation. Never proceed to `select` with a silently-reduced candidate set.

## After generation → normal evaluate / select

Once candidates are registered, the rest of the solve phase is unchanged and single-vendor: the
leader scores each candidate against the constraints and runs `select`. Add a **Model** column to
the Contrastive Matrix so the vendor-of-origin diversity is visible at selection time:

```
| Candidate | Model  | c1 | c2 | c3 | Total | Winner |
|-----------|--------|----|----|----|-------|--------|
| cand-1    | claude | 8  | 6  | 9  | 23    |        |
| cand-2    | codex  | 7  | 9  | 8  | 24    | ★      |
| cand-3    | cursor | 9  | 5  | 7  | 21    |        |
```

A candidate from a non-Claude vendor winning is the signal cross-vendor generation exists to
surface — the best approach the Claude-only fan-out would never have proposed.

## Cost & defaults

Cross-vendor generation runs one vendor per candidate instead of `AGENT_COUNT` Claude agents —
roughly the same fan-out width, with per-vendor token pricing rather than all-Claude. Announce
the vendor set + rough cost before spending. Single-vendor remains the default; `--cross-vendor`
is purely additive and changes only who generates candidates, never the scoring/selection logic.
