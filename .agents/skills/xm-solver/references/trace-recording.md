# Trace Recording

x-solver should leave a lightweight trace whenever it delegates agents or makes phase-boundary decisions.

## When to record

Record an `agent_step` entry after:

- classification fallback agent completes
- decompose/explore/evaluate/synthesize agent work completes
- iterate diagnose/hypothesize/test/refine/resolve agent work completes
- constrain elicit/generate/evaluate/select agent work completes
- verification agent or manual verification completes

## Entry fields

```json
{
  "type": "agent_step",
  "plugin": "solver",
  "problem": "problem-slug",
  "strategy": "iterate",
  "phase": "test",
  "agent": "hypothesis-1-verifier",
  "model": "sonnet",
  "result_summary": "Hypothesis refuted by failing baseline check",
  "evidence_path": ".xm/solver/problems/<problem>/phases/03-solve/...",
  "created_at": "ISO8601"
}
```

## Rules

- Keep summaries evidence-based and short.
- Store paths to artifacts, not full command logs, when logs are large.
- Do not store secrets, tokens, or private user data.
- If x-trace is unavailable, write the same information into the relevant phase artifact.

## Applies to

All x-solver strategies and phase transitions where an agent result drives the next action.
