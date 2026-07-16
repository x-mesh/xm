# Data Model Reference

Directory layout and JSON schemas for `.xm/build/` project state.

## Directory Layout (`.xm/build/`)

```
.xm/build/projects/<name>/
├── manifest.json              # Project metadata
├── config.json                # Project-specific config overrides
├── HANDOFF.json               # Session state preservation
├── context/
│   ├── CONTEXT.md             # Goals, decisions, constraints
│   ├── REQUIREMENTS.md        # Scoped features [R1], [R2]...
│   ├── ROADMAP.md             # Phase breakdown
│   └── decisions.md           # Decision log (markdown)
├── phases/
│   ├── 01-research/
│   │   ├── status.json        # Phase status
│   │   └── notes.md           # Raw research agent outputs
│   ├── 02-plan/
│   │   ├── PRD.md             # Canonical PRD location
│   │   ├── tasks.json         # Task list + status
│   │   ├── steps.json         # Computed DAG steps
│   │   └── plan-check.json    # Plan validation result
│   ├── 03-execute/
│   │   ├── circuit-breaker.json
│   │   └── progress.json
│   ├── 04-verify/
│   │   ├── checklist.md
│   │   └── quality-results.json
│   └── 05-close/
│       └── summary.md
├── checkpoints/               # Manual markers
├── metrics/
│   └── sessions.jsonl         # Append-only metrics (auto-rotated at 5MB)
└── worktrees/                 # Worktree pipeline artifacts (worktree mode only)
    ├── preflight.json         # Capability probe (gate_capable, degraded, panel_ok)
    └── <task-id>/
        ├── run.json           # Per-task worktree run record (see below)
        ├── task-context.md    # CANONICAL task context (worktree TASK-CONTEXT.md is a snapshot of this)
        ├── panel-before.json  # gate-panel verdict artifacts (before/after)
        ├── panel-after.json
        ├── patch-before.diff  # gate patches (before/after; release under __integration__)
        └── patch-after.diff
```

## Worktree Run Schema (`worktrees/<task-id>/run.json`)

Single writer: the orchestrator. Worktree agents never write it. `worktree_status` is a separate axis from canonical `task_status` (no new `tasks.json` enum is introduced).

```json
{
  "task_id": "t3",
  "branch": "feat/t3-search-index",
  "worktree": "/path/to/worktree",
  "base": "develop",
  "task_status": "running | completed | failed",
  "worktree_status": "READY | WORKTREE_CREATED | RUNNING | VERIFYING | REVIEWING | MERGING | DONE | BLOCKED | NEEDS_FIX",
  "gk_runs": [],
  "panel_artifacts": [],
  "gk_gate_run_id": "gk audit run id | null",
  "last_error": null,
  "recover": []
}
```

The reserved `__integration__` task id holds release-time `main...develop` batch review artifacts (`patch-release.diff` + panel verdict).

Worktree `worktree.*` config resolves: CLI flag > `.xm/build/config.json` > `.xm/config.json` > defaults; `gate_policy` merges per-key across layers. `gate_policy` supports phase overlays (`before`/`after`/`release` partial policies over the flat base; default blocks critical/high per-task and re-adds medium at release — non-blocked confirmed findings surface as `advisory_findings`). Related keys: `gate_max_rounds` (consecutive panel-fail rounds before medium auto-demotes to advisory; 0 = no cap), `pre_gate` (cheap command template run before the panel; `{patch}` substituted; exit 1 = fail-fast block), `gate_phase: release` (per-task merges run UNGATED; `review-integration` is the single gate — `worktrees status` shows pending/stale/pass).

## Task Schema (`tasks.json`)

```json
{
  "tasks": [{
    "id": "t1",
    "name": "Implement JWT auth [R1]",
    "description": "1-3 sentences: WHAT the task does + WHY it exists. The name is a compressed title; this is what the executor reads. null until set via --desc.",
    "depends_on": [],
    "size": "small | medium | large",
    "status": "pending | ready | running | completed | failed | cancelled",
    "done_criteria": [
      "Acceptance criteria or verification contract"
    ],
    "expected_files": ["src/a.mjs", "src/b.mjs"],
    "interface_contract": "parse(s) → AST|null; 입력은 신뢰 불가; 예외 대신 null",
    "strategy": "refine | review | null",
    "team": "team name | null",
    "created_at": "ISO8601",
    "started_at": "ISO8601 | null",
    "completed_at": "ISO8601 | null",
    "retry_count": 0,
    "next_retry_at": "ISO8601 | null"
  }]
}
```

`interface_contract` (optional string): the delegation interface — 2-3 lines of signatures/invariants a delegate must not renegotiate. Injected into the agent prompt (`## Interface Contract`) and emitted on `run --json` entries; plan-check warns (`delegation-contract`) when a delegation-shaped task (expected_files set, or low-tier execution) lacks it. Set via `tasks add|update --interface-contract "..."`; empty string clears.

`expected_files[]` (added for worktree mode): the parallel-batching signal. Tasks with non-overlapping expected files are parallel-safe; missing/empty or overlapping → sequential. Set via `tasks add|update --expected-files "a,b"`. Absent on tasks written before the field existed (normalizes to `[]`).

## Steps Schema (`steps.json`)

```json
{
  "steps": [
    { "id": 1, "tasks": ["t1", "t2"] },
    { "id": 2, "tasks": ["t3"] }
  ],
  "computed_at": "ISO8601"
}
```

## Circuit Breaker Schema

```json
{
  "state": "closed | open | half-open",
  "consecutive_failures": 0,
  "opened_at": "ISO8601 | null",
  "cooldown_until": "ISO8601 | null"
}
```

## Applies to

Used by all x-build CLI commands that read/write project state. The `.xm/build/` directory is created by `$XMB init <name>` and updated by every phase transition, task update, and gate pass. HANDOFF.json is written on `$XMB handoff` and read on `$XMB handoff --restore`.
