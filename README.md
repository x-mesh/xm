<p align="center">
  🇰🇷 <a href="./README.ko.md">한국어</a> | 🇺🇸 English
</p>

<p align="center">
  <img src="assets/xm-logo.jpeg" alt="xm" width="600" />
</p>

<h1 align="center">xm</h1>

<p align="center">
  AI coding agents fail silently — they skip planning, ignore context, and never verify.<br />
  <strong>xm fixes this.</strong>
</p>

<p align="center">
  <a href="https://github.com/x-mesh/xm/releases"><img src="https://img.shields.io/badge/version-1.26.17-blue" alt="Version" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License: MIT" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node.js" /></a>
  <a href="#plugins"><img src="https://img.shields.io/badge/plugins-12-orange" alt="Plugins" /></a>
</p>

<p align="center">
  A plugin toolkit for <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a> that adds structured planning, multi-agent review, and quality verification — so your agents deliver production-grade code, not prototypes.
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
- [Plugins](#plugins) — [x-build](#x-build) · [x-op](#x-op) · [x-review](#x-review) · [x-solver](#x-solver) · [x-probe](#x-probe) · [x-eval](#x-eval) · [x-humble](#x-humble) · [x-dashboard](#x-dashboard) · [x-agent](#x-agent) · [x-trace](#x-trace) · [x-memory](#x-memory) · [x-ship](#x-ship)
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
/plugin marketplace add x-mesh/xm:kit
/plugin install xm@xm -s user
```

### First-Run Init (Global)

After installing, run once per machine to copy the trace-session hook into `~/.claude/hooks/` and register Skill matchers in `~/.claude/settings.json`:

```
/xm:kit:init              # install trace-session hook into ~/.claude/
/xm:kit:init status       # verify install state
/xm:kit:init uninstall    # remove hook + settings entries
/xm:kit:init --no-hooks   # CLI-only install (no-op today — reserved)
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

The installer writes `~/.local/bin/xm:kit` (override with `XM_BIN_DIR`; ensure it is on your `PATH`) and, when the `claude` CLI is on `PATH`, also runs `claude plugin install <p>@xm -s user` for every plugin in `marketplace.json` (x-build, x-agent, x-op, x-solver, x-review, x-trace, x-memory, x-eval, x-probe, x-humble, x-dashboard, xm). Run `/reload-plugins` inside Claude Code afterward to activate them. If `claude` is not on `PATH`, the CLI wrapper alone is installed and the plugin list is printed for manual install.

#### Global hook install (`xm init`)

The bash `xm init` subcommand is equivalent to the `/xm:kit:init` slash command — it installs the Skill-tracing hook into **user-scoped** `~/.claude/` (once per machine):

```bash
xm init                 # install trace-session hook into ~/.claude/
xm init status          # verify install state
xm init uninstall       # remove hook + settings entries
xm init --no-hooks      # CLI-only install (no-op today — reserved)
```

Writes `~/.claude/hooks/xm-trace-session.mjs` and merges `PreToolUse`/`PostToolUse` Skill matchers into `~/.claude/settings.json` (existing hooks such as mem-mesh are preserved; a timestamped backup is created on every write). Use the bash route when you are outside Claude Code; otherwise `/xm:kit:init` is the preferred entry point.

```bash
xm dashboard                       # start — uses ~/.xm/projects.json registry (all registered projects)
xm dashboard --scan ~/work         # legacy multi-project mode: scan ~/work for .xm/ dirs (depth 4)
XM_DASHBOARD_SCAN=~/work xm dashboard   # same, persisted via env var
xm dashboard stop                  # stop it
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
xm trace <subcmd>      # execution traces
xm solver <subcmd>     # structured problem solving
xm handoff [reason]    # save session state
xm handon              # restore session state
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

Most AI coding tools follow checklists: "check for SQL injection, check for null, check for N+1." A checklist finds patterns. A senior engineer finds *problems*.

A senior engineer asks **"Can an attacker actually reach this code path?"** before filing a security finding. They ask **"What was the last working state?"** before debugging. They ask **"Am I inflating this because I'm unsure?"** — and downgrade when uncertain.

xm embeds these judgment patterns — distilled from 20 years of engineering practice — directly into every agent prompt. The result: agents that reason about context, not just pattern-match against lists.

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

## Plugins

12 plugins, each installable individually or bundled via `xm`.

| Plugin | Purpose | Key command |
|--------|---------|-------------|
| [x-build](#x-build) | Project lifecycle & PRD pipeline | `/xm:build plan "goal"` |
| [x-op](#x-op) | 18 multi-agent strategies | `/xm:op debate "A vs B"` |
| [x-review](#x-review) | Judgment-based code review | `/xm:review diff` |
| [x-solver](#x-solver) | Structured problem solving | `/xm:solver init "bug"` |
| [x-probe](#x-probe) | Evidence-grade premise validation | `/xm:probe "idea"` |
| [x-eval](#x-eval) | Quality scoring & benchmarks | `/xm:eval score file` |
| [x-humble](#x-humble) | Structured retrospective | `/xm:humble reflect` |
| [x-agent](#x-agent) | Agent primitives & teams | `/xm:agent fan-out "task"` |
| [x-trace](#x-trace) | Execution tracing & cost | `/xm:trace timeline` |
| [x-memory](#x-memory) | Cross-session memory | `/xm:memory inject` |
| [x-sync](#x-sync) | Multi-machine .xm/ sync | `xm sync push` |
| [x-ship](#x-ship) | Release automation & squash | `/xm:ship auto` |
| xm | Bundle + config + pipeline | `/xm:kit pipeline release` |

---

### x-build

Full project lifecycle — PRD generation, multi-mode deliberation, consensus review, acceptance contracts, and quality-gated execution.

```bash
/xm:build init my-api
/xm:build discuss --mode interview       # Multi-round requirements interview
/xm:build plan "Build a REST API with JWT auth"
/xm:build run                             # Agents execute in DAG order
```

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
| **plan-check (11 dims)** | atomicity, deps, coverage (incl. done_criteria), granularity (upper bound >15), completeness, context, naming (44-verb dict), tech-leakage, scope-clarity (Out of Scope match), risk-ordering (DAG-based), overall |
| **Domain-aware done_criteria** | Auto-generated based on task domain, size tier, and PRD NFR targets |

| Category | Commands |
|----------|----------|
| **Project** | `init`, `list`, `status`, `next [--json]`, `close`, `dashboard` |
| **Phase** | `phase next/set`, `gate pass/fail`, `checkpoint`, `handoff --full`, `handon` |
| **Plan** | `plan "goal"`, `plan-check [--strict]`, `prd-gate [--threshold N]`, `consensus [--round N]` |
| **Tasks** | `tasks add [--deps] [--size] [--strategy] [--team] [--done-criteria]`, `tasks done-criteria`, `tasks list`, `tasks remove [--cascade]`, `tasks update` |
| **Steps** | `steps compute/status/next` |
| **Execute** | `run`, `run --json`, `run-status` |
| **Verify** | `quality`, `verify-coverage`, `verify-traceability`, `verify-contracts` |
| **Analysis** | `forecast`, `metrics`, `decisions`, `summarize` |
| **Export** | `export --format md/csv/jira/confluence`, `import` |
| **Release** | `release detect`, `release squash`, `release bump`, `release commit`, `release test`, `release trace`, `release diff-report` |
| **Settings** | `mode developer/normal`, `config set/get/show` |

</details>

---

### x-op

18 multi-agent strategies with self-scoring and auto-verification.

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
- **--verify**: Judge panel validates quality, auto-retries if below threshold
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
--verify                Auto quality validation (judge panel + retry)
--threshold N           Verify pass score (default 7)
--vote                  Enable voting (brainstorm)
--dry-run               Show execution plan only
--resume                Resume from checkpoint
--explain               Include decision trace
--pipe <strategy>       Chain strategies (compose)
```

</details>

---

### x-review

Multi-perspective code review with judgment frameworks, not just checklists.

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

4 structured strategies with weight-based auto-classification and compound keyword detection.

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

Should you build this? Probe before you commit. Evidence-grade questioning, domain-aware probing, and pre-mortem analysis with structured downstream integration.

```bash
/xm:probe "Build a payment system"    # Full probe session
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

Multi-rubric scoring, strategy benchmarking, A/B comparison, and change measurement.

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

Learn from failures together. Not a rule generator — the retrospective process itself is the value.

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

Web dashboard for `.xm/` project state. Visualize builds, probes, solvers, **reviews, evals, humble lessons**, traces, memory, and costs — all read-only, no build chain.

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

Agent primitives and autonomous behaviors on top of Claude Code's native Agent tool. Primitives give you direct control; autonomous behaviors let agents self-direct, discover, and collaborate via stigmergy.

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
```

| Layer | Commands | What it does |
|-------|----------|-------------|
| **Primitives** | fan-out, delegate, broadcast | Direct agent control — parallel, specialized, or role-based |
| **Autonomous** | research, solve, consensus, swarm | Goal-driven — agents explore, adapt, and converge on their own |
| **Team** | team create/assign/status | Hierarchical: Team Leader (opus) → Members |
| **Presets** | 15 role presets | Cross-cutting roles injected into all layers |

**Key distinction**: x-op = conductor with a score (leader controls every phase). x-agent = jazz band (agents listen to each other and adapt).

**Autonomous options**: `--budget N` (max rounds), `--depth shallow|deep|exhaustive`, `--focus <hint>`, `--web` (allow web search).

Model auto-routing: `architect` → opus, `executor` → sonnet, `scanner` → haiku. Override with `--model`.

---

### x-trace

See what your agents actually did — timeline, cost, and replay.

```bash
/xm:trace timeline              # Agent execution timeline
/xm:trace cost                  # Token/cost breakdown per agent
/xm:trace replay <id>           # Replay a past execution
/xm:trace diff <id1> <id2>      # Compare two execution runs
```

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
x-sync push     # push .xm/ to server
x-sync pull     # pull other machines' data
x-sync status   # show config and sync state
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

Release automation — commit squash, version bump, push. Works with xm marketplace plugins AND standalone projects (Node.js, Rust, Python, Go).

```bash
/xm:ship                # Interactive: test → review → release
/xm:ship auto           # Squash + bump + push, no gates
/xm:ship status         # Show commits since last release
/xm:ship patch          # Explicit patch bump
```

| Feature | Description |
|---------|-------------|
| **Release CLI** | 7 subcommands: `detect`, `diff-report`, `squash`, `bump`, `test`, `commit`, `trace` |
| **WIP squash** | Auto-classifies WIP commits (tm(), fixup!, wip:) and squashes them |
| **Quality gates** | Optional test + review gates before release |
| **Standalone support** | Auto-detects package.json, Cargo.toml, pyproject.toml, go.mod |
| **Release metrics** | Records version, bump type, test/review results to `.xm/traces/` |
| **Diff-based analysis** | Per-commit diff report for intelligent squash grouping |

---

## Quality & Learning Pipeline

xm connects thinking principles across plugins into a closed feedback loop.

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
| **plan-check (11 dims)** | atomicity, deps, coverage (incl. done_criteria), granularity (upper bound >15), completeness, context, naming (44-verb dict), tech-leakage, scope-clarity (Out of Scope match), risk-ordering (DAG-based), overall |
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
├── x-op/                           Strategy orchestration (18 strategies)
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
└── .claude-plugin/marketplace.json  11 plugins registered
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

xm includes 37 specialist agents covering core and domain areas. Plugins use these agents automatically (e.g., x-op refine injects specialists per topic; x-review uses them with `--specialists`).

```bash
/xm:kit agents list                        # List all 37 specialists
/xm:kit agents match "payment API design"  # Find best agents for a topic
/xm:kit agents get security --slim         # Show a specialist's rules
```

| Tier | Agents |
|------|--------|
| **Core** | api-designer, compliance, database, dependency-manager, deslop, developer-experience, devops, docs, frontend, performance, qa, refactor, reviewer, security, sre, tech-lead, ux-reviewer |
| **Domain** | ai-coding-dx, analytics, blockchain, data-pipeline, data-visualization, eks, embedded-iot, event-driven, finops, gamedev, i18n, kubernetes, macos, mlops, mobile, monorepo, oke, prompt-engineer, search, serverless |

Catalog located at `xm/agents/catalog.json`. Each agent has a full rules file and a slim version (~30 lines) for prompt injection.

---

## Configuration

```bash
/xm:kit config set agent_max_count 10              # 10 agents parallel
/xm:kit config set team_default_leader_model opus  # Team Leader model
/xm:kit config set team_max_members 5              # Max members per team
/xm:kit config show
```

Settings stored in `.xm/config.json` (project-level).

### Cost Efficiency

Control model spending with **model profiles** and **budget guards**.

```bash
/xm:kit config set model_profile economy           # Sonnet-centric, maximum savings
/xm:kit config set model_profile default           # Default — Opus-centric (Opus 4.7 era)
/xm:kit config set model_profile max               # Opus everywhere, quality-first
/xm:kit config set budget '{"max_usd": 5.0}'       # Set session budget limit
```

The `model_profile` key expresses **cost intent** (how much to spend) on a single axis. Legacy names `balanced` and `performance` are auto-mapped to `default` and `max` respectively.

| Profile | architect | executor | designer | explorer | writer | Notes |
|---------|-----------|----------|----------|----------|--------|-------|
| economy | sonnet | sonnet | sonnet | haiku | haiku | ~70-85% savings vs default |
| default | opus | opus | sonnet | sonnet | haiku | Opus-centric baseline |
| max | opus | opus | opus | sonnet | haiku | ~1.5-2x vs default |

Script-only commands (`config show`, `version`, `agents list`, …) still route to haiku regardless of profile (see Model Guardrail in `xm/skills/kit/SKILL.md`).

Key roles shown; full mapping includes reviewer, security, designer, debugger, writer. See `MODEL_PROFILES` in source.

Per-role overrides: `/xm:kit config set model_overrides '{"architect": "opus"}'` on top of any profile.

Budget guards warn at 80% usage and block execution at 100%, tracked via session metrics. Rolling spend is tracked in `.xm/spend-cache.json` over a configurable window (`budget.window_hours`, default 24h). Per-project caps use `budget.projects`:

```bash
/xm:kit config set budget '{"max_usd": 5.0, "window_hours": 48, "projects": {"my-proj": {"max_usd": 2.0}}}'
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

> **Takeaway:** haiku produces working code but misses edge cases. sonnet is production-grade for most tasks. opus adds defensive robustness at much higher cost. Profiles let you choose the tradeoff: `economy` (sonnet-centric) vs `default` (opus-centric) vs `max` (all-opus). Run `/xm:build forecast` for workload-specific estimates.

#### Automatic Model Routing

xm routes commands to the cheapest sufficient model automatically. Display/query commands use **haiku** (~78% cheaper), while reasoning tasks use sonnet or opus.

| Task type | Model | Examples |
|-----------|-------|---------|
| Display/query | **haiku** | `config show`, `version`, `agents list`, `status`, `task list` |
| Interactive wizard | **sonnet** | `config` (interactive), `init`, `setup`, auto-route confirmation |
| Reasoning | **sonnet** (escalate to **opus** when budget allows) | `plan`, `run`, strategy execution, code review |

> Principle: if the output is determined by a script (not LLM reasoning), use haiku. The model is a messenger, not a thinker.

#### Cost-Aware Routing

Selection follows a 3-level priority chain: `model_overrides → profile → fallback`. Each routing decision carries a correlation ID (`ce-XXXXXXXX`) linking it to outcome metrics. Use `model_overrides` for deliberate per-role choices on top of your profile.

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

- [Changelog / Releases](https://github.com/x-mesh/xm/releases)
- [Report a bug](https://github.com/x-mesh/xm/issues/new)

---

## Requirements

- Claude Code (Node.js >= 18 bundled)
- macOS, Linux, or Windows
- No external dependencies

## License

MIT © [x-mesh](https://github.com/x-mesh)
