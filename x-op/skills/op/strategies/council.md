# Strategy: council

N-party free discussion → cross-examination → deep dive → consensus.

## Round 1: OPENING
fan-out: "State your position and rationale on this topic. Structure by dimension (see Dimension Anchors). Leader assigns dimension focus to each participant. 300 words."

Leader builds a position map: group similar stances, identify divergence points.

**Call AskUserQuestion to confirm before Round 2. Show phase results first.**

## Round 2: CROSS-EXAMINE
Send other participants' positions to each agent, **excluding their own** (broadcast — different prompt per agent):
"Read the other participants' positions: agree with 1 + raise 1-2 questions + state whether your position changed."

Early termination check: if all agree → skip to Final.

**Call AskUserQuestion to confirm before Round 3. Show phase results first.**

## Round 3~N-1: DEEP DIVE
fan-out (focus on key points of contention):
"Contention 1: {description}. Provide additional evidence, propose compromises, and state any position changes."

## Final: CONVERGE
Leader drafts a consensus proposal → fan-out:
"AGREE or OBJECT to the consensus proposal. Summarize your final position in one line."

Result: FULL CONSENSUS / CONSENSUS WITH RESERVATIONS / NO CONSENSUS.

## Final Output
```
🏛️ [council] {status}
## Consensus Statement
{consensus statement}

## Stance Evolution
| Agent | Round 1 | Final | Changed? |
```

---

## Enhanced: weighted voting

Adds role-based weighted voting to the existing council.

### Weight options
`--weights "architect:3,security:2,developer:1"` or auto-assigned by the leader based on topic.

### Application
- OPENING: Specify role + weight for each agent
- CONVERGE: Apply weights to votes
  - Sum of `AGREE` weights > sum of `OBJECT` weights → CONSENSUS
  - Weighted majority not reached → CONSENSUS WITH RESERVATIONS
- Include weight rationale in final output

### Final Output change
```
🏛️ [council] {status} (weighted)
| Agent | Role | Weight | Vote |
|-------|------|--------|------|
| agent-1 | architect | 3 | AGREE |
| agent-2 | security | 2 | OBJECT |
Weighted: AGREE 4 / OBJECT 2 → CONSENSUS
```

---

## Final Step: Persist (REQUIRED)

After emitting the Final Output above and the Self-Score block, MUST save the result to `.xm/op/` (see `references/x-op-result-persistence.md`):

1. `mkdir -p .xm/op/` (Bash)
2. Filename: `council-{YYYY-MM-DD}-{slug}.json` (slug from topic, ≤ 40 chars, lowercase, hyphens)
3. Write JSON per the result schema (include `outcome.verdict={CONSENSUS|NO CONSENSUS|CONSENSUS WITH RESERVATIONS}`, `outcome.summary` with consensus statement, `self_score`, `rounds_summary`)
4. Surface path: `💾 Saved: .xm/op/{filename}`

Do not end the strategy until the file is written and the path is shown.
