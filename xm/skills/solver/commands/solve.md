# Command: solve

Execute strategy-specific agent orchestration for the selected x-solver strategy (decompose / iterate / constrain / pipeline).

1. Run: `$XMS solve`
2. Parse JSON output (`action: "solve"`)
3. Run the appropriate agent orchestration based on `strategy` and `current_phase`:

### Strategy: decompose

#### Phase: decompose
**delegate** (architect, opus):
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

**AskUserQuestion (REQUIRED):** AskUserQuestion("각 하위 문제에 대한 후보 솔루션을 생성했습니다. 평가(evaluate) 단계로 진행할까요?")

Advance: `$XMS solve-advance --phase evaluate`

#### Phase: evaluate
**delegate** (reviewer, sonnet):
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
**delegate** (architect, opus):
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

> **Leader execution rules (MUST)**
> 1. The leader (Claude) must never directly read code or verify hypotheses in any phase. **Always delegate to an agent.**
> 2. Phases must be executed in order. **Skipping is forbidden.**
> 3. After each phase completes, call `$XMS solve-advance` **immediately**. Do not advance to the next phase without calling it.
>
> **Phase Flow:**
> ```
> DIAGNOSE → HYPOTHESIZE → TEST → REFINE → RESOLVE → x-humble
> [state+baseline] [falsifiable] [one var] [switch/revert] [fix+exec proof] [why late?]
> ```

#### Phase: diagnose

> **MUST — This phase cannot be skipped. The first solve of the iterate strategy must always start from diagnose.**

**delegate** (debugger, sonnet):
```
{problem_solving_principles}

## State Diagnosis + Baseline

Before hypothesizing, answer these two questions:

S1. Current State — Describe what is happening right now, not what the problem is.
- What is the observable behavior? (error message, incorrect output, performance metric)
- Which layer/boundary is it in? (UI, API, DB, network, config, build)
- When did it start? (always, after a specific change, intermittently)

S2. Known Good Baseline — What was the last known working state?
- Is there a commit, version, or config where this worked?
- If yes: what changed between then and now? (git log, config diff, dependency update)
- If no baseline exists: state this explicitly. The first action should be finding one, not guessing.

Problem: {problem_context}
Context: {additional_context}

Output:
## Current State
{observable behavior, layer, timing}

## Baseline
{last known good state, or "no baseline — search needed"}

## Delta
{what changed between baseline and current state, or "unknown — need to investigate"}
```

**Optional: Fishbone Analysis (when root cause is unclear)**

If the diagnose result shows Delta = "unknown" or multiple possible layers, run a Fishbone analysis before hypothesizing:

delegate (analyst, sonnet):
```
## Fishbone (Ishikawa) Root Cause Analysis

Problem: {problem statement from diagnose Current State}

Categorize potential causes across 6 dimensions:
| Category | Potential Causes |
|----------|-----------------|
| People | (skills, knowledge, communication) |
| Process | (workflow, procedures, handoffs) |
| Technology | (tools, code, infrastructure) |
| Environment | (config, deployment, external deps) |
| Measurement | (metrics, monitoring, observability) |
| Data | (input quality, state, persistence) |

For each cause: one line, specific and falsifiable.
Highlight the 2-3 most likely root cause categories → these inform hypothesis generation.
```

The Fishbone result feeds into hypothesize: agent prompts include "Focus hypotheses on these categories: {top categories from Fishbone}"

After completion, run without fail:
```bash
# [REQUIRED] diagnose complete — advance to next phase
$XMS solve-advance --phase hypothesize
```

> Checklist:
> - [ ] delegate agent called
> - [ ] Current State / Baseline / Delta information collected
> - [ ] (If Delta = unknown or multiple layers) Fishbone analysis complete
> - [ ] AskUserQuestion called
> - [ ] `$XMS solve-advance --phase hypothesize` called

**AskUserQuestion (REQUIRED):** AskUserQuestion("진단(diagnose) 완료: {current_state_summary}. 가설 생성(hypothesize) 단계로 진행할까요?")

#### Phase: hypothesize

**delegate** (debugger, sonnet):
```
{problem_solving_principles}

Generate 3-5 hypotheses for this problem.

Hypothesis principles:
1. Falsifiable only — "Something is wrong with the code" is not a hypothesis. "The N+1 query in getUserOrders causes the 3s latency" is. If you can't describe how to disprove it, it's not a hypothesis.
2. Most likely first — Order by probability. Don't start with edge cases when the obvious cause hasn't been ruled out.
3. One variable per hypothesis — Each hypothesis should isolate a single cause. "The DB is slow AND the cache is stale" is two hypotheses.

Problem: {problem_context}
Context: {additional_context}

For each hypothesis:
- Description (specific and falsifiable)
- Supporting evidence (from code, logs, or observations)
- Opposing evidence (what would disprove this)
- Verification method (concrete command or check)
- Estimated likelihood (high/medium/low)

Order by likelihood descending. Output in JSON format.
```

