---
description: Cross-session artifact index — find and read review/op/plan/eval/probe outputs from previous sessions
allowed-tools: Read(/${CLAUDE_PLUGIN_ROOT}/skills/recall/**)
---

User provided: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/recall/SKILL.md` in full with the Read tool before you do anything else, then follow it for the arguments above. Do not call the Skill tool for `recall`: it returns this command again, not that file. Resolve the relative paths that file names against `${CLAUDE_PLUGIN_ROOT}/skills/recall/`.
