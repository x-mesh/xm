# Workflow Guide

Full x-build workflow from goal to project close, including planning principles, phase-by-phase execution, Quick Mode shortcut, and error recovery.

## Planning Principles

These principles apply to all plan-phase activities (PRD generation, task decomposition, consensus review, critique).

```
## Planning Principles

1. **Decide what NOT to build first** — Scope is defined more by what you exclude than what you include. Every requirement added is a constraint on every future requirement.
2. **Name the risk, then schedule it early** — Uncertainty should drive ordering. The task you're least sure about goes first, not last. Fail fast > fail late.
3. **A plan is a hypothesis, not a promise** — Plans will change. Design for adaptability: small tasks, clear boundaries, minimal cross-task dependencies.
4. **Intent over implementation** — PRD describes WHAT and WHY. Tasks describe WHAT to do. Neither should prescribe HOW (specific technology/library) unless it's a hard constraint.
5. **If you can't verify it, you can't ship it** — Every requirement needs a success criterion. Every task needs done_criteria. If you can't describe how to check "done," the scope is too vague.
6. **Surface assumptions before tasks** — Before decomposing into tasks, list the assumptions the plan rests on (project state + user intent + constraints). Assumptions with low confidence must be validated (ask user, run probe) before tasks are written.
```

## Workflow: From Goal to Completion

### Step 1: Init + Discuss (Research Phase)

User describes a goal. Initialize and gather requirements:

```bash
$XMB init my-project
$XMB discuss --mode interview
```

**Interview mode**: Structured multi-round interview with ambiguity gating. Repeats until clarity threshold is met.

1. Run: `$XMB discuss --mode interview`
2. Parse JSON output (`action: "discuss"`, `mode: "interview"`)

#### Round 0: Problem Framing (greenfield only)

Runs before Round 1, and only when `next --json` (or `discuss --mode interview`) reports `round0_pending: true`. This field is only present when `project_kind === "greenfield"` — for `brownfield` projects, skip straight to Round 1; there is no gate to check.

`project_kind` is a deterministic gauge recorded once at `init` time (4 signals: manifest found upward, lockfile present, populated source tree, >1 git commit — all miss ⇒ greenfield, any hit ⇒ brownfield, a git error fails safe to brownfield). It never re-computes mid-project, so an empty-repo project stays greenfield for its own lifetime even if files appear later. Inspect it directly with `$XMB project-kind [--json]`.

Round 0 is exactly one round, one AskUserQuestion with 4 questions — it does not scale with ambiguity the way Round 1+ does:

| Question | What it resolves |
|----------|-------------------|
| Problem definition | Is this eliminating repetitive work, adding a new capability, or something the user should just describe directly? |
| Status quo | How is this handled today — manually, with another tool, or not at all? |
| Shape of success | What does "it worked" look like — a metric moved, real users adopted it, or a demo lands? |
| MVP wedge | What is the single thinnest slice worth building first — the most-used flow, the riskiest assumption to test, or one visible output? |

Follow the dark-theme rule (`references/ask-user-question-rule.md`): decision-relevant text goes in `header`/`label`/`description`, not the `question` field.

Save the answers to the JSON's `save_path` field (do not hardcode a filename — for round 0 the CLI returns `.../01-research/discuss-round0.json`; for round 1+ it returns the normal `discuss-interview-r{n}.json` chain). Also fold the answers into CONTEXT.md under a `## Round 0 — Problem Framing` section so later phases (PRD, research synthesis) can read them without opening the JSON.

Round 0 does not replace Round 1's ambiguity gate — if dimension scores are still high after Round 0, Round 1's drill-down proceeds as usual.

#### Round 1: Dimension Scan (mandatory)

Ask exactly one question per dimension. Use AskUserQuestion with multiple questions:

