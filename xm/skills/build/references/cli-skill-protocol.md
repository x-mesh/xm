# CLI↔Skill JSON Protocol

Several commands output JSON for the skill layer to parse and act on. The skill layer (this document) is responsible for interpreting the JSON and orchestrating agents.

## Action Types

| Command | `action` field | Key fields |
|---------|---------------|------------|
| `next --json` | varies | `phase`, `action`, `args`, `reason`, `artifacts`, `goal?`, `ready?` |
| `discuss` | `"discuss"` | `mode`, `project`, `current_phase`, `round`, `max_rounds` + mode-specific fields |
| `research` | `"research"` | `goal`, `project`, `perspectives[]` |
| `plan` | `"auto-plan"` | `goal`, `project`, `existing_tasks`, `context_summary`, `requirements_summary`, `roadmap_summary` |
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
  "ready": false
}
```

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
  "prompt": "...",
  "on_complete": "node .../x-build-cli.mjs tasks update t1 --status completed",
  "on_fail": "node .../x-build-cli.mjs tasks update t1 --status failed"
}
```

- `agent_type`: `"executor"` (small/medium) or `"deep-executor"` (large)
- `model`: **always use the `model` field emitted in the CLI JSON — never hardcode.** It is resolved from `model_profile` + `model_overrides` in `.xm/config.json`.
- `on_complete`/`on_fail`: Callback commands to update task status after agent finishes

## Mapping to Agent Tool

The model ALWAYS comes from the CLI JSON `model` field (`task.model`, `agents[n].model`, `agents_spec[n].model`, `prd_writer.model`). This table maps only `agent_type` → `subagent_type`:

| CLI `agent_type` | Agent `subagent_type` | Fallback (x-agent preset) |
|-----------------|----------------------|---------------------------|
| `executor` | `oh-my-claudecode:executor` | `se` |
| `deep-executor` | `oh-my-claudecode:deep-executor` | `architect` |
| `planner` | `oh-my-claudecode:planner` | `planner` |
| `verifier` | `oh-my-claudecode:verifier` | `verifier` |
| `critic` | `oh-my-claudecode:critic` | `critic` |
| `test-engineer` | `oh-my-claudecode:test-engineer` | `test-engineer` |
| `build-fixer` | `oh-my-claudecode:build-fixer` | `build-fixer` |

## Applies to

Used by x-build skill routing when parsing CLI JSON output and dispatching to agents.
