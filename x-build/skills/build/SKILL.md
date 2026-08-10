---
name: build
description: Phase-based project harness — manage project lifecycle, DAG execution, cost forecasting, and agent orchestration
allowed-tools:
  - AskUserQuestion
---

<Purpose>
x-build manages the full project lifecycle (Research → Plan → Execute → Verify → Close) with structured requirements gathering, parallel research, plan validation, DAG-based step execution, quality gates, cost forecasting, decision memory, and agent orchestration.
</Purpose>

<Use_When>
- User wants PRD-based task tracking (new OR existing project)
- User asks to plan, execute, or verify work
- User says "build me ~" or describes a goal (auto-plan)
- User says "start project", "new project", "init"
- User asks about project status, costs, or decisions
- User wants to export to Jira, Confluence, CSV
</Use_When>

<Do_Not_Use_When>
- Simple one-off tasks that don't need project structure
- Git operations not related to x-build
</Do_Not_Use_When>

# x-build — Phase-Based Project Harness

## Model Routing

| Subcommand | Model | Reason |
|------------|-------|--------|
| `list`, `status`, `tasks list`, `decisions` | **haiku** (Agent tool) | Read-only status display |
| `init` (interactive) | **session** (leader) | Requires AskUserQuestion — leader-only |
| `plan`, `forecast`, `research`, `run` | **session** (leader) | Judgment work runs on the model the user picked via /model — never downgrade |

For haiku-eligible commands, delegate via: `Agent tool: { model: "haiku", prompt: "Run: [command]" }` <!-- managed-model: writer -->

### Model Disclosure (required every phase)

The user pays per token and cannot see which model an agent ran on. Before spawning any
agent batch — research, consensus, execute step, review group — print one line naming the
models, read from the CLI JSON (`.model` per agent/task), never from memory:

```
🤖 Execute step 2 — 3개 병렬: T4·T5 executor=sonnet · T6 deep-executor=opus
```

Rules: state the tier the Agent tool actually receives. For `"model": "inherit"` print
`inherit(세션=<current session model>)`, since the parameter is omitted. When a step mixes
tiers, name each — never collapse to one label. Report the same after a phase completes
only if the resolved model differed from the announced one (e.g. an `inherit` task).

## Mode Detection

Check mode ONCE at session start, then cache it for the whole session — never re-probe
per command (a per-command probe nearly doubles CLI invocations for zero information):
```bash
xm build mode show --json    # {"ui_mode":"developer","autopilot":true}
```
`mode show` without `--json` prints `ui_mode=<mode>` as its FIRST line, so
`mode show 2>/dev/null | head -1` also works. `run`, `run-status`, and `status` `--json` envelopes
also echo `ui_mode` and `autopilot`
(`ui_mode`, not `mode` — `mode` is the worktree-backend marker in run --json), so any
command you were about to run anyway refreshes the cache for free. Re-check only after
an explicit `mode set`.

**Developer mode**: Use technical terms (DAG, phase, gate, step, context, retry, circuit breaker). Concise.

**Normal mode**: Guide in plain Korean.
- Direct expressions without metaphors: "단계", "할 일", "확인", "다음"
- Use "~하세요" style
- Replace technical terms with explanations: "DAG" → "순서 계산", "gate" → "넘어가기 조건", "circuit breaker" → "자동 중단"
- Keep commands in English but add explanation: `steps compute` → "할 일의 실행 순서를 계산합니다"
- Key information first, supplementary details after

### Korean output style (avoid AI-slop)

Universal (both modes) — these read as machine-generated in any register:
- Drop empty intensifiers ("매우 / 완벽하게 / 강력한 / 원활하게 / 혁신적인") unless they carry a specific, real claim.
- No forced rule-of-three or "~뿐만 아니라 ~까지" balance that adds no fact.
- No hedged non-conclusions ("결국 상황에 따라 다르다 / 균형이 필요하다"). End on a concrete fact, number, or next action.

Developer mode: terse and direct — lead with the result; state findings/actions without a 권고형 결말 pile-up ("~해야 한다" sentence after sentence).
Easy/normal mode: accessible Korean is the goal — polite guidance ("~해 보세요"), one line of context for non-experts. Keep commands, flags, paths, and proper nouns in English; on first use write a domain term as Korean(original), e.g. 결론(verdict). Still apply the universal rules; accessible ≠ padded or vague.

**Pass mode when delegating agents (MANDATORY):**
Inject mode into all delegate/fan-out prompts. When in Normal mode:
- Add to first line of prompt: `"언어: 한국어로 작성. 기술 용어는 원어 유지."`
- All artifacts (PRD, CONTEXT.md, REQUIREMENTS.md, etc.) are generated in Korean
- Section titles remain in English (Goal, Success Criteria, etc.)

