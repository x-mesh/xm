# Subcommand: show

Shows one trace session: header, row-type counts, git snapshot, and every recorded `agent_step`. CLI-backed: run the command and relay its output.

## Parsing

From `$ARGUMENTS`:
- After `show` = session id. An exact id, the file name, or a unique prefix all work. If omitted, run `xm trace list --limit 1` first and use that id.

## Execution

```bash
xm trace show <session-id> [--json]
```

## Output

```
Session review-20260928-094051-9098
  skill: review   status: unknown   started: 2026-09-28T09:40:51.000Z   duration: 4.1s
  git: 989362f (develop)
  file: /repo/.xm/traces/review-20260928-094051-9098.jsonl
  rows: session_start 1, agent_step 2, session_end 1

Agents (2):
  Explore · haiku · 1.2s · success · Scan tests  [toolu_01]
  general-purpose · inherit · 3.4s · success  [toolu_02]
```

- An ambiguous prefix lists the candidates and exits 1; an unknown id points to `xm trace list`.
- `Agents: none recorded` means no Agent tool call happened inside the session (or the session predates hook-recorded spans, 2026-09-29).
- Tokens and cost are not shown: the hook payload carries neither, so any figure would be an estimate.

## Applies to
Invoked via `/xm:trace show [session]` or directly as `xm trace show <session-id>`.
