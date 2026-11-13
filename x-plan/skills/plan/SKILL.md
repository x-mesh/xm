---
name: plan
description: Produce an implementation plan from requirements, show it as readable Markdown, and persist a machine-readable PlanEnvelope under .xm/plan. Use for planning without x-build lifecycle or execution.
allowed-tools:
  - AskUserQuestion
---

# x-plan

## Planning Principles

- Keep the plan proportional to the work. Prefer the smallest approach that satisfies the user's actual goal; do not inflate a local change into a framework, migration, compatibility layer, or lifecycle.
- Treat the request as a hypothesis. Verify that the requested method achieves the underlying goal, check whether the repository already provides it, and surface a simpler adequate alternative when one exists.
- Do not invent fallbacks. A fallback belongs in the plan only when a concrete failure condition is evidenced, explicit failure would be worse, activation is observable, behavior differences are documented, and both paths have a test. Otherwise require a clear failure.
- Separate verified repository facts, inferences, and unresolved user-owned decisions. Never make a plan executable by guessing paths, APIs, validation commands, or risk assumptions.
- Identify what the change can break, then select only the smallest existing validation that directly observes that risk. Do not list test, lint, build, and review as a fixed checklist. Explain any intentionally omitted check. Propose a new gate only for a named failure that existing checks miss and only with a measurable unique-catch criterion.
- Enumerate failure modes for every risk-domain requirement (parsing, matching/regex, caching, concurrency/locking, queues, auth, crypto, input handling, streaming, protocol), and say how the code should behave when the limit is reached — not just how to test it. A measured experiment (`docs/phase-model-routing-experiment.md`) found the prescription's resolution, not the enumeration's presence, is what makes a cheaper execution model match a stronger one on robustness. A requirement with genuinely nothing to defend takes `mode: "none — <justification>"`; silence is not the same claim.
- Plan sequential execution by default. Mark tasks parallel only when their files, shared state, dependencies, and validation environments are verified independent and the expected time saving exceeds orchestration cost. Disjoint files are not independent when the tasks share a compile or test unit (one Go package, module, or crate) or one validation command: a half-finished edit in one task breaks the other task's check.
- Declare only real dependencies. A task depends on another only when it needs that task's files, interface, or output. Do not chain every task behind the previous one: a README task that documents the final flags depends on the task that defines those flags, not on every task before it.
- Stop or shrink the plan when the problem is not reproducible, a simpler path achieves the goal, complexity has no measurable benefit, or success cannot be observed.

## Mode selection

When the user did not already choose a mode, first run `xm plan --recommend --json <requirements>`. Use its recommendation directly unless `confirmation_required` is true. Only then show the context below and call AskUserQuestion once:

Quick creates the deterministic scaffold immediately. Standard adds repository inspection, a focused interview, and critique, and ends after inspection when the change qualifies for its inline exit. Ultra adds multi-model architect/implementer/critic synthesis to the Standard workflow.

- Header: Plan mode
- Standard (Recommended): inspect, interview, draft, critique, and finalize one grounded plan.
- Quick: use the existing deterministic requirements-to-task scaffold without an interview.
- Ultra: run the Standard workflow, then synthesize multi-model architect/implementer/critic candidates.

Treat explicit quick, standard, ultra, --mode, or an exact model list as already selected. Ultra is always explicit and is never auto-selected. Do not ask during --validate, --persist, session continuation, or other machine-oriented CLI operations. If confirmation is required but AskUserQuestion is unavailable, use Standard as the safe fallback instead of blocking.

## Workflows

### Quick

Run the existing deterministic scaffold path. It converts requirement lines directly into tasks, keeps unresolved planning decisions open, renders the plan, and saves the flat PlanEnvelope JSON under .xm/plan. Do not inspect or interview.

### Standard

#### Planner model (direct runs only)

Confirm the planner model once before step 1, only when the user invoked x-plan directly in this session. Skip this section when x-build's planner, another skill, or a subagent called x-plan, during --validate, --persist, or --session continuation, and in Ultra, which names its models explicitly.