## CLI

All commands via the `xm` dispatcher:
```bash
xm build <command> [args]
```

Shorthand in this document: `$XMB` means `xm build`. The dispatcher handles server-mode auto-start internally.

> **⚠ Call `xm build <command>` directly. Claude Code's Bash tool starts a fresh shell on every invocation — shell functions (`xmb()`) defined in one call do NOT persist to the next, causing `command not found: xmb`. Never define a helper across calls; always use the dispatcher.**
>
> **Fallback** (only when `xm` is not in PATH — rare; `${CLAUDE_PLUGIN_ROOT}` is NOT exported to Bash subprocesses, so don't rely on it bare):
> ```bash
> # Prefer server client when available, else direct CLI
> XMB_CLI=$(ls -d ~/.claude/plugins/cache/xm/{build,xm}/*/lib/server/xm-client.mjs 2>/dev/null | sort -V | tail -1)
> [ -f "$XMB_CLI" ] || XMB_CLI=$(ls -d ~/.claude/plugins/cache/xm/{build,xm}/*/lib/x-build-cli.mjs 2>/dev/null | sort -V | tail -1)
> case "$XMB_CLI" in
>   *xm-client.mjs) node "$XMB_CLI" x-build <command> [args] ;;
>   *)              node "$XMB_CLI" <command> [args] ;;
> esac
> ```
>
> **Forbidden:** `XMB="node ..."; $XMB <command>` — zsh treats the quoted string as a single command and fails.

## Phase 0: Project Environment Detection

See `references/environment-detection.md` — package-manager / test-runner detection, base-branch
detection (never hardcode `main`), validation-script discovery, and the offline-by-default check
policy with its `allow_live_provider_checks` opt-in.

Probe once per project and reuse the result for the whole session. Pull `done_criteria` and
quality-check commands from detection, never from memory. If detection is ambiguous (multiple
lockfiles, unknown manifest), ask via AskUserQuestion rather than guessing.

## AskUserQuestion Dark-Theme Rule

See `references/ask-user-question-rule.md` — the `question` field is invisible on dark terminals; put context in markdown, use `header`/`label`/`description` for user-facing text.

## Interaction Protocol

**CRITICAL: AskUserQuestion is reserved for user-owned intent and decision gaps. Do not create a turn boundary for routine task completion, phase movement, or per-task review.**

Rules:
1. **AskUserQuestion is REQUIRED only when a user-only answer materially changes** scope/task graph, public behavior, success criteria, irreversible/high-risk contracts, authority, external coordination, or compliance. Batch at most 3 blocking questions into one turn.
2. **Routine transitions are automatic once their deterministic gates pass.** Plan → Execute remains a `decision` gate because it approves direction. A failed quality/group-review gate, agent execution error, or newly discovered user-only ambiguity still stops. Autopilot does not pass `decision` gates.
3. **NEVER skip Research silently** — `plan "goal"` without `--quick` goes through Research, SCALED by the deterministic gauge in the plan JSON's `research_signal` (from `research-check`): `full` → 4-agent research; `slim` → 1-2 targeted agents on the HIT signals; `quick-eligible` (0/4 hits ONLY) → you MAY suggest `--quick` via AskUserQuestion, and proceed quick ONLY if the user confirms. In yolo/explicit autonomous mode, `quick-eligible` is enough to choose `--quick`. A missing/failed `research_signal` = treat as `full`. Outside that mode, auto-skipping without explicit confirmation, or calling `phase set plan` to dodge Research, is FORBIDDEN.
4. **Artifacts MUST be printed before review (Output Gate)** — any LLM-produced artifact (research findings, PRD, task breakdown, forecast, critique, consensus result) MUST be output in FULL to the user **before** calling AskUserQuestion or advancing the phase. Save-and-ask-without-showing is FORBIDDEN. Saving to disk does NOT count as showing; a summary paragraph does NOT count as showing — print the artifact content. **Self-check gate (enforce, don't just intend):** immediately before the gating `AskUserQuestion`, confirm the full artifact text was printed in the CURRENT turn, and make the question's FIRST option cite a concrete detail from it (a task id, an `R#` requirement, or a `done_criteria` string). If you cannot cite one, you did not show it — print it first, then ask.
5. **Research output MUST be persisted** — after each research sub-agent (stack / features / architecture / pitfalls) completes, immediately call `$XMB save research-notes --agent <name> --content "..."` to append the RAW agent output to `phases/01-research/notes.md`. Never discard raw agent output by only saving the synthesized ROADMAP — the user must be able to audit the evidence chain.
6. **Plan Review** — present one Plan Bundle (intent/PRD/tasks/groups/checks), then ask for the single Plan → Execute direction approval. Approval is bound to `plan_hash`; any plan change invalidates it.
7. **Execute review** — do not review every task. Run configured task-local checks in each task cwd. `build.review_mode` decides whether the LLM review is optional (`manual`) or a hard boundary (`auto`); every mode still requires the deterministic `group-check <g>` after all group tasks complete. `build.review_depth` decides HOW HEAVY the LLM review is. Default depth is `solo`: `review-group` returns a pending spec — spawn ONE reviewer agent on `solo.patch` with `solo.model` (announce it per Model Disclosure), triage its findings, then record `review-group <g> --verdict pass|fail --notes "..."`. NEVER escalate to the cross-vendor panel on your own: `--depth panel` (or `/xm:panel review`) is user-invoked only. Explicit panel reviews default to one round (`--rounds 2` opts into adversarial refutation).
8. **Verify → Close** — advance after deterministic quality checks unless a new user decision is required.
9. **Announce models before every agent batch** — see [Model Disclosure](#model-disclosure-required-every-phase). Spawning agents without naming their tiers is FORBIDDEN; the user must be able to see cost as it is incurred, not reconstruct it afterward.

10. **PRD is MANDATORY** — every project MUST have `phases/02-plan/PRD.md` before Execute phase. If tasks were added without PRD (e.g., direct `tasks add`), generate PRD from existing tasks before proceeding.
11. **Task documentation** — every task MUST have `done_criteria` before execution starts. If missing, auto-derive from PRD requirements using `$XMB tasks done-criteria`.
12. **No phantom projects** — a project without `phases/02-plan/PRD.md` and CONTEXT.md is invisible to dashboard and untrackable. Always generate these artifacts.
13. **PRD MUST be saved via `$XMB save plan`** — never `Write` PRD.md directly. A direct write skips the `<!-- prd-template-version -->` stamp, silently degrading the diagram gate (`prd-check` §8) from blocking to warning.

### Yolo / fully autonomous mode

When the host is in yolo mode, or the user explicitly asks to proceed autonomously, do not turn routine choices into questions. The CLI cannot see that host setting; the skill layer applies this policy and records every assumed choice in `CONTEXT.md` or the decision log.

- Continue automatically through research scale, task decomposition, implementation, review boundaries, Verify, and Close once deterministic checks pass.
- At `research_signal: quick-eligible`, enter `--quick` without an extra confirmation. For `slim`/`full`, keep the required research but choose its scale automatically.
- The Plan Bundle direction approval remains required. Current CLI state does not record or bypass a
  `decision` gate, so do not claim that yolo/autopilot approved it automatically.
- Ask for that direction approval and for any additional user-owned choice; batch additional
  choices when possible. Do not ask for routine confirmations.
- A yolo setting never bypasses a `decision` gate, failed tests, a failed quality gate, missing
  task-check evidence, or an explicit user constraint.

Anti-patterns:
- ❌ `plan "goal"` → `phase set plan` → PRD generation (skips Research)
- ❌ 일반 모드에서 `research_signal: quick-eligible` → quick 플로우 자동 진입 — yolo/명시적 자율 실행일 때만 자동 진입 가능
- ❌ 신호 1-2개 HIT인데 "거의 quick감"이라며 조사 생략 — 1개라도 HIT면 조사 규모만 조절(slim), quick 제안 금지
- ❌ Research agents complete → synthesize to ROADMAP.md → save → advance (raw agent output never shown, never persisted to `notes.md`)
- ❌ Task breakdown generated → `$XMB save plan` → AskUserQuestion (task list never shown to user)
- ❌ PRD generated → show to user → but forget `$XMB save plan` (PRD lost, not in dashboard)
- ❌ Per-task implementation → expensive panel → user confirmation (repeated for every task)
- ❌ Spawn 4 research agents → results appear → user never learns which tier burned the tokens
- ❌ `init` → `tasks add` → `tasks update --status in_progress` (no PRD, no CONTEXT.md — dashboard blind spot)
- ✅ `plan "goal"` → init → intent-check → **interview only if needed** → research → persist findings → PRD/tasks → print one Plan Bundle → direction approval
- ✅ Plan phase: generate tasks → **print full PRD + task list with done_criteria + groups/checks** → `save plan` → AskUserQuestion once for the direction approval
- ✅ If tasks added directly: generate PRD from task list before first `tasks update --status in_progress`

More anti-patterns:
- ❌ All tasks complete → `phase next` without the final group review
- ❌ Show plan and ask "Shall we proceed?" as text (must use AskUserQuestion)
- ✅ All tasks in `build` complete → optional `review-group build` in manual mode → mandatory `group-check build` → Verify (`review_mode=auto` makes the LLM review mandatory too)

## Phase Lifecycle

```
Research → [PRD] → Plan → Execute → Verify → Close
```

Each phase has an exit gate. The gate blocks advancement until conditions are met:

| Phase | Exit Gate | Condition |
|-------|-----------|-----------|
| Research | human-verify | CONTEXT.md or REQUIREMENTS.md must exist + no unresolved decisions in CONTEXT.md |
| Plan | **decision** | PRD.md + tasks/groups + plan-check + current `plan_hash` approval |
| Execute | auto | All tasks completed + every review group passed exactly once at its boundary |
| Verify | quality | test/lint/build all pass |
| Close | auto | — |

**Gate types and what autopilot does to each:**

| Type | Blocks? | Autopilot |
|------|---------|-----------|
| `auto` | no | — |
| `human-verify` | yes — needs `gate pass` | **downgraded to `auto`** (it is a confirmation) |
| `quality` | yes — test/lint/build must pass | untouched |
| `decision` | yes — needs `gate pass` | **untouched** (it is a direction approval, not a confirmation) |

**Turn economy:** autopilot defaults to `true`. Set `autopilot: false` in
`.xm/config.json` (or `XMB_AUTOPILOT=0` for one shot) to require every
`human-verify` confirmation gate; when enabled, every
`human-verify` confirmation gate self-downgrades to `auto`, while `quality` and `decision`
gates still block (broken code / wrong direction stay human-checked). Chain deterministic
transitions instead of spending turns on them: `gate pass --advance` runs `phase next` in
the same invocation, and `run` already auto-advances an approved plan into Execute. Never
spend a turn on a probe whose answer is already in JSON you hold (`ui_mode`, `autopilot`,
`next_action`, steps summaries).

`decision` exists because `plan → execute` is the one transition no automated check can guard.
`plan-check` proves the plan is well-formed; `quality` proves the code is correct. Neither can tell
that a well-formed plan produces correct code aimed at the wrong goal — e.g. the user asked to add an
option and the plan changes the default instead. Only the person who holds the unexpressed intent can
catch that, so autopilot must never pass this gate. Never route a phase to `decision` merely because
it feels important: use it only where a human's intent is the sole possible check.

**Plan exit gate enforcement:** Before advancing from Plan → Execute, check:
1. `phases/02-plan/PRD.md` exists and is non-empty
2. All tasks have `done_criteria` (not null)
3. **Output Gate (Rule 4) satisfied** — the full PRD text AND the task list with done_criteria were printed to the user this session, and the plan-review `AskUserQuestion` cited a concrete artifact detail. A gate pass on save-only (nothing shown in chat) is FORBIDDEN.
4. If any check fails → block transition; show the missing artifact (or generate it first), then re-ask.

## Routing

Parse user's `$ARGUMENTS` and current project state to determine the action.

**MANDATORY first step (all branches):** Run `$XMB list` BEFORE any routing decision. Never decide "new project vs existing" from user phrasing or git branch state alone. With no new goal, resume the active project via `$XMB next`. With an explicit new goal, never silently bind it to an unrelated active project: pass `--project` when the target is known, otherwise honor the CLI's `select-project` stop or initialize a new project. A git feature branch is NOT an x-build project.

### No arguments (empty)
1. Run `$XMB list` to check for existing projects
2. **If active project exists** → run `$XMB next --json` and follow Smart Router
3. **If no project exists** → immediately ask the user for a goal (AskUserQuestion):
   - Developer mode: `"What do you want to build? Describe the goal in 1-2 sentences."`
   - Normal mode: `"어떤 것을 만들고 싶으세요? 1-2문장으로 목표를 알려주세요."`
4. After receiving goal → treat it as a bare build goal below.

### Bare goal (no `plan` verb)
`$xm-build "goal"` means build: run the same Plan lifecycle first, then continue to Execute only after Plan Bundle approval. Route to `$XMB build "{goal}"`; never bypass Plan.

### `plan` (no goal argument)
1. Check for active project
2. **If active project in Plan phase** → run `$XMB next --json` to determine next plan action
3. **If active project in other phase** → show current phase, suggest `phase set plan` if appropriate
4. **If no project exists** → same as "No arguments" above — ask for goal immediately

### `plan "goal"` (with goal argument)
`plan` is plan-only: it always enters planning, produces a Plan Bundle, and stops after approval. It never silently continues to Execute.

Before Research, run the emitted `intent_check`:
1. Inspect repository/memory silently for discoverable facts.
2. Classify gaps as `fact_gap`, `intent_gap`, `implementation_choice`, or `authority_gap`.
3. Ask only user-owned blockers, at most 3 in one turn. Do not ask repository facts.
4. Research runs after intent is ready; research may reopen clarification if it discovers a new user-only blocker.

Use `plan --interview` when the user explicitly wants detailed refinement. Use `plan --draft` to produce a non-executable draft without blocking questions.
1. Check for active project
2. **If no project** → `$XMB init {slug}` → **start from Research phase** (intent-check → research → then plan):
   - Do not infer that greenfield means interview. Run Round 0 / `discuss --mode interview` only when `intent_check.readiness=clarify`, the user passed `--interview`, or research reopens a user-only blocker.
   - When clarification is needed, ask the emitted questions together (maximum 3), persist the refined intent, then continue without another confirmation.
   - Run `$XMB research "{goal}"` (4-agent parallel investigation; perspectives differ by `project_kind` — see workflow-guide)
   - Save CONTEXT.md, REQUIREMENTS.md, ROADMAP.md — REQUIREMENTS.md MUST list each requirement as a `- [R1] <text>` item with sequential IDs; free-form prose cannot be read by verify-coverage/verify-traceability (the Verify gate then fails on a vacuous 0-requirement parse)
   - `$XMB gate pass` → `$XMB phase next` (Research → Plan)
   - Then generate PRD and proceed with plan
   - **NEVER skip Research by calling `phase set plan` directly — Research produces the artifacts that PRD depends on.** Scale it instead: read `research_signal` from the plan JSON (`full` = 4 agents / `slim` = 1-2 targeted agents on HIT signals / `quick-eligible` = suggest `--quick` via AskUserQuestion, only at 0/4; yolo/explicit autonomous mode may choose it directly).
3. **If project exists in Research phase** → check artifacts, continue Research if incomplete, then plan
4. **If project exists in Plan phase** → `$XMB plan "{goal}"` (already past Research)

### `plan "goal" --quick` (explicit Quick Mode)
1. `$XMB init quick-{timestamp}` → `$XMB phase set plan` → Quick Mode flow (see [Quick Mode](#quick-mode-one-shot-planrun))
2. Only enters Quick Mode when `--quick` flag is **explicitly** provided, OR when `research_signal.recommendation === "quick-eligible"` (0/4 signals) and the user confirmed it; in yolo/explicit autonomous mode, that safe recommendation is sufficient.
3. Outside yolo/explicit autonomous mode, Research is skipped ONLY via explicit user opt-in.

### `dispatch "<instruction>"` (lightweight tracked execution)
1. `$XMB dispatch "<instruction>" [--model M|--role R] [--done-criteria "..."] --json` — one task, no PRD/phase ceremony; the CLI prints a LOUD exemption notice (relay it to the user verbatim).
2. Spawn ONE agent with the returned `task.prompt`. Model rule is the standard contract: `model` field is a tier → pass it; `"inherit"` → OMIT the model parameter.
3. A harness `completed` notification is not task completion. Require the returned `completion_contract`: final response ends with `## 완료 보고`, every done criterion is addressed, and `x-build task-check <id>` passed. If any is absent, resume the same agent with the missing requirement up to twice; then run `task.on_fail`, never `task.on_complete`.
4. Only after that evidence, verify the result against `done_criteria` yourself and run `task.on_complete` (append `--resolved-model <tier>` when the task ran on inherit).
5. If the notice says dispatch tasks are piling up (≥2), suggest promoting to a PRD flow — do not keep dispatching a multi-step project.
6. For delegation-critical instructions, set `--interface-contract`/`tasks update --interface-contract` (signatures/invariants, 2-3 lines) — it is injected into the prompt as `## Interface Contract`.

### Other commands
- Route directly to the matching CLI command (init, status, discuss, research, run, etc.)

---

## Commands

See `references/commands.md` — the full CLI surface grouped by phase (Project, Research,
Plan, Execute, Worktree backend, Verify & Close, Analysis, Export, Settings), including the
model-resolution rule that agent models always come from CLI JSON and that `"model": "inherit"`
means OMIT the Agent tool parameter.

`xm build help` prints the same surface from the CLI.

---

## Worktree Execution Mode

Optional Execute-phase backend: fan parallel-safe tasks out into isolated `gk` worktrees. It uses the same tasks, `task_checks`, review groups, and lifecycle as normal execution; only the cwd/isolation backend differs. With default `build.review_scope=group`, per-task `gk finish` is ungated. `build.review_mode=manual` makes the LLM group review optional, while the final deterministic `group-check` remains mandatory; `auto` makes both the LLM review and deterministic check shared hard boundaries. Set `build.review_scope=task` only for an explicit high-risk compatibility policy.

### 3-layer mode decision (no separate wizard or dashboard)

Worktree fan-out is the Execute-phase run backend, decided on top of existing conventions — not a new pipeline:
1. **config** — `worktree.*` in `.xm/build/config.json` or `.xm/config.json` (persistent project policy). Priority: CLI flag > `.xm/build/config.json` > `.xm/config.json` > defaults; `gate_policy` merges per-key.
2. **CLI flag** — `run --worktrees` / `run --no-worktrees` overrides config for one run. When a flag is present, skip the layer-3 question.
3. **phase gate (computed, not asked)** — `run --json` always emits `worktree_signal { enabled, parallel_safe_count, sequential_count, recommend }`; `recommend` is `true` only when `enabled && parallel_safe_count >= 2`.
   - `recommend: true` → use worktree fan-out when config/CLI selected it; emit the recommendation for observability, but do not add a confirmation turn.
   - `recommend: false` → do NOT ask; run sequentially and print one line of reason (≤1 parallel-safe task, or no `expected_files`).

Parallel-safety comes from per-task `expected_files[]`: non-overlapping expected files → parallel-safe; missing or overlapping → sequential (when in doubt, sequential). Set via `tasks add|update --expected-files "a,b"`.

**Dashboard is observe-only** — never a control plane. It reads `worktree_tasks[]`; intervention (resume, resume-accept) happens at the terminal.

Two drive modes share the same command surface: interactive orchestrator (`/xm:build` fans subagents into worktree cwds) and headless CLI (a human works each worktree, finishes with the same `worktrees resume` / `gate-panel`).

### Execution & finish (agent path)

- Real fan-out (`run --worktrees`, non-dry-run) acquires the first parallel batch, writes `run.json` + a `TASK-CONTEXT.md` snapshot per worktree, and emits `tasks[]` with `branch` / `worktree` / `env` / `acquired` / `worktree_status`. **Inject `entry.env` (`X_BUILD_ROOT` / `X_PANEL_ROOT` / `XM_ROOT`) into every spawned worktree subagent** — without it the agent reads the main repo's `.xm/` as empty. When no task is parallel-safe, the plan falls back to acquiring the first sequential task alone (`sequential_fallback: true`, `parallel: false`).
- Worktree `tasks[]` entries carry NO `on_complete`/`on_fail` — only a `completion_note`. Worktree subagents must NOT run `tasks update ... completed`; the orchestrator flips tasks.json only after `gk finish` succeeds. Under group review, that finish is intentionally per-task ungated and the group panel is the review boundary.
- `finish.auto` is always `false`. After agents complete, run `task-check <task-id>` in each task worktree, then call `worktrees resume [task-id...]` — that drives the serialized `gk finish` queue (one at a time under the target merge lock). NEVER auto-run finish from the run plan.
- `--dry-run` emits the plan only (no gk). In explicit per-task review mode, missing gk `--gate` falls back to `mode: "manual-handoff"`; default group review does not require that unused capability.

### After-gate paused is a human decision

When a finish returns after-gate `paused` (`worktree_status: BLOCKED`, `recover[]` saved), do NOT auto-run `gk ... --resume-accept`. `worktrees resume` drives every resumable task (all worktree statuses EXCEPT `BLOCKED`/`DONE`/`READY`, so happy-path `WORKTREE_CREATED`/`RUNNING`/`VERIFYING`/`REVIEWING` and `NEEDS_FIX`/`MERGING` all enter the finish queue); it skips `BLOCKED` with guidance. The accept (merge kept) vs rewind (`recover[]`) call belongs to the user.

## CLI↔Skill JSON Protocol

See `references/cli-skill-protocol.md` — JSON output schema for next/discuss/research/plan/run commands, action types, run task schema, agent_type → subagent_type mapping, and the worktree-mode / worktree_signal / worktree_tasks schemas.

---

## Workflow

See `references/workflow-guide.md` — end-to-end runbook covering:
- Planning Principles (Decide-what-NOT-to-build, Name-the-risk-early, plans-as-hypotheses)
- Step-by-step execution (Init → Discuss → Research → Plan → Execute → Verify → Close)
- Quick Mode (one-shot plan→run for simple goals)
- Error Recovery Guide (task failure, circuit breaker, replan)

Consult this file when running `plan "goal"` (full mode) or `plan "goal" --quick` (Quick Mode).

---

## Discuss Command (Phase-Aware Deliberation)

See `commands/discuss.md` — multi-mode deliberation engine (interview/assumptions/validate/critique/adapt) adapting to current project phase. JSON output schema + per-mode workflow.

---

## Commands Reference

See `commands/other-commands.md` — research (scaled investigation), plan-check (15-dimension validation including review-group ordering), next (smart routing), handoff (session preservation), context-usage (token budget), verify-coverage (requirement coverage).

---

## Data Model (`.xm/build/`)

See `references/data-model.md` — directory layout of `.xm/build/projects/<name>/`, task/step/circuit-breaker JSON schemas, HANDOFF.json structure.

---

## Plugin Integration

See `references/plugin-integration.md` — how x-build uses x-op (alternative to 4-agent research), x-solver (sub-problem decomposition), xm shared decisions, future shared-state plans.

---

## Shared Config Integration

x-build references the shared configuration in `.xm/config.json`:

| Setting | Key | Default | Effect |
|---------|-----|---------|--------|
| Mode | `mode` | `developer` | Output style (technical terms vs simple language) |
| Autopilot | `autopilot` | `true` | Auto-pass confirmation gates; quality and direction approval still block |
| Agent count | `agent_max_count` | `4` | Number of research agents, parallel run concurrency |
| TL model | `team_default_leader_model` | `opus` | Team Leader model for `--team` tasks |
| Team member count | `team_max_members` | `5` | Max members per team |

Change settings:
```bash
$XMB config set agent_max_count 10   # max parallelism
$XMB config set agent_max_count 2    # save tokens
$XMB config show                     # show current settings
```

### Config Resolution Priority

1. CLI flag (`--agents N`) — highest priority when specified
2. Tool-specific local config (`.xm/build/config.json`)
3. Shared config (`.xm/config.json`)
4. Defaults

---

## Trace Recording

See `references/trace-recording.md` — session_start/session_end are automatic via `.claude/hooks/trace-session.mjs`; emit best-effort `agent_step` entries for long sub-operations.

---

## Natural Language Mapping

| User says | Command |
|-----------|---------|
| "start project", "new project" | `init` |
| "새 프로젝트인지 확인", "is this greenfield?" | `project-kind [--json]` |
| "그냥 이거 하나 해줘", "빠르게 실행하고 기록만", "single instruction, tracked" | `dispatch "<instruction>"` |
| "what should I do?", "what's next?" | `next` |
| "gather requirements", "ask me questions" | `discuss` |
| "investigate", "research" | `research` |
| "validate requirements", "anything missing?" | `discuss --mode validate` |
| "make a plan" | `plan "goal"` (plan-only) |
| bare goal, "build me ~" | `build "goal"` (Plan first, then Execute) |
| "validate plan", "is the plan ok?" | `plan-check` |
| "critical review", "review the plan", "critique" | `discuss --mode critique` |
| "cross-vendor consensus", "review the PRD with different models", "multi-vendor consensus" | `consensus --cross-vendor` |
| "mid-check", "need to adjust the plan?" | `discuss --mode adapt` |
| "status" | `status` |
| "next phase" | `phase next` |
| "approve", "LGTM" | `gate pass` |
| "execute", "run" | `run` |
| "worktree로 병렬 실행", "병렬 브랜치로 실행" | `run --worktrees` |
| "worktree 상태", "병렬 작업 상태" / "worktree 재개", "gate 다시 태우기" | `worktrees status` / `worktrees resume` |
| "release 전 통합 리뷰", "develop 배치 리뷰" | `review-integration` |
| "cost" | `forecast` |
| "coverage" | `verify-coverage` |
| "save session" | `handoff` |
| "export" | `export` |
| "change mode" | `mode` |
| "agent settings", "agent level" | `config show` / `config set agent_max_count` |

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "We'll figure out edge cases during implementation" | Edge cases are why you plan. Discovering them mid-build means your plan was incomplete — and now rework is expensive. |
| "신호가 1개뿐이고 애매하니 quick으로 가자" | The rule is deterministic: quick-eligible requires 0/4 HITs. One HIT scales research down to slim — it never re-opens quick. Ambiguity fails safe TOWARD research (measured: unjudgeable signals count as HIT). |
| "This task is obvious, it doesn't need done_criteria" | Without done_criteria, "done" is subjective. If you can't write it in one sentence, the task is too big. |
| "Adding more detail to the PRD slows us down" | Vague PRDs cause rework. Ten minutes of spec clarity saves hours of implementation churn. |
| "The risk is unlikely, skip the mitigation" | Risks are ranked by likelihood × impact. Low-likelihood × high-impact still needs a plan. Silent risks become incidents. |
| "We can parallelize everything" | Real dependencies exist. Declaring false parallelism creates integration debt — tasks that "could" run in parallel but actually serialize on shared state. |
| "The scope is fine as is" | Scope is defined by exclusion. If you haven't decided what NOT to build, you haven't scoped anything. |
| "Planning is overhead, not value" | Planning is where wrong turns are found for free. Every hour spent in plan-phase saves multiple hours in exec-phase. |
| "User is mid-task on a feature branch — invoking build is heavy, just apply it lightly" | git branch ≠ x-build project. Run `$XMB list` first; "lightly" / "skill spirit only" is not a valid bypass — it discards the PRD/tasks tracking the user explicitly invoked build to get. |
| "This diff is big/risky, solo review feels thin — I'll escalate to the panel" | Depth escalation is the user's call, not yours. Run the solo review, report what makes the diff risky, and OFFER `--depth panel` — a panel the user didn't ask for is exactly the turn-explosion review_depth=solo exists to prevent. |
| "Announcing the model every step is noise — I'll summarize the cost at the end" | The user is paying while the agents run, not afterward. A tier named before the batch lets them stop a fable fan-out they didn't want; the same number in a closing summary only tells them what they already spent. One line per batch is not noise. |
| "User just wants quick help, no need for full Research → Plan flow" | If they wanted Quick Mode they would have said `--quick`. Default to full flow; do not auto-shortcut on the user's behalf. |
| "This is a brand-new empty directory, the full interview is overkill" | The gauge decides, not vibes: `project_kind: greenfield` triggers Round 0 (4 questions, one round). Skipping problem-framing on a greenfield project is how PRDs get built on unvalidated premises. |
| "I saved the PRD/tasks, so asking for review lets the user just open the file" | Saving is not showing — the user reviews what is in the chat, not what is on disk. Rule 4's Output Gate requires the full artifact text in the current turn, and the review AskUserQuestion must cite a detail from it (task id / R# / done_criteria) — impossible if you never printed it. |

## Red Flags

Stop and correct course when you notice any of these. Each one has produced a real failure in this repo.

| Red flag | What it means | Correct move |
|---|---|---|
| You are about to call `AskUserQuestion` and cannot cite a task id, `R#`, or `done_criteria` string from this turn | You never printed the artifact — Output Gate (rule 4) is unsatisfied | Print the full PRD / task list, then ask |
| You typed `phase set plan` right after `plan "goal"` | You are routing around Research, which produces the artifacts PRD depends on | Read `research_signal` and run research at that scale |
| An agent batch is about to spawn and you have not printed a model line | The user is paying for tiers they cannot see | Announce models from CLI JSON first (Model Disclosure) |
| You are passing `"inherit"` as the Agent tool's `model` | Not a valid value; the run either errors or silently mis-tiers | OMIT the parameter entirely |
| `run-status` reported `later.touched[]` and you moved on | A file the queue deferred changed anyway | Tell the user; `later promote <id>` or revert |
| You decided a diff was risky enough to warrant the panel | Depth escalation is the user's call | Run solo, report the risk, OFFER `--depth panel` |
| `verify-coverage` printed uncovered requirements and you treated it as a pass | It exits 0 by default — green prose is not a green gate | Re-run with `--strict`, or state the gap explicitly |
| You are writing `PRD.md` with the `Write` tool | Skips the template-version stamp and degrades the diagram gate | Use `$XMB save plan` |
| A worktree subagent is being spawned without `entry.env` | It will read the main repo's `.xm/` as empty | Inject `X_BUILD_ROOT` / `X_PANEL_ROOT` / `XM_ROOT` |
| You are about to edit a file under `xm/skills/` | That is a build artifact; the change will be overwritten | Edit the plugin's own `x-*/skills/**` source |

## Verification

Before reporting a phase complete, confirm the evidence exists — do not infer it from an agent's
claim that it finished.

| Claim | Command that proves it |
|---|---|
| "The plan is valid" | `plan-check` (add `--strict` to make coverage errors block) + `prd-check` |
| "This task is done" | `task-check <id>` — passing, exact-snapshot evidence in the task's cwd |
| "The group is reviewable" | `review-group <g>` returned a spec, and `review-group <g> --verdict …` recorded a decision |
| "Execute can exit" | `group-check <g>` for every group; `run-status --json` shows `all_done` and no stale `group_quality` |
| "Requirements are covered" | `verify-coverage --strict` and `verify-traceability` (both exit 0) |
| "Quality passes" | `quality` — every check `passed: true`, not merely "no checks detected" |
| "We have not drifted from the PRD" | `verify-drift` |
| "Review findings are handled" | `verify-review-fix` after triaging every Medium+ finding |
| "Cost estimates are trustworthy" | `forecast accuracy` — MAPE over ≥5 measured pairs, not an estimate-only run |

A harness `completed` notification is NOT task completion. Require the task's
`completion_contract`: the agent's final response ends with `## 완료 보고`, every done criterion is
addressed, and `task-check` passed. If any is missing, resume the same agent with the missing
requirement (up to twice), then run `on_fail` — never `on_complete`.
