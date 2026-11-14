---
description: Create a readable implementation plan and save its PlanEnvelope under .xm/plan
allowed-tools: Read(/${CLAUDE_PLUGIN_ROOT}/skills/plan/**)
---

User provided: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/plan/SKILL.md` in full with the Read tool before you do anything else, then follow it for the arguments above. Do not call the Skill tool for `plan`: it returns this command again, not that file. Resolve the relative paths that file names against `${CLAUDE_PLUGIN_ROOT}/skills/plan/`.

If no mode is explicit, run `xm plan --recommend --json` first and ask for Quick, Standard, or Ultra only when `confirmation_required` is true. Quick keeps the deterministic scaffold; Standard performs inspection, interview, critique, and session persistence; Ultra is explicit-only and performs Standard plus multi-model synthesis. Never start x-build execution.
