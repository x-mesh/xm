---
description: Create a readable implementation plan and save its PlanEnvelope under .xm/plan
---

User provided: $ARGUMENTS

Invoke the `plan` skill and apply it to the arguments above. If no mode is explicit, run `xm plan --recommend --json` first and ask for Quick, Standard, or Ultra only when `confirmation_required` is true. Quick keeps the deterministic scaffold; Standard performs inspection, interview, critique, and session persistence; Ultra is explicit-only and performs Standard plus multi-model synthesis. Never start x-build execution.
