# x-kit Skill Output Standard

Status: **APPROVED (2026-05-20).** Maintainer-facing standard for how every x-kit skill produces user-facing output. This document is the single source for the rule; skills carry the rule **inline** (see §5).

## 1. Goal

Every in-scope skill's user-facing output is (a) free of AI-slop in both modes, and (b) in `normal` mode, accessible Korean for non-experts.

One sentence: **mode-aware output — sharp for experts, accessible Korean for everyone else, slop-free in both.**

## 2. Modes

Read from `.xm/config.json` `mode`. Two values: `developer` (default) and `normal`. **`normal` is the canonical name** for what the user calls "easy mode" (D4: not renamed — `mode` values stay stable).

| Mode | Audience | Register |
|------|----------|----------|
| `developer` | Engineers | Technical terms, terse, EN/KO mix OK |
| `normal` | Non-experts | Accessible Korean, explained |

## 3. Universal anti-slop (BOTH modes)

These read as machine-generated in any register. Strip always:
- Empty intensifiers (매우 / 완벽하게 / 강력한 / 원활하게 / 혁신적인) without a specific claim.
- Forced rule-of-three or "~뿐만 아니라 ~까지" balance that adds no fact.
- Hedged non-conclusions (결국 상황에 따라 다르다 / 균형이 필요하다) — end on a concrete fact, number, or next action.
- Synonym cycling and machine-uniform sentence rhythm.

Full English/Korean catalog: humanize `references/patterns-en.md` + `patterns-ko.md`.

## 4. Mode-specific style

**developer**: terse and direct — lead with the result; state findings/actions without a 권고형 결말 pile-up ("~해야 한다" sentence after sentence).

**normal (한글화)**:
- All user-facing prose in Korean.
- Polite guidance (~해 보세요), one line of context for non-experts, jargon explained.
- Accessible ≠ padded or vague — §3 still applies.
- **Term policy (D1):** command names, flags, file paths, and proper nouns stay English. Domain terms are translated with the original in parentheses on first use — e.g., "결론(verdict)", "가정(premise)". Each skill keeps a term-mapping table in its Mode Detection section consistent with this.

## 5. Mechanism — inline, never a runtime reference

Each in-scope skill carries the §3+§4 rules **inline** in its SKILL.md, in a `### Korean output style (avoid AI-slop)` block under Mode Detection.

**Why not a shared `references/output-style.md`:** x-probe measured (2026-05-20) that passive "see references/X.md" pointers are NOT read at runtime — 5/5 agents skipped the file (tool_uses=0), 0/5 applied the rule; 2/2 inline controls applied it. For LLM skills, in-context reliability beats DRY. This doc is the maintainer's source; the inline block is the copy agents actually follow.

If an inline block pushes a skill over the 500-line budget, extract OTHER material (static catalogs, workflows) to references — never the style block.

## 6. Scope & coverage (D2: narrative skills only)

In-scope = skills that regularly emit flowing Korean prose. Terse-status / structured-UI skills are **exempt** (their output is menus, tables, and status lines, not prose).

| State | Skills |
|-------|--------|
| ✅ Has block | review, humble, build, probe, eval, solver, op |
| ⬜ In-scope, needs block | ship, agent, humanize, memory, trace |
| 🚫 Exempt (terse-status UI) | kit, sync, dashboard, handoff, handon |

## 7. Resolved decisions

- **D1 — term policy:** commands/flags/paths/proper-nouns English; domain terms translated with original in parens on first use.
- **D2 — scope:** narrative skills only; terse-status skills exempt (§6).
- **D3 — verification:** automated lint (§8).
- **D4 — mode naming:** keep `normal` (rename to "easy" rejected — breaking change to `mode` values, low value).

## 8. Verification — automated lint (D3)

A lint script flags violations so compliance is checkable in CI:
- §3 slop tokens (the intensifier list, "뿐만 아니라 ~까지", hedged-conclusion phrases) in any skill's user-facing output templates.
- Each in-scope skill (§6) contains the `### Korean output style (avoid AI-slop)` block.
- (Stretch) In `mode=normal` sample output, non-Korean prose sentences outside the D1 English-allowed set.

Block 2 (presence of the inline block) is the cheap, deterministic check to wire first.

## 9. Success criteria

- Every in-scope skill (§6) has the inline §3+§4 block.
- In `mode=normal`, each in-scope skill's user-facing prose is Korean per the D1 term policy.
- No §3 slop tokens in sampled output of any mode.
- Lint (§8) passes in CI.

## 10. Rollout

1. ✅ Standard doc (this) + 7 skills already carry the block.
2. ✅ Inline block added to the 5 remaining in-scope skills (ship, agent, humanize, memory, trace) — all 12 compliant.
3. ✅ D1 term policy carried in every in-scope skill's normal-mode line (Korean(original) first-use; commands/flags/proper-nouns stay English).
4. ✅ Block-presence lint wired into `bun test` (`test/skill-output-standard.test.mjs`, 12/12). Stretch (§8 slop-token scan) deferred.

**Standard fully rolled out.** Future skills that emit Korean prose must copy the §3+§4 block (lint enforces presence).
