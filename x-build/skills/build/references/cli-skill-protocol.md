# CLI↔Skill JSON Protocol

Several commands output JSON for the skill layer to parse and act on. The skill layer (this document) is responsible for interpreting the JSON and orchestrating agents.

## Action Types

| Command | `action` field | Key fields |
|---------|---------------|------------|
| `next --json` | varies | `phase`, `action`, `args`, `reason`, `artifacts`, `goal?`, `ready?`, `project_kind`, `suggest_probe`, `round0_pending?` (research phase, greenfield only), `research_signal?` (when action is `research`/`discuss`) |
| `discuss` | `"discuss"` | `mode`, `project`, `current_phase`, `round`, `max_rounds`, `project_kind` + mode-specific fields (interview: `save_path`, `round0_pending?`) |
| `research` | `"research"` | `goal`, `project`, `perspectives[]`, `project_kind`, `suggest_probe`, `agents_spec[]` (each with `perspective`, `role`, `model`, `web?`) |
| `plan` | `"auto-plan"` | `goal`, `project`, `existing_tasks`, `context_summary`, `requirements_summary`, `roadmap_summary`, `project_kind`, `research_signal`, `quick`, `flow`, `skip_research` |
| `run --json` | (no action field) | `project`, `step`, `total_steps`, `tasks[]`, `parallel` |

## `next --json` — Smart Router (primary entry point)

**When the skill is invoked without a specific command (no args), always run `next --json` first.**

Output schema:
```json
{
  "project": "my-project",
  "phase": "research",
  "action": "discuss",
  "args": ["--mode", "interview"],
  "reason": "No CONTEXT.md found. Start requirements interview.",
  "artifacts": { "context": false, "requirements": false, "roadmap": false, "prd": false, "plan_check": false },
  "goal": null,
  "ready": false,
  "project_kind": "greenfield",
  "suggest_probe": true,
  "round0_pending": true
}
```

- `project_kind`: `"greenfield"` | `"brownfield"` — deterministic gauge recorded once at `init` time (see `references/workflow-guide.md` Round 0 for the 4-signal detail). Always present.
- `suggest_probe`: `true` iff `project_kind === "greenfield"`. Signals that `/xm:probe` should be offered (never auto-run) before the Research gate.
- `round0_pending`: present only when `project_kind === "greenfield"` AND `phase === "research"`. `true` until `discuss-round0.json` has been saved — the skill must run Round 0 before Round 1 in that case. Absent for brownfield projects.
- `research_signal`: attached only when `action` is `"research"` or `"discuss"` — the deterministic full/slim/quick-eligible gauge (see SKILL.md Interaction Protocol rule 3). Absent/failed reads as `full`.

After parsing, execute the recommended action:
- `action: "discuss"` → run `$XMB discuss` with args, then follow the discuss protocol below
- `action: "research"` → run `$XMB research`, then follow the research protocol below
- `action: "plan"` → if `goal` is set, run `$XMB plan "goal"`; otherwise ask user for goal
- `action: "plan-check"` → run `$XMB plan-check`
- `action: "phase"` + `args: ["next"]` → run `$XMB phase next` (phase gate transition)
- `action: "run"` → run `$XMB run --json`, then orchestrate agents
- `action: "quality"` → run `$XMB quality`
- `action: "close"` → run `$XMB close --summary "..."`

## `run --json` Task Schema

```json
{
  "task_id": "t1",
  "task_name": "Implement auth [R1]",
  "size": "medium",
  "agent_type": "executor",
  "model": "sonnet",
  "model_vendor": "claude",
  "model_by_vendor": { "claude": "sonnet", "codex": "gpt-5.4" },
  "interface_contract": "parse(s) → AST|null; 입력은 신뢰 불가; 예외 대신 null",
  "prompt": "...",
  "on_complete": "node .../x-build-cli.mjs tasks update t1 --status completed",
  "on_fail": "node .../x-build-cli.mjs tasks update t1 --status failed"
}
```

