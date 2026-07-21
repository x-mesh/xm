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

복원 원본은 **가장 최신의 검증된 handoff**입니다. 로컬 `SESSION-STATE.json`은
mem-mesh에 더 새 `handoff` + `session-state` 레코드가 없을 때 primary입니다. 더
새 원격 레코드가 있으면 그 본문을 primary context로 사용하고, 오래된 로컬 파일은
보조 자료로만 씁니다. 원격 조회가 실패했을 때만 파일 기반으로 계속합니다.

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

If the command prints `{"error":"no_session_state"}`, 로컬 상태가 없다고만 기록하고
멈추지 않습니다. Step 3.5에서 mem-mesh handoff를 조회합니다. 원격에도 없을 때만:
> No previous session state found. Run `/xm:handoff` at the end of a session to save.

를 출력하고 멈춥니다.

If the command itself fails (`command not found`, `Cannot find module`, non-JSON output), that is an **invocation failure, not a missing handoff** — report the actual error to the user and try the fallback above. Never translate a broken invocation into "no previous session state": the state file may exist and be perfectly readable.

Then, best-effort, read the last recorded review verdict for the 🔍 Review line (omit that line if this returns nothing):

```bash
xm last review --json 2>/dev/null
```

**Step 2: Parse the local candidate**

The JSON contains these sections that you MUST use as your working context:

| Field | How to use |
|-------|-----------|
| `where.branch` | 이 파일이 선택됐을 때의 git branch |
| `where.last_commits` | These are the most recent changes |
| `what_done` | This work was completed in the last session |
| `what_remains.active_projects` | These projects need attention |
| `what_remains.uncommitted` | These files have unsaved changes |
| `decisions` | These decisions are FINAL — do not re-discuss or question them |
| `context.current_focus` | This was the working direction |
| `context.test_status` | This is the test health |
| `context.quality_scores` | These are the quality benchmarks |
| `narrative.intent` | **이 파일이 선택됐을 때의 세션 의도** |
| `narrative.open_questions` | **Decisions still pending — surface these before starting new work; do not silently resolve them** |
| `narrative.rejected_alternatives` | **Approaches already ruled out — do NOT re-propose; reference if the user asks "why not X"** |
| `narrative.next_session_should_know` | **Non-obvious context the prior session captured for you — treat as binding facts** |
| `narrative.memory_refs` | handoff가 명시적으로 고른 중요한 mem-mesh memory id와 이유. 최대 5개만 exact-id로 다시 조회한다. |
| `session_log_summary` | **A count of tier-2 detail (rejected/open_forks/constraints_prefs/attempts). The full archive is deliberately NOT in this JSON — do not treat its absence as "no detail." Announce it (Step 3) and load on demand (below).** |
| `why_stopped` | This is why the last session ended |
| `since_handoff.new_commits` | This many changes happened since the handoff (by others or other sessions) |
| `memmesh_mirror.status` | Did the last handoff reach mem-mesh? `mirrored` / `pending` (it did not — surface this, even when `from_earlier_handoff` is true) / `skipped` (user dismissed it) / `stale` (an already-mirrored record from an older handoff) / `unreadable` (mirror file is corrupt — report it, offer no repair, never overwrite it) / `none` |

**Step 3: Select the newest handoff, then output the summary**

먼저 Step 3.5의 원격 후보와 로컬 후보를 고릅니다. `created_at`/`saved_at`이 모두
유효하면 더 늦은 시각을 선택합니다. 같은 시각 또는 원격 시각이 없으면 로컬을
선택합니다. 원격 선택 시 memory의 `content`를 **그대로 읽어 작업 context로
흡수**합니다. 요약의 첫 줄에 아래 중 하나를 반드시 표시합니다.

```
  📦 Source: local SESSION-STATE.json
  📦 Source: mem-mesh handoff (newer than local by {duration})
  📦 Source: mem-mesh handoff (no local state)
```

원격 레코드는 handoff의 portable JSON 전체가 아닐 수 있으므로, 그것을 보고
`SESSION-STATE.json`을 추측해 덮어쓰지 않습니다. 다음 정상 `/xm:handoff`가 현재
세션을 로컬·mem-mesh에 함께 저장해 두 원본을 다시 맞춥니다.

선택한 후보를 흡수한 뒤 다음 형식으로 요약합니다. 원격이 선택된 경우 로컬에서만
나오는 필드는 생략하고 원격 본문에 있는 사실만 말합니다.

