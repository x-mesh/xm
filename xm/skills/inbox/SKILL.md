---
name: inbox
description: Receiving side of /xm:toss — list, take, or drop cross-project bug reports that landed in this project's .xm/inbox/. Use when the user asks to check the inbox, "받은 편지함 봐줘", "what did other projects toss at us", or wants to start/dismiss a specific handed-off item.
model: haiku
---

# x-inbox — Cross-Project Inbox

## Overview

The receiving side of `/xm:toss`: `.xm/inbox/<id>.json` holds bug reports other
registered projects tossed at this one. `/xm:inbox` lists them, marks one as being
worked on (`take`), or dismisses one that isn't relevant (`drop`). Every read
opportunistically archives resolved items older than 30 days locally (no network) —
neither this nor anything else in this CLI ever discards an unresolved item.

**The CLI itself makes zero network calls.** It cannot query mem-mesh pin state and
cannot recreate an expired pin — that requires an MCP session, which only you (the
skill, running inside Claude Code) have. Re-notifying an item whose pin already expired
is therefore something YOU do, using `mcp__mem-mesh__pin_get` / `mcp__mem-mesh__pin_add`
plus `xm inbox record --scope inbox` — see step 5 below.

## When to Use

- "받은 편지함 봐줘" / "what's in the inbox" / "show what other projects tossed at us"
- Starting work and want to check for cross-project reports before diving in
- "이거 처리할게" / "I'll work on this one" → `take <id>` (marks in-progress, returns
  the full repro/fix body to act on)
- "이건 아니다" / "not relevant, drop it" → `drop <id>`

## Do NOT Use When

- You want to SEND a report to another project — that is `/xm:toss`.
- You want to turn a taken item into a tracked x-build task — `take` only returns the
  item's content; promoting it into a task/later item is a separate manual step
  (x-build tasks have no field that holds why/repro/fix_direction verbatim).

## CLI Invocation

> **⚠ Call `xm inbox <command>` directly. Claude Code's Bash tool starts a fresh shell on every invocation — shell functions (`xinbox()`) defined in one call do NOT persist to the next, causing `command not found: xinbox`. Never define a helper across calls; always use the dispatcher.**
>
> **Fallback** (only when `xm` is not in PATH — rare; `${CLAUDE_PLUGIN_ROOT}` is NOT exported to Bash subprocesses, so don't rely on it bare):
> ```bash
> XINBOX_CLI=$(ls -d ~/.claude/plugins/cache/xm/xm/*/lib/x-inbox-cli.mjs 2>/dev/null | sort -V | tail -1)
> node "$XINBOX_CLI" <command> [args]
> ```
>
> **Forbidden:** `XINBOX="node ..."; $XINBOX list` — zsh treats the quoted string as a single command and fails.

## Core Process

1. **먼저 mem-mesh에서 수신 항목을 materialize합니다.** MCP의 memory 검색에서
   `project_id=<현재 프로젝트의 mem-mesh id>`, `tags=["inbox"]`로 조회합니다. 각
   결과의 `content`는 toss가 보낸 JSON 본문이므로, 각 결과마다 아래 명령을 실행합니다.
   ```bash
   xm inbox materialize --content '<memory content JSON>' --memory-id <memory id> --json
   ```
   pin id가 검색 결과에 있으면 `--pin-id <pin id>`도 전달합니다. 이 CLI는 네트워크를
   호출하지 않고 **현재 cwd의** `.xm/inbox/<id>.json`에만 기록합니다. malformed JSON이나
   `to_project`가 현재 프로젝트와 다른 항목은 거부하고, 이미 같은 id가 있으면 로컬 상태를
   바꾸지 않습니다. MCP 검색을 할 수 없으면 그 사실을 밝히고 기존 로컬 원장만 조회합니다.
2. **`xm inbox list`** — materialize 뒤에 실행합니다. Prints unresolved items first, then
   actioned, then dismissed; add `--json` when you need to act on fields programmatically.
3. **Address items by `id` only**, never by a remembered list position — re-run `list`
   if unsure, since the sort order and the opportunistic archive sweep can shift between
   calls.
4. **`xm inbox take <id>`** when starting work on one: relay the full returned body
   (why / repro command+output / fix direction) to the user, or use it directly as the
   starting point for a fix — don't re-derive it from scratch.
5. **`xm inbox drop <id>`** when it doesn't need action. If it's ambiguous whether an
   item is relevant, confirm with the user before dropping — treat the drop as final in
   conversation even though dismissed items remain recoverable in the archive on disk.
6. **Re-notify a dead pin yourself, when relevant.** For any `delivered`/`actioned` item
   whose `mem_mesh.pin_id` is set (visible via `xm inbox list --json`):
   - Call `mcp__mem-mesh__pin_get(pin_id)` yourself.
   - If it comes back not-found, OR `status: "completed"` (mem-mesh's 7-day auto-close —
     never a real user action on a delivery pin), the pin is dead: call
     `mcp__mem-mesh__pin_add(content=item.title, project_id=<this project's mem-mesh id>,
     tags=["inbox"])` to recreate it, then persist the new id:
     ```bash
     xm inbox record <id> --pin-id <new pin id> --scope inbox --json
     ```
   - If the pin is still `in_progress`, or the item is `dismissed`, do nothing — this
     matches `ledger.mjs`'s `reconcile()` rules exactly (dead pin + unresolved item →
     renotify; anything else → no action).
   - **If you have no MCP tools available at all** (plain shell, no Claude Code MCP
     session), skip this step entirely and say so — don't guess at pin state or claim
     re-notification happened.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "I'll remember item #2 from the last list and take() it later." | Lists are re-sorted (unresolved-first) and re-swept (archive) on every call — position 2 can point at a different item next time. Always address by `id`. |