After completion, run without fail:
```bash
$XMS hypotheses add "description"   # call once per hypothesis
# [REQUIRED] hypothesize complete — advance to next phase
$XMS solve-advance --phase test
```

> Checklist:
> - [ ] delegate agent called
> - [ ] `$XMS hypotheses add` called (once per hypothesis)
> - [ ] AskUserQuestion called
> - [ ] `$XMS solve-advance --phase test` called

**AskUserQuestion (REQUIRED):** AskUserQuestion("{N}개의 가설을 생성했습니다. 검증(test) 단계로 진행할까요?")

#### Phase: test

> **The leader must not verify hypotheses directly. Fan-out one agent per hypothesis.**

**fan-out** (N hypotheses → N agents called simultaneously, sonnet):
```
Agent tool 1: { description: "hypothesis-1-verifier", prompt: "...", run_in_background: true, model: "sonnet" }
Agent tool 2: { description: "hypothesis-2-verifier", prompt: "...", run_in_background: true, model: "sonnet" }
...
```

Each agent's prompt:
```
{problem_solving_principles}

Verify the following hypothesis:

Hypothesis: {hypothesis.description}
Problem: {problem_context}

Verification principles:
- One variable at a time — each test should check one thing. If you change two variables, you can't attribute the result.
- Prefer disproving over proving — actively try to refute the hypothesis. Confirmation bias is the enemy.
- Concrete evidence only — "it seems to work" is inconclusive. Show the command output, log line, or code path.

Read code, check logs, and run commands as needed to verify.
Result: confirmed / refuted / inconclusive + concrete evidence (paste the relevant output)
```

After all agents complete, run without fail:
```bash
$XMS hypotheses update <id> --status confirmed|refuted|inconclusive  # once per hypothesis
# [REQUIRED] test complete — advance to next phase
$XMS solve-advance --phase refine
```

> Checklist:
> - [ ] Agent fan-out complete (one per hypothesis — direct verification forbidden)
> - [ ] `$XMS hypotheses update` called (once per hypothesis)
> - [ ] AskUserQuestion called
> - [ ] `$XMS solve-advance --phase refine` called

**AskUserQuestion (REQUIRED):** AskUserQuestion("가설 검증 완료: {confirmed_count}개 확인, {refuted_count}개 반박. 정제(refine) 단계로 진행할까요?")

#### Phase: refine

Check verified (confirmed/inconclusive) hypotheses:
- Confirmed exists → proceed to resolve
- All refuted → apply **Switch or Revert** before retrying:
  1. **Switch perspective** — If all hypotheses targeted the same layer, switch to a different layer (app code → infra/config/network)
  2. **Revert to baseline** — Return to the known-good state from the diagnose phase; isolate the cause with minimal changes
  3. If both fail → return to hypothesize (iteration count increases)
- max_iterations reached → proceed to resolve with the most likely hypothesis

After completion, run without fail:
```bash
# [REQUIRED] one of two based on refine decision — must not be omitted
$XMS solve-advance --phase resolve     # if confirmed exists
# or
$XMS solve-advance --phase hypothesize # if all refuted
```

> Checklist:
> - [ ] Hypothesis status verified
> - [ ] AskUserQuestion called
> - [ ] `$XMS solve-advance` called (resolve or hypothesize)

**AskUserQuestion (REQUIRED):** AskUserQuestion("정제 결과: {refine_decision}. {'해결(resolve) 단계로 진행할까요?' if confirmed else '다시 가설 생성(hypothesize)으로 돌아갈까요?'}")

#### Phase: resolve

> **fix + exec proof — Fix it and prove it by execution. Both must be completed in this phase.**

**delegate** (executor, sonnet):
```
{problem_solving_principles}

Implement the solution and verify it works by execution.

Confirmed hypotheses: {confirmed_hypotheses}
Problem: {problem_context}

Resolution principles:
- Fix the root cause, not the symptom — if the hypothesis points to a deeper issue, address that.
- Minimal change that resolves the confirmed cause — don't refactor surrounding code.

Verification principles:
- "It should work" is NOT verification. Run the build, test, or command that proves it works.
- Paste the actual output as evidence.
- If a fix cannot be verified by execution, state explicitly that it requires human judgment.

Output:
1. What was changed (specific files/lines)
2. Verification command and its output
3. Result: PASS (evidence) or FAIL (what's still broken)
```

After completion, run without fail:
```bash
$XMS candidates add "solution description" --source executor
$XMS candidates select <id>
$XMS verify   # automatically transitions to verify phase + records result
$XMS close --summary "..."
```

> Checklist:
> - [ ] delegate agent called (including fix + exec proof)
> - [ ] Execution evidence confirmed (paste command output)
> - [ ] `$XMS candidates add` + `select` called
> - [ ] `$XMS verify` called
> - [ ] `$XMS close` called
> - [ ] If non-trivial problem: suggest `/xm:humble review "x-solver: {title} — why late?"`

### Strategy: constrain

#### Phase: elicit
**delegate** (analyst, opus):
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
**delegate** (architect, opus):
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
