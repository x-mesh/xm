# xm Agent Directory

xm is a Claude Code plugin marketplace providing 5 tools for structured multi-agent orchestration.
Agent primitives are handled by `x-agent`; strategies by `x-op`; project lifecycle by `x-build`.

## Agent Tiers

| Tier | Model | Use For | Cost |
|------|-------|---------|------|
| Quick | haiku | Exploration, documentation, scanning | Low |
| Standard | sonnet | Implementation, debugging, testing, review | Medium |
| Deep | opus | Architecture, planning, critical review | High |

## Role Presets (x-agent)

| Preset | Model | Description |
|--------|-------|-------------|
| explorer | haiku | Codebase exploration, structure mapping |
| se | sonnet | Implementation, refactoring, testing |
| sre | sonnet | Infrastructure, monitoring, SLO, incidents |
| architect | opus | System design, trade-offs, ADR |
| reviewer | sonnet | Code review, quality, maintainability |
| security | sonnet | OWASP, vulnerabilities, auth/authz |
| debugger | sonnet | Error tracing, root cause, regression isolation |
| optimizer | sonnet | Performance profiling, caching, query tuning |
| documenter | haiku | API docs, README, changelog, onboarding |
| verifier | sonnet | Evidence-based completion checks, test adequacy |
| planner | opus | Structured consultation, work plan generation |
| critic | opus | Plan review, gap detection, simulation |
| test-engineer | sonnet | Test strategy, TDD, coverage, flaky test hardening |
| build-fixer | sonnet | Build/type error resolution, minimal diffs |

## OMC Integration

When oh-my-claudecode is installed, x-build maps agent types to OMC agents:

| x-agent Preset | OMC Agent (`oh-my-claudecode:*`) | Fallback |
|-----------------|----------------------------------|----------|
| explorer | explore | Inline preset |
| se / executor | executor | Inline preset |
| architect | architect | Inline preset |
| reviewer | code-reviewer | Inline preset |
| security | security-reviewer | Inline preset |
| debugger | debugger | Inline preset |
| documenter | writer | Inline preset |
| verifier | verifier | Inline preset |
| planner | planner | Inline preset |
| critic | critic | Inline preset |
| test-engineer | test-engineer | Inline preset |
| build-fixer | build-fixer | Inline preset |

When OMC is NOT installed, x-agent inline presets provide equivalent behavior.

## Development Conventions

- Plugin skill development: `sonnet` tier by default
- Architecture decisions and planning: `opus` tier
- Exploration and documentation: `haiku` tier
- x-build `run` auto-selects tier by task size (small/medium -> sonnet, large -> opus)
- Always verify with `verifier` preset before claiming completion
<!-- xm:BEGIN v2 -->
## xm — multi-agent orchestration toolkit

Each entry below corresponds to a saved prompt under `~/.codex/prompts/`
(or `.codex/prompts/` for project-local installs). Invoke with
`/prompts:<filename>` followed by any required arguments.

- `/prompts:xm-agent` — Agent primitives and autonomous behaviors — fan-out, delegate, broadcast, research, solve, consensus, swarm for Claude Code native multi-agent orchestration
- `/prompts:xm-build` — Phase-based project harness — manage project lifecycle, DAG execution, cost forecasting, and agent orchestration
- `/prompts:xm-dashboard` — Web dashboard for .xm project state — start, stop, open in browser
- `/prompts:xm-eval` — Agent output quality evaluation — multi-rubric scoring, strategy benchmarking, and A/B prompt experiments
- `/prompts:xm-handoff` — Session handoff — save comprehensive session state for cross-session continuity
- `/prompts:xm-handon` — Session restore — resume from last handoff, inject context automatically
- `/prompts:xm-humble` — Structured retrospective — reflect on failures together, find root causes, explore alternatives, and grow
- `/prompts:xm-kit` — x-mesh toolkit — list available tools and their status
- `/prompts:xm-memory` — Cross-session decision and pattern memory — persist learnings, auto-inject relevant context on session start
- `/prompts:xm-op` — Strategy orchestration — 17 strategies including refine, tournament, chain, review, debate, red-team, brainstorm, distribute, council, socratic, persona, scaffold, compose, decompose, hypothesis, i...
- `/prompts:xm-probe` — Premise validation — challenge assumptions, kill bad ideas early, earn the right to build
- `/prompts:xm-review` — Multi-perspective code review orchestrator — PR diff analysis with severity-rated findings and LGTM verdict
- `/prompts:xm-ship` — Release automation — commit squash, version bump, changelog, push. Works with any project.
- `/prompts:xm-solver` — Structured problem solving — decompose, iterate, constrain, or auto-pipeline with strategy recommendation
- `/prompts:xm-sync` — Multi-machine .xm/ state sync — server start/stop, push, pull, setup, status
- `/prompts:xm-trace` — Agent execution tracing — timeline, token/cost tracking, replay, and diff for multi-agent observability

See https://github.com/x-mesh/xm for the source-of-truth SKILL.md files.
<!-- xm:END -->
