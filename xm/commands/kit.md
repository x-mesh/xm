---
description: x-mesh toolkit — list available tools and their status
allowed-tools: Read(/${CLAUDE_PLUGIN_ROOT}/skills/kit/**)
---

User provided: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/kit/SKILL.md` in full with the Read tool before you do anything else, then follow it for the arguments above. Do not call the Skill tool for `kit`: it returns this command again, not that file. Resolve the relative paths that file names against `${CLAUDE_PLUGIN_ROOT}/skills/kit/`.
