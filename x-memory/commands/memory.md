---
description: Cross-session decision and pattern memory — persist learnings, auto-inject relevant context on session start
allowed-tools: Read(/${CLAUDE_PLUGIN_ROOT}/skills/memory/**)
---

User provided: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/memory/SKILL.md` in full with the Read tool before you do anything else, then follow it for the arguments above. Do not call the Skill tool for `memory`: it returns this command again, not that file. Resolve the relative paths that file names against `${CLAUDE_PLUGIN_ROOT}/skills/memory/`.
