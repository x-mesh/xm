---
description: "Strategy orchestration — 17 strategies including refine, tournament, chain, review, debate, red-team, brainstorm, distribute, council, socratic, persona, scaffold, compose, decompose, hypothesis, investigate, monitor"
---

# x-op — Strategy Orchestration (Claude Code Native)

Direct structured strategies to an agent team.
The leader Claude (you) serves as both orchestrator and synthesizer, controlling agents via the **Claude Code native Agent tool**.
No external dependencies (no term-mesh or tmux required).

## Arguments

User provided: $ARGUMENTS

## Mode Detection

Read mode from `.xm/config.json` (`mode` field). Default: `developer`.

**Developer mode**: Use technical terms (strategy, verdict, premise, assumption, consensus). Concise.

**Normal mode**: 쉬운 한국어로 안내합니다.
- "strategy" → "전략", "verdict" → "판정", "premise" → "가정", "self-score" → "자체 점수"
- "consensus" → "합의", "refinement" → "다듬기", "tournament" → "대결", "debate" → "토론"
- "compose" → "조합", "decompose" → "분해"
- Use "~하세요" form; lead with key information first

## Model Routing

| Subcommand | Model | Reason |
|------------|-------|--------|
| `list` | **haiku** (Agent tool) | Catalog display, no reasoning |
| Auto-route (strategy detection) | **sonnet** | Requires AskUserQuestion for confirmation |
| Strategy execution | **sonnet** | Multi-agent orchestration |

For haiku-eligible commands, delegate via: `Agent tool: { model: "haiku", prompt: "Run: [command]" }`

## Wiring

```
suggests: x-eval
suggests: x-humble
```

## Post-Strategy Eval Gate

After every strategy completes (Self-Score appended), check for auto-eval:

1. Read `.xm/config.json` → check `eval.auto` field
2. If `eval.auto: true` OR `--verify` flag was used:
   - Automatically invoke x-eval score with the strategy output
   - Rubric: use the strategy's default rubric from Self-Score Protocol mapping
   - Mode: use `--grounded` if the strategy involved code (review, red-team, monitor)
   - Linkage: pass `--run-id`, `--source-plugin x-op`, `--source-strategy`, and `--source-result`
   - Store result in `.xm/eval/results/`
3. If `eval.auto` is not set and `--verify` is not used:
   - Show suggestion: `"💡 x-eval로 품질 평가를 할 수 있습니다. /xm:eval score로 실행하세요."`

This replaces the previous --verify inline judge panel with x-eval delegation, ensuring a single evaluation path.

> **Self-Score rule (applies to all strategies)**: Every strategy's final output MUST include a `## Self-Score` block per `references/self-score-protocol.md`.

## AskUserQuestion Dark-Theme Rule

See `references/ask-user-question-rule.md` — the `question` field is invisible on dark terminals; put context in markdown, use `header`/`label`/`description` for user-facing text.

## Interaction Protocol

**CRITICAL: x-op strategies with multiple phases MUST use AskUserQuestion at phase boundaries.**

Rules:
1. **AskUserQuestion is REQUIRED at every phase transition** — after completing a phase, call AskUserQuestion to confirm before proceeding to the next phase. This is the ONLY mechanism that forces a real turn boundary.
2. **No text-only questions** — NEVER output "진행할까요?" as plain text. Use AskUserQuestion tool.
3. **Show results before asking** — output the current phase results, then call AskUserQuestion for confirmation.
4. **Auto-Route confirmation is mandatory** — when auto-detecting a strategy, MUST use AskUserQuestion to confirm the recommendation before executing.

Anti-patterns (NEVER do these):
- ❌ Complete Phase 1, output results, then immediately start Phase 2
- ❌ Ask "다음 단계로 넘어갈까요?" as text output
- ✅ Complete Phase 1, output results, call AskUserQuestion("Phase 1 완료. Phase 2를 진행할까요?")

### Phase Checkpoint (required before any phase transition)

Before calling AskUserQuestion for a phase boundary, the leader MUST output a `**PHASE_N_CHECKPOINT:**` block listing the exit conditions for the phase just completed. This forces self-verification and gives the user something concrete to approve.

Template:
```
**PHASE_{N}_CHECKPOINT:**
- [x] {required output produced}
- [x] {evidence collected}
- [x] {dimensions covered or agents completed}
```

Rules:
- Every unchecked (`- [ ]`) item means the phase is NOT complete — fix it before asking
- For fan-out phases, include agent count (e.g., `- [x] 4/4 agents completed`)
- For compose sub-strategies, emit a checkpoint at each sub-strategy boundary, not only at the outer level
- Checkpoint precedes AskUserQuestion; AskUserQuestion still carries phase-transition authority

### Phase Boundary Exceptions

Some strategies contain internal loops or sub-strategy calls. Apply the phase boundary rule at user-meaningful boundaries:
- `chain`: checkpoint after each declared step; ask before moving to the next step unless the user selected `--dry-run`
- `compose`: each sub-strategy follows its own phase rules; ask before starting the next sub-strategy in the pipeline
- `socratic`: ask after the seed phase and after each synthesized question round
- `investigate`: Phase 2.5 cross-validation is part of Phase 2 for `deep|exhaustive`; ask before Phase 3

## Routing

Determine strategy from the first word of `$ARGUMENTS`:
- `list` → [Subcommand: list]
- `refine` → [Strategy: refine]
- `tournament` → [Strategy: tournament]
- `chain` → [Strategy: chain]
- `review` → [Strategy: review]
- `debate` → [Strategy: debate]
- `red-team` → [Strategy: red-team]
- `brainstorm` → [Strategy: brainstorm]
- `distribute` → [Strategy: distribute]
- `council` → [Strategy: council]
- `socratic` → [Strategy: socratic]
- `persona` → [Strategy: persona]
- `scaffold` → [Strategy: scaffold]
- `compose` → [Strategy: compose]
- `decompose` → [Strategy: decompose]
- `hypothesis` → [Strategy: hypothesis]
- `investigate` → [Strategy: investigate]
- `monitor` → [Strategy: monitor]
- Empty input → [Subcommand: interactive-pick] — show catalog, then AskUserQuestion to select strategy
- Other text (no strategy keyword match) → [Auto-Route] — detect intent and recommend strategy

> **Empty-input anti-pattern** (NEVER do this): output a plain-text question like "어떤 작업을 도와드릴까요?" and wait. Empty input has a deterministic spec — follow it. Plain-text questions don't create a real turn boundary, so the skill keeps re-firing against no arguments.

### Auto-Route (Natural Language → Strategy)

See `references/x-op-auto-route.md` — signal detection table, priority rules, compound signal boost, execution flow, and examples for mapping free-form input to strategies.

