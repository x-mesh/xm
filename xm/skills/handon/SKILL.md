---
name: handon
description: Session restore — resume from last handoff, inject context automatically
model: haiku
---

# x-handon — Session Restore (Resume)

Restore session context from the last handoff. **Context injection is automatic** — running this skill means "give me the previous session's context."

## Model Routing

This skill is **haiku** (Agent tool). Steps 1-3 are JSON read + structured display. No reasoning involved in restoration itself.

```
Agent tool: { model: "haiku", description: "x-handon", prompt: "Run: xm build handon --json" } <!-- managed-model: writer -->
```

The leader receives the JSON, formats the summary, and waits for user direction. **Step 4 (wait for user)** is the boundary — once the user asks for actual work based on the restored context, that work runs at its own appropriate model (typically sonnet).

**Guardrail**: never haiku if the user follows up with "what should I do next" or "analyze the prior session" — those are reasoning tasks, escalate to **sonnet**.

## When to Use
- Start of a new session
- After `/clear` or context compaction
- When resuming work after a break

## Execution (MANDATORY behavior)

**Step 1: Read session state as JSON**

> **⚠ Call `xm build handon` directly. Never use a repo-relative path like `node x-build/lib/x-build-cli.mjs` — that path only exists inside the x-kit repo itself and fails with `Cannot find module` in every other project. Claude Code's Bash tool starts a fresh shell on every invocation, so never define shell helper functions across calls either.**
>
> **Fallback** (only when `xm` is not in PATH):
> ```bash
> XMB_CLI=$(ls -d ~/.claude/plugins/cache/xm/{build,xm}/*/lib/x-build-cli.mjs 2>/dev/null | sort -V | tail -1)
> node "$XMB_CLI" handon --json
> ```

```bash
xm build handon --json
```

If the command prints `{"error":"no_session_state"}`, output:
> No previous session state found. Run `/xm:handoff` at the end of a session to save.

And stop.

If the command itself fails (`command not found`, `Cannot find module`, non-JSON output), that is an **invocation failure, not a missing handoff** — report the actual error to the user and try the fallback above. Never translate a broken invocation into "no previous session state": the state file may exist and be perfectly readable.

Then, best-effort, read the last recorded review verdict for the 🔍 Review line (omit that line if this returns nothing):

```bash
xm last review --json 2>/dev/null
```

**Step 2: Parse and absorb as context**

The JSON contains these sections that you MUST use as your working context:

| Field | How to use |
|-------|-----------|
| `where.branch` | You are on this git branch |
| `where.last_commits` | These are the most recent changes |
| `what_done` | This work was completed in the last session |
| `what_remains.active_projects` | These projects need attention |
| `what_remains.uncommitted` | These files have unsaved changes |
| `decisions` | These decisions are FINAL — do not re-discuss or question them |
| `context.current_focus` | This was the working direction |
| `context.test_status` | This is the test health |
| `context.quality_scores` | These are the quality benchmarks |
| `narrative.intent` | **Why the last session was started — load this as your interpretive frame before suggesting next steps** |
| `narrative.open_questions` | **Decisions still pending — surface these before starting new work; do not silently resolve them** |
| `narrative.rejected_alternatives` | **Approaches already ruled out — do NOT re-propose; reference if the user asks "why not X"** |
| `narrative.next_session_should_know` | **Non-obvious context the prior session captured for you — treat as binding facts** |
| `why_stopped` | This is why the last session ended |
| `since_handoff.new_commits` | This many changes happened since the handoff (by others or other sessions) |

**Step 3: Output summary to user**

After absorbing, show a human-readable summary:

```
📋 Session Restored

  📍 Branch: {branch} (+{ahead} ahead)
  ✅ Done: {what_done count} commits last session
  📌 Active: {active_projects count} projects
  🔒 Decisions: {decisions count} carried forward
  🎯 Focus: {current_focus}
  🧭 Intent: {narrative.intent}                     (omit line if empty)
  ❓ Open: {narrative.open_questions.length} question(s)   (omit if 0; list inline if ≤2)
  ✗ Ruled out: {narrative.rejected_alternatives.length}   (omit if 0)
  → Carryover: {narrative.next_session_should_know.length} note(s)  (omit if 0)
  💤 Last stopped: {why_stopped}
  🔍 Review: last {ref} ({N} commits ago, {verdict})           (omit line if no recorded review)

  Since handoff: {new_commits} new commits

Ready to continue. What would you like to work on?
```

**Rendering rules for narrative**:
- If `narrative` is missing or all fields empty, omit the entire 🧭/❓/✗/→ block.
- If `open_questions` has ≥3 items, render as a bulleted sublist instead of inline count, so the user actually sees them.
- Never silently drop `rejected_alternatives` or `next_session_should_know` — they exist precisely because the prior session decided you need to see them.

**Rendering rule for the 🔍 Review line**: its source is a separate `xm last review --json` read (NOT the handon JSON above). If that returns no record (empty / error), omit the 🔍 line entirely. `{ref}` = short sha of `.ref`, `{verdict}` = `.status` (`lgtm` / `request-changes` / `block`); `{N}` = `git rev-list --count <.ref>..HEAD` — if that fails, render `last {ref} ({verdict})` without the commits-ago count.

**Step 4: Wait for user direction**

Do NOT auto-start any work. Present the restored context and wait for the user to say what to do next.

## Key Rule: Decisions are Final

The `decisions` array contains choices already made and agreed upon. When the user asks about a topic covered by a decision, reference it — do not re-analyze or suggest alternatives unless explicitly asked to reconsider.

## Arguments

- `/xm:handon` — restore and show summary (default)
- `/xm:handon --json` — same behavior (JSON is always used internally; flag is for backward compat)
