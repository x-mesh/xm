# Cross-Vendor Mode (consensus review)

By default the Consensus Loop fans out 4 single-vendor Claude agents — architect / critic /
planner / security — same model, different personas. They share the same training priors, so
they share blind spots: the most dangerous assumption is the one ALL four models were trained
to make. With `--cross-vendor`, each role is assigned across the available model vendors
(claude + codex + cursor + …) via the shared x-panel engine — distinct vendors when 4+ are
installed, spread/doubled-up when fewer — so the PRD critique gains real cross-model diversity
on top of its role diversity. A single-vendor harness structurally cannot do this.

This is where cross-vendor pays off most: consensus output is opinion/critique (AGREE/OBJECT +
rationale), not execution, and a flawed PRD propagates to every downstream task. Catching
single-model groupthink here has the largest blast radius in the whole lifecycle.

> **⚠ Call `xm panel …` directly via the dispatcher (Bash) — never import.** Fresh shell per Bash
> call ⇒ no helper functions persist. Always use the `xm panel` dispatcher.

## Probe + fallback (do this first)

```bash
xm panel detect --auth --json   # available = installed AND authenticated (skips logged-out CLIs)
```

If fewer than 2 vendors are ready, run the normal single-vendor Claude Consensus Loop and
tell the user (loud, never silent — Lesson L6): "cross-vendor consensus requested but only N
vendor(s) ready (installed + signed in) (<list>) — running single-vendor; run `xm panel doctor`
to fix auth, or install another CLI (codex/cursor)."

## The primitive: `xm panel cross`

Runs ONE prompt across N vendors in parallel and returns each vendor's RAW text output (no
findings parsing, no merge). The caller does the synthesis. Output lands in `.xm/cross/<run>/`.

```bash
xm panel cross --models "<vendor>" --prompt-file <role-prompt-tmp> --json \
  --source build:consensus --title "<PRD name> — <role>"
# → {"results":[{"model","ok","output","error"}, ...]}
```

Always pass `--source build:consensus` and `--title` so each role's run is identifiable in the
dashboard panel list by its calling workflow + topic, not a bare timestamp.

## Role → vendor assignment

Take the 4 roles in fixed order `[architect, critic, planner, security]` and the available
vendors `V` (length ≥ 2 after the fallback gate). Assign role `i` → `V[i % len(V)]`:

| Vendors available | architect | critic | planner | security |
|---|---|---|---|---|
| 4 (claude, codex, cursor, kiro) | claude | codex | cursor | kiro |
| 3 (claude, codex, cursor) | claude | codex | cursor | claude |
| 2 (claude, codex) | claude | codex | claude | codex |

Every role always runs; doubling up a vendor on two roles is honest cross-vendor (the critique
is still spread across model families) — just don't claim "4 distinct models" when there were 2.
State the actual role→vendor map to the user before spending.

## Round flow

Each role keeps the SAME role prompt as the single-vendor Consensus Loop (the architect /
critic / planner / security prompts with their principles + good/bad OBJECT examples). Only the
executor changes.

**Round 1: broadcast (4 roles, each to its assigned vendor)**

1. For each role, write its full role prompt (PRD content + the role's principles/evaluate
   block, ending with "Conclusion: AGREE or OBJECT + specific feedback. 200 words max.") to a
   temp file.
2. Send it to that role's assigned vendor:
   ```bash
   xm panel cross --models "<role's vendor>" --prompt-file <role-prompt-tmp> --json \
     --source build:consensus --title "<PRD name> — <role>"
   ```
   These are independent — fire all four; each is one single-vendor `cross` call.
3. Collect each role's raw verdict (AGREE / OBJECT + feedback).

> **Per-role failure rule (do NOT skip — prevents false consensus).** A single-vendor `cross`
> call returns `{ok:false, output:""}` and exits non-zero when that one vendor errors (auth,
> timeout, crash). NEVER treat an empty/failed role result as AGREE — that silently drops a
> reviewer (e.g. security) and fabricates "All AGREE" on the highest-blast-radius path. On any
> role failure: surface the failed role + error to the user (loud — Lesson L6), then EITHER
> reassign that role to `claude` (always available) and re-run it, OR record it as a blocking
> abstain that prevents declaring consensus until resolved. A failed role is never a passing role.

**Consensus judgment** (identical to single-vendor):
- **All AGREE** → consensus reached; show results, return to PRD Review options.
- **1+ OBJECT** → leader (Claude) synthesizes the OBJECT feedback, revises the PRD, re-broadcasts
  (max 3 rounds). Same re-entry limit: the Consensus Loop runs at most 2× per PRD Review session.
- **No consensus after 3 rounds** → summarize disagreements for the user, request user judgment.

## Result output (add a Vendor column)

```
🏛️ [consensus · cross-vendor] PRD Review — Round {n}/{max}
   roles: architect=claude · critic=codex · planner=cursor · security=kiro

| Role      | Vendor | Verdict  | Key Feedback |
|-----------|--------|----------|--------------|
| architect | claude | ✅ AGREE  | Structure is sound |
| critic    | codex  | ❌ OBJECT | [R3] Missing test strategy |
| planner   | cursor | ✅ AGREE  | Decomposable |
| security  | kiro   | ❌ OBJECT | No rate-limit on [R1] public endpoint |

→ Incorporating codex+kiro feedback to revise PRD...
```

Note: each reviewer judges from a DIFFERENT role lens on a DIFFERENT vendor — this is not N
vendors scoring one identical prompt, it is role diversity × vendor diversity. So read the
verdicts as role/vendor reviewers: when ALL role/vendor reviewers AGREE, treat it as consensus;
when a single role/vendor reviewer OBJECTs, weigh it — don't auto-discard. A lone objection from
a non-Claude vendor is often exactly the blind spot the Claude-trained roles' shared priors
would have missed.

## Cost & defaults

Cross-vendor does NOT add calls: it is the same 4 role invocations × rounds (max 12 calls, with
the 3-round cap) as single-vendor consensus — only the per-vendor token pricing differs, so cost
shifts rather than multiplies. Announce the role→vendor map + rough cost before spending.
Single-vendor remains the default for consensus; `--cross-vendor` is purely additive and changes
only who executes each role, never the consensus judgment logic.
