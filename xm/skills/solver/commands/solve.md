# Command: solve

Execute strategy-specific agent orchestration for the selected x-solver strategy (decompose / iterate / constrain / pipeline).

1. Run: `$XMS solve`
2. Parse JSON output (`action: "solve"`)
3. Use `agent_count` from the JSON output as `AGENT_COUNT` for fan-out/broadcast in this phase.
4. Run the appropriate agent orchestration based on `strategy` and `current_phase`:

### Strategy: decompose

#### Phase: decompose
**delegate** (architect — omit `model`; inherits the session model):
```
{problem_solving_principles}

Break this problem into 2-5 independent sub-problems.

Decomposition principles:
1. Sub-problems must be independently solvable — If solving sp2 requires knowing sp1's result, they're not independent. Merge or reorder.
2. Same abstraction level — "Set up database" and "Fix typo in readme" are not peers. Sub-problems should be roughly equal in scope.
3. Complete coverage — Solving all sub-problems must solve the original problem. If not, there's a missing sub-problem.

Problem:
{problem_context}

For each sub-problem:
- ID (sp1, sp2, ...)
- Description
- Difficulty (trivial/medium/hard)
- Relationship to other sub-problems
- Independence check: can this be solved without the others' results? (yes/no — if no, explain the dependency)

Output in JSON format:
{ "sub_problems": [{ "id": "sp1", "description": "...", "difficulty": "medium", "independent": true }] }
```

Use the result to call `$XMS tree add "description" --difficulty medium`.

**AskUserQuestion (REQUIRED):** AskUserQuestion("문제를 {N}개의 하위 문제로 분해했습니다. 탐색(explore) 단계로 진행할까요?")

Advance: `$XMS solve-advance --phase explore`

#### Phase: explore
**fan-out** (`AGENT_COUNT` agents per sub-problem, sonnet):
`AGENT_COUNT` agents per sub-problem propose solutions in parallel:
```
{problem_solving_principles}

Propose a solution for the following sub-problem:

Sub-problem: {sub_problem.description}
Full context: {problem_context}
Constraints: {constraints}

Requirements:
- Solution must be specific and actionable (not "use a better approach")
- State which constraints it satisfies and which it trades off
- If multiple approaches exist, choose the simplest that satisfies hard constraints
- Provide evidence (code paths, docs, benchmarks) for why this solution works
```

Use the result to call `$XMS candidates add "description" --source agent-N --sub-problem spN`.

> **Cross-vendor (opt-in):** when invoked with `--cross-vendor`, generate candidates across
> different model vendors (one per vendor via `xm panel cross`) instead of same-model Claude
> fan-out, and tag each `candidates add --source <vendor>`. See `references/cross-vendor.md`.

**AskUserQuestion (REQUIRED):** AskUserQuestion("각 하위 문제에 대한 후보 솔루션을 생성했습니다. 평가(evaluate) 단계로 진행할까요?")

Advance: `$XMS solve-advance --phase evaluate`

> `solve-advance` validates that the target phase belongs to the current strategy and normally only permits the next phase. The iterate `refine → hypothesize` retry path is the only intentional backward transition.

#### Phase: evaluate
**delegate** (reviewer — omit `model`; inherits the session model):
```
{problem_solving_principles}

Evaluate the candidates for each sub-problem and select the optimal one.

Candidate list: {candidates}
Constraints: {constraints}

Evaluation principles:
- Hard constraint violation = immediate disqualification (score 0), regardless of other scores
- Every score needs a one-line justification — a score without reasoning is noise
- Equal scores → simpler solution wins. Complexity is a tiebreaker against.
- Prefer reversible over optimal — a 7/10 you can change later beats a 9/10 that's permanent

Score each candidate 0-10 against each constraint. Include justification per score.
```

Use the result to call `$XMS candidates score <id> --constraint c1 --score 8`.

**AskUserQuestion (REQUIRED):** AskUserQuestion("후보 평가가 완료됐습니다. 통합(synthesize) 단계로 진행할까요?")

Advance: `$XMS solve-advance --phase synthesize`

#### Phase: synthesize
**delegate** (architect — omit `model`; inherits the session model):
```
{problem_solving_principles}

Synthesize the selected sub-solutions into a unified solution.

Sub-solutions: {selected_candidates}
Full problem: {problem_context}
Constraints: {constraints}

Synthesis principles:
- Integration conflicts reveal missing constraints — document them, don't hide them
- The combined solution must be simpler than the sum of its parts. If merging adds complexity, question whether the decomposition was correct.
- Verify: does solving all sub-problems actually solve the original problem? If not, identify the gap.

Resolve any conflicts and present the final integrated solution.
```

Use the result to create the final candidate + select.

### Strategy: iterate

See `commands/iterate.md` — REPRODUCE → DIAGNOSE → HYPOTHESIZE → TEST → REFINE → RESOLVE, with the
reproduce gate, the independent refuter, the three exits when iterations run out, and the regression
proof that resolve must produce.

### Strategy: constrain

