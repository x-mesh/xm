---
name: panel
description: Cross-model adversarial review panel. Run multiple LLM CLIs (claude/codex/agy/cursor) on the same target, have them refute each other, and synthesize a consensus verdict. Use when the user asks to review/plan with several models at once, "panel review", "다른 모델들로 같이 리뷰", "여러 LLM으로 적대 리뷰", or /xm:panel. Interactive when invoked bare; passes through when models/target are given.
model: sonnet
---

# x-panel — Cross-Model Adversarial Review Panel

## Overview

Different models have different blind spots — in dogfooding, codex missed a perf
issue claude/agy caught, and cursor missed a SQL injection. `x-panel` runs N model
CLIs on the same target, runs one adversarial round (each refutes the others'
findings), and synthesizes a verdict that separates **consensus** (how many models
agreed — confidence) from **diversity** (what only one model saw). The orchestrator
is a tool-neutral CLI, so the "leader" is not a fixed model.

## When to Use

- "여러 모델로 같이 리뷰/검토해줘", "panel review", cross-model second opinion
- "적대적으로 교차검증", multi-model plan/design critique
- `/xm:panel` (interactive), `/xm:panel <file>`, `/xm:panel --preset <name>`

## Do NOT Use When

- A single-model review is explicitly requested → x-review.
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

## Core Process

Route by what the user gave you.

### A. `/xm:panel` with NO args → interactive launch
1. Show the current setup so the choice is informed:
   `xm panel setup` (prints detected CLIs on PATH + current config defaults).
2. Ask the user how to run it (AskUserQuestion, one turn):
   - **Models**: offer (a) config default, (b) a named preset from config, (c) `--full` (all installed), (d) custom `name` / `name:model` list.
   - **Target**: current `git diff HEAD` (default), a file path, or pasted text.
3. Run it: `xm panel [target] --models <list>` or `xm panel [target] --preset <name>`.
4. Relay the verdict in this order: **consensus issues (N/M) first**, then contested
   (a model refuted), then per-model diversity. Do not re-dump every raw finding —
   the consensus merge already collapsed duplicates.

### B. `/xm:panel setup` → interactive config
1. Show `xm panel setup` (detected + current models/judge).
2. Ask (AskUserQuestion): which **models**, any per-model **overrides** (`name:model`,
   e.g. `codex:gpt-5.2`), **judge** (rule for now), and **scope** (project `.xm` or `--global`).
3. Save: `xm panel setup --models a:m1,b,c --judge rule [--global]`.
   For presets/overrides not expressible via flags, edit `panel.presets` /
   `panel.model_overrides` in the chosen `config.json` and confirm with `xm panel setup`.

### C. `/xm:panel <target>` or explicit `--models`/`--preset` → run directly
Pass straight through: `xm panel <args>`. No questions — the user already specified.

### AskUserQuestion protocol
Ask all needed choices in ONE AskUserQuestion call (don't drip questions across turns).
If the user already implied a choice (a file path, a preset name, `--full`), skip that
question. Never silently pick models when the user invoked `/xm:panel` bare to choose.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "I'll just hardcode `--models claude,codex`." | The user has a configured default/preset — respect it (or ask). Hardcoding ignores their setup. |
| "Interactive is slow, I'll pick the models myself." | Bare `/xm:panel` exists precisely to let the user choose. Decide for them only when they gave a target/flags. |
| "One model's review is enough, skip the panel." | The whole value is cross-model diversity + consensus; a single model misses what others catch (proven in dogfooding). |
| "I'll define a bash function for the long command." | Bash tool is stateless per call; the function vanishes → `command not found`. Use `xm panel` directly. |
| "The verdict has duplicate findings, I'll dedupe by hand." | `consensus[]` already merges same file+line across models with an N/M tag. Read consensus, not raw `confirmed`. |
| "Some models timed out, I'll just present what I have as complete." | Report failures (timeouts, missing CLIs) honestly. A 2/4 panel is not a 4/4 panel. |

## Red Flags

- You picked models without asking, on a bare `/xm:panel`.
- You pasted raw per-model findings instead of the merged consensus view.
- You hid a model failure (timeout / not-installed) to make the panel look complete.
- You defined a shell helper/alias and reused it across Bash calls.

## Verification

- For bare `/xm:panel`, you asked the user (models + target) before running.
- You reported consensus (N/M) and diversity, and named any model that failed.
- For `setup`, you confirmed the saved config with `xm panel setup`.
- The verdict file exists under `.xm/panel/<run>/verdict.json` (recall can show it later).
