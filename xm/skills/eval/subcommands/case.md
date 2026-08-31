# Subcommand: case

The persistent case set under `.xm/eval/cases/` — fixed inputs the same strategies get re-run against, so "did this SKILL.md / prompt / model change help?" has a stable answer. Usage: `/xm:eval case add|list|show …`.

> **⚠ Call `xm eval case …` directly. Claude Code's Bash tool starts a fresh shell on every invocation — shell functions defined in one call do NOT persist to the next. Never define a helper across calls; always use the dispatcher.**
>
> **Fallback** (only when `xm` is not in PATH — rare; `${CLAUDE_PLUGIN_ROOT}` is NOT exported to Bash subprocesses, so don't rely on it bare):
> ```bash
> XMEV_CLI=$(ls -d ~/.claude/plugins/cache/xm/{eval,xm}/*/lib/x-eval-cli.mjs 2>/dev/null | sort -V | tail -1)
> node "$XMEV_CLI" case [args]
> ```
>
> **Forbidden:** `XMEV="node ..."; $XMEV case list` — zsh treats the quoted string as a single command and fails.

## Where cases come from

| Trigger | Action |
|---|---|
| A `score` result FAILs (`passed: false`) on a task worth re-checking | `case add --prompt-file <task> --rubric <same rubric> --tag <plugin> --source-ref <result file>` |
| A review finding is triaged `false_positive` | add the reviewed snippet as a case with `--assert "<what the lens got wrong>"` so the next lens edit is measured against it |
| A user rejects a strategy's output | add the task with `--min-overall` set to the bar they expected |
| `xm trace replay --promote-to-eval` | writes a `replay-*` case (metadata only) — listed, but not runnable until it carries a prompt |

Ng's rule applies: the suite evolves from real failures, not from a one-time authoring session.

## `case add`

```bash
xm eval case add --prompt "<task text>" | --prompt-file <file> \
  [--rubric general|code-quality|…] [--tag <t>]... [--risk high] \
  [--assert-cmd 'name=<cmd>']... [--assert-file 'name=exists|absent=<path>']... \
  [--assert-grep 'name=[!]<regex>:<path>']... [--assert-json 'name=<a.b>=<v>:<file>']... \
  [--assert "<judge statement>"]... [--min-overall N] [--source-ref <path|id>] [--json]
```

`--prompt-file` must be a regular non-symlink file and is read only after its 64 KiB limit is checked. Case files are bounded to 256 KiB, stay under `.xm/eval/cases/`, and reject unsupported top-level/source fields, non-normalized timestamps, or excessively deep JSON.

- The id is `case-<sha256(prompt + rubric + sorted tags)[:24]>`, so adding the same case twice is a no-op (`created: false`).
- `--risk high` raises the default trial count from 3 to 5 in `bench plan` — testing effort scales with the cost of being wrong.
- `--min-overall` pins the pass bar for this case (default 7.0). Executable assertions run at `bench record --run-assertions`; judge assertions are handed to the assertion judge with the rest of the panel.
- The prompt text is stored (it is user-authored input). Never paste model output into a case.

## `case list [--tag <t>] [--json]` · `case show <id>`

`list` prints id, type (`task` / `replay`), rubric, risk, tags, and a prompt preview; malformed files are reported, never silently dropped. `show` prints the payload.

## Storage

`.xm/eval/cases/<id>.json`:
```json
{ "v": 1, "type": "task", "id": "case-…", "prompt": "…", "rubric": "general", "tags": ["op"], "risk": "normal",
  "assertions": [{ "kind": "cmd", "name": "tests", "spec": "bun test test/x.test.mjs" }, { "kind": "judge", "text": "…" }],
  "expected": { "min_overall": 7 }, "created_at": "ISO8601", "source": { "plugin": "manual", "ref": null } }
```

## Applies to
Invoked via `/xm:eval case …`. Consumed by `bench plan --set`. See `references/storage-layout.md`.
