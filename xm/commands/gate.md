---
description: Create or extend an invariant-based project review gate
allowed-tools: Read(/${CLAUDE_PLUGIN_ROOT}/skills/gate/**)
---

User provided: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/gate/SKILL.md` in full with the Read tool before you do anything else, then follow it for the arguments above. Do not call the Skill tool for `gate`: it returns this command again, not that file. Resolve the relative paths that file names against `${CLAUDE_PLUGIN_ROOT}/skills/gate/`.

Retain the caller's review operation ID and authorized file scope. Do not invoke review
or spawn another workflow from the gate skill.
