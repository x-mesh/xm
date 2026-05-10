# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added
- `xm update` now auto-propagates skills/hooks to every installed LLM target (Cursor/Codex/Kiro/Antigravity/OpenCode) via the manifest registry. Per-file SHA-256 diffing skips unchanged targets.
- `xm install --propagate` — re-render every installed manifest target programmatically (used internally by `xm update`).
- `xm install --list-installed` — print installed manifest inventory as JSON.
- `xm update --no-propagate` — opt out of fan-out (Claude-only update).
- `writeMergeMarker` now emits a warning when xm-managed marker block content was edited by the user; surfaced in install/propagate output.
