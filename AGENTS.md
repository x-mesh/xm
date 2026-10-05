# xm Agent Directory

xm is a Claude Code plugin marketplace of tools for structured multi-agent orchestration (current plugin list: `.claude-plugin/marketplace.json`).
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
| reviewer | profile/session | Code review, quality, maintainability |
| security | profile/session | OWASP, vulnerabilities, auth/authz |
| debugger | sonnet | Error tracing, root cause, regression isolation |
| optimizer | sonnet | Performance profiling, caching, query tuning |
| documenter | haiku | API docs, README, changelog, onboarding |
| verifier | sonnet | Evidence-based completion checks, test adequacy |
| planner | opus | Structured consultation, work plan generation |
| critic | opus | Plan review, gap detection, simulation |
| test-engineer | sonnet | Test strategy, TDD, coverage, flaky test hardening |
| build-fixer | sonnet | Build/type error resolution, minimal diffs |

## Development Conventions

- Plugin skill development: `sonnet` tier by default
- Architecture decisions and planning: `opus` tier
- Exploration and documentation: `haiku` tier
- x-build `run` picks each role's model from `model_overrides` -> profile (`economy`/`default`/`max`) -> fallback, and warns when a large task is routed to haiku
- Always verify with `verifier` preset before claiming completion

## Review-Fix Gate

After x-review returns `Request Changes` or `Block`, do not start a broad second implementation pass.

Required sequence:
1. Run `x-build verify-review-fix --init` to create `.xm/review/triage.json`.
2. Triage every Medium+ finding as `fix_now`, `backlog`, `accept_risk`, or `false_positive`.
3. Never move Critical/High findings to `backlog`; fix them now or provide concrete evidence for `accept_risk` / `false_positive`.
4. Limit review-fix edits to `fix_now` findings and files listed in `fix_scope.allowed_files`.
5. Run `x-build verify-review-fix`, then quality checks, then re-run x-review once as the delta review.
6. Limit each task to one full review, one approved fix pass, and one delta review. If the delta adds any finding, report it and stop at every severity.
7. Read the terminal action before any follow-up. A stop action never authorizes automatic fixes or another review, even when the verdict is LGTM.
8. If review preparation fails, report the error and stop. Do not dispatch reviewers directly or reset the budget to bypass the lifecycle.
9. Continue beyond the budget only after explicit user approval for a one-time exception. Keep the same operation identity across the approved sequence.

This gate prevents review feedback from becoming an unbounded rewrite loop.

## Later Queue

When fixing A, do not opportunistically fix unrelated B.

Rule:
- If B blocks A or changes A's correctness, keep it in the current scope and update the active task/review-fix triage.
- If B does not affect A, capture it with `x-build later add "..." --reason "..." --source "..." --files "..."` and keep coding focused on A.
- Do not edit files for later items until they are promoted with `x-build later promote <id>`.

Use `later` for drive-by bugs, cleanup ideas, refactors, stale comments, and non-blocking review observations.

## Cross-Session Recall

Earlier sessions in this repo (Claude, Codex, Cursor) persist their outputs under
`.xm/` — code reviews, op strategy results, plans/PRDs, eval scores, probe verdicts.
To pick up what another session produced, query them with the tool-neutral
`xm recall` CLI. It is plain bash over `.xm/` (no Claude Code skill required), so it
works the same from any tool:

- `xm recall list` — all artifacts, newest first (`--type review|op|plan|eval|probe`, `--since 7d`, `--json`)
- `xm recall show review --last` — read the most recent code review
- `xm recall show <id>` — read a specific artifact (ids come from `list`)
- `xm recall search "<query>"` — full-text + metadata search across artifacts
- `xm recall handoff-md` — (re)generate `.xm/build/HANDOFF.summary.md`

`.xm/build/HANDOFF.md` is a stable tool-neutral pointer to the canonical
`.xm/build/SESSION-STATE.json`; read the JSON for the saved intent, decisions, and
open questions. Run `xm recall handoff-md` when a materialized plain-Markdown
summary is preferred.

If `xm` is not on PATH, the CLI is at
`~/.claude/plugins/cache/xm/{x-recall,recall,xm}/*/lib/x-recall-cli.mjs` — call it with `node`.
