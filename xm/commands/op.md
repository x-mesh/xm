---
description: Strategy orchestration — 17 strategies including refine, tournament, chain, review, debate, red-team, brainstorm, distribute, council, socratic, persona, scaffold, compose, decompose, hypothesis, investigate, monitor
allowed-tools: Read(/${CLAUDE_PLUGIN_ROOT}/skills/op/**)
---

User provided: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/op/SKILL.md` in full with the Read tool before you do anything else, then follow it for the arguments above. Do not call the Skill tool for `op`: it returns this command again, not that file. Resolve the relative paths that file names against `${CLAUDE_PLUGIN_ROOT}/skills/op/`.
