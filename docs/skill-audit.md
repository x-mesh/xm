# SKILL.md Audit

Status of every `SKILL.md` in the repo against the length budget and required-sections rules in `CLAUDE.md`.

Last updated: 2026-04-17 (post-xm split)

---

## Length budget compliance

**Hard limit:** 500 lines per `SKILL.md`. Anything over needs reference material split to sibling sub-directories (`references/`, `commands/`, `strategies/`, `lenses/`, `judges/`, `subcommands/`, `sessions/`, `autonomous/`).

| Status | Count |
|--------|-------|
| ✅ Under budget | 14 |
| 🔴 Over budget | 0 |

### Current lines (source files)

Recounted from disk 2026-08-11. **All 25 SKILL.md files under the 500-line cap.**

Regenerate with the Regression guard command below rather than editing rows by hand — a
hand-maintained count went 181 lines stale (x-build was recorded as 411 while it was 592).

| Lines | Plugin | Status |
|-------|--------|--------|
| 498 | `x-agent/skills/agent/SKILL.md` | ✅ OK |
| 497 | `x-build/skills/build/SKILL.md` | ✅ OK |
| 491 | `x-op/skills/op/SKILL.md` | ✅ OK |
| 402 | `xm/skills/ship/SKILL.md` | ✅ OK |
| 388 | `x-memory/skills/memory/SKILL.md` | ✅ OK |
| 379 | `x-trace/skills/trace/SKILL.md` | ✅ OK |
| 378 | `x-humanize/skills/humanize/SKILL.md` | ✅ OK |
| 375 | `x-review/skills/review/SKILL.md` | ✅ OK |
| 375 | `x-humble/skills/humble/SKILL.md` | ✅ OK |
| 358 | `x-solver/skills/solver/SKILL.md` | ✅ OK |
| 305 | `x-eval/skills/eval/SKILL.md` | ✅ OK |
| 292 | `x-probe/skills/probe/SKILL.md` | ✅ OK |
| 278 | `xm/skills/handoff/SKILL.md` | ✅ OK |
| 260 | `x-sync/skills/sync/SKILL.md` | ✅ OK |
| 240 | `xm/skills/handon/SKILL.md` | ✅ OK |
| 230 | `xm/skills/kit/SKILL.md` | ✅ OK |
| 194 | `x-panel/skills/panel/SKILL.md` | ✅ OK |
| 190 | `xm/skills/inbox/SKILL.md` | ✅ OK |
| 152 | `xm/skills/toss/SKILL.md` | ✅ OK |
| 138 | `x-wt/skills/wt/SKILL.md` | ✅ OK |
| 136 | `x-dashboard/skills/dashboard/SKILL.md` | ✅ OK |
| 122 | `xm/skills/later/SKILL.md` | ✅ OK |
| 96 | `x-recall/skills/recall/SKILL.md` | ✅ OK |
| 59 | `xm/skills/local-fix/SKILL.md` | ✅ OK |
| 57 | `x-remote/skills/remote/SKILL.md` | ✅ OK |

---

## Common Rationalizations section coverage

Every SKILL.md must have a `## Common Rationalizations` section.

**Coverage: 14/14 (100%)** — all plugins compliant.

| Plugin | Rows | Focus |
|--------|:----:|-------|
| x-humble | 7 | retrospective decay, pattern recognition |
| x-probe | 7 | premise validation, inversion, self-evident trap |
| x-review | 7 | review discipline, severity, author blind spots |
| x-build | 7 | planning, done_criteria, scope, risk |
| x-solver | 7 | structured decomposition, iteration, constraints |
| x-eval | 7 | rubrics, N=1 eval, LLM-as-judge bias |
| x-op | 7 | strategy selection, --verify, compose |
| x-agent | 7 | parallelism, delegation, context isolation |
| x-trace | 6 | session boundaries, metadata-only, fail-open |
| x-memory | 7 | bloat vs recall, re-derivation, dedupe |
| xm | 7 | shared config, cost engine, DAG, model routing |
| x-ship | 6 | changelog, semver, squash, irreversibility |
| x-sync | 5 | pull-first, conflicts, drift |
| x-dashboard | 5 | cross-plugin vs plugin-scoped view |

---

## Sub-file inventory

Largest sub-files (non-SKILL.md) by line count. These don't fall under the 500-line cap but warrant attention if they become unwieldy.

| Lines | File | Notes |
|-------|------|-------|
| 494 | `x-agent/skills/agent/references/role-presets.md` | Per-primitive role presets |
| 429 | `x-build/skills/build/references/workflow-guide.md` | Was 654; Step 3 Plan extracted to phases/plan.md |
| 326 | `x-build/skills/build/references/phases/plan.md` | Full Plan-phase walkthrough (extracted 2026-04-17) |
| 241 | `x-build/skills/build/references/cli-skill-protocol.md` | All 16 `next --json` actions + run-status envelopes |
| 104 | `x-build/skills/build/references/commands.md` | Full CLI surface (extracted from SKILL.md 2026-08-11) |
| 59 | `x-build/skills/build/references/environment-detection.md` | Toolchain/base-branch detection (extracted 2026-08-11) |
| 488 | `x-solver/skills/solver/commands/solve.md` | 4 strategy branches; already borderline |
| 429 | `x-agent/skills/agent/TEAM.md` | Team mode dispatcher |
| 396 | `x-review/skills/review/references/review-workflow.md` | Phase 1-4 full pipeline |
| 365 | `x-probe/skills/probe/sessions/probe.md` | Premise + evidence + verdict |
| 257 | `x-humble/skills/humble/sessions/reflect.md` | Reflection walkthrough |

---

## Remaining work

### Tier 1 — none

All 14 plugin skills are under budget. No urgent splits required.

### Tier 2 — sub-file hygiene (optional, low priority)

These references don't hit the 500-line policy (it applies to SKILL.md only) but could be split if they grow further:

- `x-build/references/workflow-guide.md` (332 lines, was 654) — Step 3 Plan extracted 2026-04-17. If Step 2 Research or Step 4 Execute grows, consider further per-phase splits
- `x-solver/commands/solve.md` (488 lines) — borderline; consider per-strategy split (`decompose.md`, `iterate.md`, `constrain.md`, `pipeline.md`) if strategy branches grow

### Regression guard

Re-run this audit whenever:
- A SKILL.md gains a new major section (>50 lines)
- A new plugin is added to the marketplace
- `release bump --minor` is invoked for any SKILL.md-carrying plugin

Command:
```bash
# Sources only. Plain `xm/skills/*/SKILL.md` double-counts the bundle copies of
# every x-* plugin, which inflates the file count and hides which row is source.
for f in x-*/skills/*/SKILL.md; do echo "$(wc -l < "$f") $f"; done | sort -rn
for f in xm/skills/*/SKILL.md; do n=$(basename "$(dirname "$f")"); \
  [ -d "x-$n/skills/$n" ] || echo "$(wc -l < "$f") $f"; done | sort -rn
```
