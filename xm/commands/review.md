---
description: Multi-perspective code review orchestrator — PR diff analysis with severity-rated findings and LGTM verdict
allowed-tools: Read(/${CLAUDE_PLUGIN_ROOT}/skills/review/**)
---

User provided: $ARGUMENTS

Tool-neutral executable lifecycle:

```bash
xm review run [target.patch|git-ref] --cross-vendor [--models claude,codex] [--lenses correctness,risk]
xm review resume <run-id>
```

The command stores the frozen target, plan, chunks, prompts, parent manifest, child results,
coverage, synthesis, events, and trace under `.xm/review/runs/<run-id>/`. Failed runs keep their
artifacts, and resume skips completed children with the expected target hash.

Read `${CLAUDE_PLUGIN_ROOT}/skills/review/SKILL.md` in full with the Read tool before you do anything else, then follow it for the arguments above. Do not call the Skill tool for `review`: it returns this command again, not that file. Resolve the relative paths that file names against `${CLAUDE_PLUGIN_ROOT}/skills/review/`.
