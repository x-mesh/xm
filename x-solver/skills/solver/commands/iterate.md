# Strategy: iterate — debug to a proven fix

Extracted from `solve.md` (the file was past the 500-line budget and iterate is the branch that
grows). `solve.md` keeps decompose, constrain and pipeline, and points here.

> **Leader execution rules (MUST)**
> 1. The leader (Claude) must never directly read code or verify hypotheses in any phase. **Always delegate to an agent.**
> 2. Phases must be executed in order. **Skipping is forbidden.**
> 3. After each phase completes, call `$XMS solve-advance` **immediately**. Do not advance to the next phase without calling it.
>
> **Phase Flow:**
> ```
> REPRODUCE → DIAGNOSE → HYPOTHESIZE → TEST → REFINE → RESOLVE → x-humble
> [repro+marker] [state+baseline] [falsifiable] [one var] [switch/revert] [fix+regression proof] [why late?]
> ```

#### Phase: reproduce

> **MUST — the iterate strategy always starts here. A fix you cannot see fail is a fix you cannot prove.**

**delegate** (debugger — omit `model`; inherits the session model):
```
{problem_solving_principles}

## Reproduction

R1. Repro command — ONE command a stranger can run in this repo that shows the failure.
- Prefer the narrowest scope that still fails: single test > suite > manual steps.
- If you changed the environment to see it, that setup is part of the repro — state it.

R2. Failure evidence — actually run it. Paste the real output, not a description of it.
- Record the exit code.
- Choose one literal substring that appears in that output ONLY when the bug happens (an assertion
  message, an error class, a wrong value). This is the FAILURE MARKER.
- Do not invent a marker that is not in the text you pasted. The CLI checks, and will refuse it.
- A timestamp, a path, or a line number is not a marker — those change for unrelated reasons.

R3. Determinism — how many of N runs fail?
- Failed once? Run it at least 3 more times before calling it deterministic.
- Fails sometimes: record the observed rate as N/M (e.g. 3/10). That is an INTERMITTENT repro, not
  a failed reproduction attempt.

R4. Baseline search — find the newest commit where the repro command PASSES.
    git bisect start <bad-ref> <good-ref>
    git bisect run <repro command>     # must exit non-zero on failure
    git bisect reset
- If `git bisect run` is unusable (needs a build step, manual steps, or no known-good ref), bisect
  by hand over the commits touching the failing area: git log --oneline -20 -- <path>
- "No baseline found — searched <what>" is a valid answer. An unexplained "unknown" is not.

Problem: {problem_context}
Context: {additional_context}

Output: repro status (reproduced | intermittent N/M | unavailable), the command, the captured
output, the failure marker, the exit code, and the baseline.

If the status is `unavailable`, do NOT continue as if it were reproduced. State which is true and
what you tried: (a) environment-only, (b) symptom already gone, (c) needs production data or scale,
(d) no access to a failing instance.
```

After completion, run without fail:
```bash
$XMS repro set --command "<cmd>" --output-file <captured> --exit-code <n> \
  --failure-marker "<literal substring>" --status reproduced [--runs 3/10] [--baseline-commit <sha>]
# not reproducible:
# $XMS repro set --status unavailable --justification "<which of a-d, and what was tried>"
$XMS solve-advance --phase diagnose
```

> Checklist:
> - [ ] delegate agent called (the leader must not run the repro itself)
> - [ ] Command + real output + exit code captured
> - [ ] Failure marker chosen FROM the pasted output
> - [ ] Baseline searched (bisect attempted or explicitly ruled out)
> - [ ] `$XMS repro set` accepted
> - [ ] AskUserQuestion called
> - [ ] `$XMS solve-advance --phase diagnose` called

**AskUserQuestion (REQUIRED):**
- reproduced/intermittent → "재현 확인: `{command}` ({status}). 진단(diagnose) 단계로 진행할까요?"
- unavailable → 3지 선택: 1) 계측만 추가하고 재발을 기다린다 2) baseline 복원·revert로 좁힌다 3) 지금은 기록만 남기고 중단한다

#### Phase: diagnose

> **MUST — Runs after reproduce. The first solve of the iterate strategy must always start from reproduce.**

**delegate** (debugger — omit `model`; inherits the session model):
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

delegate (analyst — omit `model`; inherits the session model):
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

**delegate** (debugger — omit `model`; inherits the session model):

> **Cross-vendor (opt-in):** with `--cross-vendor`, broadcast this hypothesis-generation prompt
> across vendors via `xm panel cross` and merge the distinct hypothesis sets (dedup overlaps) —
> different model families frame root causes differently. Then `hypotheses add` the merged set.
> See `references/cross-vendor.md`. (The `test` phase below stays single-vendor — execution.)

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

**Independent refutation first.** Each hypothesis was verified by the agent that owns it, which
corroborates nothing. Fan out **one refuter per confirmed hypothesis** — typically one agent, since
usually one hypothesis survives testing. A second confirmed hypothesis means the test phase was
blurry and is worth the extra agent.

