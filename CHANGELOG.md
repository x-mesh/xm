# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

Plugins are versioned independently; the authoritative per-plugin version lives
in `.claude-plugin/marketplace.json`. Dated sections below group the plugin
bumps shipped in each marketplace release.

## [Unreleased]

## [2.18.0] - 2026-08-21

### Added

- **review:** bound provider exploration and retry

## [2.18.0] - 2026-08-21

### x-build 3.2.2 → 3.2.3

- Register `panel.command_budget` in the shared config schema so operators can tune the Codex review command cap without an unregistered-key warning (`x-build/lib/config-schema.mjs`, `x-build/lib/shared-config.mjs`).

### x-panel 0.20.6 → 0.21.0

- Bound Codex review exploration with a configurable completed-command budget (default 24). Raw and streaming providers now stop with typed `command_budget` before a reviewer can spend the full wall-clock cap without producing a valid contract (`x-panel/lib/x-panel/adapters.mjs`).
- Distinguish semantic progress from byte activity. `panel watch` now reports command usage, valid-contract state, attempt number, provider freshness, idle deadline, and hard-cap remaining (`x-panel/lib/x-panel-cli.mjs`).

### x-review 2.3.5 → 2.4.0

- Limit failed provider recovery to one strict-subset retry. The retry helper copies complete frozen diff sections only for exact target paths named in failure evidence; unsafe, full-target, and repeated retries fail closed as `Review incomplete` (`x-review/skills/review/scripts/retry-target.mjs`).

### xm 2.17.0 → 2.18.0

- Rebundle bounded review execution, progress telemetry, retry policy, config registration, and deterministic regression coverage for installed `xm panel` and `xm review` users.

## [2.17.0] - 2026-08-21

### x-build 3.2.1 → 3.2.2

- Bind host review-fix decisions to the same canonical review context used by reviewers. The gate now requires finding-level context references, invariant and acceptance evidence, and a matching recomputed digest before authorizing or closing fixes, so stale or altered intent cannot silently pass (`x-build/lib/x-build/verify.mjs`).
- Recover stale group-check locks and carry explicit long-check timeout settings through task execution, preventing crashed checks from wedging later verification runs (`x-build/lib/x-build/tasks.mjs`, `x-build/lib/x-build/phase.mjs`).

### x-review 2.3.4 → 2.3.5

- Add a bounded, allowlisted review context contract for goals, invariants, constraints, non-goals, and acceptance checks. Every reviewer report must echo the canonical hash, while source coverage and review-fix artifacts preserve the same provenance (`x-review/skills/review/scripts/context-contract.mjs`, `x-review/skills/review/scripts/validate-reports.mjs`).
- Reject duplicate context IDs across all sections so host evidence cannot ambiguously refer to both an invariant and an acceptance check.

### x-panel 0.20.5 → 0.20.6

- Carry the trusted review context separately from untrusted target text through native and cross-model review prompts, and persist the verified digest in panel verdict and status artifacts (`x-panel/lib/x-panel/context-contract.mjs`, `x-panel/lib/x-panel-cli.mjs`).

### xm 2.16.8 → 2.17.0

- Rebundle the context-bound review pipeline and host verification gate so installed `xm review`, `xm panel`, and `xm build verify-review-fix` share one tamper-evident intent contract (`xm/skills/review/`, `xm/lib/x-panel/`, `xm/lib/x-build/`).

## [2.16.7] - 2026-08-20

### x-panel 0.20.3 → 0.20.4

- `xm panel status --watch` now prints the full `provider:model` slot label instead of the bare provider name, so concurrent slots fronted by one provider (for example `codex:gpt-5.6-sol` and `codex:glm-5`) stay distinguishable in the model list (`x-panel/lib/x-panel-cli.mjs`).

### xm 2.16.6 → 2.16.7

- Rebundle the x-panel watch label fix so installed `xm panel status --watch` separates multiple model slots served by the same provider (`xm/lib/x-panel-cli.mjs`).

## [2.16.6] - 2026-08-20

### x-panel 0.20.2 → 0.20.3

