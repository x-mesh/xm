---
description: Repository-grounded planning with native execution; legacy lifecycle commands are explicit opt-ins
allowed-tools: Read(/${CLAUDE_PLUGIN_ROOT}/skills/build/**)
---

User provided: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/build/SKILL.md` in full with the Read tool before you do anything else, then follow it for the arguments above. Do not call the Skill tool for `build`: it returns this command again, not that file. Resolve the relative paths that file names against `${CLAUDE_PLUGIN_ROOT}/skills/build/`.

Route `plan` to x-plan, and use `legacy-plan` only when the user explicitly requests the former PRD/task/phase planner.
