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

| Lines | Plugin | Over budget? |
|-------|--------|--------------|
| 2185 | `x-op/skills/x-op/SKILL.md` | 🔴 **4.4x** over |
| 1922 | `x-agent/skills/x-agent/SKILL.md` | 🔴 **3.8x** over |
| 1743 | `x-build/skills/x-build/SKILL.md` | 🔴 **3.5x** over |
| 1218 | `x-eval/skills/x-eval/SKILL.md` | 🟠 2.4x over |
| 1108 | `x-review/skills/x-review/SKILL.md` | 🟠 2.2x over |
| 960  | `x-solver/skills/x-solver/SKILL.md` | 🟡 1.9x over |
| 677  | `x-kit/skills/x-ship/SKILL.md` | 🟡 1.4x over |
| 627  | `x-probe/skills/x-probe/SKILL.md` | 🟡 1.3x over |
| 608  | `x-humble/skills/x-humble/SKILL.md` | 🟡 1.2x over |
| 587  | `x-trace/skills/x-trace/SKILL.md` | 🟡 1.2x over |
| 539  | `x-kit/skills/x-kit/SKILL.md` | 🟡 1.1x over |
| 512  | `x-memory/skills/x-memory/SKILL.md` | 🟡 1.0x over |
| 294  | `x-kit/skills/x-sync/SKILL.md` | ✅ OK |
| 89   | `x-kit/skills/x-dashboard/SKILL.md` | ✅ OK |

---

## Common Rationalizations section coverage

Every SKILL.md must have a `## Common Rationalizations` section per `docs/skill-anatomy.md §4`.

| Plugin | Has Common Rationalizations? |
|--------|----------------------------|
| x-humble | ✅ (added 2026-04-08) |
| x-probe | ✅ (added 2026-04-08) |
| x-review | ✅ (added 2026-04-08) |
| x-build | ✅ (added 2026-04-08) |
| x-solver | ✅ (added 2026-04-08) |
| x-eval | ✅ (added 2026-04-08) |
| x-op | ❌ pending |
| x-agent | ❌ pending |
| x-memory | ❌ pending |
| x-trace | ❌ pending |
| x-kit | ❌ pending |
| x-ship | ❌ pending |
| x-sync | ❌ pending |
| x-dashboard | ❌ pending |

**Phase 1 done:** The 6 skills where "skipping discipline" is the actual failure mode (planning, retrospectives, premise validation, review, structured solving, evaluation).

**Phase 2 candidates:** The tool-like skills (x-op, x-agent, x-memory, x-trace, x-kit, x-ship, x-sync, x-dashboard). These are lower priority because they're less about enforcing process and more about exposing capability — but they still need the section for spec compliance.

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