- Preserve completed review contracts when a model reaches the wall-clock cap instead of discarding valid findings as an empty failure. Explicit single-model recovery runs can now retry only the failed slot, while `panel.timeout_max_s` bounds automatic runs and an explicit `--timeout` retains its derived absolute cap (`x-panel/lib/x-panel/adapters.mjs`, `x-panel/lib/x-panel-cli.mjs`).
- Make long reviews observable without confusing a live orchestrator heartbeat with provider progress. `xm panel status --watch` now separates provider silence, idle time remaining, orchestrator heartbeat freshness, and absolute cap remaining (`x-panel/lib/x-panel-cli.mjs`).

### xm 2.16.5 → 2.16.6

- Rebundle the x-panel recovery and progress signals so installed `xm panel` commands can recover one failed model and distinguish a quiet remote provider from a stalled local run (`xm/lib/x-panel-cli.mjs`, `xm/lib/x-panel/adapters.mjs`).

## [2.16.5] - 2026-08-19

### x-review 2.3.3 → 2.3.4

- Delegate transport failures such as `Broken pipe` no longer override complete review artifacts. x-review now validates `reports/*.json` first, enters synthesis when `validation.json.ok` proves N/N coverage, and limits request-id recovery or fresh re-dispatch to report ids that remain missing or invalid.

### xm 2.16.4 → 2.16.5

- Rebundled the x-review artifact-first recovery contract and refreshed installation checksums so installed review skills preserve completed reports after a transport failure.

## [2.16.4] - 2026-08-19

### x-dashboard 2.16.1 → 2.16.2

- Activity now defaults to live-first, freshest-heartbeat ordering with `Active first`, `Latest`, and `Project name` sort modes plus `All`, `Live only`, and `Problems` filters. Choices persist locally, heartbeat age is visible, and SSE events refresh the view immediately.
- Reduced the cross-workspace polling payload by omitting provider stdout/stderr tails from the aggregate API; detailed run pages retain full output. In the measured 14-workspace fixture this reduced the response from 568 KB to 104 KB while keeping 12–16 ms response time.

### x-review 2.3.2 → 2.3.3

- Headless and delegated review invocations now degrade to a bounded single-pass `correctness` + `risk` review instead of attempting unavailable fan-out and waiting indefinitely. Normal fan-out stops after three consecutive empty waits and reports incomplete coverage.

### xm 2.16.3 → 2.16.4

- Rebundled the Dashboard and review fixes. x-sync pull now canonicalizes humble lessons to `humble/lessons/L{N}.json`, deduplicates compounded machine suffixes without inflating confirmation counts, and migrates already polluted stores during the next pull.

## [2.16.3] - 2026-08-19

### x-panel 0.20.1 → 0.20.2

- Fixed `xm panel watch` being interpreted as a literal review target. It is now a read-only alias for `xm panel status --watch`, so monitoring never fans out model calls or triggers provider permission prompts.
- Hardened parallel review execution: unique run ids prevent lens artifacts from overwriting each other, session fallback and signal retry share one wall-clock/spawn budget, real child signals replace stderr substring guesses, and same-provider model slots report multi-model rather than cross-vendor provenance.

### xm 2.16.2 → 2.16.3

- Rebundled the x-panel fixes and updated the panel skill, English/Korean usage docs, and installation checksums so installed dispatchers expose the safe `watch` alias.

### xm 2.5.2 → 2.6.0

- Added native Codex Plugin packaging in `xm/lib/install/`: installs bundled Skills and a semantic marketplace entry while keeping searchable `$xm-<skill>` aliases, so users can discover `$xm-op` and invoke the namespaced `$xm:op` form after plugin registration.
- Replaced the legacy Codex prompt/dispatcher compatibility path and hardened migrations: stale `AGENTS.md` cleanup now preserves blocks still owned by Antigravity, and generated plugin manifests accept complete SemVer prerelease + build versions.

### dashboard 2.4.4 → 2.4.5

- Surface nested workspaces. `scanWorkspaces` no longer stops at the first `.xm/` it finds — it registers the workspace and keeps recursing, so independent repos living inside a container workspace (e.g. `agentic/httprove`, `agentic/x-kit`) now appear instead of being silently swallowed by the parent. Each workspace carries a `parentId`; `/api/workspaces` adds `parentId` + `childCount`. The switcher and home cards render the parent→child hierarchy (tree indent + `└` glyph, `↳ nested in <parent>` label, `N nested` badge). IDs are disambiguated on basename collision.

## 2026-06-06

### xm 2.4.7 → 2.4.8