- `agent_type`: `"executor"` (small/medium) or `"deep-executor"` (large, opus, or a judgment role on `"inherit"`)
- `interface_contract` (optional): the delegation interface — signatures/invariants the executor must not renegotiate. Also injected into `prompt` as `## Interface Contract`. Set via `tasks add|update --interface-contract "..."`.
- `model`: **always use the `model` field emitted in the CLI JSON — never hardcode.** It is resolved from `model_profile` + `model_overrides` in `.xm/config.json`. This is the Claude tier and is the Agent-tool routing contract.
- `model: "inherit"` → **OMIT the `model` parameter in the Agent tool call.** The subagent then runs on the harness-inherited default — the session/parent model as the harness resolves it (measured 2026-07: a Fable session inherited opus for subagents; the leader turn itself rides the session model). Never pass the literal string `"inherit"` (not a valid Agent-tool value) and never substitute a hardcoded tier. On completion, report the model it actually ran on via `tasks update <id> --status completed --resolved-model <haiku|sonnet|opus>` so the metric records ground truth.
- `model_vendor` (additive): the vendor the orchestrator itself runs on — always `"claude"`. Present alongside `model`, never replaces it.
- `model_by_vendor` (additive): per-vendor spec map. `claude` mirrors `model`; `codex` is a GPT spec derived from `vendor_models` in `.xm/config.json` (falls back to a built-in table; an `"inherit"` tier resolves via the opus fallback before lookup). The `codex` key is **omitted** when `vendor_models` is malformed or the tier has no mapping — consumers must fall back to `claude` in that case. Present for `task[]`, consensus `agents[]`, and `prd_writer`.
- `on_complete`/`on_fail`: Callback commands to update task status after agent finishes

## Mapping to Agent Tool

The model ALWAYS comes from the CLI JSON `model` field (`task.model`, `agents[n].model`, `agents_spec[n].model`, `prd_writer.model`); if that field is `"inherit"`, omit the Agent-tool `model` parameter (see above). This table maps only `agent_type` → `subagent_type`:

| CLI `agent_type` | Agent `subagent_type` | Fallback (x-agent preset) |
|-----------------|----------------------|---------------------------|
| `executor` | `oh-my-claudecode:executor` | `se` |
| `deep-executor` | `oh-my-claudecode:deep-executor` | `architect` |
| `planner` | `oh-my-claudecode:planner` | `planner` |
| `verifier` | `oh-my-claudecode:verifier` | `verifier` |
| `critic` | `oh-my-claudecode:critic` | `critic` |
| `test-engineer` | `oh-my-claudecode:test-engineer` | `test-engineer` |
| `build-fixer` | `oh-my-claudecode:build-fixer` | `build-fixer` |

## Worktree Mode JSON

The worktree pipeline is the optional Execute-phase backend. See the SKILL.md "Worktree Execution Mode" section for the decision rules; this section documents the JSON surfaces.

### `worktree_signal` (on every `run --json`)

Emitted regardless of mode so the Execute phase gate can decide whether to offer fan-out:

```json
{
  "worktree_signal": {
    "enabled": true,
    "parallel_safe_count": 3,
    "sequential_count": 1,
    "recommend": true
  }
}
```

- `enabled`: `worktree.enabled` after config + flag resolution (`--worktrees` / `--no-worktrees`).
- `parallel_safe_count` / `sequential_count`: partition of ready tasks by `expected_files[]` overlap.
- `recommend`: `true` iff `enabled && parallel_safe_count >= 2`. The skill offers fan-out only when `true`; otherwise runs sequentially with a one-line reason.

### `run --worktrees` — real fan-out plan

Non-dry-run, gk gate-capable. Acquires the first parallel batch, inits `run.json`, drops the `TASK-CONTEXT.md` snapshot, and emits:

