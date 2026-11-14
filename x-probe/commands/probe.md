---
description: Premise validation — challenge assumptions, kill bad ideas early, earn the right to build
allowed-tools: Read(/${CLAUDE_PLUGIN_ROOT}/skills/probe/**)
---

User provided: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/probe/SKILL.md` in full with the Read tool before you do anything else, then follow it for the arguments above. Do not call the Skill tool for `probe`: it returns this command again, not that file. Resolve the relative paths that file names against `${CLAUDE_PLUGIN_ROOT}/skills/probe/`.
