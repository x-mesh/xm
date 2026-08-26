# x-build Command Reference

Full CLI surface. SKILL.md links here instead of inlining it — the catalog is lookup material, not decision logic.

## Commands

### Project
- `init <name>` — Create project (`.xm/build/` in cwd)
- `list` — List all projects
- `status` — Show status with progress bars
- `next [--json]` — Smart routing: tells you what to do next (JSON mode for skill layer)
- `handoff [--restore]` — Save/restore session state
- `close [--summary "..."]` — Close project
- `dashboard` — Multi-project overview

### Research Phase
- `discuss [--mode interview|assumptions|validate]` — Gather & validate requirements
- `research [goal]` — Parallel agent investigation

> **Agent models always come from CLI JSON** (`task.model`, `agents[n].model`, `agents_spec[n].model`, `prd_writer.model`) — resolved from `model_profile`/`model_overrides` in `.xm/config.json`. Never hardcode a model when spawning agents.
>
> **`inherit` means OMIT the parameter**: when the CLI JSON says `"model": "inherit"`, spawn the agent WITHOUT a `model` parameter — the subagent then runs on the harness-inherited default (the session/parent model as the harness resolves it; measured 2026-07: a Fable session inherited opus for subagents, never below opus). NEVER pass the literal string `"inherit"` to the Agent tool (it is not a valid value) and never substitute a hardcoded tier for it.

### Deliberation (cross-phase)
- `discuss --mode interview [--round N]` — Multi-round requirements interview with drill-down
- `discuss --mode assumptions` — Codebase-driven assumption generation
- `discuss --mode validate` — Research artifact completeness verification (Research phase)
- `discuss --mode critique [--round N]` — Strategic plan review by Critic+Architect (Plan phase)
- `discuss --mode adapt ["topic"]` — Adaptive review between execution steps (Execute phase)

### Plan Phase
- `plan <x-plan args> [--replace] [--no-import]` — deprecated alias for `xm plan`; saves the PlanEnvelope to `.xm/plan` and imports it into the current project when it is executable (`--replace` overwrites existing plan artifacts, `--no-import` keeps it out of the project)
- `legacy-plan "goal" [--interview|--draft] [--profile light|standard|deep]` — former x-build PRD/task/phase planner; explicit compatibility use only
- `build "goal" [--profile light|standard|deep]` — same Plan lifecycle, then continue Execute only after content-bound approval
- `plan-check` — Validate the existing 15 quality dimensions for Execution Readiness plus 3 Decision Quality dimensions
- `prd-check [--json]` — Deterministic PRD gate (blocks Execute on unresolved `[A*, low]` / `Status: blocking`); `phase set execute --force` to override
- `prd-gate [--threshold N]` — Judge panel PRD quality evaluation (rubric-based scoring)
- `consensus [--round N] [--cross-vendor]` — 4-agent consensus review (architect/critic/planner/security); `--cross-vendor` assigns each role to a different model vendor via `xm panel cross` (opt-in, graceful single-vendor fallback). Default without the flag: `.xm/config.json` `cross_vendor.build` ?? `cross_vendor.default`; `--no-cross-vendor` forces single — see `references/cross-vendor-consensus.md`
- `phase next` / `phase set <name>` — Move between phases
- `gate pass/fail [message]` — Resolve gate
- `checkpoint <type> [message]` — Record checkpoint

