# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

Plugins are versioned independently; the authoritative per-plugin version lives
in `.claude-plugin/marketplace.json`. Dated sections below group the plugin
bumps shipped in each marketplace release.

## [Unreleased]

### Added
- `xm update` now auto-propagates skills/hooks to every installed LLM target (Cursor/Codex/Kiro/Antigravity/OpenCode) via the manifest registry. Per-file SHA-256 diffing skips unchanged targets.
- `xm install --propagate` — re-render every installed manifest target programmatically (used internally by `xm update`).
- `xm install --list-installed` — print installed manifest inventory as JSON.
- `xm update --no-propagate` — opt out of fan-out (Claude-only update).
- `writeMergeMarker` now emits a warning when xm-managed marker block content was edited by the user; surfaced in install/propagate output.
- `x-build tasks update --tokens-in/--tokens-out` records measured token cost (`cost_source: "actual"`); `computeTokenActuals` now excludes estimated samples so cost actuals learn from real usage instead of recycling their own estimates.

### Fixed
- x-memory CLI crashed with `ERR_MODULE_NOT_FOUND` in the installed plugin cache layout (top-level cross-plugin import of `x-trace`); trace-writer is now resolved lazily with a no-op fallback so every subcommand runs.
- `x-build run --json` (the agent-spawn plan) bypassed the budget gate and ignored `model_profile`; it now enforces the budget (blocks with exit 1) and resolves spawn models via `getModelForRole`.

### Changed
- Untracked build artifacts from git: `coverage/` (now gitignored) and `.codex/` (install-time render target); removed stray files committed by the task harness.

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