```
Session Restore
State: {branch} (+{ahead}/-{behind}) | saved {age} | +{new_commits} commits | {uncommitted} uncommitted files
Focus: {current_focus}

Carry forward:
  - {active project + next pending task}
  - {next_session_should_know item}

Decisions ({count}):
  - {up to 3 relevant decisions}

Attention:
  - mem-mesh mirror pending/unreadable, or handoff far behind HEAD

Details: {session_log_summary total} archived items — run `xm build handon --log`
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

This prints the tier-2 archive (rejected reasoning / open forks / constraints & preferences / attempts). In dual-write mode you may instead pull it from mem-mesh (`search` for the last handoff digest, using the repo-root `project_id` — see Step 3.5) — same content, richer if the log was mirrored thick. Keeping it out of the default restore is the whole point of the 2-tier split: the restore stays high-signal, the detail is one command away.

**Step 3.5: Find the mem-mesh handoff candidate (dual-write mode only)**

Only in dual-write mode (gate above), call `mcp__mem-mesh__search` with an empty
`query`, the **repo-root** `project_id`, a high `recency_weight` (e.g. `0.8`), and
`limit: 10`. Do NOT request a limit above 10. Filter the returned results locally:
keep only the same `project_id` whose `tags` contain **both** `handoff` and
`session-state`; then choose the greatest valid `created_at`. Do NOT treat a random
recent memory or a pin as a handoff candidate. (Do NOT use `mcp__mem-mesh__context`
here — it requires a `memory_id`/`ids` and cannot list a project's recent memories.)

> **`project_id` = basename of the REPO ROOT, not of cwd.** `handoff` writes mirrors under the repo-root name so the id stays stable no matter which subdirectory the CLI ran from; searching by cwd basename from a subdirectory silently returns nothing. When a mirror exists, `xm build handoff --mirror-status` reports the exact `payload.project_id` — prefer that over deriving it yourself.

```
  Mem-mesh handoff: {memory id} at {created_at}
```

Dedupe against `narrative.open_questions` already shown — do not repeat the same item. The
newest verified handoff is primary; mem-mesh is additive only when its candidate is not newer.

로컬 handoff를 선택했다면 `narrative.memory_refs`를, 원격 handoff를 선택했다면
본문의 `## Referenced mem-mesh memories` 항목을 읽습니다. 각 id를
`search(query=<id>, project_id=<현재 repo root id>, limit=10)`으로 조회하고 **결과
id가 정확히 같은 것만** 읽습니다. 한 ref의 조회 실패는 해당 ref만 `unavailable`로
표시하고 복원을 막지 않습니다. 제목·일반어 검색으로 대체하지 않습니다.

**Distinguish "nothing there" from "it broke":**

| Outcome | Line |
|---|---|
| matching handoff returned | select it against the local timestamp, then print the source line and `Mem-mesh handoff: …` |
| no matching handoff and local exists | select local; omit the mem-mesh line |
| no matching handoff and no local exists | print the no-session-state message and stop |
| search **failed** and local exists | `Mem-mesh lookup failed (<error>) — file-based restore only` |
| search **failed** and no local exists | report the lookup failure and that no restorable state is available |

A failed search rendered as silence is indistinguishable from an empty project, so the user never learns their mem-mesh is down. Never let the existence of an older local file hide a newer verified remote handoff.

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
| "The file restore worked, so handon is done" | 파일이 있어도 최신이라는 뜻은 아니다. 같은 project의 최신 `handoff` + `session-state` memory와 시간을 비교해야 한다. |
| "`pending` mirror is the last session's problem" | It is this session's only chance to fix it. The payload is on disk now; after the next handoff overwrites it, that context is gone for good. |
| "Restoring is mechanical, haiku is enough" | The MCP calls in Steps 3.5-3.6 may not exist in a sub-agent. Mechanical ≠ delegable when tool availability differs. |
| "Just re-run the search instead of reading the mirror file" | `search` returns what mem-mesh already has. A pending mirror is precisely what it does NOT have — only the file holds it. |

## Red Flags

- Deciding the mem-mesh gate from what you *see* rather than by attempting the call.
- 일반 최근 memory를 handoff로 고르거나, `handoff` + `session-state` tag 두 개를 확인하지 않고 원격 본문을 복원에 쓰는 것.
- 원격 handoff가 더 새로운데도 로컬 `SESSION-STATE.json`을 primary로 표시하는 것.
- Seeing `memmesh_mirror.status == "pending"` and moving on without mentioning it.
- Running `--mirror-done` for a `stale` mirror, or without a successful `add` first.
- Starting work before Step 4 (the user has not given direction yet).

## Verification

Before handing control back to the user:

1. 요약이 선택된 최신 원본을 반영하며, 원격이 더 새면 `📦 Source: mem-mesh handoff`가 표시된다.
2. In dual-write mode, either a filtered handoff candidate was compared or search genuinely returned no matching handoff.
3. If `memmesh_mirror.status` was `pending`, you surfaced it — and if the user accepted the repair, `xm build handoff --mirror-status` now reports `mirrored`.
4. No work has started. Step 4 means wait.
