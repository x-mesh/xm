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
| `init` | (command) | Install global hooks |

### Routing rules

1. **If arguments are empty** → print the subcommand table above and stop. Do not invoke any skill.
2. **If first word matches a subcommand in the table** → invoke the corresponding skill (from `skills/<subcommand>/SKILL.md`) and pass the remaining arguments as its input.
3. **If first word is unknown** → respond with `Unknown subcommand: <first-word>. Available: op, solver, build, eval, agent, review, trace, memory, humble, probe, dashboard, kit, ship, sync, handoff, handon, init` and stop.
4. **For `init`** there is no skill — it is a plain command; follow instructions in `commands/init.md`.

### Examples

- `/xm` → list subcommands
- `/xm solver 문제가 다 해결되었는지 확인해보자` → invoke solver skill with that argument
- `/xm op refine "draft response" "make it crisper"` → invoke op skill
- `/xm build plan "new feature goal"` → invoke build skill