## Options

- `--rounds N` — Number of rounds (default 4)
- `--preset quick|thorough|deep` — quick: rounds=2, thorough: rounds=4, deep: rounds=6
- `--preset analysis-deep` — compose preset: `investigate | hypothesis | refine`
- `--preset security-audit` — compose preset: `review | red-team`
- `--preset consensus` — compose preset: `persona | council`
- `--agents N` — Number of participating agents (default: shared config's agent_max_count (default 4). Overrides when specified)
- `--model sonnet|opus|haiku` — Agent model (default sonnet)
- `--steps "role:task,role:task"` — Manually specify chain steps
- `--target <file|dir>` — review/red-team target
- `--vote` — Enable dot voting for brainstorm
- `--analogical` — Brainstorm: cross-domain structural mapping mode
- `--lateral` — Brainstorm: de Bono lateral thinking operators mode (4 agents)
- `--context` — Inject conversation context to agents
- `--no-context` — Disable context injection
- `--personas "role1,role2,..."` — Manually specify roles for persona strategy
- `--bracket single|double` — Tournament bracket type (default single)
- `--weights "role:N,role:N"` — Council weighted voting (default equal)
- `--dry-run` — Output execution plan only (no agent execution)
- `--resume` — Resume from previous checkpoint
- `--explain` — Output decision trace
- `--pipe <strategy>` — Strategy pipelining (compose)
- `--start haiku|sonnet` — Escalate starting level (default haiku)
- `--threshold N` — Quality threshold for escalation and x-eval verification (default 7)
- `--max-level haiku|sonnet|opus` — Escalate maximum level (default opus)
- `--angles "a,b,c"` — Manually specify investigation angles
- `--depth shallow|deep|exhaustive` — Investigation depth (default shallow)
- `--verify` — Delegate final quality verification to x-eval after strategy completion

## Shared Config Integration

x-op references shared config from `.xm/config.json`:

| Setting | Key | Default | Effect |
|---------|-----|---------|--------|
| Agent count | `agent_max_count` | `4` | Determines fan-out/broadcast agent count when `--agents` is not specified |
| Mode | `mode` | `developer` | Output style (technical terms vs plain language) |

Change settings: `xm config set agent_max_count 10`

When the skill layer creates agents, if no `--agents` flag is present, it reads agent_max_count from shared config to determine the number of agents.

## Pre-Execution Confidence Gate

Before dispatching agents for any strategy, the leader self-assesses readiness. This is a lightweight pre-check (~50 tokens), not a post-execution quality gate.

### Checklist (answer each before proceeding)

1. **Topic clarity** — Is the task unambiguous? Can agents act on it without guessing?
2. **Sufficient context** — Does the leader have enough information (files read, prior results) to orchestrate?
3. **Strategy fit** — Is the selected strategy appropriate for this task type?
4. **Scope boundedness** — Can agents produce a result within their token/round budget?

### Decision

| Yes count | Confidence | Action |
|:---------:|:----------:|--------|
| 4/4 | HIGH | Proceed silently — no user interruption |
| 3/4 | MEDIUM | State which item is uncertain, proceed with caveat noted in trace |
| ≤ 2/4 | LOW | **STOP.** Show the uncertain items. Use AskUserQuestion: "Confidence is low. Clarify or proceed anyway?" |

### Rules
- The gate fires AFTER strategy selection but BEFORE the first agent dispatch
- For `compose` pipelines, the gate fires ONCE at the top level, not per sub-strategy
- The gate does NOT fire for `list`, `--dry-run`, or `--resume` (no agent dispatch)
- When `--context` is active, context injection counts toward "sufficient context"
- Record the confidence level in the trace entry (session_start args)

## Agent Primitives

This skill uses only Claude Code built-in tools:

### fan-out (same question to all)
Invoke N Agent tools **simultaneously** in a single message:
```
Agent tool call 1: { description: "agent-1", prompt: "...", run_in_background: true, model: "opus" } <!-- managed-model: executor -->
Agent tool call 2: { description: "agent-2", prompt: "...", run_in_background: true, model: "opus" } <!-- managed-model: executor -->
Agent tool call 3: { description: "agent-3", prompt: "...", run_in_background: true, model: "opus" } <!-- managed-model: executor -->
```
All agents receive the same prompt but respond independently.

Agent count is determined by the `--agents N` flag or shared config's `agent_max_count`.

### delegate (assign to a specific agent)
Invoke 1 Agent tool:
```
Agent tool: { description: "role name", prompt: "...", run_in_background: false }
```
Receive the result immediately and use it in the next step.

### broadcast (different context to each)
Same as fan-out, but sends a **different** prompt to each agent (e.g., including other agents' results).

### Result collection
- Agents with `run_in_background: true` auto-notify on completion
- When notified, read results and use them in the next round

## Subcommand: list

```
x-op — Strategy Orchestration

Strategies:
  refine <topic>          Diverge → converge → verify rounds
  tournament <topic>      Compete → anonymous vote → winner
  chain <topic>           A→B→C sequential pipeline (conditional branching)
  review --target <file>  Multi-perspective code review
  debate <topic>          Pro vs Con → verdict
  red-team --target <f>   Attack → defend → re-attack
  brainstorm <topic>      Free ideation → cluster → vote [--analogical|--lateral]
  distribute <topic>      Split → parallel execute → merge
  council <topic>         N-party deliberation → weighted consensus
  socratic <topic>        Question-driven deep inquiry
  persona <topic>         Multi-persona perspective analysis
  scaffold <topic>        Design → dispatch → integrate (top-down)
  compose "A | B | C"     Strategy piping / chaining
  decompose <topic>       Recursive decompose → leaf parallel → bottom-up
  hypothesis <topic>      Generate → falsify → adopt surviving hypotheses
  investigate <topic>     Multi-angle investigation → synthesize → gap analysis
  monitor --target <f>    Observe → analyze → auto-dispatch (1-shot watchdog)

Options:
  --rounds N              Round count (default 4)
  --preset quick|thorough|deep
  --agents N              Number of agents (default: agent_max_count)
  --model sonnet|opus     Agent model
  --vote                  Enable dot voting (brainstorm)
  --target <file>         Review/red-team target
  --personas "a,b,c"      Persona roles (persona strategy)
  --bracket single|double Tournament bracket type
  --weights "role:N"      Council weighted voting
  --dry-run               Show execution plan only
  --resume                Resume from checkpoint
  --explain               Include decision trace
  --pipe <strategy>       Chain strategies (compose)
  --angles "a,b,c"       Investigation angles (investigate)
  --depth shallow|deep|exhaustive  Investigation depth (investigate)

Examples:
  /xm:op refine "Payment API design" --rounds 4
  /xm:op tournament "Login implementation" --agents 4 --bracket double
  /xm:op debate "Monolith vs microservices"
  /xm:op review --target src/auth.ts
  /xm:op brainstorm "v2 feature ideas" --vote
  /xm:op socratic "Why microservices?" --rounds 4
  /xm:op persona "Auth redesign" --personas "engineer,security,pm"
  /xm:op scaffold "Plugin system" --agents 4
  /xm:op investigate "Auth system" --target src/auth/ --depth deep
  /xm:op investigate "Redis vs Memcached" --angles "performance,ecosystem,ops,cost"
  /xm:op compose "brainstorm | tournament | refine" --topic "v2 plan"
  /xm:op refine "API design" --dry-run
  /xm:op tournament "Login" --explain
  /xm:op decompose "Implement payment system" --agents 6
  /xm:op hypothesis "Why is latency spiking?" --rounds 3
```

---

## Subcommand: interactive-pick

Entry: empty `$ARGUMENTS`. See `references/x-op-interactive-pick.md` — render catalog (same block as `## Subcommand: list`), then TWO AskUserQuestion calls: (1) strategy (4 common options; `AskUserQuestion` auto-appends `Other`, do NOT add it yourself), (2) topic. Plain-text questions are forbidden — they don't create a turn boundary and cause the skill to re-fire against empty args.

---

## Strategy: refine

See `strategies/refine.md` — round-based Diverge → Converge → Verify refinement. Round 1 DIVERGE fan-out produces N independent proposals (run_in_background parallel); Round 2 CONVERGE leader synthesizes and runs a vote fan-out to adopt the best; Round 3+ VERIFY fan-out checks the adopted proposal — all OK triggers early termination, issues raised loop back until max_rounds.

---

## Strategy: tournament

See `strategies/tournament.md` — Compete → anonymous vote → adopt winner. Phase 1 COMPETE fan-out collects solutions; Phase 2 ANONYMIZE removes agent names and shuffles order; Phase 3 VOTE fan-out ranks anonymized solutions; Phase 4 TALLY applies Borda count. Supports `--bracket double` for seed ranking with losers' bracket.

---

## Strategy: chain

See `strategies/chain.md` — A→B→C sequential pipeline with conditional branching. Each step delegates to one agent passing prior step result as context. Enhanced mode supports `if:condition->step` DAG branching syntax and auto-inserts supplementary steps when confidence is low.

---

## Strategy: review

See `strategies/review.md` — Multi-perspective code review fan-out. Phase 1 TARGET reads `--target` file or `git diff HEAD`; Phase 2 ASSIGN distributes Security/Logic/Performance perspectives (scales with `--agents N`); Phase 3 REVIEW fan-out with per-perspective prompts; Phase 4 SYNTHESIZE deduplicates and sorts by severity.

---

## Strategy: debate

See `strategies/debate.md` — Pro vs Con debate followed by verdict. Phase 1 POSITION distributes agents into PRO/CON/JUDGE; Phase 2 OPENING runs simultaneous fan-out for arguments; Phase 3 REBUTTAL cross-sends openings; Phase 4 VERDICT delegate scores all arguments and delivers a final recommendation.

---

## Strategy: red-team

See `strategies/red-team.md` — Adversarial attack/defend cycle. Phase 1 TARGET collects via `--target` or `git diff HEAD`; Phase 2 ATTACK fan-out finds vulnerabilities tagged by dimension; Phase 3 DEFEND fan-out provides fixes or counter-evidence; Phase 4 REPORT synthesizes Fixed(🟢)/Partial(🟡)/Open(🔴).

---

## Strategy: brainstorm

See `strategies/brainstorm.md` — free ideation → cluster → vote. Phase 1 GENERATE fan-out produces minimum 5 tagged ideas per agent; two optional modes: `--analogical` (cross-domain structural mapping) and `--lateral` (de Bono operators: Reversal, Provocation, Random Entry, Fractionation). Phase 2 CLUSTER deduplicates and groups by theme; Phase 3 VOTE (when `--vote` is set) fan-out selects top 3.

---

## Strategy: distribute

See `strategies/distribute.md` — Split a large task into independent subtasks → parallel fan-out → merge. Phase 1 SPLIT auto-splits or uses `--splits`; Phase 2 DISPATCH fan-out with scoped subtask prompts; Phase 3 MERGE leader resolves conflicts and synthesizes by theme.

---

## Strategy: council

See `strategies/council.md` — N-party free discussion → cross-examination → deep dive → consensus. Round 1 OPENING fan-out collects positions; Round 2 CROSS-EXAMINE broadcasts each agent's view to others (excluding their own); Round 3~N-1 DEEP DIVE targets key points of contention; Final CONVERGE drafts a consensus proposal for vote. Supports `--weights` for role-based weighted voting.

---

## Strategy: socratic

See `strategies/socratic.md` — Socratic questioning across N rounds: Phase 1 SEED collects an initial position via delegate; Phase 2 QUESTION ROUNDS fan-out agents as questioners targeting logical gaps and implicit premises, then leader synthesizes and sends to a responding agent. Early termination when questions become trivial; max_rounds cap for best-effort output.

---

## Strategy: persona

See `strategies/persona.md` — Role-based multi-perspective analysis. Phase 1 ASSIGN distributes fixed personas (default: senior engineer, security expert, PM, junior developer); Phase 2 ANALYZE broadcast with per-persona prompts; Phase 3 SYNTHESIZE unifies across perspectives; optional Phase 4 CROSS-CHECK verifies unified proposal from each persona's view.

---

## Strategy: scaffold

See `strategies/scaffold.md` — Structure design → module distribution → parallel implementation → integration. Phase 1 DESIGN delegates to opus for module/interface spec; Phase 2 DISPATCH fan-out per module; Phase 3 INTEGRATE resolves interface compatibility and assembles final result.

---

## Options Reference

See `references/x-op-options.md` — detailed behavior for `--dry-run`, `--resume`, `--explain`, `--verify`, `--vote` (Self-Consistency).

---

## Strategy: compose

See `strategies/compose.md` — Chain multiple strategies into a sequential pipeline. Supports `compose "A | B | C"` syntax and `--pipe` flag. Leader constructs `pipe_payload` between each step using per-strategy extraction rules; includes a full transformation table for common strategy pairings.

---

## Strategy: decompose

See `strategies/decompose.md` — Recursive decomposition → leaf parallel execution → bottom-up assembly. Phase 1 DECOMPOSE delegates to an opus agent to build a dependency tree; Phase 2 EXECUTE LEAVES fan-out in dependency order; Phase 3 ASSEMBLE integrates results bottom-up.

---

## Strategy: hypothesis

See `strategies/hypothesis.md` — Generate hypotheses → falsify → adopt survivors. Phase 1 GENERATE fan-out produces 2-3 tagged hypotheses per agent with falsifiable predictions; Phase 2 FALSIFY fan-out attempts to disprove each (FALSIFIED or SURVIVED); Phase 3 SYNTHESIZE selects strongest survivor, re-runs if none survive (up to max_rounds).

---

## Strategy: investigate

See `strategies/investigate.md` — Multi-angle investigation → synthesis → gap analysis. Phase 1 SCOPE auto-selects angles from topic pattern (codebase/comparison/security/performance/general); Phase 2 EXPLORE broadcast with depth-aware prompts (shallow/deep/exhaustive); Phase 2.5 CROSS-VALIDATE for deep/exhaustive; Phase 3 SYNTHESIZE with conflict resolution and confidence aggregation; Phase 4 GAP ANALYSIS delegate suggests follow-up strategies.

---

## Strategy: monitor

See `strategies/monitor.md` — one-shot OODA (observe → orient → decide → act). Default observation targets: `--target` or recent git changes. Phase 2 ORIENT broadcasts to N agents across code-quality/security/dependency/test-coverage angles; Phase 3 DECIDE applies wait/escalate/act; Phase 4 ACT auto-dispatches red-team/review/chain/investigate/hypothesis per alert type.

---

## Strategy Selection Guide

When the user does not know which strategy to use, recommend one using the decision tree below:

```
What kind of task is this?
│
├─ Code writing/implementation → What scale?
│   ├─ Single module → scaffold
│   ├─ Multiple independent tasks → distribute
│   └─ Dependency tree → decompose
│
├─ Code review/security → What purpose?
│   ├─ Quality inspection → review
│   ├─ Vulnerability hunting → red-team
│   └─ Both → compose "review | red-team"
│
├─ Decision-making/design → Are there options?
│   ├─ 2 opposing choices → debate
│   ├─ 3+ candidates → tournament
│   ├─ Multiple stakeholders → council
│   └─ Per-perspective analysis needed → persona
│
├─ Problem solving/debugging → Do you know the cause?
│   ├─ Unknown → hypothesis
│   ├─ Exploration needed → investigate
│   └─ Want to verify assumptions → socratic
│
├─ Ideation/planning → What stage?
│   ├─ Divergence → brainstorm
│   ├─ Diverge→select→refine → compose "brainstorm | tournament | refine"
│   └─ Improve existing proposal → refine
│
├─ Sequential workflow → chain
│
└─ Change monitoring/anomaly detection → monitor
```

## Agent Output Quality Contract
See `references/agent-output-contract.md` — evidence-based, falsifiable, dimension-tagged outputs with per-category Dimension Anchors and strict evidence standards.

---

## Self-Score Protocol

See `references/self-score-protocol.md` — 1-10 self-assessment scale, Strategy-Rubric mapping, 4Q hallucination check, output block format.

## Result Persistence (REQUIRED — every strategy)

Every strategy MUST save its result to `.xm/op/` as the final step, after the Self-Score block.

See `references/x-op-result-persistence.md` — save workflow, result schema, per-strategy outcome mapping, and what NOT to save.

### Termination Checkpoint (required before declaring any strategy complete)

Before treating a strategy as done, emit this block as the last thing. Any unchecked item = strategy NOT complete — return to the missing step, do not end the turn.

```
**TERMINATION_CHECKPOINT:**
- [x] Final Output emitted (strategy-specific format)
- [x] Self-Score block emitted (per `references/self-score-protocol.md`)
- [x] Result file written to `.xm/op/{strategy}-{YYYY-MM-DD}-{slug}.json`
- [x] Save path surfaced to user: `💾 Saved: .xm/op/{filename}`
```

Rules:
- Run this checkpoint BEFORE the Post-Strategy Eval Gate
- `--dry-run` skips the checkpoint (no strategy execution occurred)
- `compose` emits one checkpoint per sub-strategy AND one for the outer pipeline
- Skipping the save step because "the result is in chat" is wrong: the next session cannot resume or cross-reference without the file

---

## Trace Recording

See `references/trace-recording.md` — session_start/session_end are automatic via `.claude/hooks/trace-session.mjs`; emit best-effort `agent_step` entries for long sub-operations.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll just use refine, it always works" | refine is convergence, not exploration. Use it *after* you have candidates, not before. Problems that need divergent thinking (brainstorm, tournament) starve on refine alone. |
| "This result looks good, `--verify` is overkill" | `--verify` exists precisely because "looks good" is where shared bias hides. Skipping it means you're trusting one model's confidence instead of checking its work. |
| "Debate is expensive, I'll skip it" | Debate is expensive *because* it surfaces disagreements that single-strategy runs hide. The cost is the value — if it didn't disagree, you didn't need it. |
| "Any strategy works for this" | "Any strategy" is the tell that you haven't classified the problem. Use auto-route or interactive-pick first — "any strategy" is functionally the same as no strategy. |
| "17 strategies is too many, I'll stick with 3" | Sticking with 3 means you're using them outside their fit zone. Auto-route narrows the 17 to the right 1-2 in seconds. |
| "The strategy matters less than the prompt" | The strategy *is* the control loop around the prompt. Wrong strategy = wrong loop = wasted agents even with a perfect prompt. |
| "Compose is for complex problems, mine is simple" | Compose chains strategies that address different failure modes. Even simple problems benefit when divergence-then-convergence is cheaper than any single strategy solving both. |

---
<!-- [See: agent-output-contract] -->

# Agent Output Quality Contract

All agent prompts in x-op strategies implicitly reference this contract. The leader enforces it during synthesis.

## Output Quality Criteria

Every argument, finding, or position an agent produces must be:
1. **Evidence-based** — Cites a specific fact, example, or mechanism. "It's better" → FAIL. "Reduces latency by eliminating N+1 queries" → PASS.
2. **Falsifiable** — States a claim that could be proven wrong. "This might help" → FAIL. "This approach fails when concurrent users exceed 1K" → PASS.
3. **Dimension-tagged** — Labels which dimension it addresses. Two arguments on the same dimension must be merged.

## Dimension Anchors by Strategy Category

See `references/dimension-anchors.md` — per-category dimension pools (Code, Ideation, Argument/Analysis, Task Decomposition).

## Judge/Evaluator Rubric

When a strategy includes a judge, evaluator, or voting phase:
- Score each argument on **strength** (evidence + logic, 1-10) and **coverage** (dimensions addressed, 1-10)
- Verdict must cite dimension scores, not just declare a winner

## Evidence Standards (Strict)

Every factual claim in an agent's output must be backed by one of the Valid evidence types. The leader rejects findings whose only support is Invalid evidence during synthesis.

| Valid Evidence | Invalid Evidence |
|----------------|------------------|
| `file.ts:123` with the actual code snippet quoted | "likely includes...", "probably because...", "may be" |
| Output from a command the agent actually ran (grep, test, diff) | Logical deduction without code proof |
| A test executed whose result proves the behavior | General explanation of how a technology works |
| Cited URL + quoted passage (not just a link) | Bare URL with no quoted content |
| Another agent's output referenced by ID/phase | "It is well known that…" / appeal to common practice |

Rejection rule: when an agent submits a finding with no Valid evidence, the leader either (a) drops it from synthesis, or (b) returns it to the agent for evidence before counting it.

## Good vs Bad Agent Output

Good: `[feasibility] Requires only stdlib — no new deps, deploys on existing infra. Fails if payload exceeds 1MB (no streaming). Evidence: src/server/upload.ts:42 uses Buffer.concat with no size guard.`
Bad: `This approach is more practical and easier to implement.`

## Applies to

x-op (all strategies), x-review (finding quality enforcement), x-eval (output scoring rubric)

---
<!-- [See: ask-user-question-rule] -->

# AskUserQuestion Dark-Theme Rule

Reference for x-op prompts using AskUserQuestion.

**CRITICAL:** The `question` field in AskUserQuestion is invisible on dark terminals.

## Visibility map

| Element | Visible | Use for |
|---------|---------|---------|
| `header` | YES | Short context tag, for example `x-op` or `Pipeline` |
| `question` | NO | Keep minimal; user may not see this text |
| option `label` | YES | Primary info; must be self-explanatory |
| option `description` | YES | Supplementary detail |

## Required pattern

1. Output all context as regular markdown before calling AskUserQuestion.
2. Put the short visible context in `header`.
3. Keep `question` short.
4. Carry decision-relevant information in option `label` and `description`.

## Anti-pattern

- Wrong: putting all context in the `question` field.
- Right: print context first, then use `header` and option labels for the interactive choice.

## Applies to

x-op auto-route, interactive-pick, and all strategy phase boundaries.

---
<!-- [See: dimension-anchors] -->

# Dimension Anchors

Reference for tagging x-op agent outputs with structured dimensions.

Agents must tag output by dimension before generating content. This prevents overlap and improves coverage.

## Dimension Anchors by Strategy Category

| Category | Strategies | Dimension Pool |
|----------|-----------|---------------|
| Argument/analysis | refine, tournament, debate, council, socratic, hypothesis, investigate | `feasibility`, `scalability`, `maintainability`, `cost`, `risk`, `performance`, `security`, `dx` |
| Code analysis | review, red-team, monitor | `correctness`, `security`, `performance`, `resilience`, `testability`, `readability` |
| Task decomposition | scaffold, decompose, distribute, chain | `scope-clarity`, `dependency-minimality`, `parallelizability`, `testability`, `interface-completeness` |
| Ideation | brainstorm, persona | `novelty`, `feasibility`, `impact`, `effort`, `risk` |

## Assignment rule

The leader pre-assigns dimensions to agents before generation. Agents do not freely pick dimensions.

- Deterministic strategies (`review`, `red-team`, `monitor`, `scaffold`, `decompose`, `distribute`, `chain`): use fixed dimensions where possible.
- Exploratory strategies (`debate`, `refine`, `tournament`, `brainstorm`, `council`, `socratic`, `persona`, `hypothesis`, `investigate`): select the most relevant dimensions for the topic; diversity across trials is acceptable.

## Agent Output Quality Contract

1. **Evidence-based** — Every claim cites a source: file:line with code quoted, command output, executed test result, cited URL plus quoted passage, or another agent's output referenced by ID/phase.
2. **Falsifiable** — Claims can be proven wrong.
3. **Dimension-tagged** — Claims identify the dimension they address.

## Applies to

x-op strategies and x-eval scoring of x-op outputs.

---
<!-- [See: self-score-protocol] -->

# Self-Score Protocol

Reference for agents scoring their own output on a 1-10 scale. Used by all x-op strategies.

All strategies include a `## Self-Score` block in the final output. The leader self-scores based on rubric after strategy completion.

## Strategy-Rubric mapping

| Category | Strategies | Default Rubric | Criteria (weight) |
|----------|-----------|----------------|-------------------|
| Code analysis | review, red-team, monitor | code-quality | correctness 0.30, readability 0.20, maintainability 0.20, security 0.20, test-coverage 0.10 |
| Argument/analysis | refine, tournament, debate, council, socratic, hypothesis, investigate | general | accuracy 0.25, completeness 0.25, consistency 0.20, clarity 0.20, hallucination-risk 0.10 |
| Task decomposition | scaffold, decompose, distribute, chain | plan-quality | completeness 0.30, actionability 0.30, scope-fit 0.20, risk-coverage 0.20 |
| Ideation | brainstorm, persona | general | accuracy 0.25, completeness 0.25, consistency 0.20, clarity 0.20, hallucination-risk 0.10 |
| Pipeline | compose | last strategy's rubric | - |

Override with `--rubric <name>` flag.

## Self-Score output format

Appended to the end of every strategy's final output:

```
## Self-Score
| Criterion | Score | Note |
|-----------|-------|------|
| {criterion1} | {1-10} | {one-line rationale} |
| {criterion2} | {1-10} | {one-line rationale} |
| ... | ... | ... |
| **Overall** | **{weighted average}** | |
```

Scoring scale: 1=fail, 5=baseline, 7=good, 10=excellent.

## Hallucination Self-Check (4Q)

After computing Self-Score and before presenting the final output, the leader answers 4 verification questions. This is a lightweight self-check that fills the gap between "no check" and the heavyweight `x-eval --grounded` judge panel.

1. **Evidence exists?** — Every factual claim cites a source (file:line, URL, tool output, agent quote). Claims without sources → flag as UNVERIFIED.
2. **Requirements addressed?** — Enumerate each element of the original task/topic. For each: covered / partially covered / not covered.
3. **No unverified assumptions?** — List assumptions made during the strategy. For each: cite evidence or mark ASSUMED.
4. **Internal consistency?** — Do findings/arguments contradict each other? Does the verdict follow from the evidence?

Output format:

```
### 4Q Check
| # | Question | Status | Note |
|---|----------|:------:|------|
| 1 | Evidence | ✅/⚠️ | {N verified, M unverified} |
| 2 | Requirements | ✅/⚠️ | {N/M covered} |
| 3 | Assumptions | ✅/⚠️ | {N assumptions, M unverified} |
| 4 | Consistency | ✅/⚠️ | {consistent / conflicts noted} |
```

If 2+ questions are ⚠️, append: `"⚠ 2+ items flagged. Consider: /xm:eval score --grounded for tool-verified evaluation."`

## Rules

- 4Q is mandatory for all strategies.
- 4Q supplements Self-Score; it does not replace it.
- 4Q does not use tools. For tool-assisted verification, use `x-eval --grounded`.
- Keep answers concise.

## Applies to

x-op strategies.

---
<!-- [See: trace-recording] -->

# Trace Recording

Reference for x-op trace entries. `session_start` and `session_end` are automatic via `.claude/hooks/trace-session.mjs`.

## Per agent call

Read the session ID from `.xm/traces/.active`, then record `agent_step` with role, model, estimated tokens, duration, and status. Use `parent_id` for fan-out trees and `null` for root agents.

## Rules

1. `session_start` and `session_end` are automatic; do not emit them manually.
2. `agent_step` is best-effort; record it when possible.
3. Store metadata only. Never include LLM output or verdicts in trace entries.
4. If trace write fails, log to stderr and continue. Trace failures must not block strategy execution.

## Applies to

x-op strategy execution and long-running sub-operations.

---
<!-- [See: x-op-auto-route] -->

# Auto-Route (Natural Language → Strategy)

When the user provides text that doesn't match any strategy keyword, auto-detect the best strategy.

## Signal detection table

| Signal Pattern | Detected Intent | Recommended Strategy | Confidence |
|---------------|----------------|---------------------|------------|
| "리뷰", "review", "check", "검토", "코드 리뷰" | Code quality check | **review** | high |
| "보안", "security", "취약점", "vulnerability", "XSS", "injection" | Security audit | **red-team** | high |
| "vs", "비교", "compare", "어떤 게 나아", "which is better" | Comparison/decision | **debate** | high |
| "아이디어", "idea", "브레인스토밍", "brainstorm", "방법 없을까" | Idea generation | **brainstorm** | high |
| "왜", "why", "원인", "root cause", "디버그", "debug" | Root cause analysis | **hypothesis** | high |
| "조사", "investigate", "분석", "analyze", "알아봐" | Deep investigation | **investigate** | high |
| "개선", "improve", "다듬", "refine", "더 좋게" | Iterative improvement | **refine** | high |
| "설계", "design", "아키텍처", "architecture", "구조" | Design decision | **council** | medium |
| "합의", "consensus", "의견 모아", "다 같이" | Multi-perspective agreement | **council** | high |
| "분해", "break down", "나눠", "쪼개" | Problem decomposition | **decompose** | high |
| "조합", "combine", "파이프라인", "순서대로" | Multi-strategy pipeline | **compose** | medium |
| "모니터", "watch", "감시", "지켜봐" | Continuous monitoring | **monitor** | high |
| "관점", "perspective", "입장", "stakeholder" | Multi-perspective analysis | **persona** | high |
| "질문", "socratic", "탐구", "명확하게" | Requirement clarification | **socratic** | medium |
| File/dir path detected (e.g., `src/`, `*.ts`) | Code target → review or red-team | **review** | medium |

## Priority rules

**Compound signal boost:** 2+ signals → +confidence. E.g., "보안 리뷰" = security + review → **red-team** (security takes priority over review).

**Priority rules when multiple signals match:**
1. Security signals always win → **red-team**
2. Explicit comparison ("vs", "비교") → **debate**
3. Code/file target → **review** (unless security signal present)
4. Question/why → **hypothesis**
5. Fallback → **refine** (safe default for improvement tasks)

## Execution flow

1. Parse input text against signal table
2. If high confidence match → show recommendation and confirm:

   **Developer mode:**
   ```
   🎯 Auto-detected: "{input}" → strategy: {recommended}
   Reason: {matched signals}

   1) {recommended} (Recommended)
   2) {alternative_1}
   3) {alternative_2}
   4) Other — choose manually
   ```

   **Normal mode:**
   ```
   🎯 자동 감지: "{input}" → 전략: {recommended}
   이유: {matched signals 한국어}

   1) {recommended} (추천)
   2) {alternative_1}
   3) {alternative_2}
   4) 직접 선택
   ```

3. If low/medium confidence or no match → show top 3 suggestions with AskUserQuestion
4. **Call AskUserQuestion to confirm strategy selection before executing.** (See Interaction Protocol)
5. After user confirms → execute the selected strategy with the original text as topic

## Examples

```
/xm:op "이 API 설계 괜찮은지 봐줘"
  → Signal: "봐줘" (review) + implicit code context
  → Recommended: review
  → Executes: /xm:op review "이 API 설계 괜찮은지 봐줘"

/xm:op "Redis vs Memcached"
  → Signal: "vs" (compare)
  → Recommended: debate
  → Executes: /xm:op debate "Redis vs Memcached"

/xm:op "왜 이 테스트가 자꾸 실패하지"
  → Signal: "왜" (root cause)
  → Recommended: hypothesis
  → Executes: /xm:op hypothesis "왜 이 테스트가 자꾸 실패하지"

/xm:op "결제 시스템 보안 점검"
  → Signal: "보안" (security) + "점검" (check)
  → Recommended: red-team
  → Executes: /xm:op red-team "결제 시스템 보안 점검"

/xm:op "새 기능 아이디어 좀 내보자"
  → Signal: "아이디어" (idea generation)
  → Recommended: brainstorm
  → Executes: /xm:op brainstorm "새 기능 아이디어 좀 내보자"
```

## Applies to

x-op (routing layer only)

---
<!-- [See: x-op-interactive-pick] -->

# x-op — Empty-Input Interactive Pick

**Entry:** empty `$ARGUMENTS` routed from `## Routing` in `SKILL.md`.

**Purpose:** empty input means the user invoked `/xm:op` without deciding — show them the catalog and collect a concrete strategy + topic in the same turn. Replaces the previous spec (empty → catalog only), which left users stuck at the next turn and caused the skill to re-fire against empty args (observed failure mode, 2026-04-23).

## Flow

1. **Render the catalog.** Output the same block as `## Subcommand: list` (strategy table + options + examples) first, so the user can see everything before picking.

2. **Call AskUserQuestion (mandatory).** Single tool call, NOT plain text. The tool accepts 2–4 options and **auto-appends "Other"** (do NOT include Other yourself). Use exactly these 4 common strategies:

   | Label | Description | Maps to |
   |-------|-------------|---------|
   | `refine` | 반복 개선 — 설계/문서/API 다듬기 | refine |
   | `tournament` | N개 제안 경쟁 — 최적안 선정 | tournament |
   | `review` | 코드 리뷰 — 보안/품질/성능 다각도 | review |
   | `brainstorm` | 아이디어 발산 — 투표 기반 수렴 | brainstorm |

   Auto-injected "Other" covers the other 13 strategies — the user types the full `/xm:op <strategy> <topic>` in the Other free-text field or in their next message.

3. **After the user picks:**
   - `Other` (auto-injected) → stop. Do not dispatch. Wait for the user's next message (they will respecify the strategy).
   - One of the 4 → call AskUserQuestion a second time to collect the topic:
     - question: `"{strategy}"의 대상 또는 주제는?`
     - 2 options: `Type topic` (description: "자유 텍스트 입력"), `Cancel` (description: "중단하고 대기")
     - The user's free-text via Other is the topic string.
   - Then dispatch the chosen strategy with the provided topic as `$ARGUMENTS`.

## Anti-patterns

- ❌ Plain-text question like "어떤 작업을 도와드릴까요?" — not a real turn boundary, causes skill to re-fire against empty args.
- ❌ Skip the catalog and jump straight to AskUserQuestion — user loses context for the `other` escape.
- ❌ Silently pick a strategy for the user — empty input means they haven't decided.
- ❌ More than 2 AskUserQuestion calls in the pick flow — cap at (strategy, topic).

## Explicit `list` vs empty input

| Invocation | Behavior |
|------------|----------|
| `/xm:op list` | Catalog only. No AskUserQuestion. User is browsing. |
| `/xm:op` (empty args) | Catalog + AskUserQuestion(strategy) + AskUserQuestion(topic). User needs guidance. |

---
<!-- [See: x-op-options] -->

# Options Reference

Detailed behavior for all x-op execution options: `--dry-run`, `--resume`, `--explain`, `--verify`, `--vote`.

## Options: --dry-run

Output execution plan only without running any agents.

### Usage
```
/xm:op refine "topic" --dry-run
```

### Output
```
📋 [dry-run] refine "topic"

Execution Plan:
  Rounds: 4 (preset: thorough)
  Agents: 10 (agent_max_count: 10)
  Model: sonnet

  Round 1 (Diverge):  8 agents × fan-out
  Round 2 (Converge): 8 agents × fan-out + leader synthesis
  Round 3 (Verify):   8 agents × fan-out
  Round 4 (Verify):   8 agents × fan-out (if needed)

  Estimated tokens: ~120K input, ~48K output
  Estimated cost: ~$3.24
```

Returns immediately without invoking any agents. The leader constructs the plan based on the strategy documentation.

---

## Options: --resume

Resume an interrupted strategy execution from a checkpoint.

### Checkpoint schema

After each round/phase completes, the leader auto-saves to `.xm/op-checkpoints/{run-id}.json`:

```json
{
  "version": 1,
  "run_id": "refine-2026-03-27T12-30-00-000Z",
  "strategy": "refine",
  "topic": "Payment API design",
  "status": "in_progress",
  "created_at": "2026-03-27T12:30:00.000Z",
  "updated_at": "2026-03-27T12:35:42.000Z",
  "options": {
    "rounds": 4,
    "agents": 4,
    "model": "sonnet",
    "preset": "thorough"
  },
  "progress": {
    "total_rounds": 4,
    "completed_rounds": 2,
    "current_phase": "converge",
    "early_exit": false
  },
  "results": [
    {
      "round": 1,
      "phase": "diverge",
      "completed_at": "2026-03-27T12:32:10.000Z",
      "agent_outputs": [
        { "agent_id": "agent-1", "role": "engineer", "output_summary": "REST-based approach" },
        { "agent_id": "agent-2", "role": "architect", "output_summary": "GraphQL approach" }
      ],
      "summary": "3 approaches identified: REST, GraphQL, gRPC"
    }
  ],
  "verification": {
    "enabled": false,
    "rubric": "general",
    "threshold": 7,
    "attempts": [
      {
        "attempt": 1,
        "score": 6.2,
        "criteria_scores": { "accuracy": 7, "completeness": 5, "consistency": 6, "clarity": 7, "hallucination-risk": 8 },
        "feedback": "completeness scored lowest — missing edge cases",
        "timestamp": "2026-03-27T12:34:00.000Z"
      }
    ],
    "final_score": 7.8,
    "passed": true
  }
}
```

`run-id` generation: `{strategy}-{ISO timestamp}` (created on first run, reused thereafter).

### Save workflow

After each round/phase completes, the leader:
1. `mkdirSync('.xm/op-checkpoints/', { recursive: true })` (Bash)
2. Append current round result to the `results` array
3. Increment `progress.completed_rounds`, update `updated_at`
4. Save JSON file (atomic write)
5. When `--verify` is enabled: save verification results to the checkpoint
   - Record each attempt's score, criteria_scores, and feedback
   - Record the final selected version's score in final_score

### Resume workflow

```
/xm:op --resume
```

1. Select the most recent `status: "in_progress"` file from `.xm/op-checkpoints/` by `updated_at`
2. Read `progress.completed_rounds` → `resume_from = completed_rounds + 1`
3. Inject `results[].summary` as context before the next round's prompt:
   ```
   "## Previous Execution Context (Round 1~{N} results)
   {results summary}"
   ```
4. Restore `options` and resume execution from that round
5. On completion: write `status: "completed"` → excluded from resume targets

### When no checkpoint exists
If `--resume` is used with no checkpoint: output `"⚠ No checkpoint found. Run a strategy first."`.

---

## Options: --explain

Output the decision-making process transparently alongside the final result.

### Usage
```
/xm:op tournament "topic" --explain
```

### Additional output
Adds a `## Decision Trace` section to each strategy's final output:
```
## Decision Trace
| Step | Input | Decision | Rationale |
|------|-------|----------|-----------|
| Diverge | 8 proposals | 3 clusters identified | Grouped similar approaches |
| Converge | 3 clusters | Cluster B adopted (5/8 votes) | Feasibility + scalability |
| Verify | Cluster B | 2 issues found, 1 fixed | Security issue corrected |
```

The leader records why each decision was made at each step and includes it in the final output.

---

## Options: --verify

Auto quality verification after strategy completion. x-op delegates final scoring to x-eval so every plugin uses the same evaluation path.

### Verification flow

```
Strategy complete → Self-Score (self-assessment)
  │
  ├─ --verify not specified → Output Self-Score only, end
  │
  └─ --verify specified →
      1. Persist final strategy output to .xm/op/
      2. Invoke x-eval score with the persisted output
      3. Use the strategy's default rubric from self-score-protocol.md
      4. Use --grounded for code-facing strategies (review, red-team, monitor)
      5. Store the x-eval result under .xm/eval/results/
```

### Rubric mapping

`--verify` uses the same Strategy-Rubric mapping as the Self-Score Protocol:
- `review`, `red-team`, `monitor` → `code-quality` with grounded evaluation
- `scaffold`, `decompose`, `distribute`, `chain` → `plan-quality`
- `compose` → last sub-strategy's rubric
- all other strategies → `general`

`--threshold N` is passed to x-eval as the passing threshold. x-op does not run an inline judge panel or retry loop.

### Verification result output

```
## Verification
x-eval: PASS
Score: 7.8/10
Rubric: general
Saved: .xm/eval/results/{result-id}.json
```

---

## Options: --vote (Self-Consistency)

Run N independent agents with the SAME prompt, then synthesize by majority vote. Divergence reveals uncertainty.

### Usage
Append `--vote` to any strategy that uses fan-out:
- `/xm:op refine "topic" --vote` — each diverge agent's conclusion is voted on
- `/xm:op brainstorm "topic" --vote` — already supported (existing --vote for idea selection)
- `/xm:op hypothesis "topic" --vote` — each hypothesis is independently generated N times; only hypotheses appearing in 2+ agents survive

### Mechanism
1. Fan-out N agents with identical prompt (no role differentiation)
2. Collect all responses
3. Cluster similar conclusions (leader groups by semantic similarity)
4. Count: conclusions appearing in ≥50% of agents = HIGH CONFIDENCE
5. Conclusions in 25-49% = MEDIUM CONFIDENCE
6. Conclusions in <25% = LOW CONFIDENCE (divergence signal — flag uncertainty)

### Output addition
When --vote is active, append to the strategy's final output:
```
## Confidence Map (Self-Consistency)
| Conclusion | Agents | Confidence |
|-----------|--------|------------|
| {conclusion} | {N}/{total} | HIGH/MEDIUM/LOW |

Agreement rate: {percentage}%
Divergence areas: {list areas where agents disagreed}
```

### When NOT to use
- Strategies that intentionally assign different roles (persona, council) — role diversity is the point, not convergence
- Strategies with < 3 agents — insufficient sample for voting

## Applies to

x-op (all strategies that support the respective flag)

---
<!-- [See: x-op-result-persistence] -->

# Result Persistence

After every strategy completes (after Self-Score), the leader MUST save the result to `.xm/op/`.

## Save workflow

1. `mkdir -p .xm/op/` (Bash)
2. Generate filename: `{strategy}-{YYYY-MM-DD}-{slug}.json` (slug from topic, max 40 chars, lowercase, hyphens)
3. Generate `run_id`: `{strategy}-{YYYY-MM-DD}T{HH-mm-ss}-{slug}` and store it in the result JSON
4. Write JSON file with the schema below
5. If `--verify` or `eval.auto` runs x-eval, pass the same `run_id` and `source_result_path` to the eval result; then write the eval result path back into `evaluation`

## Result schema

```json
{
  "schema_version": 1,
  "run_id": "debate-2026-04-04T10-00-00-redis-vs-postgres",
  "strategy": "debate",
  "topic": "Redis vs Postgres for queue",
  "status": "completed",
  "created_at": "2026-04-04T10:00:00.000Z",
  "completed_at": "2026-04-04T10:12:34.000Z",
  "options": {
    "rounds": 4,
    "agents": 4,
    "model": "sonnet",
    "preset": null
  },
  "outcome": {
    "verdict": "Redis",
    "summary": "Low latency + pub/sub requirements favor Redis",
    "confidence": 7.8
  },
  "self_score": {
    "overall": 7.8,
    "criteria": {
      "accuracy": 8,
      "completeness": 7,
      "consistency": 8,
      "clarity": 8
    }
  },
  "participants": [
    { "role": "advocate", "position": "Redis" },
    { "role": "advocate", "position": "Postgres" },
    { "role": "judge" }
  ],
  "rounds_summary": [
    { "round": 1, "phase": "opening", "summary": "PRO: low latency; CON: durability" },
    { "round": 2, "phase": "rebuttal", "summary": "PRO addressed durability with AOF" }
  ],
  "evaluation": {
    "status": "pass",
    "result_path": ".xm/eval/results/2026-04-04T10-12-35-score.json",
    "overall": 7.8,
    "rubric": "general"
  }
}
```

## Eval link contract

When x-op delegates verification to x-eval, the two result files MUST be linkable without scanning file contents:

| Field | Location | Description |
|-------|----------|-------------|
| `run_id` | `.xm/op/*.json` and `.xm/eval/results/*.json` | Stable ID for the strategy execution |
| `source_plugin` | `.xm/eval/results/*.json` | `"x-op"` for x-op-initiated evaluations |
| `source_strategy` | `.xm/eval/results/*.json` | Strategy name, e.g. `"debate"` |
| `source_result_path` | `.xm/eval/results/*.json` | Path to the originating `.xm/op/*.json` file |
| `evaluation.result_path` | `.xm/op/*.json` | Back-link to the eval result file when verification ran |

If x-eval fails or is skipped, keep `evaluation.status` as `"skipped"` or `"failed"` with a short `reason`. Do not omit the `evaluation` object for completed x-op runs.

## Per-strategy outcome mapping

| Strategy | outcome.verdict | outcome.summary |
|----------|----------------|-----------------|
| debate | PRO or CON | Winning argument summary |
| tournament | Winner name | Winning solution summary |
| refine | "adopted" | Final adopted solution summary |
| review | "{N} issues" | Critical/High issue summary |
| red-team | "{N} vulns ({open} open)" | Top vulnerability summary |
| hypothesis | "H{N} survived" | Strongest surviving hypothesis |
| investigate | "{N} findings, {G} gaps" | Key insights summary |
| council | CONSENSUS / NO CONSENSUS | Consensus statement |
| brainstorm | "{N} ideas, {T} themes" | Top-voted ideas summary |
| scaffold | "{N} modules" | Module structure summary |
| decompose | "{N} leaves" | Assembly result summary |
| chain | "completed" | Final step output summary |
| persona | "{N} perspectives" | Unified recommendation summary |
| socratic | "{N} rounds" | Final refined position summary |
| monitor | "{alerts} alerts" | Decision + dispatch summary |
| distribute | "{N} subtasks" | Merge result summary |
| compose | "{N} strategies" | Last strategy result summary |

## What NOT to save

- Full agent outputs (too large) — only summaries in `rounds_summary`
- Checkpoint in-progress state — that stays in `.xm/op-checkpoints/`
- Eval judge transcripts — those belong in `.xm/eval/results/` as `judge_rationales`

## Applies to

x-op (all strategies)
