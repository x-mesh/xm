# Strategy: red-team

Attack/defend. Find vulnerabilities → fix.

## Phase 1: TARGET
Collect targets via `--target` or `git diff HEAD`.

**Call AskUserQuestion to confirm before Phase 2. Show phase results first.**

## Phase 2: ATTACK
Attack team fan-out:
"From an adversarial perspective, find as many vulnerabilities/defects as possible. Each attack must target a distinct dimension from the Code Analysis Anchors. Tag: [dimension] [Critical|High|Medium] location — attack vector — proof scenario."

**Call AskUserQuestion to confirm before Phase 3. Show phase results first.**

## Phase 3: DEFEND
Defense team fan-out (with attack results):
"For each attack, provide a fix or counter-evidence."

**Call AskUserQuestion to confirm before Phase 4. Show phase results first.**

## Phase 4: REPORT
Leader synthesizes: Fixed(🟢), Partial(🟡), Open(🔴).

## Final Output
```
🔴 [red-team] Complete — {total} vulnerabilities
| # | Severity | Attack | Status |
```

## Final Step: Persist (REQUIRED)

After emitting the Final Output above and the Self-Score block, MUST save the result to `.xm/op/` (see `references/x-op-result-persistence.md`):

1. `mkdir -p .xm/op/` (Bash)
2. Filename: `red-team-{YYYY-MM-DD}-{slug}.json` (slug from target or topic, ≤ 40 chars, lowercase, hyphens)
3. Write JSON per the result schema (include `outcome.verdict="{total} vulns ({open} open)"`, `outcome.summary` listing top vulnerability, `self_score`, `rounds_summary`)
4. Surface path: `💾 Saved: .xm/op/{filename}`

Do not end the strategy until the file is written and the path is shown.
