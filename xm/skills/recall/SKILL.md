---
name: recall
description: Cross-session artifact index. Find and read outputs from previous sessions — reviews, op strategy results, plans/PRDs, eval scores, probe verdicts — stored under .xm/. Use when the user asks to recall/find/look up a past review/op/plan, "what did the last review say", "show me the previous op result", "pull up the last plan", or wants a prior artifact handed to another tool/session (Codex, Cursor). Also exposes a tool-neutral handoff (HANDOFF.md).
model: haiku
---

# x-recall — Cross-Session Artifact Index

## Overview

Every xm tool already persists its output under `.xm/` (review → `.xm/review/`,
op → `.xm/op/`, plans → `.xm/build/projects/`, eval → `.xm/eval/`, probe →
`.xm/probe/`, …). What was missing is one entry point to **find and read** those
artifacts across sessions and tools. `x-recall` is that index.

Because the CLI reads `.xm/` directly, it is **tool-neutral**: a later Codex or
Cursor session in the same repo can run `xm recall …` in plain bash to pick up
what a Claude session produced. This skill is the Claude-side natural-language
front door to the same engine.

## When to Use

- "최근 리뷰 찾아줘 / what did the last review say" → `show review --last`
- "지난 op 결과 / show the previous council/debate result" → `list --type op` then `show <id>`
- "전에 만든 plan / pull up the last PRD" → `list --type plan` / `show plan:<name>`
- "이 repo에서 X 관련 산출물 찾아줘" → `search "X"`
- "최근 리뷰를 Codex가 다시 보게 / hand this to another tool" → `show review --last` (paste output, or tell them to run the same command)
- "이전 세션이 뭘 했는지 / regenerate a tool-neutral handoff" → `handoff-md`

## Do NOT Use When

- The user wants to RUN a new review/op/plan — that is x-review / x-op / x-build.
- The artifact is in the current conversation already — just answer.
- Cross-**machine** sync is needed — that is x-sync. recall reads local `.xm/` only.

## CLI Invocation

> **⚠ Call `xm recall <command>` directly. Claude Code's Bash tool starts a fresh shell on every invocation — shell functions (`xrec()`) defined in one call do NOT persist to the next, causing `command not found`. Never define a helper across calls; always use the dispatcher.**
>
> **Fallback** (only when `xm` is not in PATH — rare; `${CLAUDE_PLUGIN_ROOT}` is NOT exported to Bash subprocesses, so don't rely on it bare):
> ```bash
> XRECALL_CLI=$(ls -d ~/.claude/plugins/cache/xm/{x-recall,recall,xm}/*/lib/x-recall-cli.mjs 2>/dev/null | sort -V | tail -1)
> node "$XRECALL_CLI" <command> [args]
> ```
>
> **Forbidden:** `XREC="node ..."; $XREC list` — zsh treats the quoted string as a single command and fails.

## Core Process

1. **Map the intent to one command** (do not enumerate the whole tree by hand):

   | Command | Use |
   |---------|-----|
   | `xm recall list [--type T] [--project P] [--since 7d] [--limit N] [--json]` | Browse artifacts, newest first |
   | `xm recall show <id\|type> [--last] [--json]` | Print one artifact's content |
   | `xm recall search "<query>" [--type T] [--json]` | Full-text + metadata search |
   | `xm recall handoff-md` | (Re)write tool-neutral `.xm/build/HANDOFF.md` |
   | `xm recall types` | List artifact types |

   Types: `review op plan eval probe humble solver research prd handoff`.

2. **Run it, then present, don't dump.** For `list`/`search`, summarize the top
   hits and offer to `show` a specific one. For `show`, the output IS the
   artifact — relay the verdict/summary, not a re-derivation.

3. **For "hand to another tool" requests**, give the exact command the other
   session should run (`xm recall show <id>`) AND the resolved content, so the
   handoff works whether or not that tool has the skill.

4. **Use `--json`** when you need to act on fields programmatically (e.g. filter
   findings by severity); use the default human table when reporting to the user.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "I'll just `cat .xm/review/last-result.md` myself." | That misses host-variant dedup and won't resolve `--last`/ids consistently. The CLI is the contract other tools share — use it so behavior matches across Claude/Codex/Cursor. |
| "I'll `ls .xm/op/` and read the newest by eye." | Multi-device sync writes 3–5 host variants per artifact; eyeballing shows duplicates and may pick a stale device copy. `recall` collapses them to the canonical entry. |
| "The user said 'find the review', I'll re-run x-review." | Re-running burns tokens and changes the artifact. They asked to RECALL an existing one — read it, don't regenerate. |
| "I'll define a bash function to shorten the command." | Bash tool is stateless per call; the function is gone next call → `command not found`. Always call `xm recall` directly. |
| "JSON is more thorough, I'll always use --json." | The human table is the right default for reporting. Reserve `--json` for when you actually parse fields. |
| "There's no artifact, I'll say recall is broken." | Empty `.xm/` is a valid state — report "no artifacts yet", don't invent failure. |

## Red Flags

- You started reading `.xm/**` files directly instead of calling `xm recall`.
- You re-ran an x-op/x-review/x-build pipeline when the user only wanted a past result.
- You pasted a raw artifact id with no human summary of what it says.
- You defined a shell helper/alias and reused it across Bash calls.

## Verification

- The command you ran matches the user's intent (recall, not re-run).
- For `show`, you reported the artifact's verdict/summary, not a paraphrase of the request.
- For cross-tool handoff, you provided both the command and the content.
- If nothing matched, you said so plainly and suggested `xm recall list` to browse.
