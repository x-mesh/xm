# Subcommand: help

Displays the x-trace command reference and usage examples.

## Subcommand: help

```
x-trace — Agent Execution Tracing for xm

Commands:
  start [name]                   Start a named trace session
  stop                           Stop current session and save
  show [session]                 Show trace timeline (default: latest)
  cost [session]                 Show cost breakdown by agent/task
  replay <session> [--from step] Replay execution from specific step
  diff <session1> <session2>     Compare two trace sessions
  list                           List saved trace sessions
  clean [--older-than 7d]        Clean old trace files

Storage: .xm/traces/{session-name}-{timestamp}.jsonl

Examples:
  /xm:trace start feature-auth
  /xm:trace show
  /xm:trace cost feature-auth-20260325
  /xm:trace diff run-1 run-2
  /xm:trace replay feature-auth-20260325 --from 3
  /xm:trace clean --older-than 7d
```

## Applies to
Invoked via `/xm:trace help` or `/xm:trace` with no arguments.
