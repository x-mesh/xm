---
description: Cross-model adversarial review panel — run several model CLIs on the same target and synthesize a consensus verdict
allowed-tools: Read(/${CLAUDE_PLUGIN_ROOT}/skills/panel/**)
---

User provided: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/panel/SKILL.md` in full with the Read tool before you do anything else, then follow it for the arguments above. Do not call the Skill tool for `panel`: it returns this command again, not that file. Resolve the relative paths that file names against `${CLAUDE_PLUGIN_ROOT}/skills/panel/`.