**delegate** (refuter — omit `model`; inherits the session model):
```
{problem_solving_principles}

You are an INDEPENDENT REFUTER. Another agent concluded this hypothesis is CONFIRMED.
Your job is not to agree. Your job is to find the reading of the evidence in which it is wrong.

Hypothesis: {hypothesis.description}
Verifier's evidence (verbatim): {evidence_for}
Repro: {repro.command} — status {repro.status}{, observed rate N/M}

In order:
1. Re-derive the conclusion from the evidence alone. Does the pasted output actually SHOW what the
   verifier claims, or does it merely fail to contradict it?
2. Name at least one alternative cause that produces the SAME evidence. If you genuinely cannot,
   say so — that is itself a result.
3. Find corroborating evidence from a DIFFERENT source than the verifier used (they used:
   {source_kind}). Code read vs. log line vs. command output vs. metric are different sources;
   two reads of the same file are not.
4. If the repro is intermittent: could the verifier's observation be noise at a {N}/{M} failure
   rate? How many observations would separate signal from noise?

Verdict, exactly one:
- SURVIVED — state what it survived
- FALSIFIED — state the counter-evidence
- SINGLE-SIGNAL — plausible, but only one source supports it

Do not propose a fix. Do not edit files.
```

Then decide:

| Refuter verdict | Next |
|---|---|
| SURVIVED | `solve-advance --phase resolve` — root-cause mode |
| SINGLE-SIGNAL | Find the second source, or take the narrow exit below. A single source cannot carry a root-cause claim |
| FALSIFIED | Back to hypothesize (iteration++), or **Switch or Revert** |
| None confirmed | **Switch or Revert** first: 1) switch layer (app code → infra/config/network) 2) revert to the diagnose baseline and isolate with minimal changes 3) if both fail, back to hypothesize |

**When iterations run out**, resolving on the most likely unconfirmed hypothesis is a guess, not a
fix. Pick one of three exits — all of them terminate:

```bash
# 1) narrow — reversible instrumentation only; the cause stays unknown and close says so
$XMS solve-advance --phase resolve --unconfirmed narrow --justification "..."
# 2) extend — one more round, saying what changes. Capped at 2 extensions
$XMS solve-advance --phase hypothesize --extend-iterations 2 --justification "..."
# 3) abandon — keep the diagnosis, stop honestly
$XMS close --abandon --summary "..."
```

Convergence stop (stagnation/oscillation) cannot be extended. Repeating the same round in new words
does not become productive with more budget.

After completion, run without fail:
```bash
$XMS hypotheses update <id> --refutation survived|falsified|single-signal --refuted-by refuter-1
# [REQUIRED] one of two based on refine decision — must not be omitted
$XMS solve-advance --phase resolve     # if a confirmed hypothesis survived refutation
# or
$XMS solve-advance --phase hypothesize # if all refuted
```

> Checklist:
> - [ ] Refuter delegated for every confirmed hypothesis
> - [ ] `$XMS hypotheses update --refutation` called per hypothesis
> - [ ] AskUserQuestion called
> - [ ] `$XMS solve-advance` called (resolve or hypothesize)

**AskUserQuestion (REQUIRED):** AskUserQuestion("정제 결과: {refine_decision}. {'해결(resolve) 단계로 진행할까요?' if confirmed else '다시 가설 생성(hypothesize)으로 돌아갈까요?'}")

#### Phase: resolve

> **fix + regression proof — Fix it, and prove it against the failure you recorded. Both must happen here.**

## Regression proof (REQUIRED — this is what makes a change a fix)

Recorded before you touched anything: the command, the failure marker, and the exit code
(`$XMS repro show`).

1. Re-run the EXACT recorded command. Do not modify it, do not narrow the scope, do not add flags.
   If you feel the need to change the command, the fix is not done — say that instead.
2. Paste the new output and its exit code.
3. The failure marker must be ABSENT from the new output. If it is still there, report FAIL.
4. Add a regression test that fails on the pre-fix code and passes on the post-fix code. If an
   existing test already covers it, name that test. If the failure cannot be expressed as a test
   (infra, environment, data), say so and state what monitoring replaces it. Do not fabricate a test
   that passes both before and after.
5. Intermittent repro: run it the number of clean runs `$XMS repro show` reports. One passing run
   does not separate a fix from luck.

If `resolve_mode` is `narrow`, there is NO confirmed root cause. You may only make reversible,
evidence-gathering changes — logging, assertions, a test that captures the symptom. Do not ship a
speculative fix; the close summary will state the cause is still unknown.

```bash
$XMS repro verify --output-file <after> --exit-code 0 [--runs 0/9] [--regression-test <path>]
```
>
> **Exception — diagnosis only.** If this problem came from the Review-Fix Gate (root `CLAUDE.md` step
> 4b), stop at the confirmed cause and hand it back to triage. Do not edit: `x-build hooks install`
> arms a PreToolUse scope guard that blocks writes outside `fix_scope.allowed_files`, and widening
> that scope on a guess is the thing the gate exists to prevent.

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
> - [ ] `$XMS repro verify --output-file <after> --exit-code 0 [--regression-test <path>]` accepted
> - [ ] `$XMS candidates add` + `select` called
> - [ ] `$XMS verify` called
> - [ ] `git diff --stat` checked — this phase edits code, and the check is mandatory
> - [ ] If the diff is non-empty: review offered as the default option before close (see `references/integrations.md`)
> - [ ] `$XMS close` called
> - [ ] If non-trivial problem: suggest `/xm:humble review "x-solver: {title} — why late?"`
