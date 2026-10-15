# Trace Recording

Tracing is automatic. The trace-session hook (`.claude/hooks/trace-session.mjs`, installed into `~/.claude/hooks/` by `xm setup`) writes:

- `session_start` when an `xm:*` skill is invoked (PreToolUse on the Skill tool).
- one `agent_step` per Agent tool call made between that point and the end of the assistant turn — `id` (tool_use_id), `role` (subagent_type), `model`, `duration_ms`, `status`, `source: "hook"`. `status` comes from the tool response: `success`, `error`, `launched` (a `run_in_background` agent, so `duration_ms` is launch time, not run time), or `unknown` when no response is visible.
- `session_end` at the turn's Stop hook. An agent still running at that point is written as `status: "abandoned"` and counted in `agent_count`. A skill that spans several turns (AskUserQuestion) gets one session per turn that invoked it; later turns' Agent calls are not attributed. x-solver asks AskUserQuestion after every phase, so in practice only the first turn's agents (usually `reproduce`) are attributed — a known limit of the hook, not a solver failure.

Tokens and cost are not in the hook payload. `xm trace drift` reports them only when a writer supplies `tokens_est`, and always as estimates.

## Rules

1. Do not hand-write `session_start`, `session_end`, or `agent_step`. Duplicate rows skew `agent_count` and every drift axis.
2. `fan_out` and `synthesize` rows stay LLM-written where x-trace's SKILL.md asks for them.
3. Metadata only, in every row and in `xm trace record` notes: ids, roles, models, durations, statuses, paths. Never LLM output, verdicts, PRD text, or user requirements.
4. Record cross-tool activity with `xm trace record <tool>` (the ledger). That contract is unchanged.
5. Read traces with `xm trace list` and `xm trace show <session-id>`.
