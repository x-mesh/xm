---
description: Release automation — commit squash, version bump, changelog, push. Works with any project.
allowed-tools: Read(/${CLAUDE_PLUGIN_ROOT}/skills/ship/**)
---

User provided: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/ship/SKILL.md` in full with the Read tool before you do anything else, then follow it for the arguments above. Do not call the Skill tool for `ship`: it returns this command again, not that file. Resolve the relative paths that file names against `${CLAUDE_PLUGIN_ROOT}/skills/ship/`.
