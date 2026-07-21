<p align="center">
  🇰🇷 <a href="./README.ko.md">한국어</a> | 🇺🇸 English
</p>

<p align="center">
  <img src="assets/xm-logo.jpeg" alt="xm" width="600" />
</p>

<h1 align="center">xm</h1>

<p align="center">
  AI coding agents fail silently. They skip planning, miss context, and never check the result.<br />
  <strong>xm makes that harder to do.</strong>
</p>

<p align="center">
  <a href="https://github.com/x-mesh/xm/releases"><img src="https://img.shields.io/badge/version-2.12.0-blue" alt="Version" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License: MIT" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node.js" /></a>
  <a href="#plugins"><img src="https://img.shields.io/badge/plugins-14-orange" alt="Plugins" /></a>
</p>

<p align="center">
  A plugin toolkit for <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a>. It adds the steps a senior engineer never skips: plan before coding, review before merging, verify before declaring done.
</p>

<p align="center">
  <code>/xm:build plan "Build a REST API with JWT auth"</code><br />
  → PRD → task decomposition → parallel agents → verified ✅
</p>

---

## Table of Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [Why xm?](#why-xm)
- [Cross-Vendor Verification](#cross-vendor-verification)
- [Plugins](#plugins) — [x-build](#x-build) · [x-op](#x-op) · [x-review](#x-review) · [x-solver](#x-solver) · [x-probe](#x-probe) · [x-eval](#x-eval) · [x-humble](#x-humble) · [x-dashboard](#x-dashboard) · [x-agent](#x-agent) · [x-trace](#x-trace) · [x-memory](#x-memory) · [x-humanize](#x-humanize) · [x-recall](#x-recall) · [x-panel](#x-panel) · [x-wt](#x-wt)
- [Quality & Learning Pipeline](#quality--learning-pipeline)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

---

## Install

### Prerequisites

xm uses [Bun](https://bun.sh) as its JavaScript runtime for testing, the dashboard server, and script execution.

**Why Bun?**
- Fast startup — scripts and tests launch instantly with no JIT warmup
- Built-in test runner — `bun test` works out of the box, no extra devDependencies
- Native TypeScript/ESM — runs `.ts` and `.mjs` files directly without transpilation
- Zero-config HTTP server — powers `x-dashboard` with no npm dependencies

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# Homebrew
brew install oven-sh/bun/bun

# Windows
powershell -c "irm bun.sh/install.ps1 | iex"
```

After installation, verify with `bun --version` (requires v1.0+).

> Node.js >= 18 is still required for Claude Code itself. Bun is used for xm's own tooling.

### Plugin Setup

```bash
/plugin marketplace add x-mesh/xm
/plugin install xm@xm -s user
```

### First-Run Init (Global)

After installing, run once per machine to copy the trace-session hook into `~/.claude/hooks/` and register Skill matchers in `~/.claude/settings.json`:

```
/xm init              # install trace-session hook into ~/.claude/
/xm init status       # verify install state
/xm init uninstall    # remove hook + settings entries
/xm init --no-hooks   # CLI-only install (no-op today — reserved)
```

Idempotent: safe to re-run. Existing hooks (e.g. mem-mesh) are preserved, and each write creates a timestamped backup of `settings.json`. Traces land in each project's `.xm/traces/`.

The same install flow is available from a terminal via `xm init` (see [Terminal CLI](#terminal-cli-optional)).

### Terminal CLI (optional)

Install the `xm` umbrella CLI to run commands directly from your shell — useful for the dashboard, sync, memory, traces, etc., without entering Claude Code:

```bash
# Local install from this repo
bash xm/scripts/install.sh

# Or remote
curl -fsSL https://raw.githubusercontent.com/x-mesh/xm/main/xm/scripts/install.sh | bash
```

The installer writes `~/.local/bin/xm` (override with `XM_BIN_DIR`; ensure it is on your `PATH`) and, when the `claude` CLI is on `PATH`, also runs `claude plugin install <p>@xm -s user` for every plugin in `marketplace.json` (x-build, x-agent, x-op, x-solver, x-review, x-trace, x-memory, x-eval, x-probe, x-humble, x-humanize, x-dashboard, x-recall, x-panel, x-wt, xm). Run `/reload-plugins` inside Claude Code afterward to activate them. If `claude` is not on `PATH`, the CLI wrapper alone is installed and the plugin list is printed for manual install.

#### Global hook install (`xm init`)

The bash `xm init` subcommand is equivalent to the `/xm init` slash command — it installs the Skill-tracing hook into **user-scoped** `~/.claude/` (once per machine):

```bash
xm init                 # install trace-session hook into ~/.claude/
xm init status          # verify install state
xm init uninstall       # remove hook + settings entries
xm init --no-hooks      # CLI-only install (no-op today — reserved)
```

Writes `~/.claude/hooks/xm-trace-session.mjs` and merges `PreToolUse`/`PostToolUse` Skill matchers into `~/.claude/settings.json` (existing hooks such as mem-mesh are preserved; a timestamped backup is created on every write). Use the bash route when you are outside Claude Code; otherwise `/xm init` is the preferred entry point.

```bash
xm dashboard                       # start — uses ~/.xm/projects.json registry (all registered projects)
xm dashboard --scan ~/work         # legacy multi-project mode: scan ~/work for .xm/ dirs (depth 4)
XM_DASHBOARD_SCAN=~/work xm dashboard   # same, persisted via env var
xm dashboard stop                  # stop it
xm dashboard restart               # stop + start — picks up new server code / a fresh served bundle
xm dashboard open                  # open it in your browser

# Project registry (~/.xm/projects.json)
xm project import ~/work           # one-shot bulk-register all .xm/ projects under ~/work
xm project list                    # show registered projects
xm project add [<path>]            # register CWD or given path
xm project remove <id|path>        # unregister
xm project archive <id>            # hide from dashboard without deleting
xm project gc                      # drop entries whose path no longer exists
xm sync push           # push .xm/ state to your sync server
xm sync pull           # pull state from your sync server
xm memory <subcmd>     # save | recall | inject | list
xm build <subcmd>      # build status / list / ...
xm config <subcmd>     # show | get <key> | set <key> <val> | reset (--local | --global)
xm trace <subcmd>      # execution traces
xm solver <subcmd>     # structured problem solving
xm handoff [reason]    # save session state (+ tier-2 detail archive)
xm handon              # restore session state
xm handon --log        # print the tier-2 detailed archive on demand
xm build handoff --mirror-status   # inspect the mem-mesh mirror payload/status
xm build handoff --mirror-skip     # dismiss a pending mirror (no mem-mesh setup)
xm which               # show resolved lib paths
xm version
xm help
```

The CLI dispatches to plugin libs in `~/.claude/plugins/cache/xm/` (or `$XM_LIB`), so the Claude Code plugin must be installed first. The `sync` subcommand reuses the `x-sync` plugin lib, so you do **not** need to run `x-sync/install.sh client` separately.

#### Project Registry (`xm project`)

The dashboard reads from a machine-local registry at `~/.xm/projects.json`. Once populated, `xm dashboard` shows every registered project without `--scan`.

- **First-time setup**: run `xm project import ~/work` (or any root) to bulk-register every existing `.xm/` project. Idempotent — re-running only updates `last_seen`.
- **Auto-registration**: when you run any xm command from a project directory, the dispatcher self-registers it. New projects appear in the dashboard without explicit action.
- **Worktrees**: a worktree of an already-registered repo is collapsed onto the main repo entry. Running `xm` from any worktree updates the same registry entry — no duplicates.
- **Resolution priority**: `--scan` flag → `~/.xm/projects.json` → legacy `~/.xm/config.json` `scan_roots` → CWD only.

### Multi-Tool Install (Cursor / Codex / Kiro / Antigravity / OpenCode)

xm is published as a Claude Code marketplace plugin, but its 16 SKILLs can also be rendered into rule/steering formats consumed by other AI coding tools. A single source compiler (`xm/lib/install/install-cli.mjs`) emits per-tool artifacts.

```bash
# Interactive picker (scope + targets)
xm install
# or, when invoking the compiler directly
node xm/lib/install/install-cli.mjs --interactive

# Preview what would be installed (no fs writes)
node xm/lib/install/install-cli.mjs --list

# Install for one or more tools, project-local (default)
node xm/lib/install/install-cli.mjs --target cursor,codex,kiro,antigravity,opencode

# User-global install (~/.cursor/, ~/.codex/, ~/.kiro/, ~/.gemini/, ~/.config/opencode/)
node xm/lib/install/install-cli.mjs --target cursor --global

# Re-hash installed files against the manifest (R-SEC-13/15)
node xm/lib/install/install-cli.mjs --verify --target cursor

# Remove all xm-managed files; user content in AGENTS.md is preserved
node xm/lib/install/install-cli.mjs --uninstall --target cursor,codex
```

**Per-tool layout:**

| Tool | Skills | Slash invocation | Hook |
|------|--------|-----------------|------|
| Cursor | `.cursor/rules/xm-*.mdc` (frontmatter: `description`, `alwaysApply`) | agent-requested | `.cursor/hooks.json` (camelCase events) |
| Codex CLI | `.agents/skills/xm-<skill>/SKILL.md` aliases + `plugins/xm/.codex-plugin/plugin.json` + bundled Skills + marketplace | `$xm-<skill>` (searchable) or `$xm:<skill>` after `codex plugin add xm@<marketplace>` | `.codex/hooks.json` / `~/.codex/hooks.json` (requires `codex features enable hooks` or `[features] hooks=true`) |
| Kiro | `.kiro/steering/xm-*.md` (frontmatter: `inclusion: auto\|manual`) | n/a | `.kiro/hooks/xm-*.kiro.hook` (informational only — Kiro cannot block) |
| Antigravity | `.agent/skills/xm-*.md` (project) or `~/.gemini/antigravity/skills/xm-*.md` (`--global`) + shared `AGENTS.md` index | agent-requested | not supported (no programmable hook API) |
| OpenCode | `.opencode/skills/xm-*/SKILL.md` (project) or `~/.config/opencode/skills/xm-*/SKILL.md` (`--global`) | native skill discovery | not emitted |

**Safety:**
- `<!-- xm:BEGIN v2 --> ... <!-- xm:END -->` markers isolate xm content inside files shared with the user (AGENTS.md). Pre-existing user content is preserved.
- Existing files are rotated to `.bak`, `.bak.1`, `.bak.2` (max 3 generations) on first overwrite. Symbolic links abort.
- Lock files use `O_EXCL` atomic creation with a 60-second stale TTL.
- Each install writes a manifest under the target's `xm/manifest.json` directory (for example `.cursor/xm/manifest.json` or `~/.config/opencode/xm/manifest.json`) with SHA-256 + HMAC self-checksum. `--verify` recomputes hashes; `--uninstall` rolls back exactly the recorded files.
- `.codex/hooks.json` is shared with other tools (e.g. mem-mesh): install/uninstall track ownership per handler and merge/remove only xm's own entries, leaving other tools' hooks untouched.
- `R-SEC-02` supply-chain guard: source SKILL.md hashes are verified against `xm/skills.checksums.json` before render. `--allow-unverified` bypasses with a flagged audit entry.
- Installs are idempotent — re-running with the same arguments produces zero diff.

See [`docs/multi-tool-install.md`](docs/multi-tool-install.md) for the complete guide — capability matrix, per-tool install steps, manual verification in each IDE, security model, troubleshooting. The full design (PRD v2.1) is at [`.xm/build/projects/multi-tool-install/phases/02-plan/PRD.md`](.xm/build/projects/multi-tool-install/phases/02-plan/PRD.md).

#### Auto-propagation on update

`xm update` automatically re-renders skills to every installed LLM target (Cursor, Codex CLI, Kiro, Antigravity, OpenCode) when their global manifests are present, even when Claude is already at the remote version. Per-file SHA-256 diffing skips unchanged targets; Codex also receives a cachebuster and automatic `codex plugin add` so its active plugin cache cannot remain stale. Pass `--no-propagate` to update only the Claude plugin.

```bash
xm update                   # update plugin + propagate to all installed targets
xm update --no-propagate    # Claude-only update, skip fan-out
xm install --propagate      # re-render every installed manifest target on demand
xm install --list-installed # print installed manifest inventory as JSON
```

## Quick Start

```bash
/xm:build plan "Build a REST API with JWT auth"
```

That single line:
1. Creates a project + generates a PRD with requirements
2. Auto-decomposes into tasks with done criteria
3. Presents the plan for review (user approval)
4. Agents execute tasks in parallel → quality verification

Want to skip Research/PRD and go straight to execution? Use `--quick`:
```bash
/xm:build plan "Build a REST API with JWT auth" --quick
```

Failed? Run `/xm:build run` again. Completed tasks are skipped, only remaining ones execute.

<details>
<summary>Step-by-step tutorial (5 minutes)</summary>

```bash
# 1. Initialize
/xm:build init my-project

# 2. Gather requirements (optional but recommended)
/xm:build discuss --mode interview
# → Agent asks clarifying questions, generates CONTEXT.md

# 3. Generate PRD + decompose into tasks
/xm:build plan "Build a user auth system with JWT"
# → Auto-generates PRD + task list

# 4. Validate the plan
/xm:build plan-check
# → Checks 11 dimensions (atomicity, coverage, scope-clarity, ...)

# 5. Execute
/xm:build run
# → Agents execute tasks in parallel (DAG order)

# 6. Verify
/xm:build quality                  # test/lint/build checks
/xm:build verify-traceability      # R# ↔ Task ↔ AC matrix

# 7. Done!
/xm:build status
```

</details>

---

## Why xm?

Most AI coding tools work off a checklist: SQL injection, null check, N+1. Checklists find patterns. Senior engineers find problems.

The difference is the questions they ask before they act. Before filing a security finding: can an attacker actually reach this path? Before debugging: when did this last work? Before raising severity: am I inflating this because I'm not sure?

xm bakes those questions into every agent prompt. Agents end up reasoning about context instead of pattern-matching through a list.

<details>
<summary>Before & After examples</summary>

**Code review (x-review):**

| | Checklist agent | xm agent |
|---|----------------|-------------|
| Finding | `[Medium] src/api.ts:42 — Possible SQL injection` | `[Critical] src/api.ts:42 — req.query.id inserted directly into SQL template literal. Public API endpoint with no auth middleware.` |
| Fix | `Validate input.` | `db.query('SELECT * FROM users WHERE id = $1', [req.query.id])` |
| Why | *(missing)* | `Unauthenticated public endpoint, input flows directly to query sink` |

**Planning (x-build):**

| | Without principles | With principles |
|---|-------------------|-----------------|
| Approach | "Using microservices because it's modern" | "Monolith with module boundaries — no constraint requires separate deployment" |
| Risk | "Security risks" | "JWT secret rotation may invalidate active sessions — mitigate with grace period" |
| Done criteria | "Auth works properly" | "JWT endpoint returns 401 for expired token, refresh rotation tested" |

**Debugging (x-solver):**

| | Typical AI | xm |
|---|-----------|-------|
| First action | Generate 5 hypotheses | Describe current state + find last known-good baseline |
| Evidence | "It seems like the issue is..." | "git bisect shows regression in commit abc1234, confirmed by test output" |
| Stuck | Retry same approach | Switch layer (was checking app code → now check infra/config) |

</details>

<details>
<summary>Thinking principles at a glance</summary>

| When you... | xm principle | Tool |
|-------------|----------------|------|
| Review code | Context determines severity — same pattern, different risk depending on exposure | x-review |
| Review code | No evidence, no finding — trace it in the diff or don't report it | x-review |
| Review code | When in doubt, downgrade — over-reporting erodes trust | x-review |
| Plan a project | Decide what NOT to build first — scope by exclusion | x-build |
| Plan a project | Name the risk, schedule it first — fail fast, not fail late | x-build |
| Plan a project | Can't verify it? Can't ship it — every task needs done criteria | x-build |
| Solve a problem | Diagnose state before hypothesizing — what's happening, not what's wrong | x-solver |
| Solve a problem | Anchor to known good — no baseline, no chase | x-solver |
| Solve a problem | Compound signals — never conclude from one log line | x-solver |
| Reflect | Why happened · Why found late · What to change in the process | x-humble |

**How a senior engineer debugs** — the thinking protocol embedded in x-solver:

```
DIAGNOSE ──→ HYPOTHESIZE ──→ TEST ──→ REFINE ──→ RESOLVE ──→ REFLECT
```

1. **"What's happening right now?"** — Describe the observable state, not the problem.
2. **"When did it last work?"** — Find the baseline. No baseline = find one first.
3. **"Why?" — with evidence** — Corroborate from different sources. No evidence? Stop.
4. **"Stuck? Change the lens."** — All hypotheses from the same layer? Look at a different one.
5. **"Show me it works."** — Execution is the only proof.
6. **"Why did we miss this?"** — Retrospect via x-humble.

</details>

---

### Shared References

Common reference material lives in `references/` (synced to marketplace as `xm/references/`). Skills pull these in on demand — progressive disclosure keeps each SKILL.md lean.

| Reference | Used by |
|-----------|---------|
| `ask-user-question-rule.md` | 7 plugins (Dark-Theme rule for AskUserQuestion) |
| `trace-recording.md` | 9 plugins (trace hook protocol) |
| `dimension-anchors.md` | x-op strategies, x-review lenses, x-eval rubrics |
| `self-score-protocol.md` | all x-op strategies, x-agent solve/consensus |
| `finding-severity.md` | x-review, CLAUDE.md code review principles |

---

## Cross-Vendor Verification

Single-vendor AI harnesses — including Claude Code's own `/code-review ultra` — orchestrate one model family. They structurally cannot have a competitor's model check their work. xm can: it spawns external model CLIs (claude + codex + cursor + agy + kiro) directly, so a finding, a plan, a score, or a hypothesis can be adversarially checked across *different* model families. Different vendors have different blind spots — agreement across them is real confidence, and a lone dissent is often the blind spot one family would have shipped silently.

One engine (`xm panel cross`) backs every layer. `--cross-vendor` is **opt-in everywhere** and degrades gracefully to single-vendor when fewer than two CLIs are installed — single-vendor stays the fast, cheap default:

| Layer | Plugin | What `--cross-vendor` does |
|-------|--------|---------------------------|
| Primitive | x-agent fan-out/broadcast | each parallel agent runs on a different vendor |
| Generation | x-solver | candidates/hypotheses generated across model families |
| Planning | x-build consensus | architect/critic/planner/security roles split across vendors |
| Deliberation | x-op debate/council | PRO/CON/JUDGE are genuinely different models |
| Review | x-review | findings cross-checked — consensus vs. diversity |
| Evaluation | x-eval | judges from different vendors, bias-reduced scoring |
| Engine | x-panel | the cross-model adversarial panel itself |

All layers share **one** provider definition: which CLIs exist and how each is spawned lives in the panel's adapters (code), not config. There is no per-plugin provider setup — `panel.*` config tunes panel review only (models/judge/stream), and the cross path shares just `timeout_s`. To add or retarget a vendor, you edit that single definition and every layer picks it up.

Several of those CLIs are themselves multi-vendor gateways — `cursor` and `kiro` front Kimi, DeepSeek, GLM, Gemini, Grok and more — so `--models cursor:kimi-k2.5` works out of the box. Model catalogs move fast, so xm does **not** hardcode them: run `xm panel types` to see each installed CLI's live model-list command.

**Default via config.** Cross-vendor is opt-in per run. To make it a consumer's default, set `.xm/config.json`:

```json
{ "cross_vendor": { "default": false, "review": true, "eval": true } }
```

Precedence: `--cross-vendor` / `--no-cross-vendor` flag > `cross_vendor.<consumer>` > `cross_vendor.default` > false. Consumers: `review`, `op`, `eval`, `solver`, `build`, `agent`. A configured default still requires ≥2 installed + authenticated vendors (`xm panel doctor`); otherwise it falls back to single-vendor loudly.

This is a *capability*, available today; proving it produces measurably better outcomes is a separate, ongoing effort (see `docs/strategy/xm-differentiation.md`).

---

## Plugins

12 plugins, each installable individually or bundled via `xm`.

| Plugin | Purpose | Key command |
|--------|---------|-------------|
| [x-build](#x-build) | Project lifecycle & PRD pipeline | `/xm:build plan "goal"` |
| [x-op](#x-op) | 17 multi-agent strategies | `/xm:op debate "A vs B"` |
| [x-review](#x-review) | Judgment-based code review | `/xm:review diff` |
| [x-solver](#x-solver) | Structured problem solving | `/xm:solver init "bug"` |
| [x-probe](#x-probe) | Evidence-grade premise validation | `/xm:probe "idea"` |
| [x-eval](#x-eval) | Quality scoring & benchmarks | `/xm:eval score file` |
| [x-humble](#x-humble) | Structured retrospective | `/xm:humble reflect` |
| [x-agent](#x-agent) | Agent primitives & teams | `/xm:agent fan-out "task"` |
| [x-trace](#x-trace) | Execution tracing & cost | `/xm:trace timeline` |
| [x-memory](#x-memory) | Cross-session memory | `/xm:memory inject` |
| [x-dashboard](#x-dashboard) | Web dashboard for .xm state | `/xm:dashboard start` |
| [x-humanize](#x-humanize) | Remove AI writing patterns (v0.3.2, pre-stable) | `/xm:humanize audit text` |
| [x-recall](#x-recall) | Cross-session artifact index | `xm recall list` |
| [x-panel](#x-panel) | Cross-model adversarial review | `xm panel` |
| [x-wt](#x-wt) | Session worktree — isolate & land back | `/xm:wt` |
| xm | Bundle + config + pipeline | `/xm pipeline release` |

**Bundled in `xm` core (not separate marketplace plugins):** `/xm:ship` release automation · `x-sync` multi-machine sync server — see [x-ship](#x-ship) and [x-sync](#x-sync) below.

---

### x-build

Takes a project from idea to verified delivery. Generates the PRD, runs deliberation modes, attaches a written acceptance contract to every task, and gates execution on quality.

```bash
/xm:build init my-api
/xm:build discuss --mode interview       # Multi-round requirements interview
/xm:build plan "Build a REST API with JWT auth"
/xm:build run                             # Agents execute in DAG order
```

> Spotted off-scope work mid-task? Park it with **`/xm:later add "..."`** instead of derailing — then `/xm:later promote <id>` when you're ready to pick it up. Backed by `xm build later`.

> **Greenfield-aware** — `init` records `project_kind` via a deterministic gauge (manifest / lockfile / source tree / git history; inspect with `xm build project-kind --json`). Brand-new projects get a Round 0 problem-framing interview (problem / status quo / success / MVP wedge) and a web-enabled **landscape** research agent instead of codebase investigation; existing projects are unchanged. Every new PRD opens with a plain-language **At a Glance** summary, and `prd-check` blocks Execute when Section 8 has no diagram — older PRDs are grandfathered to warnings.

```
Research ──→ PRD ──→ Plan ──→ Execute ──→ Verify ──→ Close
 [discuss]  [quality]  [critique]  [contract]  [quality]  [auto]
  interview   consensus   validate    adapt     verify-contracts
  validate
```

<details>
<summary>Features & commands</summary>

| Feature | Description |
|---------|-------------|
| **Multi-mode deliberation** | `discuss` with 5 modes: interview, assumptions, validate, critique, adapt |
| **PRD generation** | Auto-generates 8-section PRD from research artifacts |
| **PRD quality gate** | On-demand judge panel — rubric-based scoring with guidance |
| **Planning principles** | Scope by exclusion, fail-fast risk ordering, plan as hypothesis, intent over implementation, verify or don't ship |
| **Consensus review** | 4-agent review (architect, critic, planner, security) until agreement |
| **Acceptance contracts** | `done_criteria` per task — auto-derived from PRD, verified at close |
| **Strategy-tagged tasks** | Tasks with `--strategy` flag execute via x-op with quality verification |
| **Team execution** | `--team` routes tasks to hierarchical teams (x-agent team system) |
| **DAG execution** | Tasks run in dependency order, parallel where possible |
| **Cost forecasting** | Per-task $ estimate with complexity-adjusted confidence |
| **Quality dashboard** | Per-task scores + project average in status output |
| **Traceability matrix** | R# ↔ Task ↔ AC ↔ Done Criteria with gap detection |
| **Scope creep detection** | Warns when new tasks overlap with PRD "Out of Scope" items |
| **Error recovery** | Auto-retry with exponential backoff, circuit breaker, git rollback |
| **plan-check (15 dims)** | atomicity, deps, coverage (incl. done_criteria), granularity (upper bound >15), completeness, context, naming (44-verb dict), tech-leakage, scope-clarity (Out of Scope match), risk-ordering (DAG-based), expected-files, failure-mode-coverage, delegation-contract, review-groups, overall |
| **Domain-aware done_criteria** | Auto-generated based on task domain, size tier, and PRD NFR targets |
| **Failure-mode enumeration** | PRD §7.5 forces per-requirement pathological/adversarial inputs (`[R#] <mode> → 검증: <method>`); `tasks done-criteria` injects them as stress checks, `plan-check`'s `failure-mode-coverage` warns when a risk-domain task lacks them. Measured to let a cheaper implementer model match a costlier one on robustness — see `docs/phase-model-routing-experiment.md` |
| **Worktree execution** | `run --worktrees` fans parallel-safe tasks out into isolated `git-kit` worktrees; each task's patch must clear `gate-panel` (a cross-model panel review gate) before it merges — see [Worktree pipeline](#worktree-pipeline) |
| **Group-level review** | `build.review_scope` (`group` default / `task`) batches a review group's tasks into one review run instead of per-task; `build.review_mode` (`manual` default / `auto`) decides whether the group review is optional (exposed, non-blocking) or the mandatory Execute→Verify boundary; `build.review_depth` (`solo` default / `checks-only` / `panel`) decides how heavy it is — `solo` hands the group patch to ONE reviewer agent (verdict recorded via `review-group <name> --verdict pass\|fail`), `checks-only` passes on test/lint alone, and the cross-vendor `panel` runs only on explicit `review-group <name> --depth panel [--rounds 2]`. |
| **Enforced phase gates** | Exit gates are read from config-schema defaults merged over your config, recorded to each phase's `status.json` (visible in `status --json`), and a blocked gate exits non-zero — the marquee "gate the agent can't talk past" is real, not a no-op |
| **Blocking hooks** | `hooks install` ships two native Claude Code hooks: a PreToolUse **scope-guard** that blocks edits outside `triage.fix_scope.allowed_files` during a review-fix, and a Stop **stop-gate** that blocks ending a turn with an unresolved Critical/High finding. Disk-only, fail-open; bypass any run with `XM_BUILD_HOOKS_OFF=1` |
| **ROI routing signal** | `roi` reports quality-per-dollar (Score/$) per model/role/strategy from *measured* actuals and suggests a `model_overrides` change — but only from calibrated data (≥5 tasks with real cost **and** a score); it never guesses from estimates or writes config itself |
| **Calibrated cost actuals** | `forecast update` re-aggregates measured token cost so forecasts price from ground truth; `forecast` labels each estimate `estimate-only` vs `calibrated` |

| Category | Commands |
|----------|----------|
| **Project** | `init`, `list`, `status`, `next [--json]`, `close`, `dashboard` |
| **Phase** | `phase next/set`, `gate pass/fail`, `checkpoint`, `handoff --full`, `handon` |
| **Governance** | `hooks install/uninstall/status` (native blocking hooks; bypass with `XM_BUILD_HOOKS_OFF=1`) |
| **Plan** | `plan "goal"`, `plan-check [--strict]`, `prd-gate [--threshold N]`, `consensus [--round N]` |
| **Tasks** | `tasks add [--desc] [--deps] [--size] [--strategy] [--team] [--done-criteria] [--expected-files]`, `tasks done-criteria`, `tasks list`, `tasks remove [--cascade]`, `tasks update [--desc] [--no-commit] [--expected-files]`, `tasks reopen <id> --reason "..." [--cascade]`, `later add/list/promote/dismiss/verify-scope` |
| **Steps** | `steps compute/status/next` |
| **Execute** | `run`, `run --worktrees [--dry-run] [--max-parallel N]`, `run --json`, `run-status` |
| **Worktrees** | `worktrees plan/status/resume/cleanup`, `gate-panel --project --task --phase --patch`, `review-integration [--base --target]` |
| **Verify** | `quality`, `verify-coverage`, `verify-traceability`, `verify-contracts`, `verify-review-fix [--init]` |
| **Analysis** | `forecast`, `forecast update`, `roi [--by model\|role\|strategy]`, `metrics`, `decisions`, `summarize` |
| **Export** | `export --format md/csv/jira/confluence`, `import` |
| **Release** | `release detect`, `release squash`, `release bump`, `release commit`, `release test`, `release trace`, `release diff-report` |
| **Settings** | `mode developer/normal`, `config set/get/show` |

</details>

<a id="worktree-pipeline"></a>
<details>
<summary>Worktree pipeline (parallel execution, panel-gated)</summary>

For projects with ≥2 tasks that touch disjoint files (declared via `tasks add --expected-files`), `run --worktrees` runs each task in its own isolated `git-kit` worktree instead of sequentially in the main tree:

```bash
/xm:build run --worktrees --dry-run    # plan only — no git-kit calls, prints the batches + branch names
/xm:build run --worktrees              # acquires worktrees, marks tasks RUNNING
# ... agents implement in their worktree, commit ...
/xm:build worktrees resume             # gate + merge every finished worktree, serialized
```

- **Gate**: before a worktree's branch merges, its patch runs through `gate-panel`, a cross-model (`xm panel`) review — `confirmed`/`unreviewed`/`contested` findings above policy severity block the merge (`NEEDS_FIX`), not just crash the CLI. The default per-task policy blocks **critical/high only**; confirmed medium findings surface as non-blocking `advisory_findings` and are re-blocked at the release-phase review (`gate_policy` phase overlays).
- **Round economics**: a gate fail feeds its findings straight into the worktree's `TASK-CONTEXT.md` (no manual relay), consecutive panel-fail rounds past `gate_max_rounds` (default 2) auto-demote medium to advisory, and an optional `pre_gate` command fail-fasts cheap defects before the expensive panel runs.
- **Serialization**: merges are serialized (one `git-kit worktree finish` at a time) since the target branch is locked during a gate run; task implementation itself still runs in parallel.
- **Batch selection**: `expected_files` overlap decides what can run in parallel; tasks with unknown or overlapping file sets fall back to sequential.
- **Release-time check**: `review-integration --base main --target develop` re-runs the gate against the full accumulated diff before a release, catching cross-task regressions no single-task gate would see. With `gate_phase: release`, per-task merges skip the gate entirely and this integration review becomes the single gate (`worktrees status` shows its pending/stale/pass state).

Config lives under `.xm/config.json`'s `worktree` key (`base`, `branch_prefix`, `max_parallel`, `gate_policy`, `gate_max_rounds`, `pre_gate`); see `x-build/skills/build/references/data-model.md` for the full schema and `docs/worktree-gate-optimization-plan.md` for the gate design.

</details>

---

### x-op

17 multi-agent strategies. Each one self-scores its output and can delegate verification to x-eval.

```bash
/xm:op refine "Payment API design" --rounds 4 --verify
/xm:op tournament "Best approach" --agents 6 --bracket double
/xm:op debate "REST vs GraphQL"
/xm:op investigate "Redis vs Memcached" --depth deep
/xm:op compose "brainstorm | tournament | refine" --topic "v2 plan"
```

| Category | Strategies |
|----------|-----------|
| **Collaboration** | refine, brainstorm, socratic |
| **Competition** | tournament, debate, council |
| **Pipeline** | chain, distribute, scaffold, compose, decompose |
| **Analysis** | review, red-team, persona, hypothesis, investigate |
| **Meta** | monitor |

**Quality features:**
- **Confidence Gate**: Pre-execution 4-question checklist — blocks underspecified tasks before wasting agent tokens
- **Self-Score + 4Q Check**: Every strategy auto-scores (1-10) then verifies evidence, requirements, assumptions, consistency
- **--verify**: Delegates quality verification to x-eval using the strategy's default rubric
- **Result Persistence**: Strategy results saved to `.xm/op/` — viewable in x-dashboard
- **Compose presets**: `--preset analysis-deep`, `--preset security-audit`, `--preset consensus`
- **Output Quality Contract**: Evidence-based, falsifiable, dimension-tagged arguments with per-category Dimension Anchors

<details>
<summary>All 17 strategies</summary>

| Strategy | Pattern | Best for |
|----------|---------|----------|
| **refine** | Diverge → converge → verify | Iterating on a design |
| **tournament** | Compete → seed → bracket → winner | Picking the best solution |
| **chain** | A → B → C with conditional branching | Multi-step analysis |
| **review** | Parallel multi-perspective (dynamic scaling) | Code review |
| **debate** | Pro vs Con + Judge → verdict | Trade-off decisions |
| **red-team** | Attack → defend → re-attack | Security hardening |
| **brainstorm** | Free ideation → cluster → vote | Feature exploration |
| **distribute** | Split → parallel → merge | Large parallel tasks |
| **council** | Weighted deliberation → consensus | Multi-stakeholder decisions |
| **socratic** | Question-driven deep inquiry | Challenging assumptions |
| **persona** | Multi-role perspective analysis | Requirements from all angles |
| **scaffold** | Design → dispatch → integrate | Top-down implementation |
| **compose** | Strategy piping (A \| B \| C) | Complex workflows |
| **decompose** | Recursive split → leaf parallel → assemble | Large implementations |
| **hypothesis** | Generate → falsify → adopt | Bug diagnosis, root cause |
| **investigate** | Multi-angle → cross-validate → gap analysis | Unknown exploration |
| **monitor** | Observe → analyze → auto-dispatch | Change surveillance |

</details>

<details>
<summary>Which strategy should I use?</summary>

| Situation | Strategy | Why |
|-----------|----------|-----|
| Iterate on a design | `refine` | Diverge → converge → verify |
| Pick the best solution | `tournament` | Compete → anonymous vote |
| Code review | `review` | Multi-perspective parallel review |
| REST vs GraphQL tradeoff | `debate` | Pro/con + judge verdict |
| Find a bug's root cause | `hypothesis` | Generate → falsify → adopt |
| Large feature implementation | `decompose` | Recursive split → parallel → merge |
| Security hardening | `red-team` | Attack → defend → report |
| Feature brainstorming | `brainstorm` | Free ideation → cluster → vote |
| Unknown territory exploration | `investigate` | Multi-angle → gap analysis |

Not sure? Run `/xm:op list` to see all strategies with descriptions.

</details>

<details>
<summary>Options</summary>

```
--rounds N              Round count (default 4)
--preset quick|thorough|deep|analysis-deep|security-audit|consensus
--agents N              Number of agents (default: agent_max_count)
--model sonnet|opus     Agent model
--target <file>         Review/red-team/monitor target
--depth shallow|deep|exhaustive   Investigation depth
--verify                Delegate quality validation to x-eval
--threshold N           Quality threshold (default 7)
--vote                  Enable voting (brainstorm)
--dry-run               Show execution plan only
--resume                Resume from checkpoint
--explain               Include decision trace
--pipe <strategy>       Chain strategies (compose)
```

</details>

---

### x-review

Multi-perspective code review that reasons about each finding instead of pattern-matching it against a checklist.

```bash
/xm:review diff                     # Review last commit
/xm:review diff HEAD~3              # Review last 3 commits
/xm:review pr 142                   # Review GitHub PR
/xm:review file src/auth.ts         # Review specific file
/xm:review diff --specialists       # Enhance lenses with domain specialist agents
```

| Feature | Description |
|---------|-------------|
| **4 default lenses** | security, logic, perf, tests (expandable to 7: +architecture, docs, errors) |
| **--specialists** | Injects matching specialist agent rules (security-agent, performance-agent, qa-agent, etc.) as lens preambles for deeper domain expertise |
| **Judgment framework** | Each lens has principles, judgment criteria, severity calibration, ignore conditions |
| **Why-line requirement** | Every finding must cite which severity criterion applies — no vague reports |
| **Challenge stage** | Leader validates each finding's severity before final report |
| **Consensus elevation** | 2+ agents report same issue → severity promoted + `[consensus]` tag |
| **Recall Boost** | After severity filtering, second pass scans 6 categories (stubs, contradictions, cross-refs, silent behavior changes, missing error paths, off-by-one) as `[Observation]` tags |
| **--thorough** | Dedicated recall agent with fresh context, 10 observations max, aggressive auto-promotion |
| **Severity disambiguation** | Architecture lens: "this diff introduced it" → Medium vs "follows existing convention" → Low |
| **Verdict** | LGTM (0 Critical, 0 High, Medium ≤ 3) / Request Changes (High 1-2 or Medium > 3) / Block (1+ Critical or High > 2) |

**Review principles:** Context determines severity · No evidence = no finding · No fix direction = no finding · When in doubt, downgrade

---

### x-solver

4 strategies for working through a problem. Auto-picks one based on what the problem actually looks like.

```bash
/xm:solver init "Memory leak in React component"
/xm:solver classify          # Auto-recommend strategy
/xm:solver solve             # Execute with agents
```

| Strategy | Pattern | Best for |
|----------|---------|----------|
| **decompose** | Break → solve leaves → merge | Complex multi-faceted problems |
| **iterate** | Diagnose → hypothesis → test → refine | Bugs, debugging, root cause |
| **constrain** | Elicit → candidates → score → select | Design decisions, tradeoffs |
| **pipeline** | Auto-detect → route to best strategy | When unsure |

```
DIAGNOSE → HYPOTHESIZE → TEST → REFINE → RESOLVE → x-humble
[state+baseline] [falsifiable] [one var] [switch/revert] [exec verify] [why late?]
```

---

### x-probe

Should you build this? Probe before you commit. Grades every premise on the evidence behind it, runs a pre-mortem, and only returns PROCEED when no fatal assumption is left.

```bash
/xm:probe "Build a payment system"    # Full probe session
/xm:probe grill "<decision>"          # Grill yourself — defend a decision under fire
/xm:probe verdict                      # Show last verdict
/xm:probe list                         # Past probes
```

```
FRAME ──→ PROBE ──→ STRESS ──→ VERDICT
[premises]  [socratic]  [pre-mortem]  [PROCEED/RETHINK/KILL]
                        [inversion]
                        [alternatives]
```

<details>
<summary>Features</summary>

| Feature | Description |
|---------|-------------|
| **6 thinking principles** | Default is NO, kill cheaply, evidence with provenance, pre-mortem, code is expensive, ask don't answer |
| **Premise extraction** | Auto-identifies 3-7 assumptions with evidence grades (assumption/heuristic/data-backed/validated), ordered by fragility then evidence |
| **Socratic probing** | Grade-calibrated questioning — heavy on assumptions, light on validated premises |
| **3-agent stress test** | Pre-mortem (failure scenarios) + inversion (reasons NOT to) + alternatives (without code) |
| **Domain detection** | Auto-classifies idea domain (technology/business/market) for specialized questions |
| **Reclassification triggers** | Grade auto-upgrades/downgrades based on user evidence during probing |
| **Verdict** | PROCEED / RETHINK / KILL with evidence summary — fatal+assumption blocks PROCEED |
| **x-build integration** | PROCEED verdict auto-injects premises, evidence gaps, kill criteria into CONTEXT.md |
| **Verdict schema v2** | Structured JSON with domain, evidence grades, gaps — consumed by x-solver/x-humble/xm:memory |
| **x-build link** | PROCEED auto-injects validated premises into CONTEXT.md |
| **x-humble link** | KILL triggers retrospective on why the idea reached probe stage |

</details>

---

### x-eval

Score outputs against rubrics, benchmark strategies head-to-head, and measure how quality moves between commits.

```bash
/xm:eval score output.md --rubric code-quality     # Judge panel scoring
/xm:eval score output.md --rubric code-quality \
  --assert "handles empty input" \
  --assert "no global state"               # + binary outcome assertions (HARD FAIL gate)
/xm:eval compare old.md new.md --judges 5          # A/B comparison
/xm:eval bench "Find bugs" --strategies "refine,debate,tournament" --trials 5
                                                  # pass@k/pass^k reliability metrics
/xm:eval diff --from abc1234 --quality              # Change measurement
/xm:eval diff --baseline v1.5.0                     # Regression check vs pinned tag
/xm:eval consistency x-review                       # Test specific plugin consistency
/xm:eval report --sample-transcript 2              # Dump judge rationales to audit scores
/xm:eval calibrate --rubric code-quality            # Human-vs-judge bias check
```

<details>
<summary>Commands & rubrics</summary>

| Command | What it does |
|---------|-------------|
| **score** | N judges score content against rubric (1-10, weighted avg, consensus σ); `--assert` adds binary HARD FAIL gates; judges may return `N/A` for inapplicable criteria (weight renormalized) |
| **compare** | A/B comparison with position bias mitigation |
| **bench** | strategies × models × trials with `pass@k`/`pass^k` reliability metrics, σ-aware recommendation, broken-task warning, and Score/$ optimization |
| **diff** | Git-based change analysis + optional before/after quality comparison; `--baseline <tag>` flags regressions (delta ≤ -0.5 → ⛔) for CI gates |
| **consistency** | Measure plugin output consistency across repeated runs |
| **rubric** | Create/list custom evaluation rubrics |
| **report** | Aggregated evaluation history |
| **calibrate** | Human-vs-judge calibration loop: surfaces per-criterion bias (inflate/deflate); systematic bias ≥ 1.0 triggers explicit guidance; gates automated judge use when |Δ| ≥ 1.5 on high-weight criteria |

**Built-in rubrics:** `code-quality`, `review-quality`, `plan-quality`, `general` — each declares a `pass_threshold` (7.0–8.0) used by `bench` to compute pass@k / pass^k. Custom rubrics may override via the `pass_threshold` field.

**Audit trail:** `score` and `bench` preserve per-judge rationales in `.xm/eval/results/`; read them via `report --sample-transcript N` to verify scores aren't just aggregate vibes.

**Domain presets:** `api-design`, `frontend-design`, `data-pipeline`, `security-audit`, `architecture-review`

**Bias-aware judging:** High-confidence x-humble lessons (confirmed 3+) surfaced as optional judge context

</details>

---

### x-humble

Learn from failures together. The retrospective process is the point — not the list of rules left at the end.

```bash
/xm:humble reflect              # Full session retrospective
/xm:humble review "why scaffold?"  # Deep-dive on specific decision
/xm:humble lessons              # View accumulated lessons
/xm:humble apply L3             # Apply lesson to CLAUDE.md
```

```
CHECK-IN ──→ RECALL ──→ IDENTIFY ──→ ANALYZE ──→ ALTERNATIVE ──→ COMMIT
[accountability]  [summary]  [failures]   [root cause]  [steelman]    [KEEP/STOP/START]
```

<details>
<summary>Features</summary>

| Feature | Description |
|---------|-------------|
| **Phase 0 Check-In** | Verify previous COMMIT items before new retrospective |
| **Root cause analysis** | Why it happened · Why it was discovered late · What process should change |
| **Bias analysis** | 7 cognitive biases detected (anchoring, confirmation, sunk cost, ...) |
| **Cross-session patterns** | Recurring bias tags surfaced automatically |
| **Steelman Protocol** | User proposes alternative first, agent strengthens it |
| **Comfortable Challenger** | Agent challenges self-rationalization directly |
| **KEEP/STOP/START** | Lessons stored, optionally applied to CLAUDE.md |
| **x-solver link** | After problem solving, auto-suggests retrospective for non-trivial problems |
| **Action Quality Contract** | Every action must be verifiable, scoped, and traced to root cause. Action Type Taxonomy: PROCESS, PROMPT, CONTEXT, TOOL, CALIBRATION |

</details>

---

### x-dashboard

Web dashboard for `.xm/` project state. Browse builds, probes, solvers, **reviews, evals, humble lessons**, traces, memory, and costs in one view. No build chain to set up.

> **Schema-driven Config editor** — the Config tab renders every key in the `config-schema` registry (42 entries) as a typed form: enum dropdowns, tri-state toggles for nullable booleans, a severity grid for `worktree.gate_policy`, defaults highlighted with one-click reset. Three tiers (global / project / **build-local**), the same deep-merge write semantics as the CLI wizard (`setNestedKey` shared), optimistic `If-Match` conflict detection, and hard-violation blocking (422) — add a key to the registry and it appears in the form with zero UI changes.

<p align="center">
  <img src="docs/images/dashboard.png" alt="x-dashboard" width="800" />
</p>

```bash
bun x-dashboard/lib/x-dashboard-server.mjs              # Start (standalone)
bun x-dashboard/lib/x-dashboard-server.mjs --stop       # Stop
/xm:dashboard                                       # Start from Claude Code
```

```
Browser ──→ Bun HTTP :19841 ──→ .xm/ (read-only)
  │
  ├── Home (summary + cost widget)
  ├── Builds (projects list + detail + tasks + context docs + PRD)
  ├── Probes (history + detail + diff between two verdicts)
  ├── Solvers (list + detail with phase data)
  ├── Traces (timeline + token/cost per span)
  ├── Memory (decisions with search/filter)
  └── Config
```

<details>
<summary>Features</summary>

| Feature | Description |
|---------|-------------|
| **Multi-root workspaces** | `--scan ~/work` or `scan_roots` in `~/.xm/config.json` — view all projects across directories |
| **Probe verdict diff** | Side-by-side comparison of two probe runs with premises change highlighting |
| **Cost/token dashboard** | Aggregate cost by model (haiku/sonnet/opus) and date from x-trace data |
| **Brutalism UI** | Hard shadows, monospace accents, dark/light toggle |
| **Search** | Cross-data search across projects, tasks, probes, solvers, context docs |
| **Export** | Download project/probe/solver detail as markdown |
| **Auto-refresh** | 3-second polling with ETag/304 — no scroll/focus reset |
| **Accessibility** | Skip-link, ARIA labels, keyboard navigation, focus indicators |
| **Zero dependencies** | Vanilla HTML/JS/CSS, Bun HTTP server, no npm packages |
| **Session handoff card** | Full handoff display — commits, decisions, quality scores, test status, blockers, stashes (collapsible) |
| **Multi-root session state** | Fetches handoff from all workspaces in parallel, shows most recent |

</details>

---

### x-agent

Agent primitives and autonomous behaviors on top of Claude Code's native Agent tool. Use primitives when you want to control the steps; switch to autonomous behaviors when you'd rather let agents find the path themselves (stigmergy via a shared board).

```bash
# Primitives
/xm:agent fan-out "Find bugs in this code" --agents 5
/xm:agent delegate security "Review src/auth.ts"
/xm:agent broadcast "Review this PR" --roles "security,perf,logic"

# Autonomous behaviors
/xm:agent research "Redis pub/sub limits" --budget 5
/xm:agent solve "CI-only test failure in auth" --agents 3
/xm:agent consensus "JWT vs Session for auth" --agents 4
/xm:agent swarm "Increase test coverage to 80%" --agents 5

# Team
/xm:agent team create eng --template engineering
/xm:agent team assign eng "Build payment system"

# Flow (Workflow backend — max parallelism)
/xm:agent flow "Analyze refactor impact across the token-capture path" --agents 6
/xm:agent flow --op review --target HEAD
```

| Layer | Commands | What it does |
|-------|----------|-------------|
| **Primitives** | fan-out, delegate, broadcast | Direct agent control — parallel, specialized, or role-based |
| **Autonomous** | research, solve, consensus, swarm | Goal-driven — agents explore, adapt, and converge on their own |
| **Team** | team create/assign/status | Hierarchical: Team Leader (opus) → Members |
| **Flow** | flow "&lt;goal&gt;" [--op] | Deterministic **Workflow tool** backend — decompose → topo-batch fan-out (queued, up to 1000 agents) → schema-forced merge, background + resume |
| **Presets** | 15 role presets | Cross-cutting roles injected into all layers |

**Key distinction**: x-op = conductor with a score (leader controls every phase). x-agent = jazz band (agents listen to each other and adapt).

**Autonomous options**: `--budget N` (max rounds), `--depth shallow|deep|exhaustive`, `--focus <hint>`, `--web` (allow web search).

**Flow vs primitives**: `flow` runs fan-out through the Workflow tool instead of manual Agent-tool calls — it queues past the per-message limit, forces JSON-schema-merged output, and respects dependency levels, all in a background run. Use it for unattended diverge→merge; it does **not** replace x-op strategies that gate on user confirmation mid-run.

Model auto-routing: `architect` → opus, `executor` → sonnet, `scanner` → haiku. Override with `--model`.

---

### x-trace

See what your agents actually did. Walk the timeline, check the cost, replay any past run.

```bash
/xm:trace timeline              # Agent execution timeline
/xm:trace cost                  # Token/cost breakdown per agent
/xm:trace replay <id>           # Replay a past execution
/xm:trace diff <id1> <id2>      # Compare two execution runs
```

**Activity ledger (terminal CLI).** Beyond per-session traces, x-trace keeps a cross-tool "last activity" pointer in `.xm/last.json`: which of review / build / panel / op / eval / ship last ran, on which commit, and how far `HEAD` has moved since. The `xm` dispatcher records an entry after every mutating command automatically; tools like x-review also record explicitly.

```bash
xm last                                    # Last activity per tool (ref, status, age)
xm last review --json                      # One tool's record as JSON
xm status                                  # Commits on HEAD since each tool last acted
xm trace record review --ref HEAD --status done   # Record an activity pointer
xm trace since <ref>                       # Tools + trace sessions active since <ref>
xm trace doctor --rebuild                  # Rebuild last.json from git-bearing traces
```

Coverage is best-effort: only activity that flows through the `xm` dispatcher or an explicit `xm trace record` is logged. A tool run by calling its `node …-cli.mjs` file directly, or an LLM-only skill that never touches the CLI, leaves no ledger entry.

---

### x-memory

Persist decisions and patterns across sessions. Auto-inject relevant context on start.

```bash
/xm:memory save --type decision "Redis for caching — ACID not required, read-heavy"
/xm:memory save --type failure "Auth middleware order matters — apply before rate limiter"
/xm:memory list                 # List all memories (--type, --tag filters)
/xm:memory show mem-001         # Show full memory content
/xm:memory recall "auth"        # Search past decisions and patterns
/xm:memory forget mem-003       # Delete a memory
/xm:memory inject               # Auto-inject relevant memories into current context
/xm:memory export --format json # Export memories to JSON or Markdown
/xm:memory import backup.json   # Import memories with dedup
/xm:memory stats                # Show memory statistics by type
```

| Type | Purpose | Auto-injected |
|------|---------|--------------|
| **decision** | Architecture/tech choices with rationale | On related file changes |
| **failure** | Past mistakes with lessons | On similar patterns |
| **pattern** | Reusable solutions | On matching context |

---

### x-sync

Synchronize `.xm/` project data across multiple machines via a central API server.

#### Server Deployment

**Option A: Docker (recommended for remote)**
```bash
# One-line deploy
XM_SYNC_API_KEY=secret docker compose -f x-sync/docker-compose.yml up -d

# Or pull from GHCR
docker run -d -p 19842:19842 -e XM_SYNC_API_KEY=secret \
  -v x-sync-data:/root/.xm/sync jinwoo/xm:sync:latest
```

**Option B: Standalone install**
```bash
# Install to ~/.local/bin/x-sync-server
curl -fsSL https://raw.githubusercontent.com/x-mesh/xm/main/x-sync/install.sh | bash -s server

# Run
XM_SYNC_API_KEY=secret x-sync-server --port 19842
```

#### Client Setup

```bash
# Install CLI
curl -fsSL https://raw.githubusercontent.com/x-mesh/xm/main/x-sync/install.sh | bash -s client

# Configure
x-sync setup

# Use
x-sync push       # push current project's .xm/ to server (cwd-based)
x-sync pull       # pull current project's data
x-sync push-all   # push every .xm/ project under ~/work (use --root to override)
x-sync pull-all   # pull every .xm/ project under ~/work
x-sync status     # show config, current cwd projectId, last pull/push
```

Or use directly in Claude Code: `/xm:sync push`, `/xm:sync pull`, `/xm:sync setup`

| Feature | Detail |
|---------|--------|
| **Push** | SHA-256 hash dedup, batch POST |
| **Pull** | Since-timestamp incremental, skip own machine |
| **Auth** | API key (`X-Api-Key` header) |
| **Storage** | SQLite WAL on server |
| **Offline** | SessionEnd hook queues to `.sync-queue/`, drains on next push |
| **Machine ID** | Auto-generated from hostname, stored in `~/.xm/sync.json` |

---

### x-ship

Release automation: squash WIP commits, bump the version, push. Works on xm marketplace plugins and on standalone projects (Node.js, Rust, Python, Go).

```bash
/xm:ship                # Interactive: test → review → release
/xm:ship auto           # Squash + bump + push, no gates
/xm:ship status         # Show commits since last release
/xm:ship patch          # Explicit patch bump
```

| Feature | Description |
|---------|-------------|
| **Release CLI** | 7 subcommands: `detect`, `diff-report`, `squash`, `bump`, `test`, `commit`, `trace` |
| **Tag releases** | `release commit --tag v1.2.0 --push` creates an annotated tag and pushes it with `--follow-tags`. A project whose CI triggers on `push: tags` is not released until the tag is pushed — a branch push alone fires nothing. An existing tag is never moved |
| **WIP squash** | Squashes WIP commits (`wip:`, `fixup!`, `tmp`). Atomic conventional commits are **kept** — a clean history is the output of careful work, and you cannot un-squash after a push |
| **Quality gates** | Optional test + review gates before release |
| **Standalone support** | Auto-detects package.json, Cargo.toml, pyproject.toml, go.mod. No version file → the git tag *is* the version |
| **Release metrics** | Records version, bump type, test/review results to `.xm/traces/` |
| **Diff-based analysis** | Per-commit diff report for intelligent squash grouping |

---

### x-humanize

Detect AI-writing patterns and rewrite generated text into natural human prose. Catalog draws from Wikipedia's "Signs of AI writing" (English) and observed Korean AI-slop conventions.

```bash
/xm:humanize audit <text>          # Report AI patterns only, no rewrite
/xm:humanize light <text>          # Minimal edits, preserve original structure
/xm:humanize <text>                # Default: medium intensity rewrite
/xm:humanize strong <text>         # Rebuild prose aggressively, preserve facts
/xm:humanize voice <file> <text>   # Match voice of sample file
/xm:humanize --lang ko <text>      # Force Korean output
```

| Feature | Description |
|---------|-------------|
| **Pattern catalog** | Korean (KO-1 ~ KO-40) + English (EN-1 ~ EN-22), each tagged with severity (High/Medium/Low). Korean covers translation-ese, mechanical parallelism, hedging tics, formal-tone overuse, emoji bullets, etc. |
| **Genre-aware filter** | Six genres (column / report / blog / formal / marketing / README) drop findings the genre legitimately uses — `격식체` in formal docs, `1) 2) 3)` in technical docs, em-dashes in essays. Threshold knobs (KO-26 권고형 결말 5→8 in formal, KO-39 따옴표 5→8 in marketing). |
| **Change-rate guardrails** | < 30% proceed · 30–50% warn and re-verify fact inventory · > 50% hard stop, refuse to output. Length-aware: short inputs use absolute change-count thresholds (5 / 10) instead of percentages. |
| **Auto-downshift** | When KO-26 (권고형 결말) ≥ 5 hits and KO-31 (단문 일변도) 5+ consecutive both fire, force `light` intensity even if the user asked for `medium` or `strong` — prevents the change-rate budget from blowing up on a single paragraph. |
| **Fact inventory** | Named entities, metrics, dates, citations recorded before rewrite. The rewrite must restore any dropped fact and never fabricate one. Vague claims stay vague rather than become specific. |
| **Voice calibration** | Voice sample overrides genre rules — match the user's sentence-length distribution, vocabulary level, and transition habits. Avoids "clean but soulless" output. |
| **Anti-AI audit pass** | Required Step 5 — internally asks "what still makes this obviously AI-generated?" and revises once more. Catches leftover em-dashes, sycophantic openers, trailing chatbot disclaimers. |

**Principles:** Meaning preserved 100% · Span-grounded edits only (no fix direction = no finding) · Genre kept (column ↛ essay) · Over-polish refused (>50% change rate)

---

### x-recall

Cross-session artifact index. Every xm tool persists its output under `.xm/`; `x-recall` is the one place to **find and read** those artifacts across sessions and tools.

Because the CLI reads `.xm/` directly, it is tool-neutral — a later **Codex** or **Cursor** session in the same repo runs `xm recall …` in plain bash to pick up what a Claude session produced.

```bash
xm recall list --type review --since 7d   # browse, newest first
xm recall show review --last              # read the latest code review
xm recall search "sql injection"          # full-text + metadata search
xm recall handoff-md                      # (re)write tool-neutral .xm/build/HANDOFF.md
```

Artifact types: `review op plan eval probe humble solver research prd handoff`. Host-variant copies are deduplicated to one canonical entry. A handoff also emits `.xm/build/HANDOFF.md` — a plain-markdown session summary any tool can read without the skill.

---

### x-panel

Cross-model review panel. Runs multiple model CLIs (claude/codex/agy/cursor) on the same target and synthesizes a verdict that separates **consensus** (N/M agreement — confidence) from **diversity** (what only one model caught). Default is 1 round (independent, no cross-talk); `--rounds 2` makes it adversarial — each model refutes the others' findings before the final verdict. The orchestrator is a tool-neutral CLI, so the leader isn't a fixed model.

```bash
/xm:panel                        # interactive (Claude Code skill): pick models, then review
xm panel                         # CLI: review current git diff with your default models
xm panel ./file --full           # all installed model CLIs
xm panel --models codex:gpt-5.2,cursor:gpt-5.3-codex,claude:opus
xm panel --models kiro:glm-4.6:high,codex:gpt-5.2:xhigh   # per-model reasoning effort — name:model:effort
xm panel models                  # interactive model picker (provider → model); `<vendor>` = its live catalog; `--all` dumps all
xm panel --stream                # live: per-model tokens, cost, and streaming text
xm panel --rounds 2              # 2 rounds: adds round-2 refutation (default 1: independent consensus only, no refutation)
xm panel setup --models codex,agy --global   # save defaults
xm panel doctor                  # readiness: each provider installed + authed (no model call)
xm panel preflight               # live check: probe each configured model (cursor:kimi, kiro:glm…) before a run
xm panel status --watch --lines 4   # live board: per-agent state + interpreted output tail
                                    # (findings/verdicts summarized per line, prompt echo hidden)
xm panel status <run> --logs        # stream the RAW event log (events.jsonl): last N (--lines, default 200),
                                    # or tail -f with --watch. Unlike the interpreted board, nothing is summarized
xm panel gate <run> [--policy '{…}']  # turn a run's verdict into a merge-gate EXIT CODE (0 pass / 1 block / 2 error) — for CI
xm panel stats [--roi]              # per-vendor survival rate, catches, and (with real cost) $/catch across every run
xm panel review <target> --grounded # round-2 refuters that can read the repo (codex today) OPEN each cited file and verify the finding
xm panel followup <run>             # debate round: resume each author's session, HOLD/CONCEDE/REVISE the findings an opponent refuted
```

Per-model selection via `--models name:model[:effort]`. The optional `:effort` sets reasoning depth per model — codex `minimal|low|medium|high|xhigh` (→ `model_reasoning_effort`) and kiro `low|medium|high|xhigh|max` (→ `--effort`); the sets differ by vendor, and an unknown level warns and is dropped rather than blocking the run. Bare `xm panel models` is a two-step provider→model picker (`--json` for structured rows; live-catalog vendors agy/cursor/kiro vs fixed-ID claude/codex); named `presets`, parallel calls, and results land under `.xm/panel/` (queryable with `xm recall`). Different models have different blind spots — that's the point.

Every run **captures real per-model token usage and cost** — claude via `--output-format json`, codex via its `exec --json` event stream — so panel numbers price from measured actuals, not estimates. Each finished run appends a per-model row to a **disagreement ledger** (`.xm/panel/history.jsonl`); `xm panel stats [--roi]` aggregates it into per-vendor survival rate (confirmed/raised) and cost per confirmed catch — a per-repo data moat a stateless API council can't accumulate. `--stream` adds token-by-token live text for claude/cursor (`--partial`, on by default; auto-disabled on very large targets). When a model returns a structured markdown review instead of the JSON contract (agy/Gemini does this intermittently), the panel salvages the findings from the `### [severity] file:line — title` + Why/Fix shape rather than discarding a real review as "no JSON"; when a model exits 0 with no usable answer at all, it surfaces the CLI's own stderr reason instead. Timeouts auto-scale with target size (`--timeout` to pin). kiro is spawned under an auto-provisioned no-MCP agent (`~/.kiro/agents/xm-panel-review.json`), because kiro otherwise loads the global `mcp.json` and a single MCP tool whose schema uses `oneOf`/`allOf`/`anyOf` at the top level makes Bedrock reject the whole request — set `panel.kiro_agent` to point at your own agent instead.

Two adversarial add-ons turn opinions into checked facts. **`--grounded`** makes round-2 refuters that can actually read the repo (codex today — `exec --sandbox read-only` from the repo cwd) OPEN each cited file and verify the finding against the real code, tagging the verdict with `{checked, observed}`; a text-only vendor is never asked to (a blind vendor told to "open the file" would just fake a `checked:true`). **`xm panel followup <run>`** runs a debate round: it resumes each author's own session and has them `HOLD` / `CONCEDE` / `REVISE` the findings an opponent refuted — a *held* finding (both models stand their ground) is the genuine disagreement a human must decide, a *conceded* one is resolved. It is additive (`followup-N.json`, verdict.json untouched) and needs the review to have run with `--session-reuse` (claude/codex).

`xm panel cross` exposes this engine as a reusable primitive — one prompt across N vendors, each vendor's raw output returned — which is what backs the opt-in `--cross-vendor` mode in x-agent, x-solver, x-build, x-op, x-review, and x-eval. See [Cross-Vendor Verification](#cross-vendor-verification).

---

### x-wt

Session worktree. Runs the **whole current session** in an isolated git worktree, then lands it back onto the branch you started from. Unlike `/xm:build run --worktrees` (one worktree PER task, gated), `/xm:wt` is the thin, ungated "work aside, then merge back" wrapper — two verbs, no task DAG.

```
/xm:wt              # create a worktree + switch the session into it
/xm:wt land         # verify → git-kit promote (merge into parent, no push) → return
/xm:wt status       # where the session is + git-kit worktree list
```

The harness `EnterWorktree`/`ExitWorktree` tools move the session cwd; `git-kit promote` does the merge-back (commit + merge into parent, no network). `start` records the parent as `branch.<name>.gk-parent` so `land` merges into the branch you actually came from. Nothing is pushed — you push the parent yourself when ready. State follows the worktree (each checkout keeps its own `.xm/`); config stays shared with the main repo.

---

## Quality & Learning Pipeline

Each plugin's thinking principles feed the next one. What gets caught in review turns into a planning constraint; what fails in solve turns into a humble lesson.

**Example: building a payment API**
1. `x-build plan` → PRD goal has "and"? Split into two projects. *(planning principle)*
2. `x-build consensus` → critic finds "retry logic not specified for payment gateway timeout" *(thinking)*
3. `x-build run` → agents execute with done_criteria as acceptance contracts
4. `x-review diff` → finds unhandled error path, Challenge stage validates it's genuinely High *(judgment)*
5. `x-solver iterate` → diagnoses state, anchors to last passing test, traces with evidence *(thinking protocol)*
6. `x-humble reflect` → "Why was the retry gap found during review, not planning?" → lesson saved *(retrospective)*

<details>
<summary>Full pipeline diagram</summary>

```
x-probe → Premise Validation (PROCEED/RETHINK/KILL)
     ↓
x-build plan → PRD Quality Gate (7.0+) → Consensus Review (4 agents)
     ↓
x-build tasks done-criteria → Acceptance contracts from PRD
     ↓
x-op strategy --verify → Judge Panel (bias-aware) → Auto-retry
     ↓
x-eval score → Per-task quality tracking → Project quality dashboard
     ↓
x-build verify-contracts → Done criteria fulfillment check
     ↓
x-humble reflect → Root cause + bias analysis → KEEP/STOP/START lessons
     ↓
lessons → CLAUDE.md + x-eval judge context → Next session applies patterns
```

| Component | Mechanism |
|-----------|-----------|
| **Self-Score** | Every x-op strategy auto-scores against mapped rubric |
| **--verify loop** | Judge panel (bias-aware) → fail → feedback → re-execute (max 2) |
| **PRD consensus** | architect + critic + planner + security with principle-backed prompts |
| **Acceptance contracts** | `done_criteria` auto-derived from PRD → injected into agents → verified at close |
| **Auto-handoff** | Phase transitions preserve decisions, discard exploration noise |
| **plan-check (15 dims)** | atomicity, deps, coverage (incl. done_criteria), granularity (upper bound >15), completeness, context, naming (44-verb dict), tech-leakage, scope-clarity (Out of Scope match), risk-ordering (DAG-based), expected-files, failure-mode-coverage, delegation-contract, review-groups, overall |
| **Quality dashboard** | `x-build status` shows per-task scores + project avg |
| **Domain rubrics** | 5 presets (api-design, frontend, data-pipeline, security, architecture) |
| **Bias-aware judging** | x-humble lessons (confirmed 3+) inform judge context |
| **x-eval diff** | Measure how skills changed + quality delta |

</details>

---

## Benchmarks

Empirical consistency measurements across all plugins. Run with `/xm:eval consistency`.

| Plugin | Strategy | Consistency | Status |
|--------|----------|:-----------:|--------|
| x-eval | rubric-scoring | **0.957** | PASS |
| x-humble | retrospective | **0.950** | PASS |
| x-op | debate | **0.930** | PASS |
| x-solver | decompose | **0.917** | PASS |
| x-review | multi-lens review | **0.890** | PASS |
| x-probe | premise-extraction | **0.826** | PASS |
| x-build | planning | **0.824** | PASS |

**Average: 0.899** | All 7 plugins PASS | Verdict consistency: 100%

A/B vs vanilla Claude Code: xm matches vanilla F1 (0.857) with superior precision (1.0 vs 0.75).

Full data: [`benchmarks/`](./benchmarks/SUMMARY.md)

---

## Architecture

```
xm/                              Marketplace repo
├── x-build/                        Project harness + PRD pipeline
├── x-op/                           Strategy orchestration (17 strategies)
├── x-eval/                         Quality evaluation + diff
├── x-humble/                       Structured retrospective
├── x-solver/                       Problem solving (4 strategies)
├── x-agent/                        Agent primitives & teams
├── x-probe/                        Premise validation (probe before build)
├── x-review/                       Code review orchestrator
├── x-trace/                        Execution tracing
├── x-memory/                       Cross-session memory
├── x-sync/                         Multi-machine .xm/ sync server
├── xm/                          Bundle (all skills) + shared config + server
└── .claude-plugin/marketplace.json  12 plugins + xm core registered
```

<details>
<summary>How it works</summary>

```
SKILL.md (spec)  →  Claude (orchestrator)  →  Agent Tool (execution)
       ↕                      ↕
x-build CLI (state)  ←  tasks update (callback)
```

- **SKILL.md**: Orchestration spec that Claude reads. Defines plan→run flow, agent spawn patterns, error recovery.
- **x-build CLI**: State management layer. Persists tasks/phases/checkpoints as JSON in `.xm/build/`. Does not spawn agents directly.
- **Claude**: Interprets SKILL.md, spawns agents via Agent Tool, calls CLI callbacks on completion.
- **Persistent Server**: Bun HTTP server caches CLI calls for fast repeated responses. AsyncLocalStorage for per-request isolation.
- **Bundle sync**: `scripts/sync-bundle.sh` enforces standalone ↔ bundle file synchronization.

</details>

---

## Agent Catalog

37 specialist agents ship with xm, split into core roles and domain experts. Plugins pull them in automatically when extra context would help. x-op refine injects them by topic; x-review picks them up with `--specialists`.

```bash
/xm agents list                        # List all 37 specialists
/xm agents match "payment API design"  # Find best agents for a topic
/xm agents get security --slim         # Show a specialist's rules
```

| Tier | Agents |
|------|--------|
| **Core** | api-designer, compliance, database, dependency-manager, deslop, developer-experience, devops, docs, frontend, performance, qa, refactor, reviewer, security, sre, tech-lead, ux-reviewer |
| **Domain** | ai-coding-dx, analytics, blockchain, data-pipeline, data-visualization, eks, embedded-iot, event-driven, finops, gamedev, i18n, kubernetes, macos, mlops, mobile, monorepo, oke, prompt-engineer, search, serverless |

Catalog located at `xm/agent-catalog/catalog.json`. Each agent has a full rules file and a slim version (~30 lines) for prompt injection.

---

## Configuration

`xm config` manages the settings every tool (x-build, x-solver, x-op) reads. Run it with no arguments for an interactive wizard, or use the `show` / `get` / `set` / `phase` / `reset` subcommands directly. Keys, types, and default scopes live in one registry (`config-schema.mjs`, 30 keys).

```bash
/xm config                                     # interactive wizard (7 categories)
/xm config set agent_max_count 10              # 10 agents in parallel
/xm config set model_profile economy           # cost profile
/xm config get mode                            # merged value + source tier (on stderr)
/xm config show                                # global + local + effective
```

### Interactive wizard

A bare `xm config` opens a menu-driven wizard with seven categories:

| # | Category | Covers |
|---|----------|--------|
| 1 | Model | `model_profile` · per-role `model_overrides` · per-phase models (plan / implement / review) |
| 2 | Budget | `budget.max_usd` · `budget.window_hours` · per-project `budget.projects` |
| 3 | Execution | `agent_max_count` (1–10) |
| 4 | Gates | five phase-exit gates (`research/plan/execute/verify/close-exit`) — `auto` / `human-verify` / `quality` / `decision` · `autopilot` passes `human-verify` but never `quality` or `decision` (`plan-exit` defaults to `decision`: only a human can tell that a well-formed plan aims at the wrong goal) |
| 5 | Worktree | parallel-worktree keys over a 3-tier scope (build-local > shared > global) + `gate_policy` severity lists |
| 6 | Misc | `mode` · `drift.drift_threshold` · `scan_roots` · `pipelines` · `memmesh.mirror` (set `false` for file-only setups: handoff skips the mem-mesh mirror entirely) |
| 7 | Panel | cross-vendor providers — `models` / `judge` delegate to `xm panel setup`; `timeout_s` / `model_overrides` are written directly |

Each item shows its **effective value and the tier it came from**, lets you **choose the write scope** (defaulting to the schema's tier), and **warns when a higher-priority tier would shadow** the write. Every key is validated against the registry on `set`: an unknown key or out-of-range value prints a warning but still saves (back-compat). The wizard needs a TTY — under a pipe or redirect a bare `xm config` exits with a pointer to the `show` / `get` / `set` / `phase` subcommands instead of hanging.

### Scope

| Flag | Writes to |
|------|-----------|
| (default) | `~/.xm/config.json` (global) |
| `--local` | `.xm/config.json` (project) |
| `--global` | `~/.xm/config.json` (explicit) |

Defaults follow the schema: `budget.*` writes to local, `worktree.*` resolves over its own 3-tier chain (`.xm/build/config.json` > `.xm/config.json` > `~/.xm/config.json` > defaults), and everything else to global. `xm config get <key>` reports the merged effective value with its source tier.

### Multi-vendor models

Model routing speaks in three canonical tiers — `haiku` / `sonnet` / `opus` (display labels *light* / *standard* / *max*). By default each tier maps to the matching Claude model, but xm can route a tier to another vendor's model. The built-in table (`VENDOR_MODELS` in cost-engine) ships Claude and Codex; two config keys layer overrides on top:

```bash
/xm config set vendor_models.codex.opus "gpt-5.5:high"   # tier → model[:effort]
/xm config set vendor_profiles.codex economy             # per-vendor profile (unset → inherits model_profile)
```

`vendor_models` is `{ vendor: { tier: "model[:effort]" } }`; the optional `:effort` suffix (`minimal`/`low`/`medium`/`high`/`xhigh`) is validated on write. Resolution priority is `vendor_models[vendor][tier]` → built-in table → claude passthrough. The wizard's **Model** category adds a **vendor model mapping** menu that shows which harnesses are detected, validates the effort suffix, and supports `clear` to drop an override.

**Codex support.** `xm install --target codex` emits searchable standalone aliases such as `$xm-op` plus the native `xm` Plugin (direct invocation: `$xm:op`), writes per-role agent configs (`<.codex>/xm/agents/xm-{planner,executor,reviewer}.config.toml`) and per-profile configs (`<.codex>/xm-{economy,default,max}.config.toml`), gates multi-agent features, and adds a Codex Orchestration Overlay to the `build` Skill. For Codex routing, the authoritative source is the additive vendor spec in x-build JSON: `prd_writer.model_by_vendor.codex`, `research.agents_spec[*].model_by_vendor.codex`, `consensus.agents[*].model_by_vendor.codex`, and each Execute task's `task.model_by_vendor.codex`. Static named-agent configs are exact-match only (`planner/plan`, `reviewer/review`, `executor/implement`); everything else falls back to `codex exec` with the exact model plus optional `model_reasoning_effort` from that JSON. A build-group panel resolves a bare provider with `explicit provider:model > panel.model_overrides > build reviewer route > provider default`; the routed fallback never changes the provider roster. Missing or malformed Codex specs fail loud and use the provider default rather than guessing from the Claude tier, deterministic gates and human approval gates are not LLM-routing targets, and `inherit` is never passed literally to Codex. On `resume`, exec flags still precede the `resume` subcommand.

### Cost Efficiency

Spend gets controlled with two knobs. **Model profiles** decide which model handles which role; **budget guards** stop a run before it blows past the cap.

```bash
/xm config set model_profile economy           # Sonnet-centric, maximum savings — every role pinned
/xm config set model_profile default           # Default — judgment roles inherit the session model
/xm config set model_profile max               # Quality-first — judgment inherit + opus execution
/xm config set budget '{"max_usd": 5.0}'       # Set session budget limit
```

The `model_profile` key expresses **cost intent** (how much to spend) on a single axis. Legacy names `balanced` and `performance` are auto-mapped to `default` and `max` respectively.

| Profile | architect | executor | designer | explorer | writer | Notes |
|---------|-----------|----------|----------|----------|--------|-------|
| economy | sonnet | sonnet | sonnet | haiku | haiku | ~70-85% savings vs default — no inherit, ever |
| default | inherit | sonnet | sonnet | sonnet | haiku | Judgment rides the session model; sonnet execution is the measured sweet spot |
| max | inherit | opus | opus | sonnet | haiku | Judgment inherit + opus execution |

**`inherit` means "run on the session model the user picked via `/model`"** — the profile decides *where to save*; `/model` decides *what quality means*. It is not a billable tier and is always expressed by **absence**: no `model:` frontmatter field on judgment skills, no `model` parameter on Agent-tool calls (never the literal string `"inherit"`). Judgment roles (architect, reviewer, security, planner, critic, debugger, deep-executor) inherit under default/max; economy pins every role — a spend ceiling can't inherit an arbitrarily expensive session model, even via `model_overrides`. Cost forecasting prices inherit tasks at the opus ceiling (errs high, never low); report the real model on completion with `tasks update <id> --status completed --resolved-model <haiku|sonnet|opus>`.

Script-only commands (`config show`, `version`, `agents list`, …) still route to haiku regardless of profile (see Model Guardrail in `xm/skills/kit/SKILL.md`).

Profile changes now automatically rewrite SKILL.md frontmatter `model:` fields and body markers (`<!-- managed-model: <role> -->`) via `xm/lib/skill-frontmatter-sync.mjs` — a target of `inherit` **removes** the `model:` field and the example's `model` token entirely (absence = session model). Mapping table: `xm/lib/skill-model-map.json`.

Key roles shown; full mapping includes reviewer, security, designer, debugger, writer. See `MODEL_PROFILES` in source.

Per-role overrides: `/xm config set model_overrides '{"architect": "opus"}'` on top of any profile.

Budget guards warn at 80% usage and block execution at 100%, tracked via session metrics. Rolling spend is computed from `.xm/metrics.jsonl` over a configurable window (`budget.window_hours`, default 24h); setting it to `0` disables the window and uses the lifetime spend cache (`.xm/spend-cache.json`). Per-project caps use `budget.projects`:

```bash
/xm config set budget '{"max_usd": 5.0, "window_hours": 48, "projects": {"my-proj": {"max_usd": 2.0}}}'
```

#### Cost vs Quality Benchmark

Same coding task (`rateLimiter` — sliding window) across three models:

| Criterion | haiku | sonnet | opus |
|-----------|:-:|:-:|:-:|
| Correctness | ✅ works | ✅ works | ✅ works |
| Edge cases (0, negative) | partial | ✅ full | ✅ full |
| Edge cases (NaN, Infinity, float) | ✗ | ✗ | ✅ isFinite + floor |
| Code quality | 6/10 | 8/10 | 9/10 |
| **Estimated cost (medium task)** | **$0.07** | **$0.81** | **$4.05** |

> **Takeaway:** haiku will write code that runs, but you'll be the one finding the edge cases. sonnet covers most production work fine. opus is what you reach for when robustness matters more than the cost. Profiles let you pick which trade-off you're making: `economy` (sonnet-centric), `default` (opus-centric), or `max` (all-opus). For a workload-specific estimate, run `/xm:build forecast`.

#### Automatic Model Routing

xm picks the cheapest model that can actually handle the request. Plain display commands fall to **haiku** (~78% cheaper); judgment work rides the session model — never a downgrade.

| Task type | Model | Examples |
|-----------|-------|---------|
| Display/query | **haiku** | `config show`, `version`, `agents list`, `status`, `task list` |
| Interactive wizard | **session** (leader) | `config` (interactive), `init`, `setup`, auto-route confirmation |
| Reasoning / judgment | **session** (inherit — the model you picked via `/model`) | `plan`, `run`, strategy execution, code review |

> Principle: if the output is determined by a script (not LLM reasoning), use haiku. The model is a messenger, not a thinker.

#### Cost-Aware Routing

The selection chain has three levels: `model_overrides → profile → fallback`. Every decision gets stamped with a correlation ID (`ce-XXXXXXXX`), so you can trace it back to the outcome later. Reach for `model_overrides` when you want to pin a specific role to a specific model regardless of profile.

---

## Troubleshooting

<details>
<summary>Circuit breaker is OPEN</summary>

```bash
/xm:build circuit-breaker reset    # Manual reset
```

</details>

<details>
<summary>"No steps computed"</summary>

```bash
/xm:build steps compute            # Build DAG from task dependencies
```

</details>

<details>
<summary>plan-check shows errors</summary>

1. Read each error message
2. Fix: `/xm:build tasks update <id> --done-criteria "..."` or add missing tasks
3. Re-run: `/xm:build plan-check`

</details>

<details>
<summary>"Cannot run — current phase is Plan"</summary>

```bash
/xm:build phase next               # Advance to Execute phase
/xm:build run                      # Then run
```

</details>

<details>
<summary>Task stuck in RUNNING</summary>

```bash
/xm:build tasks update <id> --status failed --error-msg "timeout"
/xm:build run                      # Will retry or skip
```

</details>

---

## Contributing

Contributions are welcome. See the [issues page](https://github.com/x-mesh/xm/issues) for open tasks.

Before opening a change, run:

```bash
bun run verify
```

- [Changelog / Releases](https://github.com/x-mesh/xm/releases)
- [Report a bug](https://github.com/x-mesh/xm/issues/new)

---

## Requirements

- Claude Code (Node.js >= 18 bundled)
- macOS, Linux, or Windows
- No external dependencies

## License

MIT © [x-mesh](https://github.com/x-mesh)
