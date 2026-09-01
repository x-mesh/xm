---
name: solver
description: Structured problem solving and bug diagnosis — iterate (diagnose → hypothesize → falsify → fix → prove), decompose, constrain, or auto-pipeline
allowed-tools:
  - AskUserQuestion
---

<Purpose>
x-solver takes a problem from symptom to proven fix. Debugging is its primary job: on a bug, error,
crash, regression, or perf problem it captures a baseline, generates falsifiable hypotheses, refutes
them with parallel agents, applies the fix, and proves it by execution — never by "it should work".
Non-bug problems route to decompose (break a problem down) or constrain (choose between options scored
against explicit constraints); pipeline auto-routes.
4 strategies: iterate (debug/diagnose), decompose, constrain, pipeline (auto).
Stateful — persists the problem, its hypotheses, and its verification evidence to `.xm/solver/`, so a
diagnosis survives turn and session boundaries.
</Purpose>

<Use_When>
- A bug, error, crash, regression, flaky test, memory leak, deadlock, or perf problem needs to be
  diagnosed AND fixed — this is x-solver's primary job
- User says "find the bug", "debug this", "why does this keep failing", "fix it",
  "이거 왜 안 돼", "버그 잡아줘", "메모리 누수 잡아줘"
- A first fix attempt already failed, or the diagnosis will need more than one round
- User wants a complex problem solved structurally: "solve this", "decompose", "차근차근 분해해서 풀어"
- User must choose between approaches against explicit constraints: "which approach is better"
- Another xm skill (x-probe, x-review, x-humble) hands a problem back for diagnosis
</Use_When>

<Do_Not_Use_When>
- Naming a probable cause in one pass, with no fix expected — use x-op hypothesis
- Open-ended exploration with no failing symptom to anchor on — use x-op investigate
- Judging a diff for defects that have not been observed yet — use x-review
- Simple one-off questions that don't need structured solving
- Project lifecycle management (use x-build instead)
- Strategy orchestration without problem tracking (use x-op instead)
</Do_Not_Use_When>

<Boundary>
Use `x-solver iterate` when the run must end in an applied, execution-proven fix — or may need more
than one round of state carried across turns; use `x-op hypothesis` when a single pass that names and
refutes causes is the whole deliverable.
</Boundary>

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

Check mode ONCE at session start, then cache it for the whole session — never re-probe
per command (a per-command probe nearly doubles CLI invocations for zero information).
Re-check only after an explicit `mode <developer|normal>`:
```bash
xm solver mode show
```

### Korean output style (avoid AI-slop)

Universal (both modes) — these read as machine-generated in any register:
- Drop empty intensifiers ("매우 / 완벽하게 / 강력한 / 원활하게 / 혁신적인") unless they carry a specific, real claim.
- No forced rule-of-three or "~뿐만 아니라 ~까지" balance that adds no fact.
- No hedged non-conclusions ("결국 상황에 따라 다르다 / 균형이 필요하다"). End on a concrete fact, number, or next action.

Developer mode: terse and direct — lead with the result; state findings/actions without a 권고형 결말 pile-up ("~해야 한다" sentence after sentence).
Easy/normal mode: accessible Korean is the goal — polite guidance ("~해 보세요"), one line of context for non-experts. Keep commands, flags, paths, and proper nouns in English; on first use write a domain term as Korean(original), e.g. 결론(verdict). Still apply the universal rules; accessible ≠ padded or vague.

## CLI

All commands via the `xm` dispatcher:
```bash
xm solver <command> [args]
```

Shorthand in this document: `$XMS` means `xm solver`.

