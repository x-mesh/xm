---
name: handoff
description: Session handoff — save comprehensive session state for cross-session continuity
model: haiku
---

# x-handoff — Session Handoff (Save)

Save comprehensive session state so the next session can pick up where you left off — including the **conversation narrative** that disk artifacts (git, decisions.json, traces) cannot capture.

## Model Routing

This skill is **hybrid**:

| Step | Model | Role | Why |
|------|-------|------|-----|
| 1. Compose narrative | **leader** (current model, typically sonnet) | narrator | Only the leader has the conversation history needed to summarize intent / open questions / rejected alternatives |
| 2. Save state to disk | **haiku** (Agent tool) | writer | Mechanical JSON write — no reasoning |

```
Agent tool: { model: "haiku", description: "x-handoff", prompt: "Run: xm build handoff --full --narrative-json '<JSON>' \"$ARGUMENTS\"" } <!-- managed-model: writer -->
```

**Guardrail**: never skip Step 1 to save tokens. Without the narrative, `/xm:handon` shows only "what was done," not "why we were doing it" — the next session has to re-derive the working direction from scratch.

## When to Use
- End of a work session
- Before `/clear` or context compaction
- When switching to a different project/branch

## Step 1 — Compose the Narrative (leader, MANDATORY)

Before dispatching to haiku, write a `narrative` object based on **this conversation**. Four fields, all required (use empty array `[]` or empty string `""` only when genuinely nothing applies):

| Field | Type | Content |
|-------|------|---------|
| `intent` | string | One sentence: *why* the user started this session. What problem are they solving / what outcome do they want? |
| `open_questions` | string[] | Decisions the user has not yet made, ambiguities you flagged but did not resolve, follow-ups the user said "later" to. |
| `rejected_alternatives` | string[] | Approaches the user considered and ruled out, with the reason. Format: `"alternative — why rejected"`. Prevents the next session from re-proposing them. |
| `next_session_should_know` | string[] | Non-obvious context the next session needs but won't see in git/decisions: user preferences revealed mid-session, constraints discovered during work, surprising findings. |

**What NOT to put here:**
- Things already in git commits → those go in `what_done` automatically
- Things already in `decisions.json` → those go in `decisions` automatically
- Step-by-step recap of what you did → the diff says that

**Sizing**: narrative should be ~5–15 short lines total. If it grows past 30 lines, you're recapping, not summarizing.

## Step 2 — Dispatch the Save

Build the CLI command:

> **⚠ Call `xm build handoff` directly. Never use a repo-relative path like `node x-build/lib/x-build-cli.mjs` — that path only exists inside the x-kit repo itself and fails with `Cannot find module` in every other project.**
>
> **Fallback** (only when `xm` is not in PATH):
> ```bash
> XMB_CLI=$(ls -d ~/.claude/plugins/cache/xm/{build,xm}/*/lib/x-build-cli.mjs 2>/dev/null | sort -V | tail -1)
> node "$XMB_CLI" handoff --full --narrative-json '<JSON>' "$ARGUMENTS"
> ```

```bash
xm build handoff --full \
  --narrative-json '{"intent":"...","open_questions":[...],"rejected_alternatives":[...],"next_session_should_know":[...]}' \
  "$ARGUMENTS"
```

`$ARGUMENTS` is used as the `why_stopped` reason. If empty, auto-generates from the last commit message.

**JSON escaping**: pass the narrative as a single-quoted shell argument so double-quoted JSON strings inside don't conflict with the shell. Escape any literal single quotes inside string values as `'\''`.

## What it Collects (automatic)

| Source | Data | Method |
|--------|------|--------|
| git | branch, last 5 commits, uncommitted files, ahead/behind | `git log`, `git status` |
| x-build | active projects, phase, tasks, pending work | `.xm/build/projects/*/manifest.json` |
| decisions | from all active projects (last 10) | `decisions.json` / `decisions.md` |
| traces | last 5 skill executions | `.xm/traces/*.jsonl` |
| eval | quality scores | `.xm/eval/results/` |
| tests | pass/fail status | `bun test` (cached) |
| key files | most changed files | `git diff --stat` |
| **narrative** | **leader-composed (Step 1)** | **`--narrative-json` flag** |

## Output

Saves to `.xm/build/SESSION-STATE.json`:

```json
{
  "v": 1,
  "saved_at": "2026-04-11T...",
  "where": { "branch": "develop", "last_commits": [...], "uncommitted_files": [...] },
  "what_done": ["commit1", "commit2"],
  "what_remains": { "active_projects": [...], "uncommitted": [...], "ideas": [] },
  "decisions": [{ "what": "...", "why": "..." }],
  "context": { "current_focus": "...", "test_status": "...", "quality_scores": {} },
  "narrative": {
    "intent": "User wanted to add conversation-level context to /xm:handoff because git artifacts alone lose the 'why'.",
    "open_questions": ["Whether narrative.intent should be auto-summarized from the last 20 turns if leader leaves it empty"],
    "rejected_alternatives": ["MEMORY auto-indexing — too broad for handoff scope"],
    "next_session_should_know": ["Leader must run at sonnet+ for narrative quality; haiku-only handoff is now disallowed"]
  },
  "why_stopped": "reason"
}
```

## Usage

```
/xm:handoff                           # leader composes narrative, auto-generated reason
/xm:handoff "dashboard 개선 완료"      # leader composes narrative + explicit reason
```

## Execution Checklist

1. **Read this conversation** — identify intent, open questions, rejected alternatives, what the next session must know.
2. **Compose `narrative` JSON** with the four fields. Empty arrays/strings are valid when genuinely nothing applies.
3. **Dispatch via Bash** (or haiku Agent) with `--narrative-json '...'`.
4. **Confirm**:
   ```
   ✅ Session state saved. Narrative captured: intent ✓, N open Q, N rejected alt.
      Next session: run /xm:handon to restore.
   ```

## Common Rationalizations (do not skip Step 1)

| Excuse | Reality |
|--------|---------|
| "Git history covers it" | Git shows *what changed*, not *why we chose this direction*. Next session will re-propose ideas you already ruled out. |
| "There were no open questions" | Then write `"open_questions": []` — but verify by scanning the conversation. Most sessions have at least one "let's defer that" moment. |
| "The user can just re-read the chat" | They cannot. `/clear` and `/compact` discard it. Handoff is the only durable cross-session record. |
| "Narrative is subjective" | That's the point. Decisions/commits are objective; narrative is the interpretive layer that makes them legible. |
| "Skipping saves haiku tokens" | Leader composes narrative at no extra agent dispatch — only one haiku Agent call regardless. There is no token saving. |
