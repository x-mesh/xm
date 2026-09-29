# Subcommand: list

Lists saved trace sessions, newest first. CLI-backed: run the command and relay its output.

## Execution

```bash
xm trace list [--limit N] [--json]
```

`--limit` defaults to 20. `--json` returns `{ trace_dir, total, shown, malformed_lines, sessions[] }` for callers that need structure.

## Output

```
STARTED           SKILL    STATUS   AGENTS  DURATION  SESSION
2026-09-29 01:47  recall   unknown  0       31ms      x-recall-20260929-014729-cf6d
2026-09-28 09:40  review   unknown  2       4.1s      review-20260928-094051-9098
2026-09-28 00:18  recall   open     0       —         x-recall-20260928-001801-ea34

3 of 245 session(s).  read one: xm trace show <session-id>
Note: 2 malformed, oversized, or unsafe JSONL line(s)/file(s) skipped
```

- `STATUS` is the `session_end.status` (`unknown` when the hook could not observe the outcome) or `open` when no `session_end` exists.
- `AGENTS` counts `agent_step` rows; the trace-session hook writes one per Agent tool call made inside the session.
- Malformed lines never abort the list. Relay the trailing note when it appears.

## Applies to
Invoked via `/xm:trace list` or directly as `xm trace list`.
