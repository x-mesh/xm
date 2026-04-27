---
description: x-mesh toolkit dispatcher — /xm <subcommand> [args...] or /xm to list subcommands
---

User provided: $ARGUMENTS

## Dispatcher

Parse the first whitespace-separated word of the arguments above as the subcommand. The rest of the line is the subcommand's arguments.

### Supported subcommands

| Subcommand | Skill | Purpose |
|------------|-------|---------|
| `op` | op | Strategy orchestration (17 strategies) |
| `solver` | solver | Structured problem solving |
| `build` | build | Phase-based project harness |
| `eval` | eval | Agent output quality evaluation |
| `agent` | agent | Agent primitives + autonomous behaviors |
| `review` | review | Multi-perspective code review |
| `trace` | trace | Agent execution tracing |
| `memory` | memory | Cross-session decision memory |
| `humble` | humble | Structured retrospective |
| `probe` | probe | Premise validation |
| `dashboard` | dashboard | Web dashboard for .xm state |
| `kit` | kit | Toolkit overview |
| `ship` | ship | Release automation |
| `sync` | sync | Multi-machine state sync |
| `handoff` | handoff | Save session state |
| `handon` | handon | Resume from handoff |
| `config` | kit (alias) | Shared toolkit config — `config show/set/get` |
| `update` | kit (alias) | Update xm plugins — `update [plugin]` |
| `version` | kit (alias) | Compare installed vs available plugin versions |
| `doctor` | kit (alias) | Diagnose xm install — `doctor [--fix]` |
| `cost` | kit (alias) | Aggregate session cost — `cost [--session]` |
| `pipeline` | kit (alias) | Run named pipeline — `pipeline <name>` / `pipeline list` |
| `validate` | kit (alias) | Check Wiring DAG for cycles |
| `agents` | kit (alias) | Agent catalog — `agents list/match/get` |
| `init` | (command) | Install global hooks |

### Routing rules

1. **If arguments are empty** → print the subcommand table above and stop. Do not invoke any skill.
2. **If first word matches a subcommand in the table** → invoke the corresponding skill (from `skills/<subcommand>/SKILL.md`) and pass the remaining arguments as its input.
3. **kit aliases** — treat `/xm <kit-cmd> [args...]` as equivalent to `/xm kit <kit-cmd> [args...]` for any of: `config`, `update`, `version`, `doctor`, `cost`, `pipeline`, `validate`, `agents`. Invoke the `kit` skill with the full original input (including the alias word itself) as its `$ARGUMENTS`.
4. **If first word is unknown** → respond with `Unknown subcommand: <first-word>. Available: op, solver, build, eval, agent, review, trace, memory, humble, probe, dashboard, kit, ship, sync, handoff, handon, config, update, version, doctor, cost, pipeline, validate, agents, init` and stop.
5. **For `init`** there is no skill — it is a plain command; follow instructions in `commands/init.md`.

### Examples

- `/xm` → list subcommands
- `/xm solver 문제가 다 해결되었는지 확인해보자` → invoke solver skill with that argument
- `/xm op refine "draft response" "make it crisper"` → invoke op skill
- `/xm build plan "new feature goal"` → invoke build skill
- `/xm config show` → shortcut for `/xm kit config show`
- `/xm config set agent_max_count 8` → shortcut for `/xm kit config set agent_max_count 8`
- `/xm update` → shortcut for `/xm kit update` (batch update all xm plugins)
- `/xm update x-build` → shortcut for `/xm kit update x-build`
- `/xm version` → shortcut for `/xm kit version`
- `/xm doctor --fix` → shortcut for `/xm kit doctor --fix`
- `/xm cost --session` → shortcut for `/xm kit cost --session`
- `/xm pipeline release` → shortcut for `/xm kit pipeline release`
- `/xm agents match "review"` → shortcut for `/xm kit agents match "review"`
