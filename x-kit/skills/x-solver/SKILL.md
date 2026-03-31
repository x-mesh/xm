---
name: x-solver
description: Structured problem solving — decompose, iterate, constrain, or auto-pipeline with strategy recommendation
---

<Purpose>
x-solver solves complex problems structurally. It auto-detects problem types and recommends optimal strategies, with manual selection also available.
4 strategies: decompose, iterate, constrain, pipeline (auto).
Stateful — persists problem state to `.xm/solver/` for cross-session continuity.
</Purpose>

<Use_When>
- User wants to solve a complex problem structurally
- User says "solve this", "analyze this", "find the bug", "which approach is better"
- User describes a bug, error, design question, or multi-faceted problem
- User says "solve", "debug", "decompose", "how should I do this"
</Use_When>

<Do_Not_Use_When>
- Simple one-off questions that don't need structured solving
- Project lifecycle management (use x-build instead)
- Strategy orchestration without problem tracking (use x-op instead)
</Do_Not_Use_When>

## Arguments

User provided: $ARGUMENTS

## Mode Detection

Check mode before every command:
```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/x-solver-cli.mjs mode show 2>/dev/null | head -1
```

## CLI

All commands via:
```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/x-solver-cli.mjs <command> [args]
```

Shorthand in this document: `$XMS` = `node ${CLAUDE_PLUGIN_ROOT}/lib/x-solver-cli.mjs`

## Routing

Parse the first word of `$ARGUMENTS` to determine the command:

- `init` → [Command: init]
- `list` → Run `$XMS list`
- `status` → Run `$XMS status`
- `describe` → Run `$XMS describe --content "..."`
- `context` → Run `$XMS context <add|list>`
- `constraints` → Run `$XMS constraints <add|list|remove>`
- `classify` → [Command: classify]
- `strategy` → Run `$XMS strategy <set|show>`
- `solve` → [Command: solve]
- `solve-status` → Run `$XMS solve-status`
- `hypotheses` → Run `$XMS hypotheses <list|add|update>`
- `tree` → Run `$XMS tree <show|add|update>`
- `candidates` → Run `$XMS candidates <list|add|select|score>`
- `phase` → Run `$XMS phase <next|set>`
- `verify` → [Command: verify]
- `close` → Run `$XMS close`
- `history` → Run `$XMS history`
- `next` → [Command: next]
- `handoff` → Run `$XMS handoff [--restore]`
- Empty input → Ask the user to describe the problem (AskUserQuestion)
- Other natural language → [Command: auto] Treat as problem description and run `init` + `classify`

## Natural Language Mapping

| User says | Action |
|-----------|--------|
| "Help me fix this bug" | init → classify (likely iterate) |
| "Which approach is better" | init → classify (likely constrain) |
| "Analyze this problem" | init → classify (pipeline) |
| "Break it down and solve" | init → strategy set decompose → solve |
| "Add hypothesis" | hypotheses add |
| "Show the tree" | tree show |
| "List candidates" | candidates list |
| "Verify it" | verify |
| "What's next?" | next |

---

## Agent Primitives

This skill uses only Claude Code's built-in Agent tool:

### fan-out (parallel agents)
Call N Agent tools **simultaneously** in a single message:
```
Agent tool 1: { description: "agent-1", prompt: "...", run_in_background: true, model: "sonnet" }
Agent tool 2: { description: "agent-2", prompt: "...", run_in_background: true, model: "sonnet" }
Agent tool 3: { description: "agent-3", prompt: "...", run_in_background: true, model: "sonnet" }
```

### delegate (single agent delegation)
```
Agent tool: { description: "role name", prompt: "...", run_in_background: false, model: "opus" }
```

### broadcast (different prompts to each)
Same as fan-out but with a different prompt for each agent.

---

## Command: init

1. Run: `$XMS init "problem description"`
2. Parse JSON output (`action: "init"`)
3. Ask the user for additional information (AskUserQuestion):
   - Background/context of the problem
   - Related code/files
   - Constraints
4. After collecting answers:
   ```bash
   $XMS context add --content "..." --type code
   $XMS constraints add "constraint" --type hard
   ```
5. Automatically run classify

## Command: classify

1. Run: `$XMS classify`
2. Parse JSON output (`action: "classify"`)
3. **Confidence check**:

### High confidence (≥ 0.7)
Use the rule-based result as-is:
- Show the result to the user (recommended strategy, confidence, reasoning)
- AskUserQuestion for strategy selection

### Low confidence (< 0.7) — LLM Fallback
When rules alone are insufficient, delegate classification to an agent:

