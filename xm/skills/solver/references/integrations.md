# x-solver Integrations

Cross-plugin integrations — x-review hand-off for the code resolve edited, x-humble retrospective link
after close, and x-build task/decision injection.

## Post-Resolve: x-review Hand-off

The `resolve` phase edits code. Those edits leave x-solver unreviewed unless they are handed off — a
solver-authored diff currently reaches `close` without passing any review gate.

**The check is mandatory; running the review is not.** After `$XMS verify` passes and before
`$XMS close`:

```bash
git diff --stat
```

- **Empty** — nothing was changed in code (an environment or config cause). Skip the hand-off and say
  so in one line.
- **Non-empty** — the close AskUserQuestion MUST offer review as the default option, and MUST name the
  fan-out size before spawning it:

```
1) /xm:review diff — 수정분 다관점 리뷰 (렌즈 에이전트 N개)   [권장]
2) 리뷰 없이 close
```

Run it after verify, never before: a fix that cannot pass its own execution proof does not deserve a
review fan-out.

```
/xm:review diff "x-solver resolve: {problem_title} — confirmed cause: {hypothesis}. Review this fix."
```

| Verdict | Action |
|---|---|
| LGTM | `$XMS close --summary "..."`, then the x-humble link below |
| Request Changes / Block | Do **not** close. `$XMS context add --content "<findings>" --type review`, then `$XMS solve-advance --phase refine`. Findings are new evidence, not a blind patch |

**Ownership.** When x-solver started the fix, the solver problem owns closure — do not open a separate
review-fix triage for the same diff. When the Review-Fix Gate sent the problem here for diagnosis
(root `CLAUDE.md`), `.xm/review/triage.json` owns closure and x-solver returns a diagnosis only.

## Post-Close: x-humble Link [why late?]

After `$XMS close`, **always suggest this for non-trivial problems in the iterate strategy (2+ iterations or a perspective switch occurred).**

```
문제가 해결됐습니다. 왜 이 문제가 늦게 발견됐는지 되돌아볼까요?
1) 네 → /xm:humble review로 분석
2) 아니요 — 끝
```

On "Yes", pass context to x-humble:
```
/xm:humble review "x-solver: {problem_title} — strategy: {strategy}, iterations: {count}, why was this found late?"
```

Key questions: **Why did this problem occur? Why was it found late? What should change in the process?**

Skip: Simple problems (single iteration, confirmed at first try).

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

Conversion commands use the `xm build` dispatcher:
```bash
# decompose result example (3 leaves)
xm build tasks add "Implement cache layer [R1]" --size medium
xm build tasks add "Add rate limiting [R2]" --size small --deps t1
xm build tasks add "Write integration tests [R3]" --size small --deps t1,t2
```

### x-build decisions integration

Decisions made during solve can be auto-injected into x-build:
```bash
xm build decisions add "Redis for caching" --type architecture --rationale "x-solver constrain result: optimal for response time/cost"
```

## Applies to
Called after `close` phase completion. Converts solve results into follow-up actions (humble retrospective, x-build tasks/decisions).
