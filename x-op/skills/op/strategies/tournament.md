# Strategy: tournament

Compete → anonymous vote → adopt winner. Default single-elimination; `--bracket double` enables losers' bracket with seed ranking.

## Phase 1: COMPETE
> 🏆 [tournament] Phase 1: Compete

fan-out:
```
"Submit your best result. This is a competition — the best result will be adopted. Structure by dimension (see Dimension Anchors). Judges score per-dimension. 400 words max."
```

**Call AskUserQuestion to confirm before Phase 2. Show phase results first.**

## Phase 2: ANONYMIZE
The leader anonymizes collected results:
- Remove agent names, shuffle order
- Label as "Solution A", "Solution B", "Solution C"

**Call AskUserQuestion to confirm before Phase 3. Show phase results first.**

## Phase 3: VOTE
fan-out:
```
"Rank the solutions below from 1st to last.
{anonymized solution list}
Format: 1st: [A|B|C], 2nd: [...], ... Reason: [one line]"
```

**Call AskUserQuestion to confirm before Phase 4. Show phase results first.**

## Phase 4: TALLY
Borda count (1st=N points, 2nd=N-1 points...). Leader breaks ties.

## Final Output
```
🏆 [tournament] Winner: Solution {X} ({agent})
| Rank | Solution | Score |
| 1st | {X} | {S} |
```

---

## Enhanced: seed ranking

Adds seed ranking to the existing tournament.

### Phase 0: SEED (new)
> 🏆 [tournament] Phase 0: Seed

Before COMPETE, a lightweight evaluation (leader directly or haiku agent):
- Quick-score each candidate solution 1-10
- Compose bracket based on scores (strong competitors meet later)

### Bracket options
- `--bracket single` — Single elimination (default)
- `--bracket double` — Double elimination (includes losers' bracket)
- With 8 agents: quarterfinals → semifinals → finals

Remaining phases (COMPETE, ANONYMIZE, VOTE, TALLY) proceed identically but within the bracket structure, round by round.

---

## Final Step: Persist (REQUIRED)

After emitting the Final Output above and the Self-Score block, MUST save the result to `.xm/op/` (see `references/x-op-result-persistence.md`):

1. `mkdir -p .xm/op/` (Bash)
2. Filename: `tournament-{YYYY-MM-DD}-{slug}.json` (slug from topic, ≤ 40 chars, lowercase, hyphens)
3. Write JSON per the result schema. Required fields:
   - `outcome.verdict={winner name}`
   - `outcome.summary` with winning solution rationale
   - **`themes[]` with EACH candidate carrying its full body and vote results** per the schema below. `outcome.summary` alone is NOT sufficient — the full candidate description and voter rationales must be saved so reviewers can see what competed and why the winner won in the dashboard.
   - `self_score`, `rounds_summary`

   Output schema per candidate entry in `themes[]` (this is what gets persisted — rank alone does NOT replace the body):

   ```json
   {
     "id": "A",
     "name": "<solution label, e.g. 'Solution A'>",
     "description": "<actual 1-3 line content of the candidate solution from Phase 1>",
     "score": 12,
     "rank": 1,
     "voter_rationales": [
       "<short reason from voter 1>",
       "<short reason from voter 2>"
     ],
     "selected": true
   }
   ```

   Every Phase 1 candidate MUST appear in `themes[]`. Dropping candidates — or keeping only `{id, name, score, rank}` — discards the competition content and the dashboard renders empty cards.

   When `--bracket double`: include `"bracket": "winners|losers"` and `"eliminated_round": <N>` on each entry to preserve the bracket progression.

4. Surface path: `💾 Saved: .xm/op/{filename}`

Do not end the strategy until the file is written and the path is shown.
