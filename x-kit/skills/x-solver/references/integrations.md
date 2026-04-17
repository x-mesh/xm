# x-solver Integrations

Cross-plugin integrations — x-humble retrospective link after close, and x-build task/decision injection.

## Post-Close: x-humble Link [why late?]

After `$XMS close`, **always suggest this for non-trivial problems in the iterate strategy (2+ iterations or a perspective switch occurred).**

```
문제가 해결됐습니다. 왜 이 문제가 늦게 발견됐는지 되돌아볼까요?
1) 네 → /x-humble review로 분석
2) 아니요 — 끝
```

On "Yes", pass context to x-humble:
```
/x-humble review "x-solver: {problem_title} — strategy: {strategy}, iterations: {count}, why was this found late?"
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

## Applies to
Called after `close` phase completion. Converts solve results into follow-up actions (humble retrospective, x-build tasks/decisions).
