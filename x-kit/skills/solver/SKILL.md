---
name: solver
description: Structured problem solving — decompose, iterate, constrain, or auto-pipeline with strategy recommendation
allowed-tools:
  - AskUserQuestion
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

## Interaction Protocol

**CRITICAL: x-solver phase transitions MUST use AskUserQuestion for user confirmation.**

Rules:
1. **AskUserQuestion is REQUIRED** — after each phase completes, call AskUserQuestion before proceeding. Text-only questions do NOT create turn boundaries.
2. **classify → strategy selection**: MUST use AskUserQuestion to confirm recommended strategy.
3. **solve phase completion**: MUST use AskUserQuestion before proceeding to verify.
4. **verify results**: MUST use AskUserQuestion to confirm before close.

Anti-patterns:
- ❌ Run classify, show result, immediately start solve
- ✅ Run classify, show result, AskUserQuestion("전략 {X}를 추천합니다. 진행할까요?")

---

## AskUserQuestion Dark-Theme Rule

See `references/ask-user-question-rule.md` — the `question` field is invisible on dark terminals; put context in markdown, use `header`/`label`/`description` for user-facing text.

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

> **⚠ When using Bash tool, always define a shell function first:**
> ```bash
> xms() { node "${CLAUDE_PLUGIN_ROOT}/lib/x-solver-cli.mjs" "$@"; }
> xms constraints add "text" --type hard
> ```
> **Forbidden:** Assigning `XMS="node ..."` then calling `$XMS constraints add` — zsh treats the entire quoted string as a single command name and fails with `no such file or directory`.
> When running multiple commands sequentially, define the function on the first line then call `xms <command>` afterward.
> Alternative: use the unified dispatcher `x-kit solver <command>` — no function needed.

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
- `close` → Run `$XMS close`, then [Post-Close: x-humble Link]
- `history` → Run `$XMS history`
- `next` → [Command: next]
- `handoff` → Run `$XMS handoff [--restore]`
- Empty input → Ask the user to describe the problem (AskUserQuestion)
- Other natural language → [Command: auto] Treat as problem description and run `init` + `classify`

## Trace Recording

See `references/trace-recording.md` — session_start/session_end are automatic via `.claude/hooks/trace-session.mjs`; emit best-effort `agent_step` entries for long sub-operations.

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

This skill uses only Claude Code's built-in Agent tool.

### Agent Count Resolution (MANDATORY)

Before any fan-out or broadcast, resolve the agent count:

```bash
node -e "import('/Users/jinwoo/.claude/plugins/cache/x-kit/x-kit/1.26.4/lib/shared-config.mjs').then(m => console.log(m.getAgentCount()))"
```

Use the returned value as `AGENT_COUNT` for all fan-out/broadcast operations in this session.
Do NOT hardcode agent counts. Always use the resolved value.

### fan-out (parallel agents)
Call `AGENT_COUNT` Agent tools **simultaneously** in a single message:
```
Agent tool 1: { description: "agent-1", prompt: "...", run_in_background: true, model: "sonnet" }
Agent tool 2: { description: "agent-2", prompt: "...", run_in_background: true, model: "sonnet" }
...up to AGENT_COUNT agents
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
   - **Assumptions** — what are you assuming about inputs/environment/prior state? Surface unstated assumptions before decomposition; low-confidence ones block progress until validated.
4. After collecting answers:
   ```bash
   $XMS context add --content "..." --type code
   $XMS constraints add "constraint" --type hard
   ```
5. Automatically run classify

## Command: classify

See `commands/classify.md` — rule-based signal detection with LLM fallback for low-confidence cases. Recommends x-solver strategy and optionally an x-op alternative.

Key behaviors:
- **Step-Back (check higher-level pattern):** Before classifying, step back and ask — "What kind of problem is this, fundamentally?"
- High confidence (≥ 0.7): use rule-based result as-is
- Low confidence (< 0.7): LLM fallback via delegate agent
- AskUserQuestion (REQUIRED) for final strategy selection

---


## Problem-Solving Principles

These principles are injected into all solve-phase agent prompts.

```
## Problem-Solving Principles