| Dimension | Question Pattern | Example |
|-----------|-----------------|---------|
| **scope** | "What is explicitly OUT of scope?" | "Admin panel? Mobile? i18n?" |
| **users** | "Who are the primary users and what's their technical level?" | "Developers via API? End users via UI?" |
| **tech** | "Are there hard tech constraints or preferences?" | "Must use PostgreSQL? Existing framework?" |
| **quality** | "What's the minimum acceptable quality bar?" | "Tests required? CI/CD? Performance SLA?" |
| **timeline** | "What's the urgency and phasing?" | "MVP first? All-at-once? Deadline?" |

After user answers, compute **ambiguity score** per dimension:

| User answer | Ambiguity |
|-------------|:---------:|
| Specific, decisive ("PostgreSQL, no alternatives") | 0 (clear) |
| Partial ("probably REST, maybe GraphQL") | 1 (needs follow-up) |
| Vague ("whatever works") | 2 (high ambiguity) |
| No answer / skipped | 2 (high ambiguity) |

**Ambiguity gate**: Sum all dimension scores. Max = 10, threshold = 3.
- Total ≤ 3 → proceed to CONTEXT.md generation
- Total > 3 → drill-down round on highest-ambiguity dimensions

#### Round 2+: Drill-Down (conditional)

For each dimension with ambiguity ≥ 2, ask 2-3 targeted follow-up questions:

```
Dimension: scope (ambiguity: 2)
You said "whatever works" for scope. Let me narrow down:
1. Will this need authentication/authorization?
2. Is there an existing codebase this integrates with?
3. Should this be deployable standalone or as part of a larger system?
```

Re-score after each round. Repeat until total ≤ 3 or `--round N` limit reached (default: 3 rounds).

#### CONTEXT.md Generation

After ambiguity gate passes, save:
```bash
$XMB save context --content "# CONTEXT.md\n\n## Goal\n...\n## Scope\n### In Scope\n...\n### Out of Scope\n...\n## Users\n...\n## Tech Constraints\n...\n## Quality Bar\n...\n## Timeline\n...\n## Decisions\n...\n## Ambiguity Log\n| Dimension | Round 1 | Final | Resolution |\n"
```

The **Ambiguity Log** records how each dimension was clarified — this feeds into x-probe if the user runs premise validation later.

**Assumptions mode**: Claude reads the codebase, generates assumptions with confidence levels, and asks the user to confirm/reject:

1. Run: `$XMB discuss --mode assumptions`
2. Read 5-15 relevant files from the codebase
3. Generate assumptions with confidence (High/Medium/Low) and failure scenario
4. Present to user for confirmation
5. Save confirmed assumptions to CONTEXT.md

### Step 2: Research (Research Phase)

Parallel investigation with 4 agents. The JSON's `perspectives[]` (and `project_kind`) tell you which set of 4 to run — brownfield and greenfield use different perspectives because a greenfield project has no existing codebase to inspect:

1. Run: `$XMB research "goal description"`
2. Parse JSON output (`action: "research"`)
3. Spawn 4 agents in parallel (fan-out), each investigating one perspective:

**brownfield** (`project_kind: "brownfield"`) — inspects the existing codebase:
```
Agent 1: "stack" — What tech stack is in use? What's available? What fits?
Agent 2: "features" — Break down the goal into concrete feature requirements
Agent 3: "architecture" — How should this be structured? What patterns apply?
Agent 4: "pitfalls" — What could go wrong? Common mistakes? Edge cases?
```

**greenfield** (`project_kind: "greenfield"`) — no codebase exists, so look outward instead:
```
Agent 1: "landscape" — Find 3-5 existing tools/products/OSS solving a similar problem
                       (strengths / weaknesses / license). Identify common stack
                       patterns for this domain (what people usually reach for —
                       there is no existing codebase to inspect here). Derive 2-3
                       differentiation opportunities.
Agent 2: "user-scenarios" — Write 3-5 concrete scenarios ("As a {user}, when
                       {situation}, I want {action} so that {outcome}"). Split
                       MVP vs later using the Round 0 wedge answer. Derive [R#]
                       requirements from scenarios — every R# must trace to at
                       least one scenario. Conflicting scenarios become open questions.
Agent 3: "architecture" — same as brownfield
Agent 4: "pitfalls" — same as brownfield
```

