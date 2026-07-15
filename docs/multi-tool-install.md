# xm Multi-Tool Install Guide

xm is published as a Claude Code marketplace plugin, but its 16 SKILLs can also be rendered into the formats consumed by **Cursor**, **OpenAI Codex CLI**, **AWS Kiro**, **Google Antigravity**, and **OpenCode**. A single source compiler (`xm/lib/install/install-cli.mjs`) emits per-tool artifacts so you maintain one source of truth.

> **TL;DR**
> ```bash
> # interactive picker
> xm install
> # preview
> node xm/lib/install/install-cli.mjs --list
> # install for one repo
> node xm/lib/install/install-cli.mjs --target cursor,codex,kiro,antigravity,opencode
> # validate
> node xm/lib/install/install-cli.mjs --verify
> # remove (preserves your AGENTS.md content)
> node xm/lib/install/install-cli.mjs --uninstall
> ```

## Table of Contents
- [Capability Matrix](#capability-matrix)
- [Prerequisites](#prerequisites)
- [Install per Tool](#install-per-tool)
  - [Cursor](#cursor)
  - [Codex CLI](#codex-cli)
  - [Kiro](#kiro)
  - [Antigravity](#antigravity)
  - [OpenCode](#opencode)
- [Verification](#verification)
- [Uninstall](#uninstall)
- [Testing](#testing)
- [Security Model](#security-model)
- [Troubleshooting](#troubleshooting)

---

## Capability Matrix

Claude Code is the reference target — every other tool is a compiled subset shaped by the host's plugin model.

| Capability | Claude Code | Cursor | Codex CLI | Kiro | Antigravity | OpenCode |
|------------|:-:|:-:|:-:|:-:|:-:|:-:|
| xm SKILL bodies | ✅ | ✅ `.cursor/rules/*.mdc` | ✅ `plugins/xm/skills/*/SKILL.md` | ✅ `.kiro/steering/*.md` | ✅ `.agent/skills/*.md` (or `~/.gemini/antigravity/skills/`) | ✅ `.opencode/skills/*/SKILL.md` (or `~/.config/opencode/skills/*/SKILL.md`) |
| Auto rule loading | ✅ | △ agent-requested via description | ✅ native Plugin Skill discovery | △ inclusion: auto/manual | △ agent-requested | ✅ native skill discovery |
| Explicit discovery | ✅ `/xm:build` | △ `.cursor/commands/` (no commands declared yet) | ✅ `$xm:build` via `/skills` or `$` completion | ❌ | △ workflows file | ❌ skill-only |
| Blocking hook (exit 2) | ✅ | ✅ `.cursor/hooks.json` (camelCase) | △ Bash/shell only (issue #16732) | ❌ run-only, no block | ❌ no programmable API | ❌ not emitted |
| References as separate files | ✅ | ✅ `xm-*-ref-*.mdc` | △ inlined in prompt body | ✅ `#[[file:…]]` include | △ inlined | △ inlined |
| CLI bundling (build/solver/memory) | ✅ `${CLAUDE_PLUGIN_ROOT}` | ✅ `~/.cursor/xm/lib/` | ✅ `~/.codex/xm/lib/` | ✅ `~/.kiro/xm/lib/` | ✅ `~/.gemini/xm/lib/` | ✅ `~/.config/opencode/xm/lib/` |
| MCP servers | ✅ | ✅ | ✅ | ✅ | ✅ (config-only) | ✅ |
| Programmable hook API | ✅ | ✅ | △ partial | △ run-only | ❌ | ❌ |

Legend: ✅ full / △ limited / ❌ unsupported.

---

## Prerequisites

- **Node.js ≥ 20** (or **Bun**) — the install CLI is `.mjs` and uses only Node stdlib + crypto. No external dependencies.
- **Git** — manifests live alongside source; `.bak` rotation works on regular files only.
- A clone of this repo or the published `x-mesh/xm` package on disk.

> The same SKILL source files render to all supported targets. You do **not** need each target's IDE installed before running `xm install`; rules will be picked up the next time you open the project in that tool.

---

## Install per Tool

`xm install` writes files under one of two roots:

| Scope | Root | Use when |
|------:|:-----|:---------|
| `--local` (default) | current working directory | per-repo install, version-controlled rules |
| `--global` | `$HOME` | machine-wide rules visible across every project |

You can pick one or many targets:

```bash
# interactive scope + target picker
xm install
# direct compiler invocation
node xm/lib/install/install-cli.mjs --interactive

# one tool, project-local (most common)
node xm/lib/install/install-cli.mjs --target cursor

# many tools, project-local
node xm/lib/install/install-cli.mjs --target cursor,codex,kiro,antigravity,opencode

# user-global, with confirmation skipped (CI)
node xm/lib/install/install-cli.mjs --target cursor --global --yes
```

The interactive picker asks for `local` vs `global`, then accepts target numbers,
names, `all`, or unique fuzzy fragments such as `open` for `opencode`.

The first run writes new files and a manifest. Re-runs are idempotent — same arguments produce zero `git diff`. Existing user-authored content (e.g. notes you wrote in `AGENTS.md`) is preserved via `<!-- xm:BEGIN v2 --> ... <!-- xm:END -->` markers and `.bak` rotation (max 3 generations).

### Cursor

```bash
node xm/lib/install/install-cli.mjs --target cursor
```

Writes:
- `.cursor/rules/xm-<plug>.mdc` × 16 — primary skill rules (frontmatter: `description`, `alwaysApply: false`)
- `.cursor/rules/xm-<plug>-ref-<name>.mdc` — reference companions (alwaysApply: false)
- `.cursor/hooks.json` — Cursor 1.7+ hooks translated from `.claude/settings.json`
- `.cursor/xm/manifest.json` — install manifest (auto)

Verify in Cursor:
1. Open the project. Cursor reads `.cursor/rules/*.mdc` at session start.
2. Start a new chat; ask the agent something that should match a SKILL description (e.g. "plan a phased rollout"). The relevant `xm-build.mdc` should be auto-attached.
3. Edit a file; the `block-marketplace-copy.mjs` hook should fire (visible in the Cursor agent log).

> **`xm-op.mdc` exceeds Cursor's recommended 500-line limit (522 lines).** Cursor may truncate. We emit a warning; treat the rule as best-effort until x-op SKILL.md is decomposed.

### Codex CLI

```bash
# local — register the project marketplace once
node xm/lib/install/install-cli.mjs --target codex --local
codex plugin marketplace add "$PWD"
codex plugin add xm@<marketplace-printed-by-installer>

# global (recommended for Codex)
node xm/lib/install/install-cli.mjs --target codex --global
codex plugin add xm@personal

# enable hooks (one-time)
codex features enable hooks
# or add to ~/.codex/config.toml:
# [features]
# hooks = true
```

Writes:
- `~/plugins/xm/.codex-plugin/plugin.json` (or `./plugins/xm/...` for `--local`) — native Codex Plugin manifest
- `~/plugins/xm/skills/<skill>/SKILL.md` — per-skill bodies invoked as `$xm:<skill>`
- `~/.agents/plugins/marketplace.json` (or `./.agents/plugins/marketplace.json` for `--local`) — merges only the `xm` entry and preserves other plugins
- `~/.codex/hooks.json` — PascalCase Claude-style hooks, sanitized commands
- `~/.codex/xm/manifest.json`

Verify in Codex:
1. For `--local`, run the printed `codex plugin marketplace add <project-root>` first. Then run the printed `codex plugin add xm@<marketplace>` and start a new Codex thread.
2. Type `$xm:build plan a phased rollout`. `$` completion should list the installed xm Skills.
3. Hooks: trigger a Bash tool call; `PreToolUse` hook should run (other matchers may be silently ignored — upstream tracking [openai/codex#16732](https://github.com/openai/codex/issues/16732)).

### Kiro

```bash
node xm/lib/install/install-cli.mjs --target kiro
```

Writes:
- `.kiro/steering/xm-<plug>.md` × 16 — `inclusion: auto` (Kiro asks the LLM whether to load each)
- `.kiro/steering/xm-<plug>-ref-<name>.md` × 23 — `inclusion: manual` (companion docs only loaded when explicitly mentioned)
- `.kiro/hooks/xm-<event>-<index>.kiro.hook` — JSON hooks (one per translatable Claude hook); uses `when.toolTypes[]` for tool events, `when.patterns[]` for file events; `version: "1.0.0"` (semver). **Runs alongside the operation, cannot block** (R-SEC-09 limitation)
- `.kiro/hooks/xm-pretooluse-1.kiro.hook` (etc.) — trace-session hooks converted as **best-effort** (`toolTypes: ["*"]`); Kiro has no Skill matcher equivalent
- `.kiro/xm/manifest.json`

Verify in Kiro:
1. Open the project in Kiro. The "Steering" panel should list xm-* entries.
2. Ask the agent "what does xm build do?" — Kiro should auto-attach `xm-build.md` because `inclusion: auto` matches description.
3. Reference an inclusion: `#xm-op-ref-strategies` should resolve to the manual-inclusion file.
4. Check `.kiro/hooks/` — hook files should have `version: "1.0.0"`, `when.toolTypes` (array) for tool events, and no `enabled` or `when.tool` fields. Trace-session hooks should exist with `toolTypes: ["*"]` and "best-effort" in description.

> **Hook semantics differ from Claude/Cursor.** Kiro's `runCommand` runs in parallel with the tool call — it cannot exit-code-deny. We surface this in the hook's `description` field and in install stdout. Use Cursor or Codex if you need blocking.

> **Trace-session hooks** are now converted as best-effort with `toolTypes: ["*"]` (triggers on all tool calls). The original Claude `Skill` matcher has no Kiro equivalent; the hook description notes this approximation.

### Antigravity

Antigravity is **Public Preview** as of 2026-04. We deliberately keep the renderer conservative.

```bash
node xm/lib/install/install-cli.mjs --target antigravity
```

Writes:
- `AGENTS.md` index block
- `.agent/skills/xm-<plug>.md` × 16 (project) or `~/.gemini/antigravity/skills/xm-<plug>.md` (`--global`) — per-skill bodies, plain Markdown (no frontmatter)
- `.gemini/xm/manifest.json`

Notes:
- We avoid `~/.gemini/GEMINI.md` for global installs (conflicts with `gemini-cli`, [google-gemini/gemini-cli#16058](https://github.com/google-gemini/gemini-cli/issues/16058)) — use `~/.gemini/AGENTS.md` instead.
- Antigravity does **not** expose a programmable hook API. The renderer skips hooks entirely; Cursor or Codex remain the targets if you need that surface.
- See [`.xm/build/projects/multi-tool-install/phases/02-plan/E0-gate.md`](../.xm/build/projects/multi-tool-install/phases/02-plan/E0-gate.md) for the spike decision rationale.

### OpenCode

```bash
node xm/lib/install/install-cli.mjs --target opencode

# global
node xm/lib/install/install-cli.mjs --target opencode --global
```

Writes:
- `.opencode/skills/xm-<plug>/SKILL.md` × 16 (project) or `~/.config/opencode/skills/xm-<plug>/SKILL.md` (`--global`) — native OpenCode skills with `name`, `description`, and `compatibility: opencode` frontmatter
- `.opencode/xm/manifest.json` (project) or `~/.config/opencode/xm/manifest.json` (`--global`)

Verify in OpenCode:
1. Start `opencode` in the project root.
2. Ask for an xm workflow such as "use xm build to plan a phased rollout"; OpenCode should discover the matching skill.
3. For global installs, confirm `~/.config/opencode/skills/xm-build/SKILL.md` exists and restart OpenCode if the session was already running.

Notes:
- OpenCode can also read some Claude-compatible skill locations, but xm installs to the native `.opencode` / `~/.config/opencode` paths so users can disable Claude compatibility without losing xm.
- Hooks are not emitted for OpenCode. Use Cursor or Codex when you need translated hook behavior.

---

## Verification

Re-hash the installed files against the manifest's recorded SHA-256 (R-SEC-13/15). Detects tampering, file modes drifting from `0o644`/`0o600`, and missing files.

```bash
node xm/lib/install/install-cli.mjs --verify
node xm/lib/install/install-cli.mjs --verify --target cursor       # one tool
```

A clean install reports:
```
# cursor (local, 40 files)
  selfChecksum: ok
  status counts: ok=40
```

A tampered file reports:
```
# cursor (local, 40 files)
  selfChecksum: ok
  status counts: ok=39, changed=1
  changed  /path/to/.cursor/rules/xm-build.mdc
```

A mode mismatch (e.g. someone `chmod 666`'d a global file) reports:
```
  ⚠ mode mismatch: 1 entry(ies) (R-SEC-08).
    expected=0o600 actual=0o666 /path/to/file
```

Exit code is 0 only when `selfChecksum: ok`, every entry status is `ok` or `unverified`, and no mode mismatches were found.

---

## Uninstall

```bash
node xm/lib/install/install-cli.mjs --uninstall --target cursor,codex
```

Reads each manifest, removes only the files xm wrote, restores AGENTS.md to its pre-xm content (preserving anything you added outside the marker), and deletes the manifest. External files (anything you authored under `.cursor/rules/`, `.kiro/steering/`, etc., that isn't `xm-*` and isn't manifest-tracked) are untouched.

A second run safely reports "nothing to uninstall".

---

## Testing

### Automated unit + integration (CI)

```bash
bun test test/install.test.mjs
# run `bun test test/install.test.mjs` for the current count
```

Covers: input validation, `--list`/`--dry-run` (zero side-effects), install + idempotency for all supported targets, supply-chain checksum guard with both pass and bypass paths, `--verify` (clean / tampered / missing), uninstall (preservation of user content + external files), and file permissions (`0o644` for local, `0o600` for global).

The full project test suite stays green:

```bash
bun test
# 565 pass / 1 fail (pre-existing x-dashboard/api unrelated)
```

### Smoke script (manual, one command)

```bash
# all supported targets
bash xm/scripts/test-install.sh
# subset
bash xm/scripts/test-install.sh cursor codex
```

The script:
1. Creates a tmp project with seeded `.claude/settings.json` and a user-authored `AGENTS.md`.
2. Runs `--check` against `xm/skills.checksums.json`.
3. For each target: install → re-install (idempotency check) → `--verify` clean → AGENTS.md preservation (codex/antigravity).
4. Final uninstall pass + AGENTS.md user-content preservation.
5. Reports pass/fail per check; exits non-zero on any failure.

Recent run: use `bash xm/scripts/test-install.sh` for the current pass/fail count.

### Manual end-to-end in the actual IDE

The CI tests verify file shape and content. To verify the rules are *consumed* correctly, you must open the target IDE:

| Tool | How to verify rules are loaded |
|------|-------------------------------|
| Cursor | Open the project; chat "plan a phased rollout" — the `xm-build.mdc` rule should attach (visible in `@Files` panel or inspector) |
| Codex CLI | install the Plugin, start a new thread, then type `$xm:build` — `$` completion should list the Skill and invoke it |
| Kiro | Open project; the "Steering" panel should list xm-* entries with their `inclusion` mode |
| Antigravity | Open project; ask "what xm tools are available?" — agent should reference the AGENTS.md index |

Document the result in your own QA log. We do not bundle each IDE in CI.

---

## Security Model

The installer is governed by 15 security requirements (R-SEC-01..15) defined in [`PRD.md`](../.xm/build/projects/multi-tool-install/phases/02-plan/PRD.md) §14.

Highlights:
- **R-SEC-02** — `xm/skills.checksums.json` records SHA-256 of every source SKILL.md. The CLI refuses to render a SKILL whose hash doesn't match. `--allow-unverified` bypasses with an audited per-entry flag (R-SEC-15).
- **R-SEC-04** — `--target` is an enum (`cursor|codex|kiro|antigravity`); plugin/skill names must match `/^[a-z][a-z0-9-]{0,30}$/`; final write paths are validated via `resolve()` + `startsWith(installRoot)`.
- **R-SEC-05** — `.bak` rotation aborts on symlinks (`lstat` check) to defeat TOCTOU symlink-escape.
- **R-SEC-13/14** — manifest entries carry SHA-256 + the manifest itself carries an HMAC `selfChecksum` keyed by an install-time nonce. Lock files use `O_EXCL` atomic create with a 60-second stale TTL.
- **R-SEC-08** — global writes are mode `0o600`/`0o700`; `--verify` flags any mode drift.

Refresh the checksum registry whenever a SKILL.md changes:

```bash
node xm/scripts/skills-checksum.mjs           # write
node xm/scripts/skills-checksum.mjs --check   # CI gate (exit 1 on stale)
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `R-SEC-02: SKILL.md checksum mismatch` | `xm/skills.checksums.json` is stale or you edited a SKILL.md | `node xm/scripts/skills-checksum.mjs` (release flow) — or `--allow-unverified` for one-off debugging |
| `lock held: <file>.lock` | Another `xm install` is still running, or a previous run crashed within 60 s | Wait, or delete the `.lock` file after confirming no other process holds it |
| `marker mismatch in AGENTS.md` | The xm marker block was edited manually or partially deleted | Inspect the file and either restore the marker pair manually or delete the corrupt block — the installer refuses to auto-recover by design |
| `refusing to back up symlink: …` | The target path is a symlink (R-SEC-05) | Replace with a regular file or relocate the symlink |
| Cursor doesn't pick up rules | `.cursor/rules/*.mdc` hot reload is unreliable; rules attach at session start | Open a new Cursor chat or restart the IDE |
| Codex `$xm:build` is not listed | Plugin was not installed/refreshed, or the current thread predates installation | Re-run `xm install --target codex --global`, run the printed `codex plugin add xm@<marketplace>`, then start a new thread |
| `xm-op.mdc body has 522 lines (> 500)` warning | Cursor's recommended cap | Acknowledged; tracked in PRD §16. Use `--target codex` if line limit matters |
| Kiro hook didn't block a write | Kiro doesn't support exit-code denial (R-SEC-09) | Use Cursor or Codex if blocking semantics are required |
| `~/.gemini/GEMINI.md` mysteriously rewritten | gemini-cli also uses this path ([#16058](https://github.com/google-gemini/gemini-cli/issues/16058)) | We default to `~/.gemini/AGENTS.md`; if you must use `GEMINI.md`, install with `--local` only |

If `--verify` reports `selfChecksum: FAIL`, the manifest itself was tampered with. Re-run install to regenerate, and consider what process modified the target's `xm/manifest.json` outside the installer.

---

## Reference

- Architecture decision records: see [`PRD.md`](../.xm/build/projects/multi-tool-install/phases/02-plan/PRD.md) §5.1 (SkillIR), §5.2 (overflow strategy), §5.3 (multi-writer protocol)
- Frozen IR: [`xm/lib/install/INTERFACE-FREEZE.md`](../xm/lib/install/INTERFACE-FREEZE.md)
- E0 (Antigravity) gate decision: [`E0-gate.md`](../.xm/build/projects/multi-tool-install/phases/02-plan/E0-gate.md)
- B PoC gate evidence: [`B-gate.md`](../.xm/build/projects/multi-tool-install/phases/02-plan/B-gate.md)
- Per-tool research notes: [`phases/01-research/notes.md`](../.xm/build/projects/multi-tool-install/phases/01-research/notes.md)
