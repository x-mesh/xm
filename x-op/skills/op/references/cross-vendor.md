# Cross-Vendor Mode (debate / council)

By default x-op strategies fan out single-vendor Claude agents (different personas/roles,
same model). With `--cross-vendor`, `debate` and `council` instead assign roles/positions to
DIFFERENT model vendors (claude + codex + cursor + …) via the shared x-panel engine, so the
deliberation has real cross-vendor diversity — a single-vendor harness structurally cannot do this.

> **⚠ Call `xm panel …` directly via the dispatcher (Bash) — never import.** Fresh shell per Bash
> call ⇒ no helper functions.

## Probe + fallback (do this first)

```bash
xm panel detect --json        # {"available":[...],"known":[...]}
```

If `available` has fewer than 2 vendors, run the normal single-vendor Claude flow and tell the
user (loud, never silent — Lesson L6): "cross-vendor requested but only N vendor(s) installed
(<list>) — running single-vendor; install codex/cursor for cross-vendor."

## The primitive: `xm panel cross`

Runs ONE prompt across N vendors in parallel and returns each vendor's RAW text output (no
findings parsing, no merge). The caller does the synthesis. Output lands in `.xm/cross/<run>/`.

```bash
xm panel cross --models "<available>" --prompt-file <prompt-tmp> --json
# → {"results":[{"model","ok","output","error"}, ...]}
```

## debate (PRO / CON / JUDGE across vendors)

1. Assign roles to distinct vendors (e.g. PRO=claude, CON=codex, JUDGE=cursor).
2. OPENING: for each side, write its role prompt to a temp file and call
   `xm panel cross --models <that vendor> --prompt-file <role-prompt>`.
3. REBUTTAL: send each side's opening to the opposing vendor as the next prompt.
4. VERDICT: give the JUDGE vendor both sides' arguments; it scores and recommends.
The cross-vendor value: PRO and CON are genuinely different models, not one model role-playing both.

## council (N-party across vendors)

1. OPENING: same question to all available vendors in one call —
   `xm panel cross --models "<available>" --prompt-file <question>`.
2. CROSS-EXAMINE: broadcast each vendor's position to the others (exclude its own) as the next prompt.
3. DEEP DIVE / CONVERGE: leader (Claude) drafts a consensus proposal from the vendor positions; note
   where vendors agreed (consensus) and where only one did (diversity) — keep both, drop neither.

## Cost & defaults

Cross-vendor multiplies cost (vendors × rounds). Announce the model set + rough cost before
spending. Single-vendor remains the default for every strategy; `--cross-vendor` is purely additive
and currently wired for `debate` and `council` only.
