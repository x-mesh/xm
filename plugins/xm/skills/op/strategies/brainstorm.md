# Strategy: brainstorm

Free ideation → cluster → vote.

## Phase 1: GENERATE
fan-out:
"Generate as many ideas as possible on this topic. No criticism allowed. Each idea: [dimension] title + 1-2 lines. Tag each with a dimension from the Ideation Anchors (novelty/feasibility/impact/effort/risk). Minimum 5."

## Brainstorm Modes

Default mode generates ideas freely. Two additional modes are available:

**`--analogical` mode:** Each agent must source ideas from a DIFFERENT domain and map them structurally:
- Agent prompt addition: "Find a solved problem in {assigned domain} that is structurally similar. Map: what plays the role of X in that domain? What plays the role of Y? Where does the analogy break?"
- Leader assigns domains: e.g., biology, urban planning, game design, supply chain, social networks
- Synthesis: leader extracts the structural mapping, not just the surface idea

**`--lateral` mode:** Each agent applies a different de Bono lateral thinking operator:
- Agent 1: **Reversal** — "What if the opposite were true? What if we did the exact reverse?"
- Agent 2: **Provocation (PO)** — "State something deliberately absurd about this problem. Then extract the useful kernel."
- Agent 3: **Random Entry** — "Pick a random word/concept. Force a connection to this problem."
- Agent 4: **Fractionation** — "Break the problem into non-obvious pieces. Recombine differently."
- Synthesis: leader runs vertical validation — which lateral ideas actually work when scrutinized?

**Call AskUserQuestion to confirm before Phase 2. Show phase results first.**

## Phase 2: CLUSTER
Leader deduplicates, groups by theme, assigns numbers, **and records the full idea bodies into `themes[i].ideas[]`**.

Output schema per theme (this is what gets persisted in the JSON file — `ideas_count` alone is NOT sufficient; the body must be saved so reviewers can see the diverged ideas in the dashboard):

```json
{
  "id": "T1",
  "name": "<short theme label>",
  "ideas": [
    {
      "id": "T1.I1",
      "title": "<idea title>",
      "description": "<1-2 line body, the actual content from Phase 1>",
      "dimension": "<novelty|feasibility|impact|effort|risk>"
    }
  ]
}
```

Every Phase 1 idea (post-dedup) MUST appear under exactly one theme's `ideas[]`. Dropping ideas after clustering — or keeping only `ideas_count` — discards the divergence and the dashboard themes card renders empty.

**Call AskUserQuestion to confirm before Phase 3. Show phase results first.**

## Phase 3: VOTE (when --vote is set)
fan-out:
"Select the 3 most valuable. Format: 1. [number], 2. [number], 3. [number]"

After collecting votes, the leader annotates the selected ideas **in place inside `themes[i].ideas[j]`** — add `votes: <count>` and `rank: <position>` to each voted idea, e.g. `{ "id": "T1.I3", "title": "...", "description": "...", "votes": 4, "rank": 1 }`. This preserves the selection alongside the divergence so the dashboard can show *what was chosen out of what was generated* on a single screen, not only via `outcome.summary` text.

## Final Output
```
💡 [brainstorm] {N} ideas, {T} themes
## Top 5 (when --vote is set)
| Rank | Idea | Votes |
```

## Final Step: Persist (REQUIRED)

After emitting the Final Output above and the Self-Score block, MUST save the result to `.xm/op/` (see `references/x-op-result-persistence.md`):

1. `mkdir -p .xm/op/` (Bash)
2. Filename: `brainstorm-{YYYY-MM-DD}-{slug}.json` (slug from topic, ≤ 40 chars, lowercase, hyphens)
3. Write JSON per the result schema. Required fields:
   - `outcome.verdict="{N} ideas, {T} themes"`
   - `outcome.summary` listing top-voted ideas (string array)
   - **`themes[]` with EACH theme carrying its full `ideas[]` body** per the Phase 2 schema. `ideas_count` alone is NOT sufficient — the body must be saved so reviewers can see the diverged ideas in the dashboard.
   - When `--vote` is set: voted ideas carry `votes` and `rank` inline (per Phase 3). Selection must be inspectable from `themes`, not only from `outcome.summary` text.
   - `self_score`, `rounds_summary`
4. Surface path: `💾 Saved: .xm/op/{filename}`

Do not end the strategy until the file is written and the path is shown.