Only the agent(s) whose `agents_spec[].web` is `true` (the greenfield `landscape` agent) may do live web research. When that agent needs it, apply this fallback chain and never fail silently: `mgrep --web` → `WebSearch` → if neither is available, do not skip the finding — record it as an explicit gap in ROADMAP.md ("web research unavailable for X").

All agents run with `run_in_background: true`, `model` from the research JSON `agents_spec[].model` — never hardcode.

4. Collect results, synthesize into:
   - **REQUIREMENTS.md**: Scoped features with IDs (`[R1]`, `[R2]`, ...)
   - **ROADMAP.md**: Phase breakdown mapping to requirements

```bash
$XMB save requirements --content "# Requirements\n\n- [R1] User authentication with JWT\n- [R2] CRUD API endpoints\n..."
$XMB save roadmap --content "# Roadmap\n\n## Phase 1: Foundation\n- R1, R2\n..."
```

### Optional: SWOT Analysis (for technology/approach decisions)

When research involves choosing between technologies, frameworks, or approaches, add a SWOT analysis after the 4-agent fan-out:

delegate (analyst, sonnet):
```
"## SWOT Analysis: {technology/approach decision}

Based on research findings:

| | Positive | Negative |
|---|---------|----------|
| **Internal** | **Strengths:** team expertise, existing code | **Weaknesses:** gaps, limitations |
| **External** | **Opportunities:** ecosystem, trends | **Threats:** risks, competition |

Then derive TOWS strategies:
- **SO:** Use strengths to capture opportunities
- **WO:** Address weaknesses to capture opportunities
- **ST:** Use strengths to mitigate threats
- **WT:** Address weaknesses to mitigate threats

Output: 2-3 actionable TOWS strategies that inform the plan phase."
```

This step is triggered when the research goal contains technology comparison keywords (vs, compare, choose, select, migrate).

5. **(Optional but recommended) Validate research artifacts**:
   ```bash
   $XMB discuss --mode validate
   ```
   - Checks completeness, consistency, testability, scope clarity, risk identification
   - If `verdict === "incomplete"`: address gaps via `discuss --mode interview --round 2`
   - If `verdict === "pass"`: proceed to gate

6. **Decision checkpoint (MUST — before gate pass)**:
   Before advancing, check CONTEXT.md `## Decisions` section for unresolved items.
   - Scan for keywords: "미결정", "undecided", "TBD", "조사 후 결정", "to be determined"
   - If unresolved decisions exist → present each to the user via AskUserQuestion with the research findings as context
   - User must confirm a choice for each unresolved decision before proceeding
   - Update CONTEXT.md with confirmed decisions (change "미결정" → chosen option)
   - Only after ALL decisions are resolved → proceed to gate pass

   Anti-patterns:
   - ❌ CONTEXT.md has "미결정" items → immediately `gate pass` (skips decisions)
   - ❌ Assume defaults for unresolved decisions without asking
   - ✅ Present each unresolved decision with research-backed options → AskUserQuestion → update CONTEXT.md → gate pass

7. **Before `gate pass` (greenfield only):** if the research JSON had `suggest_probe: true`, offer `/xm:probe` once as a one-line suggestion — never auto-run it:
   - Developer mode: "Before locking scope: consider `/xm:probe` to pressure-test this idea's premise (optional)."
   - Normal mode: `"본격적으로 만들기 전에 /xm:probe로 전제를 점검해볼 수 있어요 (선택)."`
8. Advance to Plan phase: `$XMB gate pass "Research complete — all decisions resolved"` → `$XMB phase next`

### Step 3: Plan (Plan Phase)

See `phases/plan.md` — full Plan phase walkthrough: PRD generation, PRD review (automatic + consensus), task decomposition, DAG design, plan-check validation (strict vs standard), and the 9-step orchestration. Covers PRD schema, consensus loop, strategy selection, and done_criteria definition.

