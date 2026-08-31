---
description: Multi-perspective code review orchestrator — PR diff analysis with severity-rated findings and LGTM verdict
---

User provided: $ARGUMENTS

Tool-neutral executable lifecycle:

```bash
xm review run [target.patch] --cross-vendor [--models claude,codex] [--lenses correctness,risk]
xm review resume <run-id>
```

The command stores the frozen target, plan, chunks, prompts, parent manifest, child results,
coverage, synthesis, events, and trace under `.xm/review/runs/<run-id>/`. Failed runs keep their
artifacts, and resume skips completed children with the expected target hash.

Invoke the `review` skill to handle this request. Follow the instructions in `skills/review/SKILL.md` (bundled with this plugin) and apply them to the user's arguments above.
