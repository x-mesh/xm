---
name: plan
description: Produce an implementation plan from requirements, show it as readable Markdown, and persist a machine-readable PlanEnvelope under .xm/plan. Use for planning without x-build lifecycle or execution.
allowed-tools:
  - AskUserQuestion
---

# x-plan

## Mode selection

When the user did not already choose a mode, first run `xm plan --recommend --json <requirements>`. Use its recommendation directly unless `confirmation_required` is true. Only then show the context below and call AskUserQuestion once:

Quick creates the deterministic scaffold immediately. Standard adds repository inspection, a focused interview, and critique. Ultra adds multi-model architect/implementer/critic synthesis to the Standard workflow.

- Header: Plan mode
- Standard (Recommended): inspect, interview, draft, critique, and finalize one grounded plan.
- Quick: use the existing deterministic requirements-to-task scaffold without an interview.
- Ultra: run the Standard workflow, then synthesize multi-model architect/implementer/critic candidates.

Treat explicit quick, standard, ultra, --mode, or an exact model list as already selected. Ultra is always explicit and is never auto-selected. Do not ask during --validate, --persist, session continuation, or other machine-oriented CLI operations. If confirmation is required but AskUserQuestion is unavailable, use Standard as the safe fallback instead of blocking.

## Workflows

### Quick

Run the existing deterministic scaffold path. It converts requirement lines directly into tasks, keeps unresolved planning decisions open, renders the plan, and saves the flat PlanEnvelope JSON under .xm/plan. Do not inspect or interview.

### Standard

Run inspect → clarify → draft → critique → finalize:

1. Inspect the repository first. Record verified paths, APIs, conventions, and test commands as evidence. Do not ask discoverable questions.
2. Classify ambiguity as discoverable, user_owned, safe_default, or blocking_unknown. Persist the incomplete session with evidence.json and questions.json before asking, so the interview is resumable. Show findings, then ask at most three user_owned or blocking questions in one AskUserQuestion call. Stop and wait for the answers.
3. Draft a plan whose must requirements map to tasks or validation. Every task needs expected_files and done_criteria.
4. Critique requirement coverage, dependency order, scope, failure modes, rollback or recovery, and validation. Revise before finalizing.
5. Set executable=true only when evidence exists, every question is answered, critique passes, every task names expected files, validation commands are verified, and no disagreement remains unresolved.
6. Persist plan.md, envelope.json, evidence.json, questions.json, critique.json, and manifest.json in one .xm/plan/<run-id>/ session directory.

On continuation, update the same directory with --session <run-id>; never create a second session for the same interview.

### Ultra

Perform the complete Standard workflow, including the interview. After clarification, fan out exact model slots as architect, implementer, and critic, validate each candidate, synthesize them, preserve failures and disagreements, run the final critique, and persist candidate artifacts under candidates/ in the same session directory. Ultra never skips the interview merely because multiple models are available.

The raw xm plan --mode ultra command is the post-interview multi-model backend. Invoke it only after the Standard inspect and clarify stages have produced evidence.json and answered questions.json, and pass those artifacts plus --session <run-id>.

Act as an implementation planner, not as a JSON formatter. Inspect the repository when it exists, resolve decisions that can be grounded in the codebase, and present the resulting plan as readable Markdown. Include concise diagrams when they materially clarify architecture, data flow, or a multi-step interaction.

After Standard or Ultra planning, persist the completed envelope with the verified evidence, answered questions, and passing critique. Never paste the raw PlanEnvelope into the user-facing response.

Before claiming a plan is executable, verify repository paths, APIs, and test commands. Preserve genuinely unresolved decisions as questions and keep `executable=false`; do not invent details to make the plan appear complete.

Use --json only when a caller explicitly needs JSON on stdout. Validate an existing envelope with xm plan --validate. Standard persistence requires --persist --mode standard with --evidence, --questions, and --critique JSON artifacts; pass --session on subsequent turns. Ultra requires that same session and interview context before model calls. Use --no-save only for an explicit dry run. Report the readable plan and saved artifact path after persistence.

Ultra mode fans exact model slots through observable `xm panel cross` runs, assigns
`architect`, `implementer`, and `critic` roles in stable order, validates every candidate, and
deterministically synthesizes valid candidates while preserving provider failures and
disagreements:

```bash
xm plan --mode ultra --models codex:gpt-5.6-sol:xhigh,codex:claude-opus-5:high --file requirements.md
```

Ultra mode requires at least two distinct slots. It is opt-in because it spends one provider run
per slot and can still preserve unresolved disagreements as `executable=false`.

Boundaries:
- Owns PlanEnvelope schema, normalization, validation, readable rendering, and `.xm/plan` artifact persistence.
- Does not create `.xm/build` projects, move phases, approve plans, or execute tasks. Only ultra mode calls providers, through `xm panel cross`.
- `xm build plan` and `xm panel plan` retain their existing behavior in this release.
