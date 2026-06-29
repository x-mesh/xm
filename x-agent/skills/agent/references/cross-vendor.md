# Cross-Vendor Mode (fan-out / broadcast)

By default `fan-out` and `broadcast` run N same-model Claude agents via the built-in Agent tool.
Same model = same training priors = correlated outputs: same-model fan-out has low diversity ROI.
With `--cross-vendor`, each agent is assigned a model vendor from the available set
(claude + codex + cursor + …, cycled round-robin when agents outnumber vendors) via the shared
x-panel engine, so the parallel agents span different model families — the diversity that
fan-out/broadcast exist to produce. This is the lowest-level primitive: every
caller that fans out (and every higher-level skill built on it) can opt into vendor diversity here.

**Scope: fan-out + broadcast only.** `delegate` is a single agent — there is no diversity to add;
to use a non-Claude model there, just pick that vendor directly. Cross-vendor is about running
MANY models at once, which only fan-out and broadcast do.

> **⚠ Call `xm panel …` directly via the dispatcher (Bash) — never import.** Fresh shell per Bash
> call ⇒ no helper functions persist. Always use the `xm panel` dispatcher.

## Probe + fallback (do this first)

```bash
xm panel detect --auth --json   # available = installed AND ready (authed, or assumed-ready like agy w/ creds; skips logged-out)
```

If fewer than 2 vendors are ready, run the normal single-vendor Claude fan-out/broadcast and
tell the user (loud, never silent — Lesson L6): "cross-vendor requested but only N vendor(s)
ready (installed + signed in) (<list>) — running single-vendor; run `xm panel doctor` to fix auth,
or install another CLI (codex/cursor)."

## The primitive: `xm panel cross`

`--models` takes a COMMA-JOINED vendor list (e.g. `claude,codex` — join `detect`'s `available`
JSON array yourself). One call sends ONE identical prompt to EVERY listed vendor and returns each
vendor's raw text:

```bash
xm panel cross --models "<available>" --prompt-file <prompt-tmp> --json
# → {"results":[{"model","ok","output","error"}, ...]}
```

Key consequence: to send a DIFFERENT prompt per agent (roles), you must loop one single-vendor
call per agent — a single `--models "<available>"` call cannot vary the prompt per vendor.

## fan-out --cross-vendor

**Without `--roles`** (identical prompt — the common case): one call, all vendors.
```bash
xm panel cross --models "<available>" --prompt-file <prompt-tmp> --json
```
Each successful vendor is one agent result.

**With `--roles "se,sre,security"`** (different preset per agent): loop one single-vendor call per
ROLE, using vendor `V[i % len(V)]` (one vendor per role — not a vendor×role cross product), baking
each role preset into that vendor's prompt:
```bash
# for each role i, using vendor V[i % len(V)]:
xm panel cross --models "<that vendor>" --prompt-file <role-preset+prompt> --json
```

## broadcast --cross-vendor

Broadcast already varies role/context per agent, so assign each role its vendor `V[i % len(V)]`
and loop single-vendor calls — same shape as fan-out's `--roles` path (one vendor per role):
```bash
# for each role i, using vendor V[i % len(V)]:
xm panel cross --models "<that vendor>" --prompt-file <role_i context+prompt> --json
```
With fewer vendors than roles, vendors double up (still cross-vendor — just don't claim "N
distinct models" when there were fewer).

## Counts, model flag, failures

- **Width / result count is path-dependent, and `--agents N` never drives it:**
  - *No-roles fan-out* (one `--models "<available>"` call): result count = number of SUCCESSFUL
    vendors; width = vendor count.
  - *`--roles` fan-out / broadcast* (one call per role): width = number of ROLES (vendors repeat
    round-robin); result count = successful (role, vendor) calls.
- **`--model` is ignored** in cross-vendor mode — each vendor uses its own model family (that is
  the entire point). Don't try to force one `--model` across vendors.
- **Per-vendor failure rule (L6 — never silent).** A failed vendor (`ok:false`) is not a wrong
  answer, but always surface the failed vendor + error.
  - *No-roles fan-out:* a failed vendor = one fewer result.
  - *`--roles`/broadcast:* a vendor handles multiple roles via round-robin, and it is the same
    CLI — if that vendor fails, EVERY role assigned to it fails (multiple fewer results).
    Reassign those roles to a surviving vendor or a Claude agent.
  - If fewer than 2 DISTINCT vendors succeed, the fan-out has no cross-model diversity to compare:
    warn and re-run, add a Claude agent to reach ≥2, or fall back to single-vendor.

## Result collection

Tag each result with its vendor of origin and synthesize as usual — now the commonalities /
differences are ACROSS model families, which is the signal cross-vendor adds:
```
📡 [fan-out · cross-vendor] {N} vendors completed — claude, codex, cursor

## claude
{result}
## codex
{result}
---
💡 Cross-vendor agreement: {what all model families independently said}
⚡ Vendor-specific: {what only one model family surfaced — often the blind spot}
```

## Cost & defaults

Cross-vendor runs one vendor per agent instead of N Claude agents — roughly the same fan-out
width, with per-vendor token pricing rather than all-Claude. Announce the vendor set + rough cost
before spending. Single-vendor remains the default; `--cross-vendor` is purely additive and
changes only WHO runs each agent, never the collection/synthesis logic.
