---
name: handon
description: Session restore — resume from last handoff, inject context automatically
model: sonnet
---

# x-handon — Session Restore (Resume)

Restore session context from the last handoff. **Context injection is automatic** — running this skill means "give me the previous session's context."

## Model Routing

This skill runs **entirely on the leader** (sonnet). The JSON read itself is mechanical, but Step 3.5 is an MCP call and MCP tools are frequently unavailable inside a dispatched Agent — routing this to haiku silently degrades the restore to file-only. Run the CLI with Bash from the leader; do not delegate.

**Step 4 (wait for user)** is the boundary — once the user asks for actual work based on the restored context, that work runs at its own appropriate model.

## mem-mesh Backend (capability gate)

**Do NOT decide by inspecting your toolset.** MCP tools are often *deferred* — listed by name with no loaded schema — so "is `mcp__mem-mesh__search` in my tools?" reads as "no" even when mem-mesh is fully available. That misread silently disabled the mem-mesh half of this skill.

Decide by **attempting**, in this order:

1. If `mcp__mem-mesh__search` is directly callable → dual-write mode.
2. If it is listed as a deferred tool → load it first (`ToolSearch` with `select:mcp__mem-mesh__search`), then dual-write mode.
3. Only if the tool does not exist at all, or the call fails after loading → **file-only mode**: make ZERO further mem-mesh calls and never mention mem-mesh in the output.

SESSION-STATE.json is the **primary** restore source; mem-mesh only augments. If a mem-mesh call errors, omit the enrichment line and render the file-based summary anyway.

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
| `memmesh_mirror.status` | Did the last handoff reach mem-mesh? `mirrored` / `pending` (it did not — surface this, even when `from_earlier_handoff` is true) / `skipped` (user dismissed it) / `stale` (an already-mirrored record from an older handoff) / `unreadable` (mirror file is corrupt — report it, offer no repair, never overwrite it) / `none` |

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
  ⚠️ mem-mesh: 지난 handoff가 mem-mesh에 미러되지 않음 (pending)   (ONLY when memmesh_mirror.status == "pending")
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

Only in dual-write mode (gate above). Call `mcp__mem-mesh__search` with an empty `query`, `project_id` = basename of cwd, and a high `recency_weight` (e.g. 0.8) to pull recent items / the last handoff archive, then append one line to the summary. (Do NOT use `mcp__mem-mesh__context` here — it requires a `memory_id`/`ids` and cannot list a project's recent memories.)

```
  🧠 mem-mesh: {N} recent pins/items ({M} open)     (omit line if nothing returned)
```

Dedupe against `narrative.open_questions` already shown — do not repeat the same item. SESSION-STATE.json remains primary; mem-mesh is additive.

**Distinguish "nothing there" from "it broke":**

| Outcome | Line |
|---|---|
| search returned items | `🧠 mem-mesh: {N} recent pins/items ({M} open)` |
| search returned nothing | *(omit the line — an empty project is not an error)* |
| search **failed** | `🧠 mem-mesh: 조회 실패 (<error>) — 파일 기반 복원만 표시` |

A failed search rendered as silence is indistinguishable from an empty project, so the user never learns their mem-mesh is down. Report it and continue with the file-based summary.

**Step 3.6: Offer to repair a pending mirror (dual-write mode only)**

When `memmesh_mirror.status == "pending"`, the previous session wrote the payload but never completed the `add`. The payload is still on disk and still valid — offer to finish it, do not silently ignore it:

1. Read `.xm/build/memmesh-mirror.json`.
2. Pass its `.payload` **verbatim** to `mcp__mem-mesh__add`.
3. Run `xm build handoff --mirror-done <memory_id>`.

Do this only if the user agrees (one line: "지난 handoff가 mem-mesh에 안 올라갔는데 지금 올릴까?").

- `from_earlier_handoff: true` means the payload predates the current SESSION-STATE — it is still the only copy of that session, so still offer it, but say the content is from the earlier handoff.
- Never repair a `stale` mirror — that record was already mirrored; there is nothing outstanding.
- If the user does not use mem-mesh at all, offer `xm build handoff --mirror-skip` so the warning stops instead of recurring on every restore.

**Step 4: Wait for user direction**

Do NOT auto-start any work. Present the restored context and wait for the user to say what to do next.

## Key Rule: Decisions are Final

The `decisions` array contains choices already made and agreed upon. When the user asks about a topic covered by a decision, reference it — do not re-analyze or suggest alternatives unless explicitly asked to reconsider.

## Arguments

- `/xm:handon` — restore and show summary (default)
- `/xm:handon --json` — same behavior (JSON is always used internally; flag is for backward compat). Tier-2 `session_log` is withheld here as a `session_log_summary` count.
- `xm build handon --log` — print the tier-2 detailed archive on demand (rejected reasoning, open forks, constraints & preferences, attempts)

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "I don't see `mcp__mem-mesh__search` in my tools" | Deferred tools are listed by name with no schema loaded. Load it with `ToolSearch` and try. Not-seen ≠ not-available — this misread is why the mem-mesh half never ran. |
| "The file restore worked, so handon is done" | In dual-write mode the restore is file + mem-mesh. A file-only restore silently drops everything mem-mesh accumulated between handoffs. |
| "`pending` mirror is the last session's problem" | It is this session's only chance to fix it. The payload is on disk now; after the next handoff overwrites it, that context is gone for good. |
| "Restoring is mechanical, haiku is enough" | The MCP calls in Steps 3.5-3.6 may not exist in a sub-agent. Mechanical ≠ delegable when tool availability differs. |
| "Just re-run the search instead of reading the mirror file" | `search` returns what mem-mesh already has. A pending mirror is precisely what it does NOT have — only the file holds it. |

## Red Flags

- Deciding the mem-mesh gate from what you *see* rather than by attempting the call.
- Rendering the summary with no 🧠 line while in dual-write mode and search returned results.
- Seeing `memmesh_mirror.status == "pending"` and moving on without mentioning it.
- Running `--mirror-done` for a `stale` mirror, or without a successful `add` first.
- Starting work before Step 4 (the user has not given direction yet).

## Verification

Before handing control back to the user:

1. The summary reflects `SESSION-STATE.json` — branch, decisions, and narrative all rendered.
2. In dual-write mode, either the 🧠 enrichment line is present or search genuinely returned nothing.
3. If `memmesh_mirror.status` was `pending`, you surfaced it — and if the user accepted the repair, `xm build handoff --mirror-status` now reports `mirrored`.
4. No work has started. Step 4 means wait.
