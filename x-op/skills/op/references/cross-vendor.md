# Cross-Vendor Mode (debate / council / brainstorm)

By default x-op strategies fan out single-vendor Claude agents (different personas/roles,
same model). With `--cross-vendor`, `debate` and `council` instead assign roles/positions to
DIFFERENT model vendors (claude + codex + cursor + …) via the shared x-panel engine, so the
deliberation has real cross-vendor diversity — a single-vendor harness structurally cannot do this.

> **⚠ Call `xm panel …` directly via the dispatcher (Bash) — never import.** Fresh shell per Bash
> call ⇒ no helper functions.

## Probe + fallback (do this first)

```bash
xm panel detect --auth --json   # available = installed AND ready (authed, or assumed-ready like agy w/ creds; skips logged-out)
```

If fewer than 2 vendors are ready, run the normal single-vendor Claude flow and tell the
user (loud, never silent — Lesson L6): "cross-vendor requested but only N vendor(s) ready
(installed + signed in) (<list>) — running single-vendor; run `xm panel doctor` to fix auth,
or install another CLI (codex/cursor)."

## The primitive: `xm panel cross`

Runs ONE prompt across N vendors in parallel and returns each vendor's RAW text output (no
findings parsing, no merge). The caller does the synthesis. Output lands in `.xm/cross/<run>/`.

```bash
xm panel cross --models "<available>" --prompt-file <prompt-tmp> --json \
  --source op:<strategy> --title "<short topic>"
# → {"results":[{"model","ok","output","error"}, ...]}
```

Always pass `--source op:<strategy>` (e.g. `op:debate`, `op:council`) and `--title "<short topic>"`.
These tag the run with its calling workflow and a human name so it is identifiable in the dashboard
panel list (otherwise it shows as a bare `cross` run with a timestamp). `--source` is sanitized to a
short safe tag; `--title` falls back to the prompt's first line when omitted.

## debate (PRO / CON / JUDGE across vendors)

1. Assign roles to distinct vendors (e.g. PRO=claude, CON=codex, JUDGE=cursor).
2. OPENING: for each side, write its role prompt to a temp file and call
   `xm panel cross --models <that vendor> --prompt-file <role-prompt> --source op:debate --title "<motion>"`.
3. REBUTTAL: send each side's opening to the opposing vendor as the next prompt.
4. VERDICT: give the JUDGE vendor both sides' arguments; it scores and recommends.
The cross-vendor value: PRO and CON are genuinely different models, not one model role-playing both.

## council (N-party across vendors)

1. OPENING: same question to all available vendors in one call —
   `xm panel cross --models "<available>" --prompt-file <question> --source op:council --title "<question>"`.
2. CROSS-EXAMINE: broadcast each vendor's position to the others (exclude its own) as the next prompt.
3. DEEP DIVE / CONVERGE: leader (Claude) drafts a consensus proposal from the vendor positions; note
   where vendors agreed (consensus) and where only one did (diversity) — keep both, drop neither.

## brainstorm (ideation across vendors)

The GENERATE phase (Phase 1) fans out to DIFFERENT vendors instead of same-model Claude agents, so
the idea pool spans model families — different priors surface ideas one model never would. CLUSTER
and VOTE stay single-vendor: the leader dedups and groups (CLUSTER), and the standard single-vendor
fan-out picks the top ideas (VOTE).

1. GENERATE: send the SAME ideation prompt to every available vendor in one call — if
   `--analogical`/`--lateral` is set, that mode is already baked into the base prompt, so every
   vendor receives the same mode-applied prompt (min 5 tagged ideas each) —
   `xm panel cross --models "<available>" --prompt-file <generate-prompt> --source op:brainstorm --title "<topic>"`.
2. Collect each vendor's idea set (a per-vendor failure = one fewer pool, surfaced not silent — L6).
3. CLUSTER: leader merges all vendors' ideas, dedups, groups by theme — tag each cluster with the
   vendors that reached it (a cluster only one vendor produced is the cross-vendor signal).
4. VOTE (if `--vote`): the standard single-vendor brainstorm fan-out selects the top ideas — NOT a
   cross-vendor step (it votes on the already vendor-merged pool from CLUSTER).

GENERATION-only pattern (same as x-solver): inject diversity where ideas are born, keep synthesis
with the leader. `select`/judgement is NOT cross-vendor here.

## Cost & defaults

Cross-vendor multiplies cost (vendors × rounds). Announce the model set + rough cost before
spending. Single-vendor remains the default for every strategy; `--cross-vendor` is purely additive
and currently wired for `debate`, `council`, and `brainstorm` (the last on its GENERATE phase only).