#### Phase: elicit
**delegate** (analyst — omit `model`; inherits the session model):
```
{problem_solving_principles}

Extract and classify all constraints for this problem.

Elicitation principles:
- Hard constraints are non-negotiable — if violating it makes the solution unacceptable, it's hard. Everything else is soft or preference.
- Implicit constraints are the dangerous ones — look for unstated assumptions (backward compatibility, deployment environment, team expertise, budget).
- Fewer hard constraints = more solution space. Don't promote soft constraints to hard unless the user explicitly says "must."

Problem: {problem_context}
Existing constraints: {constraints}

Classify any additional constraints found as:
- hard (must satisfy — violation = solution rejected)
- soft (satisfy if possible — violation = tradeoff)
- preference (preferred — nice to have)
```

Use the result to call `$XMS constraints add "description" --type hard|soft|preference`.

**AskUserQuestion (REQUIRED):** AskUserQuestion("제약 조건 추출 완료: hard {hard_count}개, soft {soft_count}개. 후보 생성(generate) 단계로 진행할까요?")

Advance: `$XMS solve-advance --phase generate`

#### Phase: generate
**fan-out** (`AGENT_COUNT` agents, sonnet):
`AGENT_COUNT` agents generate candidates, each optimizing a different soft constraint:

> **Cross-vendor (opt-in):** with `--cross-vendor`, generate one candidate per vendor via
> `xm panel cross` (assign each vendor a different `focus_constraint` round-robin) instead of
> same-model fan-out, and tag each `candidates add --source <vendor>`. See
> `references/cross-vendor.md`.

```
{problem_solving_principles}

Propose a solution for the following problem.
Focus on optimizing {focus_constraint} while satisfying all hard constraints.

Generation principles:
- Hard constraints are pass/fail — verify your solution satisfies every one before submitting
- State the tradeoff explicitly — "This solution optimizes for {focus_constraint} at the cost of {other_constraint}"
- Simpler is better — if you can satisfy the focus constraint without additional complexity, do so

Problem: {problem_context}
Hard constraints: {hard_constraints}
Soft constraints: {soft_constraints}
```

Use the result to call `$XMS candidates add "description" --source agent-N`.

**AskUserQuestion (REQUIRED):** AskUserQuestion("{N}개의 후보 솔루션을 생성했습니다. 평가(evaluate) 단계로 진행할까요?")

Advance: `$XMS solve-advance --phase evaluate`

#### Phase: evaluate
**broadcast** (`AGENT_COUNT` agents, multi-perspective, sonnet):
`AGENT_COUNT` agents score candidates, each from a different perspective:
```
{problem_solving_principles}

Evaluate the following candidates from a {perspective} perspective.

Candidates: {candidates}
Constraints: {constraints}

Scoring principles:
- Hard constraint violation = 0 for the entire candidate, regardless of other scores
- Every score needs a one-line justification — a number without reasoning is noise
- Score the constraint, not your preference — personal opinion is not a criterion

Score each candidate 0-10 against each constraint. Include justification per score.
```

Use the result to call `$XMS candidates score <id> --constraint c1 --score N`.

After scoring, the leader produces a **Contrastive Matrix** for the user:

```
## Contrastive Matrix
| Constraint      | Candidate A | Candidate B | Candidate C | Winner |
|-----------------|-------------|-------------|-------------|--------|
| c1 (hard)       | 8 — reason  | 9 — reason  | 0 — violates| B      |
| c2 (soft)       | 7 — reason  | 5 — reason  | 8 — reason  | C      |
| c3 (preference) | 6 — reason  | 8 — reason  | 6 — reason  | B      |
| **Total**       | **21**      | **22**      | **14** ❌   | **B**  |

Situational recommendation: {which candidate is better in which situation, based on context}
```

This makes tradeoffs visible at a glance before selection.

**AskUserQuestion (REQUIRED):** AskUserQuestion("후보 평가가 완료됐습니다. 위의 Contrastive Matrix를 검토하고 최종 선택(select) 단계로 진행할까요?")

Advance: `$XMS solve-advance --phase select`

#### Phase: select
**delegate** (architect — omit `model`; inherits the session model):
```
{problem_solving_principles}

Aggregate score results and select the optimal candidate.

Scores by candidate: {candidate_scores}
Constraints: {constraints}

Selection principles:
- Equal scores → simpler solution wins. Complexity is a tiebreaker against.
- Prefer reversible over optimal — a 7/10 you can change later beats a 9/10 that's permanent.
- If no candidate satisfies all hard constraints, report the failure — don't pick the "least bad" option without flagging it.

Analyze tradeoffs and present a final recommendation.
Identify which constraints conflict if a hard constraint fails.
```

Use the result to call `$XMS candidates select <id>`.

### Strategy: pipeline

#### Phase: classify
Run `$XMS classify` to detect problem type.
Auto-select the appropriate strategy based on the result.

#### Phase: route
Execute the solve workflow of the selected strategy (decompose/iterate/constrain).

#### Phase: meta-verify
Additional verification after solving: confirm the original problem is actually resolved.
Retry with an alternative strategy on failure.

## Applies to
Invoked by x-solver after `classify` + `strategy set`. Dispatches agents per phase as defined in the selected strategy.
