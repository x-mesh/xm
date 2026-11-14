---
description: Session handoff — save comprehensive session state for cross-session continuity
allowed-tools: Read(/${CLAUDE_PLUGIN_ROOT}/skills/handoff/**)
---

User provided: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/handoff/SKILL.md` in full with the Read tool before you do anything else, then follow it for the arguments above. Do not call the Skill tool for `handoff`: it returns this command again, not that file. Resolve the relative paths that file names against `${CLAUDE_PLUGIN_ROOT}/skills/handoff/`.
