# Trace Recording

Reference for x-op trace entries. `session_start` and `session_end` are automatic via `.claude/hooks/trace-session.mjs`.

## Per agent call

Read the session ID from `.xm/traces/.active`, then record `agent_step` with role, model, estimated tokens, duration, and status. Use `parent_id` for fan-out trees and `null` for root agents.

## Rules

1. `session_start` and `session_end` are automatic; do not emit them manually.
2. `agent_step` is best-effort; record it when possible.
3. Store metadata only. Never include LLM output or verdicts in trace entries.
4. If trace write fails, log to stderr and continue. Trace failures must not block strategy execution.

## Applies to

x-op strategy execution and long-running sub-operations.
