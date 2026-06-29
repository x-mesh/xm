---
name: panel
description: Cross-vendor entry point + adversarial panel engine. `/xm:panel <verb>` routes multi-model work to the matching consumer in --cross-vendor mode (review→x-review, plan(brainstorm)/debate/council→x-op, solve→x-solver, eval→x-eval, consensus→x-build, fan-out→x-agent); `/xm:panel <target>` runs the panel engine itself (N model CLIs refute each other → consensus verdict); bare `/xm:panel` is an interactive picker; cross/detect/doctor/types/models are engine utilities. Use for "panel review", "다른 모델들로 같이 리뷰", "여러 LLM으로 적대 리뷰", "다중모델로 토론/문제해결/평가", or /xm:panel.
model: sonnet
---

# x-panel — Cross-Model Adversarial Review Panel

## Overview

`x-panel` is the **cross-vendor entry point**. It has two jobs:

1. **Router** — `/xm:panel <verb>` (review/debate/council/solve/eval/consensus/fan-out) delegates to
   the matching consumer (x-review/x-op/x-solver/x-eval/x-build/x-agent) in `--cross-vendor` mode.
   The domain logic stays in the consumer; panel just picks the door. This is why "do it with
   several models" has ONE obvious entry point instead of remembering each plugin's flag.
2. **Engine** — `/xm:panel <target>` runs the native adversarial panel: N model CLIs review the
   same target, one refute round, and a verdict that separates **consensus** (how many models
   agreed — confidence) from **diversity** (what only one model saw). The orchestrator is a
   tool-neutral CLI, so the "leader" is not a fixed model.

Different models have different blind spots — in dogfooding, codex missed a perf issue claude/agy
caught, and cursor missed a SQL injection. That diversity is the whole point of both jobs.

## When to Use

- "여러 모델로 같이 리뷰", "다중모델로 토론/문제해결/평가" → route to the matching consumer (§1)
- "panel review", cross-model second opinion, "적대적으로 교차검증" → engine (§3) or `review` route
- `/xm:panel` (picker), `/xm:panel <file>` (engine), `/xm:panel review|debate|solve|eval …` (route)

## Do NOT Use When

- A **single-model** review/op is wanted → call that consumer directly without `--cross-vendor`.
- The user wants to *recall* a prior panel result → x-recall (`xm recall show panel --last`).

## CLI Invocation

> **⚠ Call `xm panel <command>` directly. Claude Code's Bash tool starts a fresh shell on every invocation — shell functions (`xp()`) defined in one call do NOT persist to the next, causing `command not found`. Never define a helper across calls; always use the dispatcher.**
>
> **Fallback** (only when `xm` is not in PATH — rare; `${CLAUDE_PLUGIN_ROOT}` is NOT exported to Bash subprocesses):
> ```bash
> XPANEL_CLI=$(ls -d ~/.claude/plugins/cache/xm/{x-panel,panel,xm}/*/lib/x-panel-cli.mjs 2>/dev/null | sort -V | tail -1)
> node "$XPANEL_CLI" <command> [args]
> ```
>
> **Forbidden:** `XP="node ..."; $XP review` — zsh treats the quoted string as one command and fails.

## Programmatic API (for other plugins — cross-vendor review)