1. **Simplest sufficient solution** — The best solution is the simplest one that satisfies all hard constraints. Complexity must justify itself with evidence.
2. **Reversibility over optimality** — When two solutions score similarly, prefer the one that's easier to undo or change. Irreversible decisions need stronger evidence.
3. **Separate the problem from the solution** — Understand what's actually wrong before proposing fixes. A misdiagnosed problem leads to a correct solution for the wrong question.
4. **Evidence over intuition** — Every claim needs supporting evidence from code, logs, docs, or tests. "I think" is not evidence.
5. **Constraints are guardrails, not goals** — Satisfying constraints is necessary but not sufficient. The goal is solving the actual problem.
6. **Compound signals, not single indicators** — Never conclude from one log line, one error, or one metric. Require corroborating evidence from a different source. If only one signal exists, state the uncertainty.
7. **No evidence, full stop** — If you cannot find evidence for a claim, stop and say so. Do not fill the gap with speculation. "I don't know yet" is a valid intermediate answer.
```

## Command: solve

See `commands/solve.md` — strategy-specific agent orchestration. Phase flow:
- decompose: decompose → explore → evaluate → synthesize
- iterate: DIAGNOSE → HYPOTHESIZE → TEST → REFINE → RESOLVE [state+baseline] [falsifiable] [one var] [switch/revert] [fix+exec proof] [why late?]
- constrain: elicit → generate → evaluate → select (Contrastive Matrix with Winner column)
- pipeline: classify → route → meta-verify

### iterate — Leader execution rules (MUST)
The leader must never directly read code or verify hypotheses in any phase. Always delegate to an agent.

**diagnose phase:** MUST — This phase cannot be skipped. The first solve of the iterate strategy must always start from diagnose.
- State Diagnosis + Baseline: Current State / Baseline / Delta
- Optional Fishbone (Ishikawa) Root Cause Analysis when Delta = "unknown" or multiple layers
- Checklist: delegate agent called / Current State + Baseline + Delta collected / (if Delta = unknown) Fishbone analysis complete / AskUserQuestion called / solve-advance called

**hypothesize phase:** Generate 3-5 falsifiable hypotheses, ordered by likelihood.
- Checklist: delegate agent called / hypotheses add called / AskUserQuestion called / solve-advance called

**test phase:** Fan-out one agent per hypothesis — direct verification forbidden.
- Checklist: Agent fan-out complete / hypotheses update called / AskUserQuestion called / solve-advance called

**refine phase:** Check confirmed/inconclusive; if all refuted apply Switch or Revert before retrying.
- Checklist: Hypothesis status verified / AskUserQuestion called / solve-advance called

**resolve phase:** fix + exec proof — Fix it and prove it by execution. Both must be completed in this phase.
- Checklist: delegate agent called (including fix + exec proof) / Execution evidence confirmed / candidates add + select called / verify called / close called

### constrain — Contrastive Matrix
After scoring, the leader produces a Contrastive Matrix showing each candidate scored per constraint with a Winner column, making tradeoffs visible at a glance before selection.

---

## Command: verify

**Principle: "Solved" is confirmed by execution only — not by reading, not by reasoning, not by "it should work."**

1. Run: `$XMS verify`
2. Parse JSON output (`action: "verify"`)
3. If there are constraints without scores:
   - **delegate** (verifier, sonnet) agent for verification:
     ```
     Verify whether this solution satisfies the following constraints.
     Solution: {selected_candidate}
     Constraints: {unscored_constraints}

     Verification must be by execution:
     - Run the build, test, or command that demonstrates the constraint is met
     - Paste the actual output as evidence
     - "It should work" or "the code looks correct" is NOT verification
     - If a constraint cannot be verified by execution (e.g., "maintainable code"), state explicitly that it requires human judgment
     ```
4. Show results to the user with execution evidence
5. **AskUserQuestion (REQUIRED):** On pass: AskUserQuestion("검증 통과: {constraints_passed}개 제약 조건 모두 충족됐습니다. 문제를 종료(close)할까요?")
6. On pass (confirmed): `$XMS phase next` → run close. Suggest committing (save known-good state).
7. On fail: show which constraints are unmet with the failing output; AskUserQuestion("검증 실패: {failed_constraints}. solve 단계로 돌아갈까요?")

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

## Integrations (x-humble, x-build)

See `references/integrations.md` — post-close x-humble retrospective + x-build task/decisions conversion.

---

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

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I already know the answer" | You have a solution. Structured decomposition tests whether you have the right problem. Skipping it means committing to one hypothesis without alternatives. |
| "Decomposing wastes time on a simple problem" | If it's simple, decomposition takes 30 seconds and confirms that. If it's not, decomposition saves hours. Either way you win. |
| "Iteration is just retrying the same thing" | Iteration changes what you test each round. If nothing changes between rounds, you're not iterating — you're hoping. |
| "The constraints are obvious" | Obvious constraints are the ones most often violated. Name them explicitly so the solution can be scored against them. |
| "I'll skip strategy selection and just start" | Starting without strategy is the strategy of "hope". It doesn't scale beyond trivial problems. |
| "The first viable solution is good enough" | First viable ≠ best viable. The `constrain` strategy exists precisely to generate and score alternatives. |
| "The problem is too novel for a strategy" | Strategies are meta-patterns, not answers. If none fit, you haven't framed the problem yet. |