### Step 4: Execute (Execute Phase)

0. **Entry gate**: `$XMB phase set execute` runs a deterministic `prd-check`. It BLOCKS entry to Execute if the PRD has unresolved low-confidence assumptions (`[A*, low]`) or unanswered `Status: blocking` open questions (the PRD template's own Gate rule). Resolve them via AskUserQuestion, or override with `$XMB phase set execute --force`. Inspect anytime: `$XMB prd-check --json`.
1. `$XMB run --json` — emits the execution plan AND marks the step's ready tasks RUNNING (so a later completion is actually recorded). It always emits valid JSON: when no tasks are ready it returns `{tasks: [], status: "all_done" | "in_progress" | "waiting", running: [...]}` — never human text.
2. Parse JSON → spawn Agent per task, using the plan's own fields (profile-aware — do NOT hardcode the model):
   - `subagent_type`: `task.agent_type === "deep-executor"` → `"oh-my-claudecode:deep-executor"`, else `"oh-my-claudecode:executor"`
   - `model`: use `task.model` from the plan (resolved from `model_profile`: economy/default/max)
   - `prompt`: use `task.prompt` value + **inject `done_criteria`** as acceptance contract:
     ```
     ## Acceptance Contract
     This task is complete only when all of the following conditions are met:
     {list task.done_criteria items as a checklist}
     Upon completion, report the fulfillment status of each condition.
     ```
   - `run_in_background: true` (parallel)
3. On completion: `$XMB tasks update <id> --status completed|failed`
   - **Record real token usage** whenever you know it (the subagent reports usage): append `--tokens-in <N> --tokens-out <M>`. This tags the metric `cost_source: actual` and auto-refreshes the forecaster's calibration, so future `forecast` numbers come from measured cost instead of static estimates. Without it the completion is priced from estimates (`cost_source: estimated`), which never calibrate. For an `inherit` task, also pass `--resolved-model <haiku|sonnet|opus>` so the cost is booked at the real tier, not the opus ceiling.
   - After a batch of measured completions you can also force a re-aggregation with `$XMB forecast update`; `forecast` prints whether it is `Estimate-only` or `Calibrated from actuals` (≥10 measured samples per size).
4. **Poll & route** with `$XMB run-status --json` (structured — do NOT scrape the human/emoji output). Branch on its fields:
   - `all_done: true` → confirm with the user, then `$XMB phase next` (see below)
   - `stale_running` non-empty (tasks stuck RUNNING after an interrupted or abandoned agent) → `$XMB run --reconcile` to reclaim them to PENDING, then `$XMB run --json` again
   - otherwise → follow `next_action` (`run --json` for the next step's ready tasks, `wait` while tasks are running, or `investigate failed/blocked tasks`)
   Re-running `$XMB run --json` is a safe resume — RUNNING tasks are not re-dispatched.

**Call AskUserQuestion before advancing to Verify phase.** When all tasks complete, ask the user to confirm before advancing (e.g., "All tasks completed. Proceed to the Verify phase?" in developer mode, or `"모든 태스크 완료. Verify 단계로 넘어갈까요?"` in normal mode). Do NOT run `phase next` without user confirmation.

#### Later Queue

During implementation or review-fix work, agents will notice unrelated bugs or cleanup opportunities. Do not fix them opportunistically.

Decision rule:
- If the issue blocks the current task or changes the correctness of the current fix, keep it in scope and update the active task / triage.
- If the issue does not affect the current task, capture it and continue the current task:
  ```bash
  $XMB later add "Fix stale cache warning" \
    --reason "Found while fixing auth; does not affect auth behavior" \
    --source "review-fix:F2" \
    --files "src/cache.ts"
  ```
- Later, convert it into real work with `$XMB later promote <id>`.
- Before claiming the current task is clean, run `$XMB later verify-scope` to catch edits to files that were captured as deferred work.

Later items are not permission to edit code. They are deferred work records.

#### Strategy-Tagged Execution

If a task has the `--strategy` flag, execute it via x-op strategy:

```
$XMB tasks add "Review auth module [R3]" --strategy review --rubric code-quality
$XMB tasks add "Design payment flow [R1]" --strategy refine --rubric plan-quality
$XMB tasks add "Implement CRUD endpoints [R2]"   # regular task (no strategy)
$XMB tasks add "Implement payment system [R4]" --team engineering  # assigned to team
```

Tasks with a strategy in `$XMB run --json` output include `strategy` and `strategy_hint` fields.
During execution, the leader determines the task type:

```
For each task in run output:
  if task.strategy:
    → /xm:op {task.strategy} "{task.task_name}" --verify --rubric {task.rubric || 'general'}
    → collect score, then $XMB tasks update {task.task_id} --score {score}
    → $XMB tasks update {task.task_id} --status completed
  elif task.team:
    → /xm:agent team assign {task.team} "{task.task_name}"
    → TL manages members internally, reports on completion
    → $XMB tasks update {task.task_id} --status completed
  else:
    → execute via regular agent delegation
```

#### Quality Dashboard

`status` output shows per-task score:

```
📊 Tasks (scored):
  [t1] Design payment flow [R1]     ✅ completed  Score: 8.2/10
  [t2] Review auth module [R3]      ✅ completed  Score: 7.5/10
  [t3] Implement CRUD endpoints [R2] ✅ completed
  [t4] Add error handling [R4]      ⚠ completed  Score: 6.1/10 ⚠

Project Quality: 7.3/10 avg (1 below threshold)
```

#### Automatic Strategy Recommendation

When a task has no strategy, the leader infers from the task name:

| Task keyword | Recommended strategy |
|-------------|---------|
| review, audit, check | review |
| design, plan, architect | refine |
| compare, evaluate, vs | debate |
| investigate, analyze, debug | investigate |
| implement, build, create | (regular execution) |

Recommendation only — not auto-applied. User must specify via `--strategy`.

### Step 5: Verify (Verify Phase)

1. Run quality checks: `$XMB quality`
2. Check requirement coverage: `$XMB verify-coverage`
3. Check acceptance contracts: `$XMB verify-contracts`
   - For each task with `done_criteria`, verify that the criteria are met
   - Output: `✅ t1: 3/3 criteria met` or `❌ t2: 1/3 criteria met — [missing: "at least 3 unit tests"]`
   - Unmet criteria → report to user for resolution before closing
4. If x-review returned `Request Changes` or `Block`, run the Review-Fix Gate:
   ```bash
   $XMB verify-review-fix --init
   # edit .xm/review/triage.json
   $XMB verify-review-fix
   ```
   Review-fix edits MUST be limited to `fix_now` findings and `fix_scope.allowed_files`. After applying fixes, run `$XMB quality`, `$XMB verify-review-fix`, and `/xm:review diff` again before closing.
5. **Call AskUserQuestion before closing.** Show quality check results first, then ask the user to confirm before advancing (e.g., "Quality checks passed. Proceed to the Close phase?" in developer mode, or `"품질 검사 완료. 프로젝트를 Close 단계로 넘어갈까요?"` in normal mode). Do NOT run `phase next` without user confirmation.
6. If user confirms: `$XMB phase next`

### Step 6: Close

`$XMB close --summary "Completed all requirements"`

---

## Quick Mode: One-Shot Plan→Run

A condensed version of the full 6-step flow for simple, well-defined goals.

### Quick Mode Entry Conditions
- **`--quick` flag explicitly provided** (e.g., `/xm:build plan "Build X" --quick`)
- Without `--quick`, `plan` ALWAYS runs the full flow: Research → PRD → Tasks. "plan" means planning, not skipping it
- Quick Mode is the ONLY case where Research is skipped — `phase set plan` is NEVER used outside Quick Mode
- Goal should be simple (expected 5 or fewer tasks); for complex goals, recommend full flow even with `--quick`

### Quick Mode Flow

```
Goal → Init → Auto-Plan → Review → Execute → Verify → Close
       (auto)   (auto)    (user)    (auto)     (auto)   (auto)
```

1. **Init**: `$XMB init quick-{timestamp}`
2. **Phase skip**: `$XMB phase set plan` (skip Research)
3. **Auto-Plan**: `$XMB plan "{goal}"` → parse JSON → create 3-5 tasks
   - Task decomposition from goal text only, without research artifacts
   - **Write a delta PRD** (NOT full). Quick Mode must not skip the PRD entirely — the Execute-entry wall requires one, and the AC parser + traceability + drift baseline all read it. Write a minimal PRD to `phases/02-plan/PRD.md` with ONLY these sections and the delta marker (deliberately NO `prd-template-version` marker, so the diagram gate stays a warning, not a block):
     ```markdown
     <!-- prd-tier: delta -->
     # PRD: {goal}

     ## Goal
     {one sentence}

     ## Success Criteria
     - [ ] {measurable, binary}

     ## 12. Acceptance Criteria
     - [ ] {testable by command/state} [R1]
     ```
     Verify it clears the gate: `$XMB prd-check --json` (expect `blocked: false`, `tier: "delta"` — diagram/structure entries appear only as `warnings`).
   - Register tasks: `$XMB tasks add "..." --size small|medium`
   - Auto-generate done-criteria: `$XMB tasks done-criteria`
4. **Quick Review**: Show task list via AskUserQuestion
   ```
   Quick Plan:
   - t1: {task1} (small)
   - t2: {task2} (medium, depends: t1)
   - t3: {task3} (small)

   1) Execute — proceed as-is
   2) Revise — add/change tasks
   3) Full flow — run full Research→PRD→Plan
   ```
5. **Execute**: `$XMB steps compute` → `$XMB phase set execute` → `$XMB run --json`
   - Parse JSON → spawn Agent per task using `task.agent_type` + `task.model` (same as Step 4)
   - Poll `$XMB run-status --json`; on `all_done` advance, on `stale_running` run `$XMB run --reconcile` then re-run `run --json`
6. **Verify**: `$XMB phase set verify` → `$XMB quality` → `$XMB verify-contracts`
7. **Close**: `$XMB close --summary "Quick mode completed"`

### Error Recovery

If an error occurs during Quick Mode execution:

1. **Task failure**: Check the failed task's error, fix it, then re-run `$XMB run`
   - `cmdRun` starts from non-completed tasks, so re-running is effectively a resume
   - No separate --resume flag needed
2. **Circuit breaker open**: Check `$XMB circuit-breaker status` → `$XMB circuit-breaker reset` → `$XMB run`
3. **Full restart**: `$XMB phase set plan` → modify tasks → `$XMB run`

---

## Error Recovery Guide

When x-build run fails during execution, recovery is possible without a separate checkpoint/resume mechanism:

| Situation | Recovery method |
|------|----------|
| Single agent failure | `$XMB tasks update <id> --status pending` → `$XMB run` |
| Multiple agent failures | Identify failure cause → modify tasks → `$XMB run` |
| Circuit breaker open | `$XMB circuit-breaker reset` → `$XMB run` |
| Incorrect task decomposition | `$XMB phase set plan` → modify tasks → `$XMB steps compute` → `$XMB phase set execute` → `$XMB run` |
| Session terminated mid-run | In new session: `$XMB status` to check current state → `$XMB run` (previous state is preserved) |

> **Core principle**: The CLI persists all state to `.xm/build/` files, so state is preserved even if the session disconnects. `x-build run` always starts from incomplete tasks.

## Applies to

Used by x-build routing after init/plan command parsing. The leader consults this guide during phase execution. For the full command reference, see the main SKILL.md. For discuss modes (interview/assumptions/validate/critique/adapt), see `commands/discuss.md`.
