# Strategy: persona

Role-based multi-perspective analysis — each agent is assigned a fixed persona.

## Phase 1: ASSIGN
> 🎭 [persona] Phase 1: Assign

`--personas "role1,role2,..."` or auto-assigned by the leader:
- Default personas: senior engineer, security expert, PM, junior developer
- Persona count adjusted to match `--agents N`

**Call AskUserQuestion to confirm before Phase 2. Show phase results first.**

## Phase 2: ANALYZE
> 🎭 [persona] Phase 2: Analyze

broadcast — each agent gets a different persona prompt:
```
"## Persona: {role name}
You are a {role description}.
Task: {TOPIC}
Analyze this task from the perspective of a {role name}:
- Core concerns (what matters most)
- Risks/concerns
- Recommendations
Map your persona's concerns to dimensions from the Dimension Anchors. Each persona naturally emphasizes different dimensions — make this explicit.
300 words max."
```

**Call AskUserQuestion to confirm before Phase 3. Show phase results first.**

## Phase 3: SYNTHESIZE
Leader synthesizes all analyses:
- Key summary per perspective
- Common concerns vs conflict points
- Unified recommendation

**Call AskUserQuestion to confirm before Phase 4. Show phase results first.**

## Phase 4: CROSS-CHECK (optional, when --rounds > 2)
fan-out — each agent re-verifies the unified proposal from their persona's perspective:
```
"## Unified Proposal Verification: {role name}
{unified proposal}
From the perspective of a {role name}, is anything missing or needs revision? If not, respond 'OK'."
```

## Final Output
```
🎭 [persona] Complete — {N} personas

## Unified Recommendation
{final recommendation}

## Per-Perspective Summary
| Persona | Core Concern | Recommendation | Conflict |
|---------|-------------|----------------|----------|
| Senior Engineer | {summary} | {recommendation} | {conflict} |
```

## Final Step: Persist (REQUIRED)

After emitting the Final Output above and the Self-Score block, MUST save the result to `.xm/op/` (see `references/x-op-result-persistence.md`):

1. `mkdir -p .xm/op/` (Bash)
2. Filename: `persona-{YYYY-MM-DD}-{slug}.json` (slug from topic, ≤ 40 chars, lowercase, hyphens)
3. Write JSON per the result schema (include `outcome.verdict="{N} perspectives"`, `outcome.summary` with unified recommendation, `self_score`, `rounds_summary`)
4. Surface path: `💾 Saved: .xm/op/{filename}`

Do not end the strategy until the file is written and the path is shown.
