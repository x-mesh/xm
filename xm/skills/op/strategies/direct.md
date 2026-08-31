# Strategy: direct

One agent, one call, no orchestration. `direct` is the single-agent baseline every
other strategy has to beat — and the right answer for a bounded, well-specified task
with one acceptable output.

## When it is the right pick

- The task fits in one sentence, names its target, and has one acceptable answer.
- No signal in the Auto-Route table fires (no compare / why / security / design / monitor).
- The user said "그냥", "간단히", "한 줄로", "just", "quickly" — they are asking for less process, not more.
- A bench (`/xm:eval bench`) showed the candidate strategy does not beat `direct` by ≥ 0.5 on this kind of task.

Not for: unknown root causes (hypothesis), opposing options (debate), security surfaces
(red-team), or anything that needs a second independent perspective to be trusted.

## Phase 1: EXECUTE

> ▶ [direct] Phase 1/1: Execute

Invoke ONE Agent tool on the session model with the task verbatim:
```
"## Task: {TASK}
Do this task directly. Return the deliverable, then a 2-3 line note on what you verified and what you did not.
Cite evidence (file:line, command output) for every factual claim; mark anything unverified."
```
- No fan-out, no rounds, no vote. If the agent asks a clarifying question, relay it with AskUserQuestion instead of guessing.
- No Self-Score from the agent — the leader appends the standard Self-Score block (self-score-protocol.md, rubric per the strategy-rubric mapping: `general`) so the run is comparable with every other strategy.

## Persist

Save `.xm/op/direct-{YYYY-MM-DD}-{slug}.json` with the canonical keys (`topic`, `created_at`,
`completed_at`, `options.agents: 1`, `self_score`, `status`) and `outcome: { verdict: "delivered",
summary }`. `rounds_summary` has one entry (`phase: "execute"`). The Post-Strategy Eval Gate
applies unchanged — `--verify` / `eval.auto` score a direct run exactly like any other.

## Cost

`STRATEGY_MULTIPLIERS.direct = 1.0` — this is the baseline the other multipliers are relative to.
