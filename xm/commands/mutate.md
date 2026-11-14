---
description: Check whether existing tests detect bounded source mutations; does not generate tests
allowed-tools: Read(/${CLAUDE_PLUGIN_ROOT}/skills/mutate/**)
---

User provided: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/mutate/SKILL.md` in full with the Read tool before you do anything else, then follow it for the arguments above. Do not call the Skill tool for `mutate`: it returns this command again, not that file. Resolve the relative paths that file names against `${CLAUDE_PLUGIN_ROOT}/skills/mutate/`.