delegate (foreground, sonnet):
```
"## Problem Classification

Problem description:
{description}

Context:
{context items summary}

Constraints:
{constraints list}

Rule-based pre-analysis:
- Detected signals: {signals summary}
- Pre-recommendation: {recommended} (confidence: {confidence}%)

Choose the most suitable strategy for this problem and explain why:
1. decompose — Break complex problems into sub-problems
2. iterate — Hypothesis → Test → Refine loop (bugs, performance)
3. constrain — Constraint-based candidate evaluation (design decisions)
4. pipeline — Auto-routing

Additionally, suggest if any of these x-op strategies would be more suitable:
- hypothesis: Hypothesis → Refutation → Adoption (diagnosis)
- socratic: Question-based deep exploration (unclear requirements)
- persona: Multi-perspective analysis (diverse stakeholders)
- red-team: Security attack/defense (security issues)

Format:
Strategy: [name]
Confidence: [0-100]%
Reasoning: [one line]
x-op Alternative: [name if applicable, otherwise 'none']
"
```

Parse the agent result:
- If `Strategy` is an x-solver strategy → `$XMS strategy set <chosen>`
- If `x-op Alternative` exists → Suggest the x-op strategy to the user as well

4. AskUserQuestion for final strategy selection:
   - Recommended strategy (rule-based or LLM)
   - x-op alternative (if any)
   - Alternative strategies
5. After selection: `$XMS strategy set <chosen>`

### Enhanced Signal Detection

classify detects signals via text pattern matching:

| Signal | Detection target | Example |
|--------|-----------------|---------|
| `has_error` | error, bug, crash, leak | "There's a memory leak" |
| `has_stack_trace` | stack trace, file:line | Contains `.js:42` |
| `has_code_context` | code block, code-type context | ``` block |
| `has_performance` | slow, latency, optimize, bottleneck | "The API is slow" |
| `has_security` | vulnerability, injection, XSS, security | "SQL injection concern" |
| `has_infra` | deploy, docker, k8s, scale, infrastructure | "Scaling strategy" |
| `has_design_question` | should, which, how to, design | "Which DB should I use" |
| `has_tradeoff` | vs, tradeoff, pros/cons | "Redis vs Memcached" |

### Composite Signal Boost

When 2+ signals are detected simultaneously, confidence gets a bonus:
- 2 signals: +5%
- 3+ signals: +10%

### x-op Strategy Recommendation

classify suggests relevant x-op strategies alongside its result:

| Signal combination | x-op strategy | Reasoning |
|-------------------|---------------|-----------|
| Error + complex | `hypothesis` | Diagnose root cause via hypothesis → refutation |
| Design question (no tradeoff) | `socratic` | Clarify requirements via question-based exploration |
| Design + multi-dimensional | `persona` | Multi-perspective stakeholder analysis |
| Security | `red-team` | Security attack/defense simulation |
| Performance | `hypothesis` | Validate performance bottleneck hypotheses |
| Infra + tradeoff | `debate` | Pros/cons debate on infrastructure choices |

### x-op escalate auto-integration

The `complexity` field from classify determines the `--start` level for x-op escalate:

| complexity | escalate --start | Reasoning |
|------------|-----------------|-----------|
| low | haiku | Simple problem — lowest cost |
| medium | sonnet | Medium complexity — skip haiku tier |
| high | sonnet | High complexity — start from sonnet |

When the user selects an x-op alternative, the leader automatically sets the `--start` option:
```
classify → complexity: "medium"
User: "Let's try x-op hypothesis"
→ /x-op hypothesis "problem description" --start sonnet
```

## Problem-Solving Principles

These principles are injected into all solve-phase agent prompts.

```
## Problem-Solving Principles

1. **Simplest sufficient solution** — The best solution is the simplest one that satisfies all hard constraints. Complexity must justify itself with evidence.
2. **Reversibility over optimality** — When two solutions score similarly, prefer the one that's easier to undo or change. Irreversible decisions need stronger evidence.
3. **Separate the problem from the solution** — Understand what's actually wrong before proposing fixes. A misdiagnosed problem leads to a correct solution for the wrong question.
4. **Evidence over intuition** — Every claim needs supporting evidence from code, logs, docs, or tests. "I think" is not evidence.
5. **Constraints are guardrails, not goals** — Satisfying constraints is necessary but not sufficient. The goal is solving the actual problem.
```

## Command: solve

Execute strategy-specific agent orchestration.

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
Advance: `$XMS solve-advance --phase explore`

#### Phase: explore
**fan-out** (N agents per sub-problem, sonnet):
3 agents per sub-problem propose solutions in parallel:
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

Use the result to call `$XMS hypotheses add "description"`.
Advance: `$XMS solve-advance --phase test`

#### Phase: test
**fan-out** (1 agent per hypothesis, sonnet):
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

Use the result to call `$XMS hypotheses update <id> --status confirmed|refuted|inconclusive`.
Advance: `$XMS solve-advance --phase refine`

#### Phase: refine
Check verified (confirmed/inconclusive) hypotheses:
- All refuted → return to hypothesize (increment iteration)
- Confirmed exists → proceed to resolve
- max_iterations reached → resolve with the most likely hypothesis

`$XMS solve-advance --phase resolve` or `$XMS solve-advance --phase hypothesize`

#### Phase: resolve
**delegate** (executor, sonnet):
```
{problem_solving_principles}

