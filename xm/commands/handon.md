---
description: Session restore — resume from last handoff, inject context automatically
allowed-tools: Read(/${CLAUDE_PLUGIN_ROOT}/skills/handon/**)
---

User provided: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/handon/SKILL.md` in full with the Read tool before you do anything else, then follow it for the arguments above. Do not call the Skill tool for `handon`: it returns this command again, not that file. Resolve the relative paths that file names against `${CLAUDE_PLUGIN_ROOT}/skills/handon/`.
