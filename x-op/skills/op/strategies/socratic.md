# Strategy: socratic

Socratic questioning — deconstruct premises and explore deeply through questions alone.

## Phase 1: SEED
> 🧠 [socratic] Phase 1: Seed

delegate (foreground):
```
"## Socratic Seed: {TOPIC}
Present your initial position and core arguments on this topic. 300 words max."
```

**Call AskUserQuestion to confirm before Phase 2. Show phase results first.**

## Phase 2: QUESTION ROUNDS
> 🧠 [socratic] Round {n}/{max}: Question

fan-out — each agent acts as questioner:
```
"## Current Position
{previous round result}

Read the above arguments and find logical gaps, implicit premises, and counterexamples. Ask 2-3 sharp questions targeting specific dimensions from the Dimension Anchors. Avoid repeating dimensions already explored.
Do not provide answers — only ask questions."
```

Leader synthesizes the questions → sends to the responding agent (delegate):
```
"Answer the following questions and revise your position:
{synthesized question list}
Present your revised position in 300 words max."
```

- **Questions become trivial** → Early termination
- **max_rounds reached** → Best-effort output

## Final Output
```
🧠 [socratic] Complete — {actual}/{max} rounds

## Final Refined Position
{final position}

## Question Trace
| Round | Key Question | Position Change |
|-------|-------------|----------------|
| 1 | {question summary} | {change summary} |
```

## Final Step: Persist (REQUIRED)

After emitting the Final Output above and the Self-Score block, MUST save the result to `.xm/op/` (see `references/x-op-result-persistence.md`):

1. `mkdir -p .xm/op/` (Bash)
2. Filename: `socratic-{YYYY-MM-DD}-{slug}.json` (slug from topic, ≤ 40 chars, lowercase, hyphens)
3. Write JSON per the result schema (include `outcome.verdict="{N} rounds"`, `outcome.summary` with final refined position, `self_score`, `rounds_summary`)
4. Surface path: `💾 Saved: .xm/op/{filename}`

Do not end the strategy until the file is written and the path is shown.