Implement or explain the solution based on confirmed hypotheses.

Confirmed hypotheses: {confirmed_hypotheses}
Problem: {problem_context}

Resolution principles:
- Fix the root cause, not the symptom — if the hypothesis points to a deeper issue, address that.
- Minimal change that resolves the confirmed cause — don't refactor surrounding code.
- Verify the fix addresses the original problem, not just the hypothesis.

Provide a concrete solution with the specific change needed.
```

Use the result to create candidate + select.

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
Advance: `$XMS solve-advance --phase generate`

#### Phase: generate
**fan-out** (N agents, sonnet):
Each agent generates candidates optimizing different soft constraints:
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
Advance: `$XMS solve-advance --phase evaluate`

#### Phase: evaluate
**broadcast** (multi-perspective, sonnet):
Each agent scores candidates from a different perspective:
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

---

## Command: verify

1. Run: `$XMS verify`
2. Parse JSON output (`action: "verify"`)
3. If there are constraints without scores:
   - **delegate** (verifier, sonnet) agent for verification:
     ```
     Verify whether this solution satisfies the following constraints.
     Solution: {selected_candidate}
     Constraints: {unscored_constraints}
     ```
4. Show results to the user
5. On pass: `$XMS phase next` → recommend close
6. On fail: show which constraints are unmet, recommend returning to solve

## Command: next

1. Run: `$XMS next`
2. Parse JSON output (`action: "next"`)
3. Auto-execute the appropriate command based on `recommendation`:
   - `init` → Ask the user to describe the problem
   - `describe` → Request additional description
   - `classify` → Run classify
   - `strategy set` → Ask for strategy selection
   - `solve` → Run solve
   - `candidates select` → Ask for candidate selection
   - `verify` → Run verify
   - `close` → Run close

## Command: auto

When `$ARGUMENTS` is a natural language problem description:
1. `$XMS init "description"`
2. `$XMS classify`
3. Show the recommended strategy to the user and confirm
4. `$XMS strategy set <chosen>`
5. Run `$XMS solve`

---

## Shared Config Integration

x-solver references shared config in `.xm/config.json`:

| Setting | Key | Default | Effect |
|---------|-----|---------|--------|
| Mode | `mode` | `developer` | Output style |
| Agent count | `agent_max_count` | `4` | Default agent count when `solving.parallel_agents` is not set |

Change config: `x-kit config set agent_max_count 10`

Local config's `solving.parallel_agents` takes priority over shared config when set.

---

## x-build Integration

Solve results can be converted to x-build tasks.

### solve → x-build task conversion

After `close` or `verify` completion, suggest to the user:
```
Would you like to register this solution as tasks in an x-build project?
1) Yes — Register via x-build tasks add
2) No — End with the current session
```

On "Yes", auto-extract tasks from the solve result:

| solve strategy | Conversion rule |
|---------------|----------------|
| decompose | Each leaf node → separate x-build task (preserve dependencies) |
| iterate | Final hypothesis verification result → 1 x-build task |
| constrain | Selected candidate → implementation x-build task + constraint verification task |
| pipeline | Apply the above rules based on the final strategy result |

Conversion commands:
```bash
# decompose result example (3 leaves)
x-build tasks add "Implement cache layer [R1]" --size medium
x-build tasks add "Add rate limiting [R2]" --size small --deps t1
x-build tasks add "Write integration tests [R3]" --size small --deps t1,t2
```

### x-build decisions integration

Decisions made during solve can be auto-injected into x-build:
```bash
x-build decisions add "Redis for caching" --type architecture --rationale "x-solver constrain result: optimal for response time/cost"
```

## Quick Reference

```
x-solver — Structured Problem Solving

Strategies:
  decompose    Tree-of-Thought: break → solve → merge
  iterate      Hypothesis → Test → Refine loop
  constrain    Constraints → Candidates → Score → Select
  pipeline     Auto-detect → Route to best strategy

Workflow:
  init "desc"         Start a new problem
  classify            Auto-recommend strategy
  strategy set <s>    Choose strategy
  solve               Execute strategy
  verify              Check solution
  close               Wrap up

Management:
  list / status / next / history / handoff
```
