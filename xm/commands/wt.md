---
description: Session worktree — isolate the whole session in a git worktree, then land it back to the parent branch
allowed-tools: Read(/${CLAUDE_PLUGIN_ROOT}/skills/wt/**)
---

User provided: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/wt/SKILL.md` in full with the Read tool before you do anything else, then follow it for the arguments above. Do not call the Skill tool for `wt`: it returns this command again, not that file. Resolve the relative paths that file names against `${CLAUDE_PLUGIN_ROOT}/skills/wt/`.