```json
{
  "project": "my-project",
  "step": 1,
  "total_steps": 3,
  "mode": "worktree",
  "base": "develop",
  "max_parallel": 4,
  "parallel": true,
  "degraded": false,
  "worktree_signal": { "...": "..." },
  "tasks": [{
    "task_id": "t3",
    "branch": "feat/t3-search-index",
    "worktree": "/path/to/worktree",
    "env": { "X_BUILD_ROOT": "...", "X_PANEL_ROOT": "...", "XM_ROOT": "..." },
    "acquired": true,
    "worktree_status": "WORKTREE_CREATED",
    "prompt": "...", "model": "...", "on_complete": "...", "on_fail": "..."
  }],
  "batches": [["t3", "t4"]],
  "sequential": ["t5"],
  "finish": { "auto": false, "hint": "After agents complete + verify, run: xm build worktrees resume [task-id...]" }
}
```

- Inject `tasks[].env` into every spawned worktree subagent (root env contract). `acquired: false` sets `worktree_status: "BLOCKED"` and adds `acquire_error`.
- `finish.auto` is always `false` — the orchestrator finishes via `worktrees resume`, never from this plan.

### `run --worktrees --dry-run` / degraded (manual-handoff)

`--dry-run` (or degraded, when preflight found no gk `--gate`) emits the plan WITHOUT touching gk:

```json
{
  "project": "my-project", "base": "develop", "branch_prefix": "feat/",
  "max_parallel": 4, "gate": "panel", "gate_phase": "before",
  "degraded": false,
  "mode": "dry-run",
  "parallel_batches": [["t3", "t4"]],
  "sequential": ["t5"],
  "reason": "t5: no expected_files (unknown → sequential)",
  "tasks": [{
    "task_id": "t3", "name": "...", "parallel_safe": true,
    "branch": "feat/t3-search-index", "worktree_hint": "/path/.gk/worktree/repo/feat/t3-...",
    "acquire": "GK_AGENT=1 git-kit worktree acquire feat/t3-... --from develop",
    "finish": "GK_AGENT=1 git-kit worktree finish --to develop --gate \"xm build gate-panel ...\" --gate-phase before --cleanup"
  }],
  "preflight": { "gate_capable": true, "degraded": false, "panel_ok": true, "...": "..." }
}
```

Degraded mode sets `mode: "manual-handoff"` and `degraded: true` — print the `acquire`/`finish` commands for the human; xm will not drive gk.

### `run-status --json` — `worktree_tasks[]`

```json
{
  "worktree_tasks": [{
    "task_id": "t3",
    "branch": "feat/t3-search-index",
    "worktree": "/path/to/worktree",
    "worktree_status": "NEEDS_FIX",
    "task_status": "running",
    "gk_gate_run_id": "20260702-...",
    "last_error": null
  }],
  "next_action": "worktrees resume or resolve NEEDS_FIX/BLOCKED worktrees: t3"
}
```

`worktree_status` ∈ `READY | WORKTREE_CREATED | RUNNING | VERIFYING | REVIEWING | MERGING | DONE | BLOCKED | NEEDS_FIX` (artifact axis, separate from canonical `task_status`).

### `run --reconcile --json` — `protected[]`

Stale RUNNING tasks kept out of reconcile because their worktree artifact says a human/orchestrator must act:

```json
{
  "reconciled": ["t7"],
  "count": 1,
  "protected": [{ "id": "t3", "reason": "worktree_status:NEEDS_FIX", "worktree_status": "NEEDS_FIX" }],
  "dry_run": false
}
```

NEEDS_FIX / BLOCKED / MERGING or a live worktree are never reconciled to PENDING.

### `gate-panel` / `review-integration`

`gate-panel --project <p> --task <id> --phase before|after|release --patch <path> --json` returns `{ decision: "pass"|"fail"|"error", exit_code, blocking_findings[], ... }` and exits 0/1/2. `review-integration` builds the `main...develop` patch and runs gate-panel under the reserved `__integration__` id / `release` phase.

## Applies to

Used by x-build skill routing when parsing CLI JSON output and dispatching to agents.
