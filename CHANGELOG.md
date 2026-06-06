# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

Plugins are versioned independently; the authoritative per-plugin version lives
in `.claude-plugin/marketplace.json`. Dated sections below group the plugin
bumps shipped in each marketplace release.

## [Unreleased]

_Nothing pending._

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