1. Run `xm build route models --host claude|codex --session-model <exact model id of this session> [--plan <model>]`. `<model>` is haiku, sonnet, opus, fable, inherit, or a vendor:model[:effort] pin. Pass `unknown` as the session model when the system prompt does not state it.
2. If the user passed `--plan-model <model>`, pass it as `--plan` and do not ask. Remove `--plan-model <model>` from the requirements before any `xm plan` call: that CLI rejects unknown options. Otherwise ask once with AskUserQuestion: keep the shown planner model (Recommended), or pick another. When the mode question is also due, ask both in the same call. Do not show prices: the x-kit price table is stale. If AskUserQuestion is unavailable, keep the configured model.
3. If the user picked another model, run `route models` again with `--plan <picked model>` and use that output from here on. The first output describes only the configured default. If the CLI rejects the choice, show the error and ask again. Never substitute another model.
4. If `model_routes.plan.execution` is `inline`, run Standard in this session. If it is `agent`, start one planner agent with `model_routes.plan.model_by_vendor.claude` (Codex: `model_by_vendor.codex`) and have it run Standard. The agent persists its interview questions with the session, returns the run id and the questions, and stops. Ask them here, then pass the answers back so the agent continues the same `--session`.

No CLI record enforces this choice; these instructions are the only check.

Run inspect → clarify → draft → critique → finalize:

1. Inspect the repository first. Record verified paths, APIs, conventions, and test commands as evidence. Do not ask discoverable questions.
   **Inline exit.** A small change does not need a persisted plan. The recommender reads only the requirement text, so this decision is made here, after inspection. End planning at this step, without artifacts or questions, only when every condition holds:
   - The user invoked x-plan directly in this session and named no mode, `--mode`, model list, `--session`, or `--persist`. x-build's planner, another skill, and a subagent need a saved executable envelope, so they never take this exit.
   - Inspection verified the exact files to change, and they are few.
   - One failure mode is involved, and an existing test or command observes it.
   - The change touches no public interface, schema, migration, release, or security surface.

   Then show three lines as the plan: each assumption the change relies on and the source that verified it; every input form to test, not only the reported one; what happens when a dependency the change adds fails. x-plan itself executes nothing: the session makes the change only when the user's request also asks for it; otherwise stop at the three lines. If any condition is unverified, continue Standard.
2. Classify ambiguity as discoverable, user_owned, safe_default, or blocking_unknown. Persist the incomplete session with evidence.json and questions.json before asking, so the interview is resumable. Show findings, then ask at most three user_owned or blocking questions in one AskUserQuestion call. Stop and wait for the answers.
3. Draft a plan whose must requirements map to tasks or validation. Every task needs expected_files and done_criteria. Fill `failure_modes` for each risk-domain requirement as `{requirement_ref, mode, mitigation, verification}` — `mode` is what breaks, `mitigation` is what the code does at the limit, `verification` is how it is observed.
4. Critique premise validity, requirement coverage, dependency order (every dependency real, every parallel mark free of a shared compile or test unit), scope, failure modes, rollback or recovery, and validation. Remove unjustified fallbacks and unnecessary machinery before finalizing.
5. Set executable=true only when evidence exists, every question is answered, critique passes, every task names expected files, validation commands are verified, every risk-domain requirement carries a failure mode with a concrete prescription, and no disagreement remains unresolved.
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
- Owns PlanEnvelope schema (including `failure_modes`), normalization, validation, readable rendering, and `.xm/plan` artifact persistence. `xm build import-plan` renders `failure_modes` into PRD section 7.5 and injects each one as a `스트레스:` done criterion on the tasks covering that requirement.
- Does not create `.xm/build` projects, move phases, approve plans, or execute tasks. Only ultra mode calls providers, through `xm panel cross`.
- `xm build plan` is a deprecated CLI alias for this x-plan entry point; x-build imports the resulting envelope through its own `import-plan` compiler, so x-plan still never writes `.xm/build` itself. `xm build legacy-plan` retains the former PRD/task/phase planner for explicit compatibility use. `xm panel plan` retains its own behavior.
