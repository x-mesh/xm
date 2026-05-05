# Trace Recording

Reference for x-build trace entries. `session_start` and `session_end` are automatic via `.claude/hooks/trace-session.mjs`.

## Per operation

Read the session ID from `.xm/traces/.active`, then record `agent_step` for long sub-operations such as research fan-out, consensus review, task execution, and verification. Include role, model, estimated tokens, duration, status, and `parent_id` when a step belongs to a fan-out tree.

## Rules

1. `session_start` and `session_end` are automatic; do not emit them manually.
2. `agent_step` is best-effort; record it when possible.
3. Store metadata only. Never include full PRDs, user requirements, LLM outputs, or verdict text in trace entries.
4. If trace write fails, log to stderr and continue. Trace failures must not block project execution.

## Applies to

x-build research, deliberation, DAG execution, quality checks, and long-running sub-operations.