### Execute Phase
- `tasks add <name> ... [--review-group build]` — every task belongs to a shared normal/worktree review group; default is `build`
- `tasks list` / `tasks remove <id>` / `tasks update <id> --status <s> [--desc "..."] [--done-criteria "..."] [--expected-files "a,b"]` (pass an empty string to clear expected files)
- `tasks done-criteria` — Auto-derive done criteria from PRD for all tasks
- `import-plan <envelope.json> [--json] [--replace]` — Validate a native PlanEnvelope and compile it into x-build tasks, steps, parallel metadata, requirements, and a delta PRD; approval remains required and existing artifacts require explicit replacement
- `later add|list|promote|dismiss|verify-scope` — Capture off-scope work discovered during a task without editing it; verify open later files stayed untouched. `run-status` (text and `--json`) reports `later.open` and `later.touched[]` as ADVISORY signals — a touched deferred file never blocks the run, but you must act on it: promote the item, or revert the edit. Never leave a reported `touched` unmentioned to the user.
- `steps compute` — Calculate step groups from dependencies
- `steps status` / `steps next` — Step progress
- `run` — Execute current step via agents
- `run --json` — Machine-readable execution plan (also marks ready tasks RUNNING; always emits JSON). Also emits `worktree_signal` (see [Worktree Execution Mode](#worktree-execution-mode))
- `run --reconcile [--dry-run] [--stale-min N]` — Reclaim stale RUNNING tasks (interrupted/abandoned agents) to PENDING; `protected[]` lists NEEDS_FIX/BLOCKED/MERGING worktree tasks kept from reconcile
- `run-status [--json]` — Execution progress; `--json` gives structured state (`all_done`, `steps`, `stale_running`, `blocked_tasks`, `worktree_tasks`, `next_action`) for orchestrator routing
- `task-check <task-id> [--json]` — run configured `build.task_checks` in the current task cwd and persist completion evidence; required for newly planned normal and worktree tasks
- `review-group [name] [--depth checks-only|solo|panel] [--rounds 1|2] [--json]` — group-boundary review at the configured depth (default `solo`). Solo flow: the CLI returns `{pending:"solo", solo:{patch, model}}` → spawn ONE reviewer agent on that patch with that model → `review-group <name> --verdict pass|fail [--notes "..."]` records it (fail-closed if the git target moved). `--depth panel` runs the cross-vendor panel — only when the user asks
- `templates list` / `templates use <name>` — Use task templates

**Worktree backend** (optional Execute-phase fan-out — see [Worktree Execution Mode](#worktree-execution-mode)):
- `run --worktrees [--dry-run] [--max-parallel N] [--base X] [--branch-prefix P] [--no-worktrees] [--json]` — route Execute through the worktree backend
- `worktrees plan|status|resume [task-id...]|cleanup [--json]` — plan/observe/finish worktree runs (`resume` runs the serialized `gk finish` queue)
- `gate-panel --project <p> --task <id> --phase before|after|release --patch <path> --json` — panel verdict → merge-gate exit code (0 pass / 1 policy block / 2 wrapper|panel error)
- `review-integration [--base main] [--target develop] [--max-bytes N] [--json]` — release-time `main...develop` batch review via gate-panel

**Blocking hooks** (optional — make review-fix discipline machine-enforced, not prompt convention):
- `hooks install` — write two native Claude Code hooks into `.claude/` (non-destructive, idempotent merge): a PreToolUse **scope-guard** that blocks Edit/Write to files outside `triage.fix_scope.allowed_files` during an active review-fix, and a Stop **stop-gate** that blocks ending a turn while a Critical/High `fix_now` finding is unresolved (last x-review verdict not LGTM). Disk-only, fail-open. Bypass any run with `XM_BUILD_HOOKS_OFF=1`.
- `hooks status` / `hooks uninstall` — report / remove the two entries (other hooks untouched).

### Verify & Close
- `quality` — Run test/lint/build checks
- `verify-coverage [--strict]` — Check requirement-to-task mapping (advisory; `--strict` exits 1 on uncovered)
- `verify-traceability` — R# ↔ Task ↔ AC ↔ Done Criteria matrix (exits 1 on a gap)
- `verify-contracts` — List each completed task's done_criteria as a checklist. ADVISORY ONLY: it prints contracts for you or an agent to inspect and always exits 0 — it does not verify fulfillment
- `verify-review-fix [--init] [--reverify <F#|finding_id> --outcome resolved|persistent|regression --evidence <text>]` — Gate x-review fixes through Phase-1 snapshots, exact-triage authorization, allowed-file scope, and byte-bound finding reverification. A bound review context additionally requires finding-level references/evidence plus host evidence for every invariant and acceptance check, including LGTM reviews. Every passing gate appends its triage decisions (and every accepted `--reverify` outcome) to `.xm/review/triage-ledger.jsonl` — ids, lens, severity, decision only; no finding text.
- `review-precision [--since 30d | --last N] [--lens <name>] [--min-precision 0.7] [--json]` — Error analysis over the triage ledger: per-lens and per-severity `precision = fix_now / (fix_now + false_positive)` plus reverification outcomes (resolved / persistent / regression). Unmeasured lenses print `—`, never 0%. `--min-precision` exits 2 when a measured lens falls below it (CI gate). The dashboard Reviews page shows the same table (`/api/review/precision`).
- `verify-drift [--threshold N]` — Compute weighted PRD baseline drift (0.5×goal + 0.3×constraint + 0.2×ontology); writes phases/04-verify/drift-score.json and gates on threshold
- `context-usage` — Show artifact token usage

### Analysis
- `forecast` — Per-task cost estimation ($) with complexity-adjusted confidence levels
- `forecast accuracy [--all] [--json]` — MAPE of past predictions vs MEASURED actuals. Reports "no calibrated pairs" rather than a flattering 0% when nothing was measured, and flags <5 samples as a hint, not a measurement. Use it before trusting a `forecast` number.
- `roi [--by model|role|strategy] [--json]` — quality-per-dollar (Score/$) from MEASURED actuals only. Suggests a `model_overrides` change when one model clearly earns its spend — but only from calibrated groups (≥5 tasks that reported both `--tokens-in/--tokens-out` AND `--score`); estimated cost or the default 1.0 quality never counts, and it never writes config itself.
- `metrics` — Phase duration, task velocity
- `effectiveness [--since 30d] [--profile ...] [--compare light,deep] [--json]` — aggregate local semantic workflow-value metrics. Artifact content is never recorded; `.xm/build/metrics/sessions.jsonl` stores hashes/counts and links to `xm-trace` with `trace_id`. Planning cost remains `null` and `planning_cost_coverage` remains below 1 until phase cost data is supplied or imported from a trace.
- `decisions add "..." [--type] [--rationale]` / `decisions list` / `decisions inject`
- `summarize` — Step summaries
- `save <context|requirements|roadmap|project|plan>` — Save planning artifact

### Export/Import
- `export --format md|csv|jira|confluence`
- `import <file> --from csv|jira`

### Context & Artifacts
- `context [project]` — Generate phase-aware context brief
- `phase-context [project]` — Load phase-specific context for agents
- `save <context|requirements|roadmap|project|plan> --content "..."` — Save planning artifact
- `summarize [step-id]` — Summarize completed step execution

### Resilience
- `circuit-breaker status` — Show circuit breaker state (closed/open/half-open)
- `circuit-breaker reset` — Manually reset circuit breaker to closed

### Settings
- `mode developer|normal`
- Shared config (agent_max_count, mode) is managed by the top-level `xm config show|set|get` — `config` is NOT an x-build subcommand
- `watch [--interval N]`
- `alias install`
