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

## Review-Fix Gate

After x-review returns `Request Changes` or `Block`, do not start a broad second implementation pass.

Required sequence:
1. Run `x-build verify-review-fix --init` to create `.xm/review/triage.json`.
2. Triage every Medium+ finding as `fix_now`, `backlog`, `accept_risk`, or `false_positive`.
3. Never move Critical/High findings to `backlog`; fix them now or provide concrete evidence for `accept_risk` / `false_positive`.
4. Limit review-fix edits to `fix_now` findings and files listed in `fix_scope.allowed_files`.
5. Run `x-build verify-review-fix`, then quality checks, then re-run x-review before claiming completion.

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
- `xm recall handoff-md` — (re)generate `.xm/build/HANDOFF.md`

Also read `.xm/build/HANDOFF.md` when present: it is the previous session's intent,
decisions, and open questions in plain markdown.

If `xm` is not on PATH, the CLI is at
`~/.claude/plugins/cache/xm/{x-recall,recall,xm}/*/lib/x-recall-cli.mjs` — call it with `node`.
