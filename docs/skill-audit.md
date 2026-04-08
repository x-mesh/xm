# SKILL.md Audit

Status of every `SKILL.md` in the repo against the `docs/skill-anatomy.md` spec.

Last updated: 2026-04-08

---

## Length budget compliance

**Hard limit:** 500 lines per `SKILL.md`. Anything over needs reference material split to `docs/references/`.

| Status | Count |
|--------|-------|
| ✅ Under budget | 2 |
| ⚠️ Over budget | 12 |

### Current lines (source files)

Post-Phase 2 (2026-04-08). Rationalizations added ~10-12 lines each; table reflects current state.

| Lines | Plugin | Over budget? |
|-------|--------|--------------|
| 2197 | `x-op/skills/x-op/SKILL.md` | 🔴 **4.4x** over |
| 1934 | `x-agent/skills/x-agent/SKILL.md` | 🔴 **3.9x** over |
| 1755 | `x-build/skills/x-build/SKILL.md` | 🔴 **3.5x** over |
| 1230 | `x-eval/skills/x-eval/SKILL.md` | 🟠 2.5x over |
| 1120 | `x-review/skills/x-review/SKILL.md` | 🟠 2.2x over |
| 972  | `x-solver/skills/x-solver/SKILL.md` | 🟡 1.9x over |
| 688  | `x-kit/skills/x-ship/SKILL.md` | 🟡 1.4x over |
| 639  | `x-probe/skills/x-probe/SKILL.md` | 🟡 1.3x over |
| 620  | `x-humble/skills/x-humble/SKILL.md` | 🟡 1.2x over |
| 598  | `x-trace/skills/x-trace/SKILL.md` | 🟡 1.2x over |
| 551  | `x-kit/skills/x-kit/SKILL.md` | 🟡 1.1x over |
| 524  | `x-memory/skills/x-memory/SKILL.md` | 🟡 1.0x over |
| 304  | `x-kit/skills/x-sync/SKILL.md` | ✅ OK |
| 99   | `x-dashboard/skills/x-dashboard/SKILL.md` | ✅ OK |

---

## Common Rationalizations section coverage

Every SKILL.md must have a `## Common Rationalizations` section per `docs/skill-anatomy.md §4`.

**Coverage: 14/14 (100%)** — all plugins compliant as of 2026-04-08.

| Plugin | Phase | Rows | Focus |
|--------|:-----:|:----:|-------|
| x-humble | 1 | 7 | retrospective decay, pattern recognition |
| x-probe | 1 | 7 | premise validation, inversion, self-evident trap |
| x-review | 1 | 7 | review discipline, severity, author blind spots |
| x-build | 1 | 7 | planning, done_criteria, scope, risk |
| x-solver | 1 | 7 | structured decomposition, iteration, constraints |
| x-eval | 1 | 7 | rubrics, N=1 eval, LLM-as-judge bias |
| x-op | 2 | 7 | strategy selection, --verify, compose |
| x-agent | 2 | 7 | parallelism, delegation, context isolation |
| x-trace | 2 | 6 | session boundaries, metadata-only, fail-open |
| x-memory | 2 | 7 | bloat vs recall, re-derivation, dedupe |
| x-kit | 2 | 7 | shared config, cost engine, DAG, model routing |
| x-ship | 2 | 6 | changelog, semver, squash, irreversibility |
| x-sync | 2 | 5 | pull-first, conflicts, drift |
| x-dashboard | 2 | 5 | cross-plugin vs plugin-scoped view |

**Phase 1 (discipline-enforcement plugins):** 6 skills where "skipping discipline" is the actual failure mode (planning, retrospectives, premise validation, review, structured solving, evaluation).

**Phase 2 (tool-like plugins):** 8 skills where the failure mode is wrong tool choice or context pollution (orchestration, delegation, tracing, memory, core primitives, release, sync, dashboard).

---

## Split priority (Phase 3)

Files over budget should be split by moving reference material to `docs/references/<plugin>-<topic>.md`. Prioritize by how-much-over and how-often-loaded.

### Tier 1 — Biggest wins (must-split)

**x-op (2185 lines)** — 18 strategies, each has its own workflow. Split candidates:
- `docs/references/x-op-strategies.md` — detailed per-strategy walkthroughs
- `docs/references/x-op-prompt-templates.md` — agent prompts
- Keep in main: strategy selection table, decision flow, rationalizations

**x-agent (1922 lines)** — agent primitives. Split candidates:
- `docs/references/x-agent-primitives.md` — per-primitive usage (fan-out, delegate, broadcast, etc.)
- `docs/references/x-agent-examples.md` — worked examples
- Keep in main: primitive selection matrix, workflow, rationalizations

**x-build (1743 lines)** — project lifecycle. Split candidates:
- `docs/references/x-build-data-model.md` — `.xm/build/` schema
- `docs/references/x-build-phases.md` — per-phase detail
- `docs/references/x-build-consensus-agents.md` — agent-specific prompts
- Keep in main: lifecycle diagram, phase gates, rationalizations

### Tier 2 — Moderate splits

**x-eval (1218 lines)**, **x-review (1108 lines)** — both have long rubric/lens definitions.
- `docs/references/x-eval-rubrics.md` — per-rubric scoring details
- `docs/references/x-review-lenses.md` — per-lens detailed guidance
- Keep in main: rubric/lens selection, core process, rationalizations

**x-solver (960 lines)** — 4 strategies, each detailed.
- `docs/references/x-solver-strategies.md` — per-strategy walkthroughs
- Keep in main: strategy selector, core loop, rationalizations

### Tier 3 — Light trimming

**x-ship, x-probe, x-humble, x-trace, x-kit, x-memory** — all in the 500-700 range. Light reference splits or inline trimming should bring them under budget without a references file.

---

## Execution plan (follow-up PR)

Splitting is risky — each file needs careful thought about what ships inline vs references. Recommended approach:

1. **One plugin per PR.** Don't batch splits across plugins.
2. **Start with Tier 1** (x-op, x-agent, x-build) — biggest wins.
3. **Verification:** after each split, confirm the agent still correctly activates the skill and doesn't miss references.
4. **Re-audit:** update this file after each split.

Do NOT attempt all 12 files in one pass.