> **⚠ Call `xm solver <command>` directly. Claude Code's Bash tool starts a fresh shell on every invocation — shell functions (`xms()`) defined in one call do NOT persist to the next, causing `command not found: xms`. Never define a helper across calls; always use the dispatcher.**
>
> **Fallback** (only when `xm` is not in PATH — rare; `${CLAUDE_PLUGIN_ROOT}` is NOT exported to Bash subprocesses, so don't rely on it bare):
> ```bash
> XMS_CLI=$(ls -d ~/.claude/plugins/cache/xm/{solver,xm}/*/lib/x-solver-cli.mjs 2>/dev/null | sort -V | tail -1)
> node "$XMS_CLI" <command> [args]
> ```
>
> **Forbidden:** `XMS="node ..."; $XMS <command>` — zsh treats the quoted string as a single command and fails.

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
- `repro` → Run `$XMS repro <set|verify|show>`
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
| "이거 왜 안 돼", "버그 잡아줘", "debug this", "find the bug" | init → classify (iterate) |
| "고쳐봤는데 또 안 돼", "the first fix didn't work" | init → classify (iterate, 2+ rounds) |
| "Help me fix this bug" | init → classify (likely iterate) |
| "Which approach is better" | init → classify (likely constrain) |
| "Analyze this problem" | init → classify (pipeline) |
| "Break it down and solve" | init → strategy set decompose → solve |
| "Add hypothesis" | hypotheses add |
| "Show the tree" | tree show |
| "List candidates" | candidates list |
| "Generate candidates with different models", "cross-vendor candidates" | solve --cross-vendor |
| "Verify it" | verify |
| "What's next?" | next |

---

## Agent Primitives

This skill uses only Claude Code's built-in Agent tool.

### Agent Count Resolution (MANDATORY)

Before any fan-out or broadcast, parse `agent_count` from the latest `$XMS solve` JSON output.
The CLI resolves it as local `.xm/solver/config.json` `solving.parallel_agents` first, then shared `.xm/config.json` `agent_max_count`, then default `4`.

Use that value as `AGENT_COUNT` for all fan-out/broadcast operations in the current solve phase.
Do NOT hardcode agent counts. Always use the resolved value.

### fan-out (parallel agents)
Call `AGENT_COUNT` Agent tools **simultaneously** in a single message:
```
Agent tool 1: { description: "agent-1", prompt: "...", run_in_background: true, model: "sonnet" } <!-- managed-model: executor -->
Agent tool 2: { description: "agent-2", prompt: "...", run_in_background: true, model: "sonnet" } <!-- managed-model: executor -->
...up to AGENT_COUNT agents
```

### delegate (single agent delegation)
```
Agent tool: { description: "role name", prompt: "...", run_in_background: false } <!-- managed-model: architect -->
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
- `direct` means no x-solver strategy is required; answer directly, or choose a real strategy if the problem becomes non-trivial
- AskUserQuestion (REQUIRED) for final strategy selection

---


## Problem-Solving Principles

These principles are injected verbatim into all solve-phase agent prompts.

```
1. **Simplest sufficient solution** — The best solution is the simplest one that satisfies all hard constraints. Complexity must justify itself with evidence.
2. **Reversibility over optimality** — When two solutions score similarly, prefer the one that's easier to undo or change. Irreversible decisions need stronger evidence.
3. **Separate the problem from the solution** — Understand what's actually wrong before proposing fixes. A misdiagnosed problem leads to a correct solution for the wrong question.
4. **Evidence over intuition** — Every claim needs supporting evidence from code, logs, docs, or tests. "I think" is not evidence.
5. **Constraints are guardrails, not goals** — Satisfying constraints is necessary but not sufficient. The goal is solving the actual problem.
6. **Compound signals, not single indicators** — Never conclude from one log line, one error, or one metric. Require corroborating evidence from a different source. If only one signal exists, state the uncertainty.
7. **No evidence, full stop** — If you cannot find evidence for a claim, stop and say so. Do not fill the gap with speculation. "I don't know yet" is a valid intermediate answer.
```

## Command: solve

See `commands/solve.md` (decompose / constrain / pipeline) and `commands/iterate.md` (iterate — the debug path). Phase flow:
- decompose: decompose → explore → evaluate → synthesize
- iterate: REPRODUCE → DIAGNOSE → HYPOTHESIZE → TEST → REFINE → RESOLVE [repro+marker] [state+baseline] [falsifiable] [one var] [switch/revert] [fix+regression proof] [why late?]
- constrain: elicit → generate → evaluate → select (Contrastive Matrix with Winner column)
- pipeline: classify → route → meta-verify

**Cross-vendor (opt-in):** `solve --cross-vendor` fans out the GENERATION steps (explore /
generate / hypothesize) across different model vendors via `xm panel cross` instead of
same-model Claude agents — same-model fan-out has low diversity, different model families produce
genuinely different candidates. Evaluation/scoring stays single-vendor (for cross-vendor scoring
use `x-eval --cross-vendor`). Probe `xm panel detect --auth` (installed + authenticated); fall
back loudly to single-vendor if <2 vendors are ready (`xm panel doctor` shows why). **Default without
the flag:** `.xm/config.json` `cross_vendor.solver` ?? `cross_vendor.default`; `--no-cross-vendor` forces
single-vendor. Full flow: `references/cross-vendor.md`.

### iterate — Leader execution rules (MUST)
The leader must never directly read code or verify hypotheses in any phase. Always delegate to an agent.

**reproduce phase:** MUST — This phase cannot be skipped. The first solve of the iterate strategy must always start from reproduce. A fix you cannot see fail is a fix you cannot prove.
- Capture one command a stranger could run, its real output, its exit code, and a **failure marker**: a literal substring that appears in that output only when the bug happens. The CLI checks the marker is really there, so pick it from the text you pasted.
- Search for the last known-good state with `git bisect start <bad> <good>` + `git bisect run <repro command>`, or by hand over `git log --oneline -20 -- <path>` when bisect cannot run.
- Cannot reproduce it? Say so rather than guessing: `$XMS repro set --status unavailable --justification "..."`. resolve is then limited to reversible, evidence-gathering changes.
- Intermittent? Record the observed rate (`--runs 3/10`). The CLI computes how many clean runs a fix needs to beat chance.
- Checklist: delegate agent called / command + output + exit code captured / marker chosen from that output / baseline searched / `$XMS repro set` accepted / AskUserQuestion called / solve-advance called

**diagnose phase:** MUST — Runs after reproduce.
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
5. Branch on `status`, never on `passed` alone — there are three verdicts, not two:

| `status` | exit | Meaning | Next |
|---|---|---|---|
| `passed` | 0 | Every hard constraint was checked and held | AskUserQuestion("검증 통과: {constraints_passed}개 제약 조건 모두 충족됐습니다. 문제를 종료(close)할까요?") → `$XMS phase next` → close. Suggest committing the known-good state. |
| `failed` | 1 | A hard constraint was checked and did not hold | Show the failing output; AskUserQuestion("검증 실패: {failed_constraints}. solve 단계로 돌아갈까요?") |
| `unverified` | 2 | **Nothing was checked.** No candidate, no score, or no hard constraint at all | Do NOT report success. Read `reason` and follow the two exits the CLI prints: supply the missing evidence, or attest with `--manual`. |

> **A non-zero exit here is the gate reporting a verdict, not the tool failing. Do not retry the command, and do not treat exit 2 as an error to work around.**

6. `unverified` is the verdict that used to be reported as PASSED. `reason` says which case it is:
   `no_selected_candidate` / `unscored_hard_constraints` / `no_hard_constraints`.
7. When a constraint genuinely cannot be checked by execution (the "maintainable code" case above),
   attest it — evidence is required and must be the command you ran plus its output, not a restatement
   of the claim:
   ```bash
   $XMS verify --manual "<what holds>" --evidence "<command + actual output>"
   ```
   A constraint that was measured and failed cannot be attested over. Fix it or re-score it.
8. `close` is gated on a passed verification. To close an unproven problem, say why —
   it is recorded as `closed`, not `solved`:
   ```bash
   $XMS close --force --reason "<why this is being closed unproven>"
   ```

## Command: next

1. Run: `$XMS next`
2. Parse JSON output (`action: "next"`)
3. Auto-execute the appropriate command based on `recommendation`:
   - `init` → Ask the user to describe the problem
   - `describe` → Request additional description
   - `classify` → Run classify
   - `direct` → Answer directly, then close or pick a real strategy if complexity increases
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
4. If recommendation is `direct`, answer directly and skip `strategy set`
5. Otherwise `$XMS strategy set <chosen>` and run `$XMS solve`

---

## Shared Config Integration

x-solver references shared config in `.xm/config.json`:

| Setting | Key | Default | Effect |
|---------|-----|---------|--------|
| Mode | `mode` | `developer` | Output style |
| Agent count | `agent_max_count` | `4` | Default agent count when `solving.parallel_agents` is not set |

Change config: `xm config set agent_max_count 10`

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
| "verify came back non-zero, let me run it again" | Non-zero is the verdict, not a crash. Exit 2 means nothing was checked — re-running checks nothing again. Supply the missing score or evidence first. |
| "The constraints are all unscored but the fix obviously works" | Then score one. "Obviously works" is the exact claim the gate exists to stop, and it is the claim that shipped the vacuous PASSED this gate was built to remove. |

## Red Flags

Stop when you notice any of these. Each one means the run is producing a conclusion it has not earned.

| Red flag | What it actually means | Do this instead |
|---|---|---|
| A hypothesis is marked `confirmed` from one log line, one metric, or one code read | Principle 6 is being skipped. A single source cannot corroborate itself | Find a second source of a different kind, or record it as inconclusive |
| `resolve` is starting with no `confirmed` hypothesis | The fix is a guess wearing the workflow's clothes | Return to `hypothesize`, or say plainly that you are mitigating without a known cause |
| The leader read the code or ran the check itself | The delegation rule exists so the leader stays a router, not a second opinion with no evidence trail | Delegate. Every phase, every time |
| `verify` reports `unverified` and the run continues toward close | The gate said nothing was checked, and it is being read as permission | Score the constraint, or attest with `--manual` and real evidence |
| The verification command changed between the failing run and the passing run | A different command proves a different thing | Re-run the original command. If it cannot run, the fix is not demonstrated |
| A phase was skipped "because the answer is obvious" | The obvious answer is the one most in need of a falsification attempt | Run the phase. If it is obvious, it costs a minute |
| Candidates were generated but never scored against the constraints | The constraints became decoration | Score them, or delete the ones you are not going to use |
| The same hypothesis reappears across iterations in new words | The loop is stalling, and convergence detection will say so | Switch layer or revert to baseline — repeating is not iterating |