| "Inbox is empty, something's broken." | An empty inbox is a normal, valid state — say so; don't assume the CLI or mem-mesh is malfunctioning. |
| "list didn't print anything about pins, so they must all still be fine." | `list` never checks pin state (t11 — no network in the CLI). Silence from `list` says nothing about pin health; you have to actually call `pin_get` yourself to know. |
| "take() gave me the item, I'll now `later promote` it to keep the body." | `later promote` has no field for why/repro/fix_direction — the body does not survive that trip. Use the returned item content directly instead. |
| "I'll drop an item I'm not sure about, just to clean up the list." | Drop is for items that genuinely don't need action. When unsure, leave it `delivered` (or `take` it) and ask the user rather than guessing it away. |
| "No MCP tools here, I'll just tell the user the inbox looks fine." | The listed items are accurate (local files), but you silently skipped pin re-notification. Say explicitly that you couldn't check/renew pin state — don't imply you did. |
| "I recreated the pin via pin_add but that's the whole job, no need to persist it." | Without `xm inbox record --scope inbox`, the new pin id only lives in your chat output — the next session's ledger still points at the dead pin id and would recreate ANOTHER one. Always record it. |
| "The item is old, I'll delete the file myself." | Only the CLI's own opportunistic `archiveExpired()` sweep (run before every read) may relocate terminal items, and only after 30 days. Manual deletion bypasses the recoverable archive path entirely. |

## Red Flags

- You referenced an inbox item by list position instead of `id`.
- You dropped an item without the user's confirmation when its relevance was unclear.
- You claimed pin re-notification happened without actually calling `pin_get`/`pin_add`.
- You called `pin_add` to renotify but never ran `xm inbox record --scope inbox` afterward.
- You had no MCP tools available and didn't tell the user re-notification was skipped.
- You edited or deleted a `.xm/inbox/*.json` file directly instead of going through `take`/`drop`/`record`.

## Verification

- Every item referenced by `id`, matching what `list` printed.
- `take`'s full body (why/repro/fix) was relayed or acted on, not summarized away.
- Any pin re-notification you performed was via real `pin_get`/`pin_add` MCP calls, followed by `xm inbox record --scope inbox` — never assumed or skipped silently.
- If no MCP tools were available, that limitation was stated plainly, not glossed over.
- No direct file edits under `.xm/inbox/` — only via the CLI subcommands.
