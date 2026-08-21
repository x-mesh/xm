---
name: plan
description: Convert requirement text, files, or stdin into a normalized and validated PlanEnvelope JSON. Use for JSON-only planning without x-build lifecycle or execution.
---

# x-plan

Run `xm plan <requirements>` or `xm plan --file <path>`. The output is one PlanEnvelope JSON object.

This MVP is deterministic: it creates a requirements-aligned scaffold and records unresolved planning decisions, so `executable` remains false until a planner or user resolves them. It never invents repository paths, APIs, or test commands.

Validate an existing envelope with `xm plan --validate < plan.json`.

Ultra mode fans exact model slots through observable `xm panel cross` runs, assigns
`architect`, `implementer`, and `critic` roles in stable order, validates every candidate, and
deterministically synthesizes valid candidates while preserving provider failures and
disagreements:

```bash
xm plan --mode ultra --models codex:gpt-5.6-sol:xhigh,codex:claude-opus-5:high --file requirements.md
```

Ultra mode requires at least two distinct slots. It is opt-in because it spends one provider run
per slot and can still preserve unresolved disagreements as `executable=false`.

Boundaries:
- Owns PlanEnvelope schema, normalization, validation, and scaffold creation.
- Does not create `.xm/build` projects, move phases, approve plans, call providers, or execute tasks.
- `xm build plan` and `xm panel plan` retain their existing behavior in this release.