- Relocated the 74-file specialist agent catalog (37 `rules/` + 37 `slim/`) out of `xm/agents/` to `xm/agent-catalog/`. Claude Code recursively auto-registers every `*.md` under a plugin's `agents/` directory as a native subagent (`xm:rules:*` / `xm:slim:*`), which loaded all 74 into standing context on every session even though they are meant to be on-demand only (loaded via the kit `agent-catalog` CLI). Moving them outside `agents/` suppresses that auto-registration; `agent-catalog.mjs` paths and the kit SKILL/reference docs were updated, and `xm/skills.checksums.json` regenerated.

### x-build 2.6.3 → 2.6.4

- `release commit` staging now tracks `xm/agent-catalog/` (both the patterns list and the untracked-staging loop) so the relocated catalog ships on release instead of being silently dropped by a stale hardcoded path.

## 2026-06-01

### x-build 2.6.0 → 2.6.3

- **2.6.0** — Retry actually persists now: `scheduleRetry` mutated a task object aliased to a *different* written object, so retries never reached disk and `cmdRun` never re-ran a "retried" task. Unified run-state marking so `run --json` (the agent-spawn plan the skill drives) marks tasks RUNNING and records completion metrics with the correct model and correlation id (was 0 metrics / sonnet defaults). Added `run-status --json` (structured status: `all_done` / `steps` / `stale_running` / `blocked_tasks` / `next_action`), `run --reconcile` (reclaim stale RUNNING tasks), and a deterministic `prd-check` gate (blocks Execute on unresolved `[A*, low]` / `Status: blocking`, `--force` to override). `run --json` now enforces the budget and honors `model_profile`. Added cost + actual-vs-estimated coverage columns to `metrics`; `tasks update --tokens-in/--tokens-out` records measured cost and `computeTokenActuals` excludes estimates (the old estimate→actual loop was circular).
- **2.6.1** — Documented `run-status --json` / `run --reconcile` / `prd-check` routing in the skill workflow-guide and command reference.
- **2.6.2** — Hardened `modifyJSON`: reclaim stale locks (mtime > 10s, from crashed processes) and fail loud after 50 attempts instead of silently writing unlocked. `init` prints a next-action pointer; the plan phase recalls prior decisions via `/xm:memory` before PRD generation.
- **2.6.3** — Simplified the PRD drift gate to goal-only (was `0.5 goal + 0.3 constraint + 0.2 ontology`); threshold 0.80 → 0.70, both derived from the deterministic `sim-thresholds.mjs` simulator (CLAUDE.md L9). The constraint term was a near-constant 1.0 and ontology was noisy; both are now diagnostics. Fixes a false-alarm where a healthy 75%-goal project scored 0.675 and failed the gate.

### x-memory 2.0.9

- Fixed CLI crash (`ERR_MODULE_NOT_FOUND`) in the installed plugin cache layout — a top-level cross-plugin import of `x-trace` only resolved in the flat source tree. trace-writer is now resolved lazily with a no-op fallback so every subcommand runs.

### xm 2.3.10 → 2.3.14 (bundle)

- Meta-bumps re-bundling the x-build / x-memory releases above.
- `xm update` auto-propagates skills/hooks to every installed LLM target (Cursor/Codex/Kiro/Antigravity/OpenCode) via the manifest registry (per-file SHA-256 diffing skips unchanged targets); `xm install --propagate` / `--list-installed`; `xm update --no-propagate`; merge-marker edit warnings.

### Repo

- Untracked build artifacts from git: `coverage/` (now gitignored) and `.codex/` (install-time render target); removed stray files committed by the task harness; corrected README plugin/version drift and populated this CHANGELOG.

## 2026-05-27
- xm 2.3.9 — x-sync: tombstone propagation, cursor target, path-defense hardening
- xm 2.3.8, x-build 2.5.1, x-solver 2.1.1

## 2026-05-25
- x-build 2.5.0, x-dashboard 2.3.0, x-op 2.1.0, x-probe 2.1.0, x-solver 2.1.0, xm 2.3.6

## 2026-05-20
- xm 2.3.5, x-build 2.4.1 (skill plugins patch)
- xm 2.3.4
- x-build 2.4.0, xm 2.3.2

## 2026-05-19
- xm 2.3.1, x-build 2.3.0

## 2026-05-18
- xm 2.2.12