The panel engine is reusable by other skills via the dispatcher (no imports — cache-safe).
A consumer (e.g. x-review's opt-in cross-vendor mode) probes availability, then drives a
review with its own per-lens prompt:

```bash
# Probe availability first → decide single-vendor fallback (need ≥2) BEFORE spending tokens:
xm panel detect --json          # {"available":[...installed CLIs],"known":[...]}
# detect only checks PATH. A CLI can be installed but logged out → the run fails mid-panel.
# To gate on real readiness (install + auth, no model call):
xm panel doctor                 # ✓ ready / ~ likely ready (no auth-status CLI, creds present) / ✗ NOT authenticated / ? unknown
xm panel detect --auth --json   # "available" = installed AND (authenticated OR assumed-ready, e.g. agy w/ creds)

# Drive a review with a custom per-lens prompt (--lens-tag flows to the verdict).
# Each backslash is the LAST char on its line — copy as-is. Or use --review-prompt - for stdin.
xm panel <target> \
  --review-prompt-file lens.txt \
  --lens-tag security \
  --models claude,codex,cursor --json
```

- The override replaces only the round-1 reviewer intro; a fixed output contract is appended
  so findings always come back JSON-shaped regardless of what the lens prompt asks for.
- round-2 (refute) is unchanged. Injected (review-mode) runs write to `.xm/review/<run>/`,
  separate from native `.xm/panel/` history.
- These flags are programmatic plumbing — interactive `/xm:panel` users don't need them.
- **Where providers/config live:** the provider set (which CLIs exist, how they're spawned) is
  code-defined in adapters `BUILTIN` — the ONE definition shared by panel review AND every
  cross-vendor consumer (x-review/op/agent/eval/solver/build) via `xm panel cross`. `panel.*`
  config tunes panel-review behavior (models/judge/stream) only; the sole key the cross path
  also reads is `timeout_s`. There is no separate per-consumer provider config to maintain.

## Core Process — route first

`/xm:panel` is the cross-vendor **entry point**. Decide the route from the first token — don't
assume "review".

### 1. Verb → delegate to the domain consumer in `--cross-vendor` mode (invoke via the Skill tool)
Domain logic lives in the consumer; panel only routes — never reimplement a consumer's flow here:

| `/xm:panel …` | Skill | args |
|---|---|---|
| `review [target]` | `xm:review` | `diff [target] --cross-vendor` |
| `op debate\|council\|persona\|brainstorm\|red-team\|tournament\|hypothesis [args]` | `xm:op` | `<strategy> [args] --cross-vendor` — the 7 cross-vendor-wired strategies ONLY; any other x-op strategy isn't cross-vendor → use `xm:op` directly (no `--cross-vendor`) |
| `debate <topic>` | `xm:op` | `debate <topic> --cross-vendor` |
| `council <topic>` | `xm:op` | `council <topic> --cross-vendor` |
| `solve <problem>` | `xm:solver` | `<problem> --cross-vendor` |
| `eval <content>` | `xm:eval` | `score <content> --cross-vendor` |
| `plan <goal>` | `xm:op` | `brainstorm <goal> --cross-vendor` — vendors each draft a plan/approach → cluster → synthesize (divergent; the diversity IS the value) |
| `consensus [prd]` | `xm:build` | `consensus --cross-vendor` — multi-vendor critique of an EXISTING PRD only |
| `fan-out` / `broadcast` | `xm:agent` | `<…> --cross-vendor` |

`plan` is **divergent generation** — different vendors propose different plans, then synthesize. It
does NOT produce a formal PRD. **Loose handoff:** if the user then wants a real PRD+tasks, point them
to `x-build plan` (Research→PRD lifecycle) or `/xm:panel consensus` to critique an existing PRD — do
NOT auto-run x-build. For structure/breakdown instead of ideation, use `xm:op scaffold`/`decompose` (single-vendor — neither is cross-vendor-wired).

Each consumer probes `xm panel detect --auth` / `doctor` itself and falls back to single-vendor
loudly when <2 vendors are ready — don't duplicate that here.

### 2. Engine utility → run the CLI directly (no delegation)
`cross | detect | doctor | types | models | setup` → `xm panel <cmd> [args]` straight through
(see Programmatic API above for cross/detect/doctor/models).

### 3. Target or model flags → the native panel engine
`/xm:panel <file|diff|--models|--preset>` or `/xm:panel quick [target]` → N model CLIs review the
SAME target, one refute round, consensus verdict:
1. `xm panel setup` shows detected CLIs + config defaults (skip if `--models` was given). Models:
   config default / preset / `--full` / custom `name:model`. **cursor & kiro are multi-vendor** —
   `cursor:kimi-k2.5`, `kiro:deepseek-3.2` work; `xm panel models <vendor>` lists the live catalog,
   `--check <model>` validates an ID before use (doctor checks auth only, not model IDs).
2. Run `xm panel [target] --models <list>` (or `--preset <name>`).
3. Relay: **consensus (N/M) first**, then contested, then per-model diversity. Don't re-dump raw
   findings — consensus already merged duplicates. Name any model that failed (2/4 ≠ 4/4).

### 4. Bare `/xm:panel` → interactive picker (never pick a route silently)
ONE AskUserQuestion — "다중모델로 무슨 작업?": 코드 리뷰(→review) · 계획안 발산(→plan) ·
찬반토론(→debate) · 문제해결(→solve) · 평가(→eval) · PRD 비평(→consensus) · 빠른 패널(→engine).
AskUserQuestion caps at 4 options — offer the 4 most likely (review/plan/debate/solve) and let the
rest fall to "Other". Then follow that route. If the user already implied one (a file, a verb), skip the ask.

### `/xm:panel setup` → interactive config
Ask (ONE AskUserQuestion): **models**, per-model **overrides** (`name:model`, e.g. `cursor:kimi-k2.5`),
**judge** (rule), **scope** (`.xm` or `--global`), then `xm panel setup --models … [--global]`.
> `setup` saves **panel-engine** defaults (route 3). Cross-vendor consumers don't read `models`/
> `judge`/`stream` — they detect vendors and pass `--models` themselves (only `timeout_s` is shared).

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "I'll just hardcode `--models claude,codex`." | The user has a configured default/preset — respect it (or ask). Hardcoding ignores their setup. |
| "Interactive is slow, I'll pick the models myself." | Bare `/xm:panel` exists precisely to let the user choose. Decide for them only when they gave a target/flags. |
| "One model's review is enough, skip the panel." | The whole value is cross-model diversity + consensus; a single model misses what others catch (proven in dogfooding). |
| "I'll define a bash function for the long command." | Bash tool is stateless per call; the function vanishes → `command not found`. Use `xm panel` directly. |
| "The verdict has duplicate findings, I'll dedupe by hand." | `consensus[]` already merges same file+line across models with an N/M tag. Read consensus, not raw `confirmed`. |
| "Some models timed out, I'll just present what I have as complete." | Report failures (timeouts, missing CLIs) honestly. A 2/4 panel is not a 4/4 panel. |
| "It's installed, so it'll work." | Installed ≠ authenticated. `xm panel doctor` catches a logged-out CLI up front, instead of losing a round when it fails mid-panel. Run it (or `detect --auth`) before a cross-vendor run. |
| "It's a panel verb, I'll just do the lens review / debate here myself." | Route-1 verbs **delegate** to the consumer (x-review/x-op/…) via the Skill tool. Panel routes, it doesn't reimplement domain logic — inlining it duplicates and drifts from the source skill. |

## Red Flags

- You picked models without asking, on a bare `/xm:panel`.
- You pasted raw per-model findings instead of the merged consensus view.
- You hid a model failure (timeout / not-installed) to make the panel look complete.
- You defined a shell helper/alias and reused it across Bash calls.

## Verification

- For a verb route (review/plan/debate/solve/eval/consensus/fan-out), you delegated to the consumer
  skill in `--cross-vendor` mode — you did NOT inline its lens/debate/plan/solve logic in panel.
- For bare `/xm:panel`, you asked the user (what task + models/target) before running.
- You reported consensus (N/M) and diversity, and named any model that failed.
- For `setup`, you confirmed the saved config with `xm panel setup`.
- Before a cross-vendor run, you confirmed providers are authenticated (`xm panel doctor`), not just installed.
- The verdict file exists under `.xm/panel/<run>/verdict.json` (recall can show it later).
