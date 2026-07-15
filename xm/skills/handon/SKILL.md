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

## mem-mesh Backend (capability gate)

Check ONCE at skill start whether `mcp__mem-mesh__*` tools are in your available toolset.

- **Present** → **dual-write mode**: restore from `.xm/build/SESSION-STATE.json` as below AND enrich the summary with recent mem-mesh context (Step 3.5 below).
- **Absent** → **file-only mode**: run exactly as documented, make ZERO mem-mesh calls, never mention mem-mesh.

SESSION-STATE.json is the **primary** restore source; mem-mesh only augments. If a mem-mesh call errors, log it and render the file-based summary anyway. The **leader** makes the mem-mesh call (the haiku reader may lack the MCP tools).

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
| `session_log_summary` | **A count of tier-2 detail (rejected/open_forks/constraints_prefs/attempts). The full archive is deliberately NOT in this JSON — do not treat its absence as "no detail." Announce it (Step 3) and load on demand (below).** |
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
  📚 Detailed log: {session_log_summary total} item(s) — say "자세히" to load   (omit line if no summary or total 0)
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

**Load the detailed log on demand (tier 2)**

The 📚 line is a pointer, not the content. When the user asks for the detail ("자세히", "detailed log", "what did we rule out", "why did we try X"), load it then — never up front:

```bash
xm build handon --log
```

This prints the tier-2 archive (rejected reasoning / open forks / constraints & preferences / attempts). In dual-write mode you may instead pull it from mem-mesh (`search` for the last handoff digest, project = basename of cwd) — same content, richer if the log was mirrored thick. Keeping it out of the default restore is the whole point of the 2-tier split: the restore stays high-signal, the detail is one command away.

**Step 3.5: Enrich from mem-mesh (dual-write mode only)**

Only in dual-write mode (gate above). The leader calls `mcp__mem-mesh__search` with an empty `query`, `project_id` = basename of cwd, and a high `recency_weight` (e.g. 0.8) to pull recent items / the last handoff archive, then appends one line to the summary. (Do NOT use `mcp__mem-mesh__context` here — it requires a `memory_id`/`ids` and cannot list a project's recent memories.)

```
  🧠 mem-mesh: {N} recent pins/items ({M} open)     (omit line if nothing returned)
```

Dedupe against `narrative.open_questions` already shown — do not repeat the same item. On error, omit the line silently. SESSION-STATE.json remains primary; mem-mesh is additive.

**Step 4: Wait for user direction**

Do NOT auto-start any work. Present the restored context and wait for the user to say what to do next.

## Key Rule: Decisions are Final

The `decisions` array contains choices already made and agreed upon. When the user asks about a topic covered by a decision, reference it — do not re-analyze or suggest alternatives unless explicitly asked to reconsider.

## Arguments

- `/xm:handon` — restore and show summary (default)
- `/xm:handon --json` — same behavior (JSON is always used internally; flag is for backward compat). Tier-2 `session_log` is withheld here as a `session_log_summary` count.
- `xm build handon --log` — print the tier-2 detailed archive on demand (rejected reasoning, open forks, constraints & preferences, attempts)
